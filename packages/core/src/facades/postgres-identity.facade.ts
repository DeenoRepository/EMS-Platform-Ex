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
  DirectoryIdentity,
  LocalOperatorPort,
  LocalOperatorIdentity,
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
import { dependencyFailure, normalizeDependencyResult, isNonEmptyString } from './errors.js';

export const ADMIN_ROLE_ID = 'role.platform.admin';

class TransactionAbortError extends Error {
  constructor(public readonly appError: AppError) {
    super(appError.message);
    this.name = 'TransactionAbortError';
  }
}

class BlockedLoginError extends TransactionAbortError {}

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
    let authResult: Awaited<ReturnType<DirectoryAuthenticator['authenticate']>>;
    try {
      authResult = await this.authenticator.authenticate(input.upn, input.password);
    } catch {
      return fail(dependencyFailure('Служба каталога недоступна', true));
    }
    const safeAuthResult = normalizeDependencyResult<DirectoryIdentity>(
      authResult, 'Служба каталога вернула некорректный ответ',
    );
    if (!safeAuthResult.ok) return fail(safeAuthResult.error);

    const ldapUser = safeAuthResult.value;
    if (!isDirectoryIdentity(ldapUser)) {
      return fail({
        code: 'DEPENDENCY_UNAVAILABLE',
        message: 'Некорректный ответ службы каталога',
        retryable: true,
      });
    }

    // 3. Транзакция создания/поиска сотрудника, создания сессии и записи аудита
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
          throw new BlockedLoginError({
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
        if (err instanceof BlockedLoginError) {
          await this.recordBlockedLoginAudit(ldapUser).catch(() => undefined);
        }
        return fail(err.appError);
      }
      return fail({
        code: 'DEPENDENCY_UNAVAILABLE',
        message: 'Ошибка базы данных при входе в систему',
        retryable: true,
      });
    }
  }

  private async recordBlockedLoginAudit(identity: DirectoryIdentity): Promise<void> {
    await this.pool.withTransaction(async (client) => {
      const employee = await this.employeeRepo.findByDirectoryGuid(client, identity.directoryId, identity.objectGuid);
      if (!employee || employee.status !== 'BLOCKED') return;
      await this.auditRepo.insert(client, {
        id: crypto.randomUUID(),
        subjectId: employee.id,
        action: 'LOGIN_BLOCKED',
        objectType: 'employee',
        objectId: employee.id,
        result: 'FAILURE',
      });
    });
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
    let opResult: Awaited<ReturnType<LocalOperatorPort['resolveOperator']>>;
    try {
      opResult = await this.localOperatorPort.resolveOperator();
    } catch {
      return fail(dependencyFailure('Локальный оператор недоступен', true));
    }
    const safeOperatorResult = normalizeDependencyResult(opResult, 'Локальный оператор вернул некорректный ответ');
    if (!safeOperatorResult.ok) return fail(safeOperatorResult.error);
    const operator = safeOperatorResult.value;
    if (
      !isLocalOperatorIdentity(operator) ||
      !Array.isArray(operator.permissions) ||
      operator.permissions.some((permission) => typeof permission !== 'string') ||
      !operator.permissions.includes('platform.bootstrap')
    ) {
      return fail({
        code: 'FORBIDDEN',
        message: 'У локального оператора отсутствует разрешение platform.bootstrap',
        retryable: false,
      });
    }

    // 4. Подтверждение AD-личности через внедряемый порт службы каталога
    let dirResult: Awaited<ReturnType<DirectoryIdentityResolver['resolveByUpn']>>;
    try {
      dirResult = await this.directoryResolver.resolveByUpn(input.upn);
    } catch {
      return fail(dependencyFailure('Служба каталога недоступна', true));
    }
    const safeDirResult = normalizeDependencyResult(dirResult, 'Служба каталога вернула некорректный ответ');
    if (!safeDirResult.ok) return fail(safeDirResult.error);
    const ldapIdentity = safeDirResult.value;
    if (!isDirectoryIdentity(ldapIdentity)) {
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
        const existingEmployee = await this.employeeRepo.findByDirectoryGuidForUpdate(
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
          employee = await this.employeeRepo.getOrCreateByDirectoryGuid(client, {
            directoryId: ldapIdentity.directoryId,
            objectGuid: ldapIdentity.objectGuid,
            upn: ldapIdentity.upn,
            displayName: ldapIdentity.displayName,
            status: 'ACTIVE',
            departmentId: dept.id,
          });
          const assigned = await this.employeeRepo.updateAssignment(
            client, employee.id, dept.id, [ADMIN_ROLE_ID], employee.version,
          );
          employee = assigned ?? employee;
        } else {
          const updated = await this.employeeRepo.updateAssignment(
            client,
            existingEmployee.id,
            dept.id,
            [ADMIN_ROLE_ID],
          );
          employee = updated ?? existingEmployee;
        }

        await this.sessionRepo.revokeAllForEmployee(client, employee.id, 'BOOTSTRAP_COMPLETED');

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

function isDirectoryIdentity(value: unknown): value is DirectoryIdentity {
  return Boolean(value) && typeof value === 'object' &&
    isNonEmptyString((value as DirectoryIdentity).directoryId) &&
    isNonEmptyString((value as DirectoryIdentity).objectGuid) &&
    isNonEmptyString((value as DirectoryIdentity).upn) &&
    isNonEmptyString((value as DirectoryIdentity).displayName);
}

function isLocalOperatorIdentity(value: unknown): value is LocalOperatorIdentity {
  return Boolean(value) && typeof value === 'object' &&
    isNonEmptyString((value as LocalOperatorIdentity).operatorId) &&
    Array.isArray((value as LocalOperatorIdentity).permissions) &&
    (value as LocalOperatorIdentity).permissions.every((permission) => typeof permission === 'string');
}
