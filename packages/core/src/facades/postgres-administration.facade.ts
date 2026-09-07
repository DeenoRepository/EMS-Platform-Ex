import crypto from 'node:crypto';
import type {
  AdministrationFacade,
  AssignEmployeeInput,
  AssignEmployeeOutput,
  SetModuleAvailabilityInput,
  SetModuleAvailabilityOutput,
  Result,
  AppError,
} from '@ems/contracts';
import { ok, fail } from '@ems/contracts';
import type { DatabasePool } from '../persistence/db.js';
import { EmployeeRepository } from '../persistence/employee.repository.js';
import { DepartmentRepository } from '../persistence/department.repository.js';
import { SessionRepository } from '../persistence/session.repository.js';
import { AuditRepository } from '../persistence/audit.repository.js';
import { ModuleAvailabilityRepository } from '../persistence/module-availability.repository.js';
import { RoleRepository } from '../persistence/role.repository.js';
import { ADMIN_ROLE_ID } from './postgres-identity.facade.js';
import { verifySubjectCredential, isValidCredentialFormat } from './subject-auth.js';

class TransactionAbortError extends Error {
  constructor(public readonly appError: AppError) {
    super(appError.message);
    this.name = 'TransactionAbortError';
  }
}

export class PostgresAdministrationFacade implements AdministrationFacade {
  private readonly employeeRepo = new EmployeeRepository();
  private readonly departmentRepo = new DepartmentRepository();
  private readonly sessionRepo = new SessionRepository();
  private readonly auditRepo = new AuditRepository();
  private readonly moduleAvailabilityRepo = new ModuleAvailabilityRepository();
  private readonly roleRepo = new RoleRepository();

  constructor(private readonly pool: DatabasePool) {}

