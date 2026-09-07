import type { Queryable } from './db.js';

export interface ModuleAvailabilityRow {
  readonly module_id: string;
  readonly department_id: string;
  readonly enabled: boolean;
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
    if (res.rows.length === 0) {
      // По умолчанию для MVP модуль доступен, если не отключен явно
      return true;
    }
    return res.rows[0]?.enabled ?? true;
  }

  async setAvailability(
    q: Queryable,
    moduleId: string,
    departmentId: string,
    enabled: boolean,
  ): Promise<ModuleAvailabilityRow> {
    const res = await q.query<ModuleAvailabilityRow>(
      `INSERT INTO ems_core.module_availability (module_id, department_id, enabled, updated_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (module_id, department_id)
       DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = NOW()
       RETURNING module_id, department_id, enabled, updated_at::text`,
      [moduleId, departmentId, enabled],
    );
    return res.rows[0]!;
  }
}
