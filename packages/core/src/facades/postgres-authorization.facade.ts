import type {
  AuthorizationFacade,
  AuthorizeInput,
  AuthorizeOutput,
  Result,
} from '@ems/contracts';
import { ok, fail } from '@ems/contracts';
import type { DatabasePool } from '../persistence/db.js';
import { SessionRepository } from '../persistence/session.repository.js';
import { EmployeeRepository } from '../persistence/employee.repository.js';
import { RoleRepository } from '../persistence/role.repository.js';
import { ModuleAvailabilityRepository } from '../persistence/module-availability.repository.js';

export class PostgresAuthorizationFacade implements AuthorizationFacade {
  private readonly sessionRepo = new SessionRepository();
  private readonly employeeRepo = new EmployeeRepository();
  private readonly roleRepo = new RoleRepository();
  private readonly moduleAvailabilityRepo = new ModuleAvailabilityRepository();

  constructor(private readonly pool: DatabasePool) {}

  async authorize(input: AuthorizeInput): Promise<Result<AuthorizeOutput>> {
    const { sessionContext, permission, moduleId } = input;

    // Читаем актуальное состояние из БД PostgreSQL, а не доверяем клиентским утверждениям (FR-016, NFR-003)
    const session = await this.sessionRepo.findActiveById(this.pool, sessionContext.sessionId);
    if (!session) {
      return fail({
        code: 'UNAUTHENTICATED',
        message: 'Сессия не найдена, истекла или была отозвана',
        retryable: false,
      });
    }

    const employee = await this.employeeRepo.findById(this.pool, session.employee_id);
    if (!employee) {
      return fail({
        code: 'UNAUTHENTICATED',
        message: 'Сотрудник сессии не найден',
        retryable: false,
      });
    }

    if (employee.status !== 'ACTIVE') {
      return ok({
        allowed: false,
        reason: `Сотрудник находится в статусе '${employee.status}', защищенные операции запрещены (FR-005, FR-006)`,
      });
    }

    if (!employee.department_id) {
      return ok({
        allowed: false,
        reason: 'У сотрудника не назначен активный отдел',
      });
    }

    // Проверка доступности модуля отделу сотрудника (FR-016)
    if (moduleId) {
      const isAvailable = await this.moduleAvailabilityRepo.isModuleAvailable(
        this.pool,
        moduleId,
        employee.department_id,
      );
      if (!isAvailable) {
        return ok({
          allowed: false,
          reason: `Модуль '${moduleId}' недоступен для отдела сотрудника (FR-016)`,
        });
      }
    }

    // Проверка наличия разрешения у назначенных ролей
    const roleIds = await this.employeeRepo.getRolesForEmployee(this.pool, employee.id);
    const permissions = await this.roleRepo.getPermissionsForRoles(this.pool, roleIds);

    if (!permissions.includes(permission)) {
      return ok({
        allowed: false,
        reason: `Отсутствует требуемое разрешение '${permission}'`,
      });
    }

    return ok({ allowed: true });
  }
}