  async assignEmployee(input: AssignEmployeeInput): Promise<Result<AssignEmployeeOutput>> {
    // 1. Runtime-валидация входных данных до транзакции
    if (!input || typeof input !== 'object') {
      return fail({
        code: 'VALIDATION_FAILED',
        message: 'Некорректный запрос назначения сотрудника',
        retryable: false,
      });
    }

    if (!input.actorCredential || !isValidCredentialFormat(input.actorCredential.value)) {
      return fail({
        code: 'UNAUTHENTICATED',
        message: 'Недействительные учетные данные оператора',
        retryable: false,
      });
    }

    if (!input.employeeId || typeof input.employeeId !== 'string' || input.employeeId.trim() === '') {
      return fail({
        code: 'VALIDATION_FAILED',
        message: 'Идентификатор сотрудника обязателен',
        retryable: false,
      });
    }

    if (!input.departmentId || typeof input.departmentId !== 'string' || input.departmentId.trim() === '') {
      return fail({
        code: 'VALIDATION_FAILED',
        message: 'Идентификатор отдела обязателен',
        retryable: false,
      });
    }

    if (!Array.isArray(input.roleIds) || input.roleIds.some((r) => typeof r !== 'string' || r.trim() === '')) {
      return fail({
        code: 'VALIDATION_FAILED',
        message: 'Список ролей должен содержать непустые строки',
        retryable: false,
      });
    }

    // Проверка дубликатов в roleIds
    const uniqueRoleIds = Array.from(new Set(input.roleIds));
    if (uniqueRoleIds.length !== input.roleIds.length) {
      return fail({
        code: 'VALIDATION_FAILED',
        message: 'Список ролей содержит дубликаты',
        retryable: false,
      });
    }

    if (
      input.expectedVersion === undefined ||
      typeof input.expectedVersion !== 'number' ||
      !Number.isInteger(input.expectedVersion) ||
      input.expectedVersion < 0
    ) {
      return fail({
        code: 'VALIDATION_FAILED',
        message: 'Параметр expectedVersion обязателен и должен быть неотрицательным целым числом',
        retryable: false,
      });
    }

    try {
      return await this.pool.withTransaction(async (client) => {
        // 2. Получение singleton-lock до чтения сессии, прав и назначения (FR-019, FR-021)
        const lockRes = await client.query(
          'SELECT id, status FROM ems_core.bootstrap_state WHERE id = 1 FOR UPDATE',
        );
        if (lockRes.rows.length === 0) {
          throw new TransactionAbortError({
            code: 'DEPENDENCY_UNAVAILABLE',
            message: 'Системное состояние bootstrap_state не инициализировано',
            retryable: false,
          });
        }

        // 3. Lock the target row before reading its roles or changing assignment.
        const authRes = await verifySubjectCredential(client, input.actorCredential, {
          requireActive: true,
          requireDepartment: true,
        });
        if (!authRes.ok) {
          throw new TransactionAbortError(authRes.error);
        }

        const { employee: actor, permissions: actorPermissions, roleIds: actorRoleIds } = authRes.value;

        if (!actorPermissions.includes('employees.manage')) {
          throw new TransactionAbortError({
            code: 'FORBIDDEN',
            message: 'Недостаточно прав для назначения сотрудников (требуется employees.manage)',
            retryable: false,
          });
        }

        // 4. Поиск целевого сотрудника
        const lockedTarget = await this.employeeRepo.findByIdForUpdate(client, input.employeeId);
        if (!lockedTarget) {
          throw new TransactionAbortError({
            code: 'NOT_FOUND_OR_FORBIDDEN', message: 'Сотрудник не найден', retryable: false,
          });
        }

        // 5. Проверка существования целевого отдела
        const targetDept = await this.departmentRepo.findById(client, input.departmentId);
        if (!targetDept) {
          throw new TransactionAbortError({
            code: 'VALIDATION_FAILED',
            message: `Целевой отдел '${input.departmentId}' не существует`,
            retryable: false,
          });
        }

        // 6. Проверка существования всех назначаемых ролей в БД
        for (const roleId of uniqueRoleIds) {
          const role = await this.roleRepo.findById(client, roleId);
          if (!role) {
            throw new TransactionAbortError({
              code: 'VALIDATION_FAILED',
              message: `Роль '${roleId}' не существует в системе`,
              retryable: false,
            });
          }
        }

        // 7. Проверка прав на манипуляцию ролью администратора (FR-019)
        const currentRoles = await this.employeeRepo.getRolesForEmployee(client, lockedTarget.id);
        const wasAdmin = currentRoles.includes(ADMIN_ROLE_ID);
        const willBeAdmin = uniqueRoleIds.includes(ADMIN_ROLE_ID);

        if ((!wasAdmin && willBeAdmin) || (wasAdmin && !willBeAdmin)) {
          // Добавление или снятие роли platform.admin требует обладания этой ролью
          if (!actorRoleIds.includes(ADMIN_ROLE_ID)) {
            throw new TransactionAbortError({
              code: 'FORBIDDEN',
              message: 'Назначение или отзыв роли администратора платформы требует владения этой ролью',
              retryable: false,
            });
          }
        }

        // Защита от снятия роли у последнего активного администратора (FR-019)
        if (wasAdmin && !willBeAdmin) {
          const adminCount = await this.employeeRepo.countActiveAdmins(client, ADMIN_ROLE_ID);
          if (adminCount <= 1 && lockedTarget.status === 'ACTIVE') {
            throw new TransactionAbortError({
              code: 'CONFLICT',
              message: 'Нельзя отозвать административную роль у последнего активного администратора системы (FR-019)',
              retryable: false,
            });
          }
        }

        // 8. Проверка версии целевого сотрудника
        if (lockedTarget.version !== input.expectedVersion) {
          throw new TransactionAbortError({
            code: 'CONFLICT',
            message: `Конфликт параллельного изменения данных сотрудника: ожидалась версия ${input.expectedVersion}, текущая ${lockedTarget.version}`,
            retryable: true,
          });
        }

        // 9. Атомарное обновление назначения
        const updated = await this.employeeRepo.updateAssignment(
          client,
          input.employeeId,
          input.departmentId,
          uniqueRoleIds,
          input.expectedVersion,
        );

        if (!updated) {
          throw new TransactionAbortError({
            code: 'CONFLICT',
            message: 'Конфликт параллельного изменения данных сотрудника (несовпадение expectedVersion)',
            retryable: true,
          });
        }

        // 10. Отзыв всех существующих сессий переведенного сотрудника (FR-020)
        const revokedCount = await this.sessionRepo.revokeAllForEmployee(
          client,
          lockedTarget.id,
          'ASSIGNMENT_TRANSFERRED',
        );

        // 11. Запись аудита перевода с сохранением исторического контекста
        await this.auditRepo.insert(client, {
          id: crypto.randomUUID(),
          subjectId: actor.id,
          action: 'ASSIGN_EMPLOYEE',
          objectType: 'employee',
          objectId: lockedTarget.id,
          result: 'SUCCESS',
          details: {
            previousDepartmentId: lockedTarget.department_id,
            newDepartmentId: input.departmentId,
            previousRoleIds: currentRoles,
            newRoleIds: uniqueRoleIds,
            revokedSessionsCount: revokedCount,
            newVersion: updated.version,
          },
        });

        return ok({
          employeeId: updated.id,
          departmentId: updated.department_id!,
          roleIds: uniqueRoleIds,
          version: updated.version,
        });
      });
    } catch (err) {
      if (err instanceof TransactionAbortError) {
        return fail(err.appError);
      }
      return fail({
        code: 'DEPENDENCY_UNAVAILABLE',
        message: 'Ошибка базы данных при назначении сотрудника',
        retryable: true,
      });
    }
  }

