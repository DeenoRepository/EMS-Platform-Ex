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

export class PostgresAuditFacade implements AuditFacade {
  private readonly auditRepo = new AuditRepository();

  constructor(private readonly pool: DatabasePool) {}

  async query(input: AuditQueryInput): Promise<Result<AuditQueryOutput>> {
    const { items, nextCursor } = await this.auditRepo.query(this.pool, {
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
      action: input.action,
      subjectId: input.subjectId,
      cursor: input.cursor,
      limit: input.limit,
    });

    // Аудит самого факта просмотра журнала аудита (FR-030)
    try {
      await this.auditRepo.insert(this.pool, {
        id: crypto.randomUUID(),
        subjectId: input.subjectId ?? 'unknown-viewer',
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
