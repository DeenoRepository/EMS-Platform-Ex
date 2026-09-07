import type { Queryable } from './db.js';

export interface RoleRow {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly is_system: boolean;
  readonly created_at: string;
}

export interface NewRole {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly isSystem?: boolean;
}

export class RoleRepository {
  async findById(q: Queryable, id: string): Promise<RoleRow | null> {
    const res = await q.query<RoleRow>(
      'SELECT id, name, description, is_system, created_at::text FROM ems_core.roles WHERE id = $1',
      [id],
    );
    return res.rows[0] ?? null;
  }

  async create(
    q: Queryable,
    role: NewRole,
    permissions: readonly string[],
  ): Promise<RoleRow> {
    const res = await q.query<RoleRow>(
      'INSERT INTO ems_core.roles (id, name, description, is_system) VALUES ($1, $2, $3, $4) RETURNING id, name, description, is_system, created_at::text',
      [role.id, role.name, role.description ?? null, role.isSystem ?? false],
    );

    for (const permId of permissions) {
      await q.query(
        'INSERT INTO ems_core.role_permissions (role_id, permission_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [role.id, permId],
      );
    }

    return res.rows[0]!;
  }

  async getPermissionsForRoles(
    q: Queryable,
    roleIds: readonly string[],
  ): Promise<readonly string[]> {
    if (roleIds.length === 0) return [];

    const placeholders = roleIds.map((_, i) => `$${i + 1}`).join(', ');
    const res = await q.query<{ permission_id: string }>(
      `SELECT DISTINCT permission_id FROM ems_core.role_permissions WHERE role_id IN (${placeholders})`,
      [...roleIds],
    );

    return res.rows.map((r) => r.permission_id);
  }
}
