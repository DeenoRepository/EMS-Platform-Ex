import type { Queryable } from './db.js';

export interface SessionRow {
  readonly id: string;
  readonly employee_id: string;
  readonly credential_hash: string | null;
  readonly format_version: number;
  readonly created_at: string;
  readonly expires_at: string;
  readonly idle_expires_at: string;
  readonly revoked_at: string | null;
  readonly revocation_reason: string | null;
}

export interface NewSession {
  readonly id: string;
  readonly employeeId: string;
  readonly credentialHash: string;
  readonly formatVersion?: number;
  readonly expiresAt: Date;
  readonly idleExpiresAt: Date;
}

export class SessionRepository {
  async create(q: Queryable, session: NewSession): Promise<SessionRow> {
    const res = await q.query<SessionRow>(
      `INSERT INTO ems_core.sessions (
        id, employee_id, credential_hash, format_version, expires_at, idle_expires_at
      ) VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING id, employee_id, credential_hash, format_version, created_at::text, expires_at::text, idle_expires_at::text, revoked_at::text, revocation_reason`,
      [
        session.id,
        session.employeeId,
        session.credentialHash,
        session.formatVersion ?? 2,
        session.expiresAt.toISOString(),
        session.idleExpiresAt.toISOString(),
      ],
    );
    return res.rows[0]!;
  }

  async findActiveByCredentialHash(q: Queryable, hash: string): Promise<SessionRow | null> {
    const res = await q.query<SessionRow>(
      `SELECT id, employee_id, credential_hash, format_version, created_at::text, expires_at::text, idle_expires_at::text, revoked_at::text, revocation_reason
       FROM ems_core.sessions
       WHERE credential_hash = $1 AND revoked_at IS NULL AND expires_at > NOW() AND idle_expires_at > NOW()`,
      [hash],
    );
    return res.rows[0] ?? null;
  }

  async renewIdle(
    q: Queryable,
    hash: string,
    idleTtlMs: number,
    renewThresholdMs: number,
  ): Promise<SessionRow | null> {
    const res = await q.query<SessionRow>(
      `UPDATE ems_core.sessions
       SET idle_expires_at = LEAST(NOW() + ($2 * INTERVAL '1 millisecond'), expires_at)
       WHERE credential_hash = $1
         AND revoked_at IS NULL
         AND expires_at > NOW()
         AND idle_expires_at > NOW()
         AND idle_expires_at < NOW() + ($3 * INTERVAL '1 millisecond')
       RETURNING id, employee_id, credential_hash, format_version, created_at::text, expires_at::text, idle_expires_at::text, revoked_at::text, revocation_reason`,
      [hash, idleTtlMs, renewThresholdMs],
    );
    return res.rows[0] ?? null;
  }

  async revokeByCredentialHash(
    q: Queryable,
    hash: string,
    reason = 'USER_LOGOUT',
  ): Promise<SessionRow | null> {
    const res = await q.query<SessionRow>(
      `UPDATE ems_core.sessions
       SET revoked_at = NOW(), revocation_reason = $2
       WHERE credential_hash = $1 AND revoked_at IS NULL
       RETURNING id, employee_id, credential_hash, format_version, created_at::text, expires_at::text, idle_expires_at::text, revoked_at::text, revocation_reason`,
      [hash, reason],
    );
    return res.rows[0] ?? null;
  }

  async revokeAllForEmployee(
    q: Queryable,
    employeeId: string,
    reason = 'ASSIGNMENT_TRANSFERRED',
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
