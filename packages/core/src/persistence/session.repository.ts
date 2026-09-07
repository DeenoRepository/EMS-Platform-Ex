import type { Queryable } from './db.js';

export interface SessionRow {
  readonly id: string;
  readonly employee_id: string;
  readonly created_at: string;
  readonly expires_at: string;
  readonly idle_expires_at: string;
  readonly revoked_at: string | null;
  readonly revocation_reason: string | null;
}

export interface NewSession {
  readonly id: string;
  readonly employeeId: string;
  readonly expiresAt: Date;
  readonly idleExpiresAt: Date;
}

export class SessionRepository {
  async create(q: Queryable, session: NewSession): Promise<SessionRow> {
    const res = await q.query<SessionRow>(
      `INSERT INTO ems_core.sessions (
        id, employee_id, expires_at, idle_expires_at
      ) VALUES ($1, $2, $3, $4)
      RETURNING id, employee_id, created_at::text, expires_at::text, idle_expires_at::text, revoked_at::text, revocation_reason`,
      [session.id, session.employeeId, session.expiresAt.toISOString(), session.idleExpiresAt.toISOString()],
    );
    return res.rows[0]!;
  }

  async findActiveById(q: Queryable, id: string): Promise<SessionRow | null> {
    const res = await q.query<SessionRow>(
      `SELECT id, employee_id, created_at::text, expires_at::text, idle_expires_at::text, revoked_at::text, revocation_reason
       FROM ems_core.sessions
       WHERE id = $1 AND revoked_at IS NULL AND expires_at > NOW() AND idle_expires_at > NOW()`,
      [id],
    );
    return res.rows[0] ?? null;
  }

  async revoke(
    q: Queryable,
    id: string,
    reason = 'LOGOUT',
  ): Promise<boolean> {
    const res = await q.query(
      `UPDATE ems_core.sessions
       SET revoked_at = NOW(), revocation_reason = $2
       WHERE id = $1 AND revoked_at IS NULL`,
      [id, reason],
    );
    return (res.rowCount ?? 0) > 0;
  }

  async revokeAllForEmployee(
    q: Queryable,
    employeeId: string,
    reason = 'ASSIGNMENT_CHANGED',
  ): Promise<number> {
    const res = await q.query(
      `UPDATE ems_core.sessions
       SET revoked_at = NOW(), revocation_reason = $2
       WHERE employee_id = $1 AND revoked_at IS NULL`,
      [employeeId, reason],
    );
    return res.rowCount ?? 0;
  }
}