  async setModuleAvailability(
    input: SetModuleAvailabilityInput,
  ): Promise<Result<SetModuleAvailabilityOutput>> {
    // 1. Runtime-валидация
    if (!input || typeof input !== 'object') {
      return fail({
        code: 'VALIDATION_FAILED',
        message: 'Некорректный запрос изменения доступности модуля',
        retryable: false,
      });
    }

    if (!input.actorCredential || !isValidCredentialFormat(input.actorCredential.value)) {
      return fail({
        code: 'UNAUTHENTICATED',
        message: 'Недействительные учетные данные оператора',
        retryable: false,
      });
    }

    if (!input.moduleId || typeof input.moduleId !== 'string' || input.moduleId.trim() === '') {
      return fail({
        code: 'VALIDATION_FAILED',
        message: 'Идентификатор модуля обязателен',
        retryable: false,
      });
    }

    if (!input.departmentId || typeof input.departmentId !== 'string' || input.departmentId.trim() === '') {
      return fail({
        code: 'VALIDATION_FAILED',
        message: 'Идентификатор отдела обязателен',
        retryable: false,
      });
    }

    if (typeof input.enabled !== 'boolean') {
      return fail({
        code: 'VALIDATION_FAILED',
        message: 'Параметр enabled должен быть логического типа',
        retryable: false,
      });
    }

    if (
      input.expectedVersion === undefined ||
      typeof input.expectedVersion !== 'number' ||
      !Number.isInteger(input.expectedVersion) ||
      input.expectedVersion < 0
    ) {
      return fail({
        code: 'VALIDATION_FAILED',
        message: 'Параметр expectedVersion обязателен и должен быть неотрицательным целым числом',
        retryable: false,
      });
    }

    try {
      return await this.pool.withTransaction(async (client) => {
        // Проверка прав оператора: строго 'modules.manage' (не выводить из platform.admin)
        const authRes = await verifySubjectCredential(client, input.actorCredential, {
          requireActive: true,
          requireDepartment: true,
        });
        if (!authRes.ok) {
          throw new TransactionAbortError(authRes.error);
        }

        const { employee: actor, permissions: actorPermissions } = authRes.value;

        if (!actorPermissions.includes('modules.manage')) {
          throw new TransactionAbortError({
            code: 'FORBIDDEN',
            message: 'Недостаточно прав для изменения доступности модулей (требуется modules.manage)',
            retryable: false,
          });
        }

        const dept = await this.departmentRepo.findById(client, input.departmentId);
        if (!dept) {
          throw new TransactionAbortError({
            code: 'VALIDATION_FAILED',
            message: `Отдел '${input.departmentId}' не существует`,
            retryable: false,
          });
        }

        // Compare-and-set с expectedVersion:
        // version = 0 означает INSERT при отсутствии. Если строка есть или expectedVersion != 0 — проверка версии
        const existingRow = await this.moduleAvailabilityRepo.findRow(
          client,
          input.moduleId,
          input.departmentId,
          true, // FOR UPDATE
        );

        let newVersion: number;
        if (!existingRow) {
          if (input.expectedVersion !== 0) {
            throw new TransactionAbortError({
              code: 'CONFLICT',
              message: `Запись доступности модуля отсутствует, ожидалась версия ${input.expectedVersion}`,
              retryable: true,
            });
          }

          const inserted = await this.moduleAvailabilityRepo.insertInitial(
            client,
            input.moduleId,
            input.departmentId,
            input.enabled,
          );

          if (!inserted) {
            throw new TransactionAbortError({
              code: 'CONFLICT',
              message: 'Конфликт параллельного создания настройки доступности модуля',
              retryable: true,
            });
          }
          newVersion = inserted.version;
        } else {
          if (existingRow.version !== input.expectedVersion) {
            throw new TransactionAbortError({
              code: 'CONFLICT',
              message: `Конфликт версии доступности модуля: текущая ${existingRow.version}, ожидалась ${input.expectedVersion}`,
              retryable: true,
            });
          }

          const updated = await this.moduleAvailabilityRepo.updateVersioned(
            client,
            input.moduleId,
            input.departmentId,
            input.enabled,
            input.expectedVersion,
          );

          if (!updated) {
            throw new TransactionAbortError({
              code: 'CONFLICT',
              message: 'Конфликт параллельного изменения доступности модуля',
              retryable: true,
            });
          }
          newVersion = updated.version;
        }

        // Запись аудита изменения доступности модуля
        await this.auditRepo.insert(client, {
          id: crypto.randomUUID(),
          subjectId: actor.id,
          action: 'SET_MODULE_AVAILABILITY',
          objectType: 'module_availability',
          objectId: `${input.moduleId}:${input.departmentId}`,
          result: 'SUCCESS',
          details: {
            moduleId: input.moduleId,
            departmentId: input.departmentId,
            enabled: input.enabled,
            previousVersion: input.expectedVersion,
            newVersion,
          },
        });

        return ok({
          moduleId: input.moduleId,
          departmentId: input.departmentId,
          enabled: input.enabled,
          version: newVersion,
        });
      });
    } catch (err) {
      if (err instanceof TransactionAbortError) {
        return fail(err.appError);
      }
      return fail({
        code: 'DEPENDENCY_UNAVAILABLE',
        message: 'Ошибка базы данных при изменении доступности модуля',
        retryable: true,
      });
    }
  }
}
