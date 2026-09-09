import type { Queryable } from './db.js';

export interface EmployeeRow {
  readonly id: string;
  readonly directory_id: string;
  readonly object_guid: string;
  readonly upn: string;
  readonly display_name: string;
  readonly status: 'PENDING' | 'ACTIVE' | 'BLOCKED';
  readonly department_id: string | null;
  readonly version: number;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface NewEmployee {
  readonly id: string;
  readonly directoryId: string;
  readonly objectGuid: string;
  readonly upn: string;
  readonly displayName: string;
  readonly status: 'PENDING' | 'ACTIVE' | 'BLOCKED';
  readonly departmentId?: string;
}

export class EmployeeRepository {
  async findById(q: Queryable, id: string): Promise<EmployeeRow | null> {
    const res = await q.query<EmployeeRow>(
      'SELECT id, directory_id, object_guid, upn, display_name, status, department_id, version, created_at::text, updated_at::text FROM ems_core.employees WHERE id = $1',
      [id],
    );
    return res.rows[0] ?? null;
  }

  async findByIdForUpdate(q: Queryable, id: string): Promise<EmployeeRow | null> {
    const res = await q.query<EmployeeRow>(
      'SELECT id, directory_id, object_guid, upn, display_name, status, department_id, version, created_at::text, updated_at::text FROM ems_core.employees WHERE id = $1 FOR UPDATE',
      [id],
    );
    return res.rows[0] ?? null;
  }

  async findByDirectoryGuid(
    q: Queryable,
    directoryId: string,
    objectGuid: string,
  ): Promise<EmployeeRow | null> {
    const res = await q.query<EmployeeRow>(
      'SELECT id, directory_id, object_guid, upn, display_name, status, department_id, version, created_at::text, updated_at::text FROM ems_core.employees WHERE directory_id = $1 AND object_guid = $2',
      [directoryId, objectGuid],
    );
    return res.rows[0] ?? null;
  }

  async findByDirectoryGuidForUpdate(
    q: Queryable,
    directoryId: string,
    objectGuid: string,
  ): Promise<EmployeeRow | null> {
    const res = await q.query<EmployeeRow>(
      'SELECT id, directory_id, object_guid, upn, display_name, status, department_id, version, created_at::text, updated_at::text FROM ems_core.employees WHERE directory_id = $1 AND object_guid = $2 FOR UPDATE',
      [directoryId, objectGuid],
    );
    return res.rows[0] ?? null;
  }

  async findByUpn(q: Queryable, upn: string): Promise<EmployeeRow | null> {
    const res = await q.query<EmployeeRow>(
      'SELECT id, directory_id, object_guid, upn, display_name, status, department_id, version, created_at::text, updated_at::text FROM ems_core.employees WHERE upn = $1',
      [upn],
    );
    return res.rows[0] ?? null;
  }

  async getOrCreateByDirectoryGuid(
    q: Queryable,
    data: {
      readonly directoryId: string;
      readonly objectGuid: string;
      readonly upn: string;
      readonly displayName: string;
      readonly status: 'PENDING' | 'ACTIVE' | 'BLOCKED';
      readonly departmentId?: string;
    },
  ): Promise<EmployeeRow> {
    let row = await this.findByDirectoryGuidForUpdate(q, data.directoryId, data.objectGuid);
    if (row) {
      if (row.upn !== data.upn || row.display_name !== data.displayName) {
        const updateRes = await q.query<EmployeeRow>(
          `UPDATE ems_core.employees
           SET upn = $1, display_name = $2, updated_at = NOW()
           WHERE id = $3
           RETURNING id, directory_id, object_guid, upn, display_name, status, department_id, version, created_at::text, updated_at::text`,
          [data.upn, data.displayName, row.id],
        );
        if (updateRes.rows.length > 0) {
          row = updateRes.rows[0]!;
        }
      }
      return row;
    }

    const newId = crypto.randomUUID();
    await q.query(
      `INSERT INTO ems_core.employees (
        id, directory_id, object_guid, upn, display_name, status, department_id
      ) VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (directory_id, object_guid) DO NOTHING`,
      [
        newId,
        data.directoryId,
        data.objectGuid,
        data.upn,
        data.displayName,
        data.status,
        data.departmentId ?? null,
      ],
    );

    row = await this.findByDirectoryGuidForUpdate(q, data.directoryId, data.objectGuid);
    if (!row) {
      throw new Error('Failed to get or create employee identity');
    }
    return row;
  }

  async create(
    q: Queryable,
    employee: NewEmployee,
    roleIds: readonly string[] = [],
  ): Promise<EmployeeRow> {
    const res = await q.query<EmployeeRow>(
      `INSERT INTO ems_core.employees (
        id, directory_id, object_guid, upn, display_name, status, department_id
      ) VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING id, directory_id, object_guid, upn, display_name, status, department_id, version, created_at::text, updated_at::text`,
      [
        employee.id,
        employee.directoryId,
        employee.objectGuid,
        employee.upn,
        employee.displayName,
        employee.status,
        employee.departmentId ?? null,
      ],
    );

    for (const roleId of roleIds) {
      await q.query(
        'INSERT INTO ems_core.employee_roles (employee_id, role_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [employee.id, roleId],
      );
    }

    return res.rows[0]!;
  }

  async getRolesForEmployee(
    q: Queryable,
    employeeId: string,
  ): Promise<readonly string[]> {
    const res = await q.query<{ role_id: string }>(
      'SELECT role_id FROM ems_core.employee_roles WHERE employee_id = $1 ORDER BY role_id ASC',
      [employeeId],
    );
    return res.rows.map((r) => r.role_id);
  }

  async updateAssignment(
    q: Queryable,
    employeeId: string,
    departmentId: string,
    roleIds: readonly string[],
    expectedVersion?: number,
  ): Promise<EmployeeRow | null> {
    let updateSql = `
      UPDATE ems_core.employees
      SET department_id = $1,
          status = CASE WHEN status = 'PENDING' THEN 'ACTIVE' ELSE status END,
          version = version + 1,
          updated_at = NOW()
      WHERE id = $2
    `;
    const params: any[] = [departmentId, employeeId];

    if (expectedVersion !== undefined) {
      updateSql += ' AND version = $3';
      params.push(expectedVersion);
    }

    updateSql += ' RETURNING id, directory_id, object_guid, upn, display_name, status, department_id, version, created_at::text, updated_at::text';

    const res = await q.query<EmployeeRow>(updateSql, params);
    if (res.rows.length === 0) {
      return null;
    }

    // Заменяем роли атомарно
    await q.query('DELETE FROM ems_core.employee_roles WHERE employee_id = $1', [employeeId]);
    for (const roleId of roleIds) {
      await q.query(
        'INSERT INTO ems_core.employee_roles (employee_id, role_id) VALUES ($1, $2)',
        [employeeId, roleId],
      );
    }

    return res.rows[0]!;
  }

  async countActiveAdmins(q: Queryable, adminRoleId: string): Promise<number> {
    const res = await q.query<{ count: string }>(
      `SELECT COUNT(*)::text as count
       FROM ems_core.employees e
       JOIN ems_core.employee_roles er ON e.id = er.employee_id
       WHERE er.role_id = $1 AND e.status = 'ACTIVE'`,
      [adminRoleId],
    );
    return parseInt(res.rows[0]?.count ?? '0', 10);
  }
}
