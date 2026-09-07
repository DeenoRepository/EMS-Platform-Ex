import crypto from 'node:crypto';
import type {
  SessionFacade,
  LogoutInput,
  Result,
} from '@ems/contracts';
import { ok, fail } from '@ems/contracts';
import type { DatabasePool } from '../persistence/db.js';
import { SessionRepository } from '../persistence/session.repository.js';
import { AuditRepository } from '../persistence/audit.repository.js';
import { EmployeeRepository } from '../persistence/employee.repository.js';

export class PostgresSessionFacade implements SessionFacade {
  private readonly sessionRepo = new SessionRepository();
  private readonly auditRepo = new AuditRepository();
  private readonly employeeRepo = new EmployeeRepository();

  constructor(private readonly pool: DatabasePool) {}

  async logout(input: LogoutInput): Promise<Result<void>> {
    if (!input.sessionId) {
      return fail({
        code: 'VALIDATION_FAILED',
        message: 'Идентификатор сессии обязателен для завершения',
        retryable: false,
      });
    }

    // Отзываем сессию в БД
    const actorSession = await this.sessionRepo.findActiveById(this.pool, input.actorCredential.value);
    if (!actorSession || actorSession.id !== input.sessionId) {
      return fail({ code: 'NOT_FOUND_OR_FORBIDDEN', message: 'Сессия не найдена или не принадлежит оператору', retryable: false });
    }
    const actor = await this.employeeRepo.findById(this.pool, actorSession.employee_id);
    const revoked = await this.sessionRepo.revoke(this.pool, input.sessionId, 'USER_LOGOUT');
    if (!revoked) {
      return fail({
        code: 'NOT_FOUND_OR_FORBIDDEN',
        message: 'Активная сессия не найдена',
        retryable: false,
      });
    }

    // Запись аудита выхода (FR-028: ошибка записи аудита не должна отменять успешный отзыв сессии)
    try {
      await this.auditRepo.insert(this.pool, {
        id: crypto.randomUUID(),
        subjectId: actor?.id ?? actorSession.employee_id,
        action: 'LOGOUT',
        objectType: 'session',
        objectId: input.sessionId,
        result: 'SUCCESS',
      });
    } catch {
      // Игнорируем ошибку аудита при выходе согласно FR-028
    }

    return ok(undefined);
  }
}
