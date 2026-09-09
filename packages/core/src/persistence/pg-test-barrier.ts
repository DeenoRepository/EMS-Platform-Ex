import assert from 'node:assert/strict';
import type pg from 'pg';
import type { DatabasePool } from './db.js';

const POLL_INTERVAL_MS = 25;

export async function waitUntilBlocked(
  pool: DatabasePool,
  predicateSql: string,
  timeoutMs = 10000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastCount = 0;

  while (Date.now() < deadline) {
    const result = await pool.query<{ count: string }>(predicateSql);
    lastCount = Number(result.rows[0]?.count ?? 0);
    if (lastCount > 0) return;
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  assert.fail(`Ожидание блокировки PostgreSQL истекло: count=${lastCount}`);
}

export async function withDecoyLock<T>(
  pool: DatabasePool,
  sql: string,
  params: readonly unknown[],
  operation: (release: () => Promise<void>, blockerPid: number) => Promise<T>,
): Promise<T> {
  const client = await pool.rawPool.connect();
  const pidResult = await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
  const blockerPid = pidResult.rows[0]!.pid;
  let committed = false;
  const release = async () => {
    if (!committed) {
      await client.query('COMMIT');
      committed = true;
    }
  };
  try {
    await client.query('BEGIN');
    await client.query(sql, [...params]);
    const result = await operation(release, blockerPid);
    await release();
    return result;
  } finally {
    if (!committed) {
      await client.query('ROLLBACK').catch(() => undefined);
    }
    client.release();
  }
}

export function blockedRowPredicate(relation: string, blockerPid: number): string {
  const escapedRelation = relation.replaceAll("'", "''");
  return `
    SELECT COUNT(DISTINCT activity.pid)::text AS count
    FROM pg_locks waiting
    JOIN pg_stat_activity activity ON activity.pid = waiting.pid
    WHERE NOT waiting.granted
      AND activity.pid <> pg_backend_pid()
      AND activity.wait_event_type = 'Lock'
      AND ${Number.isInteger(blockerPid) ? blockerPid : 0} = ANY(pg_blocking_pids(activity.pid))
      AND (waiting.relation = '${escapedRelation}'::regclass OR waiting.locktype = 'transactionid')
  `;
}

export function blockedTransactionPredicate(): string {
  return `
    SELECT COUNT(*)::text AS count
    FROM pg_stat_activity
    WHERE wait_event_type = 'Lock'
  `;
}

export function blockedByPredicate(blockerPid: number): string {
  return `
    SELECT COUNT(DISTINCT activity.pid)::text AS count
    FROM pg_locks waiting
    JOIN pg_stat_activity activity ON activity.pid = waiting.pid
    WHERE NOT waiting.granted
      AND activity.pid <> pg_backend_pid()
      AND activity.wait_event_type = 'Lock'
      AND ${Number.isInteger(blockerPid) ? blockerPid : 0} = ANY(pg_blocking_pids(activity.pid))
  `;
}

export type PgClient = pg.PoolClient;
