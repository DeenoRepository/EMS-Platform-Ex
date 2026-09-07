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
import { hashCredential, isValidCredentialFormat } from './subject-auth.js';

export class PostgresSessionFacade implements SessionFacade {
  private readonly sessionRepo = new SessionRepository();
  private readonly auditRepo = new AuditRepository();

  constructor(private readonly pool: DatabasePool) {}

  async logout(input: LogoutInput): Promise<Result<void>> {
    if (!input || !input.actorCredential || !isValidCredentialFormat(input.actorCredential.value)) {
      return fail({
        code: 'UNAUTHENTICATED',
        message: 'Недействительные учетные данные сессии для завершения',
        retryable: false,
      });
    }

    const hash = hashCredential(input.actorCredential.value);

    let revokedSession: import('../persistence/session.repository.js').SessionRow | null = null;
    try {
      revokedSession = await this.sessionRepo.revokeByCredentialHash(this.pool, hash, 'USER_LOGOUT');
    } catch {
      return fail({
        code: 'DEPENDENCY_UNAVAILABLE',
        message: 'Ошибка базы данных при завершении сессии',
        retryable: true,
      });
    }

    if (!revokedSession) {
      return fail({
        code: 'UNAUTHENTICATED',
        message: 'Сессия не найдена, истекла или уже отозвана',
        retryable: false,
      });
    }

    // Запись аудита выхода (FR-028: ошибка записи аудита не должна отменять успешный отзыв сессии)
    try {
      await this.auditRepo.insert(this.pool, {
        id: crypto.randomUUID(),
        subjectId: revokedSession.employee_id,
        action: 'LOGOUT',
        objectType: 'session',
        objectId: revokedSession.id, // безопасный публичный ID сессии, никогда credential или hash
        result: 'SUCCESS',
      });
    } catch {
      // Игнорируем ошибку аудита при выходе согласно FR-028 (revoke уже зафиксирован в БД)
    }

    return ok(undefined);
  }
}
