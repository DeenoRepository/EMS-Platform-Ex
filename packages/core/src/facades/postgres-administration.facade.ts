import crypto from 'node:crypto';
import type {
  AdministrationFacade,
  AssignEmployeeInput,
  AssignEmployeeOutput,
  SetModuleAvailabilityInput,
  SetModuleAvailabilityOutput,
  Result,
} from '@ems/contracts';
import { ok, fail } from '@ems/contracts';
import type { DatabasePool } from '../persistence/db.js';
import { EmployeeRepository } from '../persistence/employee.repository.js';
import { DepartmentRepository } from '../persistence/department.repository.js';
import { SessionRepository } from '../persistence/session.repository.js';
import { AuditRepository } from '../persistence/audit.repository.js';
import { ModuleAvailabilityRepository } from '../persistence/module-availability.repository.js';
import { ADMIN_ROLE_ID } from './postgres-identity.facade.js';

export class PostgresAdministrationFacade implements AdministrationFacade {
  private readonly employeeRepo = new EmployeeRepository();
  private readonly departmentRepo = new DepartmentRepository();
  private readonly sessionRepo = new SessionRepository();
  private readonly auditRepo = new AuditRepository();
  private readonly moduleAvailabilityRepo = new ModuleAvailabilityRepository();

  constructor(private readonly pool: DatabasePool) {}

  async assignEmployee(input: AssignEmployeeInput): Promise<Result<AssignEmployeeOutput>> {
    return await this.pool.withTransaction(async (client) => {
      const employee = await this.employeeRepo.findById(client, input.employeeId);
      if (!employee) {
        return fail({
          code: 'NOT_FOUND_OR_FORBIDDEN',
          message: 'Сотрудник не найден',
          retryable: false,
        });
      }

      const targetDept = await this.departmentRepo.findById(client, input.departmentId);
      if (!targetDept) {
        return fail({
          code: 'VALIDATION_FAILED',
          message: `Целевой отдел '${input.departmentId}' не существует`,
          retryable: false,
        });
      }

      // Проверка last-admin invariant (FR-019): если сотрудник был администратором, а в новых ролях роли админа нет
      const currentRoles = await this.employeeRepo.getRolesForEmployee(client, employee.id);
      const isCurrentlyAdmin = currentRoles.includes(ADMIN_ROLE_ID);
      const willBeAdmin = input.roleIds.includes(ADMIN_ROLE_ID);

      if (isCurrentlyAdmin && !willBeAdmin) {
        const adminCount = await this.employeeRepo.countActiveAdmins(client, ADMIN_ROLE_ID);
        if (adminCount <= 1) {
          return fail({
            code: 'CONFLICT',
            message: 'Нельзя отозвать административную роль у последнего активного администратора системы (FR-019)',
            retryable: false,
          });
        }
      }

      // Атомарное обновление назначения с проверкой версии (optimistic lock)
      const updated = await this.employeeRepo.updateAssignment(
        client,
        input.employeeId,
        input.departmentId,
        input.roleIds,
        input.expectedVersion,
      );

      if (!updated) {
        return fail({
          code: 'CONFLICT',
          message: 'Конфликт параллельного изменения данных сотрудника (несовпадение expectedVersion)',
          retryable: true,
        });
      }

      // Немедленный отзыв всех существующих сессий переведенного сотрудника (FR-020)
      const revokedCount = await this.sessionRepo.revokeAllForEmployee(
        client,
        employee.id,
        'ASSIGNMENT_TRANSFERRED',
      );

      // Запись аудита перевода с сохранением исторического контекста (FR-020, FR-026)
      await this.auditRepo.insert(client, {
        id: crypto.randomUUID(),
        subjectId: 'admin-action', // или контекстный оператор
        action: 'ASSIGN_EMPLOYEE',
        objectType: 'employee',
        objectId: employee.id,
        result: 'SUCCESS',
        details: {
          previousDepartmentId: employee.department_id,
          newDepartmentId: input.departmentId,
          previousRoleIds: currentRoles,
          newRoleIds: input.roleIds,
          revokedSessionsCount: revokedCount,
          newVersion: updated.version,
        },
      });

      return ok({
        employeeId: updated.id,
        departmentId: updated.department_id!,
        roleIds: input.roleIds,
        version: updated.version,
      });
    });
  }

  async setModuleAvailability(
    input: SetModuleAvailabilityInput,
  ): Promise<Result<SetModuleAvailabilityOutput>> {
    return await this.pool.withTransaction(async (client) => {
      const dept = await this.departmentRepo.findById(client, input.departmentId);
      if (!dept) {
        return fail({
          code: 'VALIDATION_FAILED',
          message: `Отдел '${input.departmentId}' не существует`,
          retryable: false,
        });
      }

      const res = await this.moduleAvailabilityRepo.setAvailability(
        client,
        input.moduleId,
        input.departmentId,
        input.enabled,
      );

      // Запись аудита изменения доступности модуля (FR-026)
      await this.auditRepo.insert(client, {
        id: crypto.randomUUID(),
        subjectId: 'admin-action',
        action: 'SET_MODULE_AVAILABILITY',
        objectType: 'module_availability',
        objectId: `${input.moduleId}:${input.departmentId}`,
        result: 'SUCCESS',
        details: {
          moduleId: input.moduleId,
          departmentId: input.departmentId,
          enabled: input.enabled,
        },
      });

      return ok({
        moduleId: res.module_id,
        departmentId: res.department_id,
        enabled: res.enabled,
      });
    });
  }
}
