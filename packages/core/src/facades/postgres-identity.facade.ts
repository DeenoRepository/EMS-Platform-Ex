import crypto from 'node:crypto';
import type {
  IdentityFacade,
  LoginInput,
  LoginOutput,
  BootstrapInput,
  BootstrapOutput,
  Result,
  SessionContext,
} from '@ems/contracts';
import { ok, fail } from '@ems/contracts';
import type { DatabasePool } from '../persistence/db.js';
import { EmployeeRepository } from '../persistence/employee.repository.js';
import { DepartmentRepository } from '../persistence/department.repository.js';
import { RoleRepository } from '../persistence/role.repository.js';
import { SessionRepository } from '../persistence/session.repository.js';
import { AuditRepository } from '../persistence/audit.repository.js';

export interface LdapAuthenticator {
  authenticate(upn: string, password: string): Promise<Result<{
    directoryId: string;
    objectGuid: string;
    upn: string;
    displayName: string;
  }>>;
}

export const ADMIN_ROLE_ID = 'role.platform.admin';

export class PostgresIdentityFacade implements IdentityFacade {
  private readonly employeeRepo = new EmployeeRepository();
  private readonly departmentRepo = new DepartmentRepository();
  private readonly roleRepo = new RoleRepository();
  private readonly sessionRepo = new SessionRepository();
  private readonly auditRepo = new AuditRepository();

  constructor(
    private readonly pool: DatabasePool,
    private readonly ldapAuthenticator: LdapAuthenticator,
  ) {}

  async login(input: LoginInput): Promise<Result<LoginOutput>> {
    if (!input.upn || !input.password) {
      return fail({
        code: 'VALIDATION_FAILED',
        message: 'Необходимо указать имя пользователя и пароль',
        retryable: false,
      });
    }

    // Проверка учетных данных через LDAP (FR-001..FR-008)
    const authResult = await this.ldapAuthenticator.authenticate(input.upn, input.password);
    if (!authResult.ok) {
      return fail(authResult.error);
    }

    const ldapUser = authResult.value;

    return await this.pool.withTransaction(async (client) => {
      // Ищем или создаем сотрудника по (directory_id, object_guid) (FR-002, FR-004)
      let employee = await this.employeeRepo.findByDirectoryGuid(
        client,
        ldapUser.directoryId,
        ldapUser.objectGuid,
      );

      if (!employee) {
        // Новый сотрудник создается в статусе PENDING без прав и отдела (FR-004)
        const newId = crypto.randomUUID();
        employee = await this.employeeRepo.create(client, {
          id: newId,
          directoryId: ldapUser.directoryId,
          objectGuid: ldapUser.objectGuid,
          upn: ldapUser.upn,
          displayName: ldapUser.displayName,
          status: 'PENDING',
        });
      }

      if (employee.status === 'BLOCKED') {
        // Заблокированная запись не активируется повторным входом (FR-006)
        await this.auditRepo.insert(client, {
          id: crypto.randomUUID(),
          subjectId: employee.id,
          action: 'LOGIN_BLOCKED',
          objectType: 'employee',
          objectId: employee.id,
          result: 'FAILURE',
        });

        return fail({
          code: 'FORBIDDEN',
          message: 'Учетная запись сотрудника заблокирована',
          retryable: false,
        });
      }

      // Получаем роли и разрешения сотрудника
      const roleIds = await this.employeeRepo.getRolesForEmployee(client, employee.id);
      const permissions = await this.roleRepo.getPermissionsForRoles(client, roleIds);

      // Сроки сессии: 8 часов абсолютный, 30 минут бездействия (baseline FR-022)
      const now = new Date();
      const expiresAt = new Date(now.getTime() + 8 * 60 * 60 * 1000);
      const idleExpiresAt = new Date(now.getTime() + 30 * 60 * 1000);

      const sessionId = crypto.randomUUID();
      await this.sessionRepo.create(client, {
        id: sessionId,
        employeeId: employee.id,
        expiresAt,
        idleExpiresAt,
      });

      // Запись аудита успешного входа в той же транзакции (FR-027)
      await this.auditRepo.insert(client, {
        id: crypto.randomUUID(),
        subjectId: employee.id,
        action: 'LOGIN',
        objectType: 'session',
        objectId: sessionId,
        result: 'SUCCESS',
      });

      const sessionContext: SessionContext = {
        sessionId,
        employeeId: employee.id,
        departmentId: employee.department_id,
        roleIds,
        permissions,
        createdAt: now.toISOString(),
        expiresAt: expiresAt.toISOString(),
        isPending: employee.status === 'PENDING',
        isBlocked: false,
      };

      return ok({ session: sessionContext });
    });
  }

  async bootstrap(input: BootstrapInput): Promise<Result<BootstrapOutput>> {
    if (!input.operatorId || !input.upn || !input.initialDepartmentId) {
      return fail({
        code: 'VALIDATION_FAILED',
        message: 'Неполные параметры для процедуры bootstrap',
        retryable: false,
      });
    }

    return await this.pool.withTransaction(async (client) => {
      // Проверяем инвариант единственного bootstrap: если администраторы уже есть, отклоняем (FR-012)
      const existingAdmins = await this.employeeRepo.countActiveAdmins(client, ADMIN_ROLE_ID);
      if (existingAdmins > 0) {
        return fail({
          code: 'CONFLICT',
          message: 'Система уже инициализирована. Повторный bootstrap запрещен (FR-012)',
          retryable: false,
        });
      }

      // Проверяем или создаем отдел
      let dept = await this.departmentRepo.findById(client, input.initialDepartmentId);
      if (!dept) {
        dept = await this.departmentRepo.create(client, {
          id: input.initialDepartmentId,
          name: 'Администрация платформы',
          code: 'PLATFORM_ADMIN',
        });
      }

      // Проверяем или создаем системную роль администратора
      let adminRole = await this.roleRepo.findById(client, ADMIN_ROLE_ID);
      if (!adminRole) {
        adminRole = await this.roleRepo.create(
          client,
          {
            id: ADMIN_ROLE_ID,
            name: 'Администратор платформы',
            description: 'Полный административный доступ к ядру платформы',
            isSystem: true,
          },
          ['platform.admin', 'platform.bootstrap', 'audit.view', 'employees.manage'],
        );
      }

      // Ищем или создаем сотрудника для первого администратора
      let employee = await this.employeeRepo.findByUpn(client, input.upn);
      if (!employee) {
        employee = await this.employeeRepo.create(client, {
          id: crypto.randomUUID(),
          directoryId: 'bootstrap-dir',
          objectGuid: crypto.randomUUID(),
          upn: input.upn,
          displayName: 'Первый администратор',
          status: 'ACTIVE',
          departmentId: dept.id,
        }, [ADMIN_ROLE_ID]);
      } else {
        await this.employeeRepo.updateAssignment(
          client,
          employee.id,
          dept.id,
          [ADMIN_ROLE_ID],
        );
      }

      // Запись аудита bootstrap (FR-010, FR-026)
      await this.auditRepo.insert(client, {
        id: crypto.randomUUID(),
        subjectId: input.operatorId,
        action: 'BOOTSTRAP',
        objectType: 'employee',
        objectId: employee.id,
        result: 'SUCCESS',
        details: {
          upn: input.upn,
          departmentId: dept.id,
          adminRoleId: ADMIN_ROLE_ID,
        },
      });

      return ok({
        employeeId: employee.id,
        departmentId: dept.id,
        roleId: ADMIN_ROLE_ID,
      });
    });
  }
}
