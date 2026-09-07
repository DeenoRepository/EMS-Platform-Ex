import crypto from 'node:crypto';
import type {
  IdentityFacade,
  LoginInput,
  LoginOutput,
  BootstrapInput,
  BootstrapOutput,
  Result,
  SessionContext,
  DirectoryAuthenticator,
  DirectoryIdentityResolver,
  LocalOperatorPort,
  AppError,
} from '@ems/contracts';
import { ok, fail } from '@ems/contracts';
import type { DatabasePool } from '../persistence/db.js';
import { EmployeeRepository } from '../persistence/employee.repository.js';
import { DepartmentRepository } from '../persistence/department.repository.js';
import { RoleRepository } from '../persistence/role.repository.js';
import { SessionRepository } from '../persistence/session.repository.js';
import { AuditRepository } from '../persistence/audit.repository.js';
import { hashCredential } from './subject-auth.js';

export const ADMIN_ROLE_ID = 'role.platform.admin';

class TransactionAbortError extends Error {
  constructor(public readonly appError: AppError) {
    super(appError.message);
    this.name = 'TransactionAbortError';
  }
}

export class PostgresIdentityFacade implements IdentityFacade {
  private readonly employeeRepo = new EmployeeRepository();
  private readonly departmentRepo = new DepartmentRepository();
  private readonly roleRepo = new RoleRepository();
  private readonly sessionRepo = new SessionRepository();
  private readonly auditRepo = new AuditRepository();

  constructor(
    private readonly pool: DatabasePool,
    private readonly authenticator: DirectoryAuthenticator,
    private readonly directoryResolver: DirectoryIdentityResolver,
    private readonly localOperatorPort: LocalOperatorPort,
  ) {}

