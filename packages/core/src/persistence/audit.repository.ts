import type { Queryable } from './db.js';

function isStrictTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match || Number.isNaN(Date.parse(value))) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  return month >= 1 && month <= 12 && day >= 1 && day <= new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export interface AuditRecordRow {
  readonly id: string;
  readonly timestamp: string;
  readonly timestamp_iso: string;
  readonly subject_id: string;
  readonly action: string;
  readonly object_type: string;
  readonly object_id: string;
  readonly result: 'SUCCESS' | 'FAILURE';
  readonly correlation_id: string | null;
  readonly details: Record<string, unknown> | null;
  readonly format_version: number;
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
  readonly formatVersion?: number;
}

export interface AuditQueryFilter {
  readonly periodStart?: string;
  readonly periodEnd?: string;
  readonly action?: string;
  readonly subjectId?: string;
  readonly cursor?: string;
  readonly limit?: number;
}

export class AuditRepository {
  async insert(q: Queryable, record: NewAuditRecord): Promise<void> {
    const text = `
      INSERT INTO ems_core.audit_log (
        id, timestamp, subject_id, action, object_type, object_id, result, correlation_id, details, format_version
      ) VALUES ($1, COALESCE($2, NOW()), $3, $4, $5, $6, $7, $8, $9, $10)
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
      record.formatVersion ?? 2,
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
      conditions.push(`ems_core.audit_log.timestamp >= $${paramIndex++}::timestamptz`);
      values.push(filter.periodStart);
    }
    if (filter.periodEnd) {
      conditions.push(`ems_core.audit_log.timestamp <= $${paramIndex++}::timestamptz`);
      values.push(filter.periodEnd);
    }
    if (filter.action) {
      conditions.push(`ems_core.audit_log.action = $${paramIndex++}`);
      values.push(filter.action);
    }
    if (filter.subjectId) {
      conditions.push(`ems_core.audit_log.subject_id = $${paramIndex++}`);
      values.push(filter.subjectId);
    }
    if (filter.cursor) {
      let parsed: any;
      try {
        const decoded = Buffer.from(filter.cursor, 'base64url').toString('utf8');
        parsed = JSON.parse(decoded);
      } catch {
        throw new Error('INVALID_CURSOR');
      }

      if (
        !parsed ||
        typeof parsed !== 'object' ||
        parsed.v !== 2 ||
        typeof parsed.t !== 'string' ||
        typeof parsed.id !== 'string' ||
        !isStrictTimestamp(parsed.t) ||
        parsed.id.trim() === ''
      ) {
        throw new Error('INVALID_CURSOR');
      }

      conditions.push(
        `(ems_core.audit_log.timestamp, ems_core.audit_log.id) < ($${paramIndex++}::timestamptz, $${paramIndex++})`,
      );
      values.push(parsed.t, parsed.id);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = Math.min(Math.max(filter.limit ?? 50, 1), 200);
    values.push(limit + 1);

    const sql = `
      SELECT
        id,
        timestamp::text as timestamp,
        to_char(timestamp AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as timestamp_iso,
        subject_id,
        action,
        object_type,
        object_id,
        result,
        correlation_id,
        details,
        format_version
      FROM ems_core.audit_log
      ${whereClause}
      ORDER BY ems_core.audit_log.timestamp DESC, ems_core.audit_log.id DESC
      LIMIT $${paramIndex}
    `;

    const res = await q.query<AuditRecordRow>(sql, values);
    const hasMore = res.rows.length > limit;
    const items = hasMore ? res.rows.slice(0, limit) : res.rows;
    const last = items[items.length - 1];
    const nextCursor =
      hasMore && last
        ? Buffer.from(
            JSON.stringify({ v: 2, t: last.timestamp_iso, id: last.id }),
            'utf8',
          ).toString('base64url')
        : undefined;

    return { items, nextCursor };
  }
}
