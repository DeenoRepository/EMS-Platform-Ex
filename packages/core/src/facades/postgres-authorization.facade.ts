import type {
  AuthorizationFacade,
  AuthorizeInput,
  AuthorizeOutput,
  Result,
} from '@ems/contracts';
import { ok, fail } from '@ems/contracts';
import type { DatabasePool } from '../persistence/db.js';
import { ModuleAvailabilityRepository } from '../persistence/module-availability.repository.js';
import { verifySubjectCredential } from './subject-auth.js';
import { dependencyFailure } from './errors.js';

export class PostgresAuthorizationFacade implements AuthorizationFacade {
  private readonly moduleAvailabilityRepo = new ModuleAvailabilityRepository();

  constructor(private readonly pool: DatabasePool) {}

  async authorize(input: AuthorizeInput): Promise<Result<AuthorizeOutput>> {
    if (!input || typeof input !== 'object') {
      return fail({
        code: 'VALIDATION_FAILED',
        message: 'Некорректный запрос авторизации',
        retryable: false,
      });
    }

    const { credential, permission, moduleId, resourceScope } = input;

    if (!permission || typeof permission !== 'string' || permission.trim() === '') {
      return fail({
        code: 'VALIDATION_FAILED',
        message: 'Разрешение должно быть непустой строкой',
        retryable: false,
      });
    }

    if (resourceScope !== undefined) {
      return ok({ allowed: false, reason: `Область ресурса '${resourceScope}' не поддерживается` });
    }

    if (moduleId !== undefined && (typeof moduleId !== 'string' || moduleId.trim() === '')) {
      return fail({
        code: 'VALIDATION_FAILED',
        message: 'Идентификатор модуля должен быть непустой строкой',
        retryable: false,
      });
    }

    let authRes: Awaited<ReturnType<typeof verifySubjectCredential>>;
    try {
      authRes = await verifySubjectCredential(this.pool, credential);
    } catch {
      return fail(dependencyFailure('Ошибка базы данных при проверке авторизации'));
    }
    if (!authRes.ok) {
      return fail(authRes.error);
    }

    const { employee, permissions } = authRes.value;

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
      let isAvailable: boolean;
      try {
        isAvailable = await this.moduleAvailabilityRepo.isModuleAvailable(
          this.pool,
          moduleId,
          employee.department_id,
        );
      } catch {
        return fail(dependencyFailure('Ошибка базы данных при проверке доступности модуля'));
      }
      if (!isAvailable) {
        return ok({
          allowed: false,
          reason: `Модуль '${moduleId}' недоступен для отдела сотрудника (FR-016)`,
        });
      }
    }

    // Проверка наличия разрешения у назначенных ролей
    if (!permissions.includes(permission)) {
      return ok({
        allowed: false,
        reason: `Отсутствует требуемое разрешение '${permission}'`,
      });
    }

    return ok({ allowed: true });
  }
}
