import type { Queryable } from './db.js';

export interface DepartmentRow {
  readonly id: string;
  readonly name: string;
  readonly code: string;
  readonly created_at: string;
}

export interface NewDepartment {
  readonly id: string;
  readonly name: string;
  readonly code: string;
}

export class DepartmentRepository {
  async findById(q: Queryable, id: string): Promise<DepartmentRow | null> {
    const res = await q.query<DepartmentRow>(
      'SELECT id, name, code, created_at::text FROM ems_core.departments WHERE id = $1',
      [id],
    );
    return res.rows[0] ?? null;
  }

  async findByCode(q: Queryable, code: string): Promise<DepartmentRow | null> {
    const res = await q.query<DepartmentRow>(
      'SELECT id, name, code, created_at::text FROM ems_core.departments WHERE code = $1',
      [code],
    );
    return res.rows[0] ?? null;
  }

  async create(q: Queryable, dept: NewDepartment): Promise<DepartmentRow> {
    const res = await q.query<DepartmentRow>(
      'INSERT INTO ems_core.departments (id, name, code) VALUES ($1, $2, $3) RETURNING id, name, code, created_at::text',
      [dept.id, dept.name, dept.code],
    );
    return res.rows[0]!;
  }

  async list(q: Queryable): Promise<readonly DepartmentRow[]> {
    const res = await q.query<DepartmentRow>(
      'SELECT id, name, code, created_at::text FROM ems_core.departments ORDER BY name ASC',
    );
    return res.rows;
  }
}
