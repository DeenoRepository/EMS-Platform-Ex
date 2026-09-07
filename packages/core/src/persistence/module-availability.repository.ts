import type { Queryable } from './db.js';

export interface ModuleAvailabilityRow {
  readonly module_id: string;
  readonly department_id: string;
  readonly enabled: boolean;
  readonly version: number;
  readonly updated_at: string;
}

export class ModuleAvailabilityRepository {
  async isModuleAvailable(
    q: Queryable,
    moduleId: string,
    departmentId: string,
  ): Promise<boolean> {
    const res = await q.query<{ enabled: boolean }>(
      `SELECT enabled FROM ems_core.module_availability
       WHERE module_id = $1 AND department_id = $2`,
      [moduleId, departmentId],
    );
    // Не конфигурированный модуль запрещен (default false)
    return res.rows[0]?.enabled ?? false;
  }

  async findRow(
    q: Queryable,
    moduleId: string,
    departmentId: string,
    forUpdate = false,
  ): Promise<ModuleAvailabilityRow | null> {
    const sql = `
      SELECT module_id, department_id, enabled, version, updated_at::text
      FROM ems_core.module_availability
      WHERE module_id = $1 AND department_id = $2
      ${forUpdate ? 'FOR UPDATE' : ''}
    `;
    const res = await q.query<ModuleAvailabilityRow>(sql, [moduleId, departmentId]);
    return res.rows[0] ?? null;
  }

  async insertInitial(
    q: Queryable,
    moduleId: string,
    departmentId: string,
    enabled: boolean,
  ): Promise<ModuleAvailabilityRow | null> {
    const res = await q.query<ModuleAvailabilityRow>(
      `INSERT INTO ems_core.module_availability (module_id, department_id, enabled, version, updated_at)
       VALUES ($1, $2, $3, 1, NOW())
       ON CONFLICT (module_id, department_id) DO NOTHING
       RETURNING module_id, department_id, enabled, version, updated_at::text`,
      [moduleId, departmentId, enabled],
    );
    return res.rows[0] ?? null;
  }

  async updateVersioned(
    q: Queryable,
    moduleId: string,
    departmentId: string,
    enabled: boolean,
    expectedVersion: number,
  ): Promise<ModuleAvailabilityRow | null> {
    const res = await q.query<ModuleAvailabilityRow>(
      `UPDATE ems_core.module_availability
       SET enabled = $3, version = version + 1, updated_at = NOW()
       WHERE module_id = $1 AND department_id = $2 AND version = $4
       RETURNING module_id, department_id, enabled, version, updated_at::text`,
      [moduleId, departmentId, enabled, expectedVersion],
    );
    return res.rows[0] ?? null;
  }
}
