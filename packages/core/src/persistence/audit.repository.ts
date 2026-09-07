import type { Queryable } from './db.js';

export interface AuditRecordRow {
  readonly id: string;
  readonly timestamp: string;
  readonly subject_id: string;
  readonly action: string;
  readonly object_type: string;
  readonly object_id: string;
  readonly result: 'SUCCESS' | 'FAILURE';
  readonly correlation_id: string | null;
  readonly details: Record<string, unknown> | null;
}

export interface NewAuditRecord {
  readonly id: string;
  readonly timestamp?: Date;
  readonly subjectId: string;
  readonly action: string;
  readonly objectType: string;
  readonly objectId: string;
  readonly result: 'SUCCESS' | 'FAILURE';
  readonly correlationId?: string;
  readonly details?: Record<string, unknown>;
}

export interface AuditQueryFilter {
  readonly periodStart?: string;
  readonly periodEnd?: string;
  readonly action?: string;
  readonly subjectId?: string;
  readonly cursor?: string; // base64url(JSON({ timestamp, id }))
  readonly limit?: number;
}

export class AuditRepository {
  async insert(q: Queryable, record: NewAuditRecord): Promise<void> {
    const text = `
      INSERT INTO ems_core.audit_log (
        id, timestamp, subject_id, action, object_type, object_id, result, correlation_id, details
      ) VALUES ($1, COALESCE($2, NOW()), $3, $4, $5, $6, $7, $8, $9)
    `;
    const values = [
      record.id,
      record.timestamp ? record.timestamp.toISOString() : null,
      record.subjectId,
      record.action,
      record.objectType,
      record.objectId,
      record.result,
      record.correlationId ?? null,
      record.details ? JSON.stringify(record.details) : null,
    ];
    await q.query(text, values);
  }

  async query(
    q: Queryable,
    filter: AuditQueryFilter,
  ): Promise<{ readonly items: readonly AuditRecordRow[]; readonly nextCursor?: string }> {
    const conditions: string[] = [];
    const values: any[] = [];
    let paramIndex = 1;

    if (filter.periodStart) {
      conditions.push(`timestamp >= $${paramIndex++}`);
      values.push(filter.periodStart);
    }
    if (filter.periodEnd) {
      conditions.push(`timestamp <= $${paramIndex++}`);
      values.push(filter.periodEnd);
    }
    if (filter.action) {
      conditions.push(`action = $${paramIndex++}`);
      values.push(filter.action);
    }
    if (filter.subjectId) {
      conditions.push(`subject_id = $${paramIndex++}`);
      values.push(filter.subjectId);
    }
    if (filter.cursor) {
      let cursor: { timestamp: string; id: string };
      try {
        const decoded = Buffer.from(filter.cursor, 'base64url').toString('utf8');
        const parsed: unknown = JSON.parse(decoded);
        if (
          typeof parsed !== 'object' || parsed === null ||
          typeof (parsed as { timestamp?: unknown }).timestamp !== 'string' ||
          typeof (parsed as { id?: unknown }).id !== 'string'
        ) throw new Error('invalid cursor');
        cursor = parsed as { timestamp: string; id: string };
      } catch {
        throw new Error('Invalid audit cursor');
      }
      conditions.push(`(timestamp, id) < ($${paramIndex++}, $${paramIndex++})`);
      values.push(cursor.timestamp, cursor.id);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = Math.min(Math.max(filter.limit ?? 50, 1), 200);
    values.push(limit + 1);

    const sql = `
      SELECT id, timestamp::text, subject_id, action, object_type, object_id, result, correlation_id, details
      FROM ems_core.audit_log
      ${whereClause}
      ORDER BY timestamp DESC, id DESC
      LIMIT $${paramIndex}
    `;

    const res = await q.query<AuditRecordRow>(sql, values);
    const hasMore = res.rows.length > limit;
    const items = hasMore ? res.rows.slice(0, limit) : res.rows;
    const last = items[items.length - 1];
    const nextCursor = hasMore && last
      ? Buffer.from(JSON.stringify({ timestamp: last.timestamp, id: last.id }), 'utf8').toString('base64url')
      : undefined;

    return { items, nextCursor };
  }
}
