import crypto from 'node:crypto';
import type {
  AuditFacade,
  AuditQueryInput,
  AuditQueryOutput,
  AuditRecord,
  Result,
} from '@ems/contracts';
import { ok } from '@ems/contracts';
import type { DatabasePool } from '../persistence/db.js';
import { AuditRepository } from '../persistence/audit.repository.js';
import { SessionRepository } from '../persistence/session.repository.js';
import { EmployeeRepository } from '../persistence/employee.repository.js';
import { RoleRepository } from '../persistence/role.repository.js';

export class PostgresAuditFacade implements AuditFacade {
  private readonly auditRepo = new AuditRepository();
  private readonly sessionRepo = new SessionRepository();
  private readonly employeeRepo = new EmployeeRepository();
  private readonly roleRepo = new RoleRepository();

  constructor(private readonly pool: DatabasePool) {}

  async query(input: AuditQueryInput): Promise<Result<AuditQueryOutput>> {
    if (!input.actorCredential.value) {
      return { ok: false, error: { code: 'VALIDATION_FAILED', message: 'Идентификатор сессии обязателен', retryable: false } };
    }
    const actor = await this.sessionRepo.findActiveById(this.pool, input.actorCredential.value);
    if (!actor) return { ok: false, error: { code: 'UNAUTHENTICATED', message: 'Сессия оператора недействительна', retryable: false } };
    const actorRoles = await this.employeeRepo.getRolesForEmployee(this.pool, actor.employee_id);
    const actorPermissions = await this.roleRepo.getPermissionsForRoles(this.pool, actorRoles);
    if (!actorPermissions.includes('audit.view')) {
      return { ok: false, error: { code: 'FORBIDDEN', message: 'Недостаточно прав для просмотра аудита', retryable: false } };
    }
    let items: readonly import('../persistence/audit.repository.js').AuditRecordRow[];
    let nextCursor: string | undefined;
    try {
      ({ items, nextCursor } = await this.auditRepo.query(this.pool, {
        periodStart: input.periodStart,
        periodEnd: input.periodEnd,
        action: input.action,
        subjectId: input.subjectId,
        cursor: input.cursor,
        limit: input.limit,
      }));
    } catch {
      return { ok: false, error: { code: 'VALIDATION_FAILED', message: 'Недопустимые параметры запроса аудита', retryable: false } };
    }

    // Аудит самого факта просмотра журнала аудита (FR-030)
    try {
      await this.auditRepo.insert(this.pool, {
        id: crypto.randomUUID(),
        subjectId: actor.employee_id,
        action: 'AUDIT_QUERY_VIEWED',
        objectType: 'audit_log',
        objectId: 'query',
        result: 'SUCCESS',
        details: {
          periodStart: input.periodStart,
          periodEnd: input.periodEnd,
          filterAction: input.action,
          returnedCount: items.length,
        },
      });
    } catch {
      // Ошибка аудита просмотра не блокирует возврат прочитанных данных
    }

    const records: AuditRecord[] = items.map((row) => ({
      id: row.id,
      timestamp: row.timestamp,
      subjectId: row.subject_id,
      action: row.action,
      objectType: row.object_type,
      objectId: row.object_id,
      result: row.result,
      correlationId: row.correlation_id ?? undefined,
      details: row.details ?? undefined,
    }));

    return ok({
      items: records,
      nextCursor,
    });
  }
}