  async login(input: LoginInput): Promise<Result<LoginOutput>> {
    // 1. Валидация входных данных
    if (
      !input ||
      typeof input !== 'object' ||
      !input.upn ||
      typeof input.upn !== 'string' ||
      input.upn.trim() === '' ||
      !input.password ||
      typeof input.password !== 'string'
    ) {
      return fail({
        code: 'VALIDATION_FAILED',
        message: 'Необходимо указать имя пользователя и пароль',
        retryable: false,
      });
    }

    // 2. Аутентификация через службу каталога (LDAP/AD)
    const authResult = await this.authenticator.authenticate(input.upn, input.password);
    if (!authResult.ok) {
      return fail(authResult.error);
    }

    const ldapUser = authResult.value;
    if (!ldapUser.directoryId || !ldapUser.objectGuid || !ldapUser.upn) {
      return fail({
        code: 'DEPENDENCY_UNAVAILABLE',
        message: 'Некорректный ответ службы каталога',
        retryable: true,
      });
    }

    // 3. Предварительная проверка блокировки учетной записи
    const existing = await this.employeeRepo.findByDirectoryGuid(
      this.pool,
      ldapUser.directoryId,
      ldapUser.objectGuid,
    );

    if (existing && existing.status === 'BLOCKED') {
      // Преднамеренная запись аудита блокировки входа (FR-006, план 3.7)
      try {
        await this.auditRepo.insert(this.pool, {
          id: crypto.randomUUID(),
          subjectId: existing.id,
          action: 'LOGIN_BLOCKED',
          objectType: 'employee',
          objectId: existing.id,
          result: 'FAILURE',
          details: { upn: input.upn },
        });
      } catch {
        // Ошибка аудита не должна маскировать отказ входа заблокированного сотрудника
      }

      return fail({
        code: 'FORBIDDEN',
        message: 'Учетная запись сотрудника заблокирована',
        retryable: false,
      });
    }

    // 4. Транзакция создания/поиска сотрудника, создания сессии и записи аудита
    try {
      return await this.pool.withTransaction(async (client) => {
        // Конкурентно-безопасный get-or-create по (directory_id, object_guid)
        const employee = await this.employeeRepo.getOrCreateByDirectoryGuid(client, {
          directoryId: ldapUser.directoryId,
          objectGuid: ldapUser.objectGuid,
          upn: ldapUser.upn,
          displayName: ldapUser.displayName,
          status: 'PENDING',
        });

        if (employee.status === 'BLOCKED') {
          throw new TransactionAbortError({
            code: 'FORBIDDEN',
            message: 'Учетная запись сотрудника заблокирована',
            retryable: false,
          });
        }

        const roleIds = await this.employeeRepo.getRolesForEmployee(client, employee.id);
        const permissions = await this.roleRepo.getPermissionsForRoles(client, roleIds);

        // Генерация криптографически стойкого секрета сессии (256 бит)
        const credentialBytes = crypto.randomBytes(32);
        const credentialValue = credentialBytes.toString('hex');
        const credentialHash = hashCredential(credentialValue);
        const sessionId = crypto.randomUUID();

        // Сроки сессии: 8 часов абсолютный, 30 минут бездействия (утвержденный baseline)
        const now = new Date();
        const expiresAt = new Date(now.getTime() + 8 * 60 * 60 * 1000);
        const idleExpiresAt = new Date(now.getTime() + 30 * 60 * 1000);

        await this.sessionRepo.create(client, {
          id: sessionId,
          employeeId: employee.id,
          credentialHash,
          formatVersion: 2,
          expiresAt,
          idleExpiresAt,
        });

        // Запись аудита успешного входа в той же транзакции (FR-027)
        // objectId фиксирует публичный sessionId, никогда не credential или hash
        await this.auditRepo.insert(client, {
          id: crypto.randomUUID(),
          subjectId: employee.id,
          action: 'LOGIN',
          objectType: 'employee',
          objectId: employee.id,
          result: 'SUCCESS',
          details: {
            upn: employee.upn,
            sessionId,
          },
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

        return ok({
          session: sessionContext,
          credential: { value: credentialValue },
        });
      });
    } catch (err) {
      if (err instanceof TransactionAbortError) {
        return fail(err.appError);
      }
      return fail({
        code: 'DEPENDENCY_UNAVAILABLE',
        message: 'Ошибка базы данных при входе в систему',
        retryable: true,
      });
    }
  }

  async bootstrap(input: BootstrapInput): Promise<Result<BootstrapOutput>> {
    // 1. Проверка портов
    if (!this.localOperatorPort || !this.directoryResolver) {
      return fail({
        code: 'DEPENDENCY_UNAVAILABLE',
        message: 'Необходимые порты оператора или службы каталога не предоставлены',
        retryable: false,
      });
    }

    // 2. Валидация входных параметров
    if (
      !input ||
      typeof input !== 'object' ||
      !input.upn ||
      typeof input.upn !== 'string' ||
      input.upn.trim() === '' ||
      !input.initialDepartmentId ||
      typeof input.initialDepartmentId !== 'string' ||
      input.initialDepartmentId.trim() === ''
    ) {
      return fail({
        code: 'VALIDATION_FAILED',
        message: 'Неполные параметры для процедуры bootstrap',
        retryable: false,
      });
    }

    // 3. Подтверждение оператора и права platform.bootstrap через внедряемый порт
    const opResult = await this.localOperatorPort.resolveOperator();
    if (!opResult.ok) {
      return fail(opResult.error);
    }
    const operator = opResult.value;
    if (
      !operator.operatorId ||
      !Array.isArray(operator.permissions) ||
      !operator.permissions.includes('platform.bootstrap')
    ) {
      return fail({
        code: 'FORBIDDEN',
        message: 'У локального оператора отсутствует разрешение platform.bootstrap',
        retryable: false,
      });
    }

    // 4. Подтверждение AD-личности через внедряемый порт службы каталога
    const dirResult = await this.directoryResolver.resolveByUpn(input.upn);
    if (!dirResult.ok) {
      return fail(dirResult.error);
    }
    const ldapIdentity = dirResult.value;
    if (!ldapIdentity.directoryId || !ldapIdentity.objectGuid || !ldapIdentity.upn) {
      return fail({
        code: 'DEPENDENCY_UNAVAILABLE',
        message: 'Некорректный ответ службы каталога при проверке AD-личности',
        retryable: true,
      });
    }

    // 5. Транзакция bootstrap под общим singleton-барьером
    try {
      return await this.pool.withTransaction(async (client) => {
        // Захватываем singleton-барьер и проверяем состояние
        const stateRes = await client.query<{ id: number; status: string }>(
          'SELECT id, status FROM ems_core.bootstrap_state WHERE id = 1 FOR UPDATE',
        );
        if (stateRes.rows.length === 0) {
          throw new TransactionAbortError({
            code: 'DEPENDENCY_UNAVAILABLE',
            message: 'Состояние bootstrap_state не инициализировано',
            retryable: false,
          });
        }

        const currentState = stateRes.rows[0]?.status;
        if (currentState !== 'ready') {
          throw new TransactionAbortError({
            code: 'CONFLICT',
            message: `Процедура bootstrap недоступна. Текущее состояние: '${currentState}' (FR-012)`,
            retryable: false,
          });
        }

        const existingAdmins = await this.employeeRepo.countActiveAdmins(client, ADMIN_ROLE_ID);
        if (existingAdmins > 0) {
          throw new TransactionAbortError({
            code: 'CONFLICT',
            message: 'Система уже инициализирована. Повторный bootstrap запрещен (FR-012)',
            retryable: false,
          });
        }

        // Проверяем статус существующей записи AD-личности (если уже есть)
        const existingEmployee = await this.employeeRepo.findByDirectoryGuid(
          client,
          ldapIdentity.directoryId,
          ldapIdentity.objectGuid,
        );

        if (existingEmployee && existingEmployee.status === 'BLOCKED') {
          throw new TransactionAbortError({
            code: 'FORBIDDEN',
            message: 'Заблокированная учетная запись не может быть инициализирована через bootstrap (FR-006)',
            retryable: false,
          });
        }

        // Создаем или получаем отдел
        let dept = await this.departmentRepo.findById(client, input.initialDepartmentId);
        if (!dept) {
          dept = await this.departmentRepo.create(client, {
            id: input.initialDepartmentId,
            name: 'Администрация платформы',
            code: 'PLATFORM_ADMIN',
          });
        }

        // Создаем или получаем системную роль администратора
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
            ['platform.admin', 'platform.bootstrap', 'audit.view', 'employees.manage', 'modules.manage'],
          );
        }

        // Создаем или назначаем сотрудника
        let employee: import('../persistence/employee.repository.js').EmployeeRow;
        if (!existingEmployee) {
          employee = await this.employeeRepo.create(
            client,
            {
              id: crypto.randomUUID(),
              directoryId: ldapIdentity.directoryId,
              objectGuid: ldapIdentity.objectGuid,
              upn: ldapIdentity.upn,
              displayName: ldapIdentity.displayName,
              status: 'ACTIVE',
              departmentId: dept.id,
            },
            [ADMIN_ROLE_ID],
          );
        } else {
          const updated = await this.employeeRepo.updateAssignment(
            client,
            existingEmployee.id,
            dept.id,
            [ADMIN_ROLE_ID],
          );
          employee = updated ?? existingEmployee;
        }

        // Переводим bootstrap_state в completed
        await client.query(
          "UPDATE ems_core.bootstrap_state SET status = 'completed', updated_at = NOW() WHERE id = 1",
        );

        // Запись аудита bootstrap с actor из проверенного порта оператора (FR-010, FR-026)
        await this.auditRepo.insert(client, {
          id: crypto.randomUUID(),
          subjectId: operator.operatorId,
          action: 'BOOTSTRAP',
          objectType: 'employee',
          objectId: employee.id,
          result: 'SUCCESS',
          details: {
            upn: ldapIdentity.upn,
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
    } catch (err) {
      if (err instanceof TransactionAbortError) {
        return fail(err.appError);
      }
      return fail({
        code: 'DEPENDENCY_UNAVAILABLE',
        message: 'Ошибка базы данных при процедуре bootstrap',
        retryable: true,
      });
    }
  }
}
