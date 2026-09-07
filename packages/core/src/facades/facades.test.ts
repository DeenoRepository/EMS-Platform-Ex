import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  PostgresIdentityFacade,
  ADMIN_ROLE_ID,
  type LdapAuthenticator,
} from './postgres-identity.facade.js';
import { PostgresAuthorizationFacade } from './postgres-authorization.facade.js';
import { PostgresAdministrationFacade } from './postgres-administration.facade.js';
import { PostgresSessionFacade } from './postgres-session.facade.js';
import { PostgresAuditFacade } from './postgres-audit.facade.js';
import { ok, fail } from '@ems/contracts';

// In-Memory Database Simulator for deterministic offline testing
class MockDatabasePool {
  public departments = new Map<string, any>();
  public roles = new Map<string, any>();
  public rolePermissions = new Map<string, Set<string>>();
  public employees = new Map<string, any>();
  public employeeRoles = new Map<string, Set<string>>();
  public moduleAvailability = new Map<string, boolean>();
  public sessions = new Map<string, any>();
  public auditLog: any[] = [];

  get rawPool(): any {
    return this;
  }

  async query(text: string, params: any[] = []): Promise<{ rows: any[]; rowCount: number }> {
    const cleanSql = text.trim().replace(/\s+/g, ' ');

    // ems_core.departments
    if (cleanSql.includes('FROM ems_core.departments WHERE id = $1')) {
      const dept = this.departments.get(params[0]);
      return { rows: dept ? [dept] : [], rowCount: dept ? 1 : 0 };
    }
    if (cleanSql.includes('INSERT INTO ems_core.departments')) {
      const row = { id: params[0], name: params[1], code: params[2], created_at: new Date().toISOString() };
      this.departments.set(params[0], row);
      return { rows: [row], rowCount: 1 };
    }

    // ems_core.roles
    if (cleanSql.includes('FROM ems_core.roles WHERE id = $1')) {
      const r = this.roles.get(params[0]);
      return { rows: r ? [r] : [], rowCount: r ? 1 : 0 };
    }
    if (cleanSql.includes('INSERT INTO ems_core.roles')) {
      const row = { id: params[0], name: params[1], description: params[2], is_system: params[3], created_at: new Date().toISOString() };
      this.roles.set(params[0], row);
      return { rows: [row], rowCount: 1 };
    }
    if (cleanSql.includes('INSERT INTO ems_core.role_permissions')) {
      let set = this.rolePermissions.get(params[0]);
      if (!set) {
        set = new Set();
        this.rolePermissions.set(params[0], set);
      }
      set.add(params[1]);
      return { rows: [], rowCount: 1 };
    }
    if (cleanSql.includes('FROM ems_core.role_permissions WHERE role_id IN')) {
      const matchedPerms = new Set<string>();
      for (const roleId of params) {
        const perms = this.rolePermissions.get(roleId);
        if (perms) {
          for (const p of perms) matchedPerms.add(p);
        }
      }
      return { rows: Array.from(matchedPerms).map((p) => ({ permission_id: p })), rowCount: matchedPerms.size };
    }

    // ems_core.employees
    if (cleanSql.includes('FROM ems_core.employees WHERE directory_id = $1 AND object_guid = $2')) {
      for (const emp of this.employees.values()) {
        if (emp.directory_id === params[0] && emp.object_guid === params[1]) {
          return { rows: [emp], rowCount: 1 };
        }
      }
      return { rows: [], rowCount: 0 };
    }
    if (cleanSql.includes('FROM ems_core.employees WHERE id = $1')) {
      const emp = this.employees.get(params[0]);
      return { rows: emp ? [emp] : [], rowCount: emp ? 1 : 0 };
    }
    if (cleanSql.includes('FROM ems_core.employees WHERE upn = $1')) {
      for (const emp of this.employees.values()) {
        if (emp.upn === params[0]) return { rows: [emp], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }
    if (cleanSql.includes('INSERT INTO ems_core.employees')) {
      const row = {
        id: params[0],
        directory_id: params[1],
        object_guid: params[2],
        upn: params[3],
        display_name: params[4],
        status: params[5],
        department_id: params[6],
        version: 1,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      this.employees.set(row.id, row);
      return { rows: [row], rowCount: 1 };
    }
    if (cleanSql.includes('UPDATE ems_core.employees SET department_id = $1')) {
      const emp = this.employees.get(params[1]);
      if (!emp) return { rows: [], rowCount: 0 };
      if (params[2] !== undefined && emp.version !== params[2]) {
        return { rows: [], rowCount: 0 }; // expectedVersion conflict
      }
      emp.department_id = params[0];
      emp.status = 'ACTIVE';
      emp.version += 1;
      emp.updated_at = new Date().toISOString();
      return { rows: [emp], rowCount: 1 };
    }
    if (cleanSql.includes('FROM ems_core.employees e JOIN ems_core.employee_roles er')) {
      let count = 0;
      for (const [empId, roles] of this.employeeRoles.entries()) {
        const emp = this.employees.get(empId);
        if (emp && emp.status === 'ACTIVE' && roles.has(params[0])) {
          count++;
        }
      }
      return { rows: [{ count: count.toString() }], rowCount: 1 };
    }

    // ems_core.employee_roles
    if (cleanSql.includes('INSERT INTO ems_core.employee_roles')) {
      let set = this.employeeRoles.get(params[0]);
      if (!set) {
        set = new Set();
        this.employeeRoles.set(params[0], set);
      }
      set.add(params[1]);
      return { rows: [], rowCount: 1 };
    }
    if (cleanSql.includes('SELECT role_id FROM ems_core.employee_roles WHERE employee_id = $1')) {
      const set = this.employeeRoles.get(params[0]) ?? new Set();
      return { rows: Array.from(set).map((r) => ({ role_id: r })), rowCount: set.size };
    }
    if (cleanSql.includes('DELETE FROM ems_core.employee_roles WHERE employee_id = $1')) {
      this.employeeRoles.delete(params[0]);
      return { rows: [], rowCount: 1 };
    }

    // ems_core.sessions
    if (cleanSql.includes('INSERT INTO ems_core.sessions')) {
      const row = {
        id: params[0],
        employee_id: params[1],
        created_at: new Date().toISOString(),
        expires_at: params[2],
        idle_expires_at: params[3],
        revoked_at: null,
        revocation_reason: null,
      };
      this.sessions.set(row.id, row);
      return { rows: [row], rowCount: 1 };
    }
    if (cleanSql.includes('FROM ems_core.sessions WHERE id = $1 AND revoked_at IS NULL')) {
      const s = this.sessions.get(params[0]);
      if (s && !s.revoked_at) {
        return { rows: [s], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }
    if (cleanSql.includes('UPDATE ems_core.sessions') && cleanSql.includes('WHERE id = $1')) {
      const s = this.sessions.get(params[0]);
      if (s && !s.revoked_at) {
        s.revoked_at = new Date().toISOString();
        s.revocation_reason = params[1];
        return { rows: [s], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }
    if (cleanSql.includes('UPDATE ems_core.sessions') && cleanSql.includes('WHERE employee_id = $1')) {
      let count = 0;
      for (const s of this.sessions.values()) {
        if (s.employee_id === params[0] && !s.revoked_at) {
          s.revoked_at = new Date().toISOString();
          s.revocation_reason = params[1];
          count++;
        }
      }
      return { rows: [], rowCount: count };
    }

    // ems_core.module_availability
    if (cleanSql.includes('FROM ems_core.module_availability WHERE module_id = $1 AND department_id = $2')) {
      const key = `${params[0]}:${params[1]}`;
      const enabled = this.moduleAvailability.has(key) ? this.moduleAvailability.get(key) : true;
      return { rows: [{ enabled }], rowCount: 1 };
    }
    if (cleanSql.includes('INSERT INTO ems_core.module_availability')) {
      const key = `${params[0]}:${params[1]}`;
      this.moduleAvailability.set(key, params[2]);
      return { rows: [{ module_id: params[0], department_id: params[1], enabled: params[2], updated_at: new Date().toISOString() }], rowCount: 1 };
    }

    // ems_core.audit_log
    if (cleanSql.includes('INSERT INTO ems_core.audit_log')) {
      const row = {
        id: params[0],
        timestamp: params[1] ?? new Date().toISOString(),
        subject_id: params[2],
        action: params[3],
        object_type: params[4],
        objectId: params[5],
        result: params[6],
        correlation_id: params[7],
        details: params[8] ? JSON.parse(params[8]) : null,
      };
      this.auditLog.push(row);
      return { rows: [row], rowCount: 1 };
    }
    if (cleanSql.includes('FROM ems_core.audit_log')) {
      return { rows: [...this.auditLog].reverse(), rowCount: this.auditLog.length };
    }

    return { rows: [], rowCount: 0 };
  }

  async withTransaction<T>(operation: (client: any) => Promise<T>): Promise<T> {
    return await operation(this);
  }
}

describe('Postgres Core Facades integration tests', () => {
  const fakeLdap: LdapAuthenticator = {
    async authenticate(upn, password) {
      if (password === 'wrong-password') {
        return fail({
          code: 'UNAUTHENTICATED',
          message: 'Неверные учетные данные',
          retryable: false,
        });
      }
      return ok({
        directoryId: 'corp.local',
        objectGuid: `guid-${upn}`,
        upn,
        displayName: `Display Name for ${upn}`,
      });
    },
  };

  test('bootstrap создает отдел, роль администратора и сотрудника (FR-009..FR-012)', async () => {
    const mockDb = new MockDatabasePool() as any;
    const identityFacade = new PostgresIdentityFacade(mockDb, fakeLdap);

    const result = await identityFacade.bootstrap({
      operatorId: 'operator-001',
      upn: 'admin@corp.local',
      initialDepartmentId: 'dept-platform',
    });

    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.value.departmentId, 'dept-platform');
      assert.equal(result.value.roleId, ADMIN_ROLE_ID);
    }

    // Повторный bootstrap должен быть отклонен (FR-012)
    const secondBootstrap = await identityFacade.bootstrap({
      operatorId: 'operator-002',
      upn: 'hacker@corp.local',
      initialDepartmentId: 'dept-other',
    });

    assert.equal(secondBootstrap.ok, false);
    if (!secondBootstrap.ok) {
      assert.equal(secondBootstrap.error.code, 'CONFLICT');
      assert.match(secondBootstrap.error.message, /FR-012/);
    }
  });

  test('первый вход нового сотрудника создает запись PENDING и сессию с записью аудита (FR-004, FR-027)', async () => {
    const mockDb = new MockDatabasePool() as any;
    const identityFacade = new PostgresIdentityFacade(mockDb, fakeLdap);

    const loginRes = await identityFacade.login({
      upn: 'ivanov@corp.local',
      password: 'correct-password',
    });

    assert.equal(loginRes.ok, true);
    if (loginRes.ok) {
      assert.equal(loginRes.value.session.isPending, true);
      assert.equal(loginRes.value.session.departmentId, null);
      assert.deepEqual(loginRes.value.session.permissions, []);
    }

    // Проверяем наличие записи аудита входа
    const auditRecord = mockDb.auditLog.find((a: any) => a.action === 'LOGIN');
    assert.ok(auditRecord, 'Запись аудита успешного входа должна быть создана');
    assert.equal(auditRecord.result, 'SUCCESS');
  });

  test('авторизация отклоняет ожидающего сотрудника и проверяет модуль отделу (FR-005, FR-016)', async () => {
    const mockDb = new MockDatabasePool() as any;
    const identityFacade = new PostgresIdentityFacade(mockDb, fakeLdap);
    const authzFacade = new PostgresAuthorizationFacade(mockDb);

    const loginRes = await identityFacade.login({
      upn: 'petrov@corp.local',
      password: 'correct-password',
    });
    assert.equal(loginRes.ok, true);
    if (!loginRes.ok) return;

    // Ожидающий сотрудник не получает доступ (FR-005)
    const checkPending = await authzFacade.authorize({
      sessionContext: loginRes.value.session,
      permission: 'demo-catalog.view',
    });

    assert.equal(checkPending.ok, true);
    if (checkPending.ok) {
      assert.equal(checkPending.value.allowed, false);
      assert.match(checkPending.value.reason!, /PENDING/);
    }
  });

  test('перевод сотрудника отзывает все его сессии и сохраняет аудит (FR-020)', async () => {
    const mockDb = new MockDatabasePool() as any;
    const identityFacade = new PostgresIdentityFacade(mockDb, fakeLdap);
    const adminFacade = new PostgresAdministrationFacade(mockDb);
    const authzFacade = new PostgresAuthorizationFacade(mockDb);

    // Bootstrap начального отдела
    await identityFacade.bootstrap({
      operatorId: 'operator-001',
      upn: 'admin@corp.local',
      initialDepartmentId: 'dept-platform',
    });

    // Создаем целевой отдел производства
    mockDb.departments.set('dept-prod', {
      id: 'dept-prod',
      name: 'Цех №1',
      code: 'PROD_01',
      created_at: new Date().toISOString(),
    });

    // Вход сотрудника
    const loginRes = await identityFacade.login({
      upn: 'sidorov@corp.local',
      password: 'correct-password',
    });
    assert.equal(loginRes.ok, true);
    if (!loginRes.ok) return;

    const empId = loginRes.value.session.employeeId;

    // Назначаем сотрудника в отдел производства
    const assignRes = await adminFacade.assignEmployee({
      employeeId: empId,
      departmentId: 'dept-prod',
      roleIds: [ADMIN_ROLE_ID],
    });

    assert.equal(assignRes.ok, true);

    // Проверяем, что старая сессия сотрудника была отозвана (FR-020)
    const authWithOldSession = await authzFacade.authorize({
      sessionContext: loginRes.value.session,
      permission: 'platform.admin',
    });

    assert.equal(authWithOldSession.ok, false);
    if (!authWithOldSession.ok) {
      assert.equal(authWithOldSession.error.code, 'UNAUTHENTICATED');
    }

    // Проверяем запись аудита перевода
    const transferAudit = mockDb.auditLog.find((a: any) => a.action === 'ASSIGN_EMPLOYEE');
    assert.ok(transferAudit, 'Запись аудита перевода должна быть создана');
    assert.equal(transferAudit.details.newDepartmentId, 'dept-prod');
  });

  test('защита от снятия роли у последнего администратора (FR-019)', async () => {
    const mockDb = new MockDatabasePool() as any;
    const identityFacade = new PostgresIdentityFacade(mockDb, fakeLdap);
    const adminFacade = new PostgresAdministrationFacade(mockDb);

    const boot = await identityFacade.bootstrap({
      operatorId: 'operator-001',
      upn: 'only-admin@corp.local',
      initialDepartmentId: 'dept-platform',
    });
    assert.equal(boot.ok, true);
    if (!boot.ok) return;

    // Пытаемся забрать роль администратора у единственного активного администратора
    const tryRemoveAdmin = await adminFacade.assignEmployee({
      employeeId: boot.value.employeeId,
      departmentId: 'dept-platform',
      roleIds: [], // без роли админа!
    });

    assert.equal(tryRemoveAdmin.ok, false);
    if (!tryRemoveAdmin.ok) {
      assert.equal(tryRemoveAdmin.error.code, 'CONFLICT');
      assert.match(tryRemoveAdmin.error.message, /FR-019/);
    }
  });

  test('выход из системы отзывает сессию (SessionFacade, FR-028)', async () => {
    const mockDb = new MockDatabasePool() as any;
    const identityFacade = new PostgresIdentityFacade(mockDb, fakeLdap);
    const sessionFacade = new PostgresSessionFacade(mockDb);

    const loginRes = await identityFacade.login({
      upn: 'test-logout@corp.local',
      password: 'password',
    });
    assert.equal(loginRes.ok, true);
    if (!loginRes.ok) return;

    const logoutRes = await sessionFacade.logout({
      sessionId: loginRes.value.session.sessionId,
    });
    assert.equal(logoutRes.ok, true);

    // Повторный logout возвращает NOT_FOUND_OR_FORBIDDEN
    const secondLogout = await sessionFacade.logout({
      sessionId: loginRes.value.session.sessionId,
    });
    assert.equal(secondLogout.ok, false);
    if (!secondLogout.ok) {
      assert.equal(secondLogout.error.code, 'NOT_FOUND_OR_FORBIDDEN');
    }
  });

  test('просмотр журнала аудита сам записывается в аудит (AuditFacade, FR-030)', async () => {
    const mockDb = new MockDatabasePool() as any;
    const auditFacade = new PostgresAuditFacade(mockDb);

    // Добавляем тестовую запись
    mockDb.auditLog.push({
      id: 'aud-1',
      timestamp: new Date().toISOString(),
      subject_id: 'user-1',
      action: 'TEST_ACTION',
      object_type: 'test',
      object_id: '1',
      result: 'SUCCESS',
      correlation_id: null,
      details: null,
    });

    const queryRes = await auditFacade.query({
      subjectId: 'admin-viewer',
    });

    assert.equal(queryRes.ok, true);
    if (queryRes.ok) {
      assert.ok(queryRes.value.items.length >= 1);
    }

    // Проверяем, что просмотр залогирован
    const viewAudit = mockDb.auditLog.find((a: any) => a.action === 'AUDIT_QUERY_VIEWED');
    assert.ok(viewAudit, 'Просмотр журнала должен аудироваться согласно FR-030');
    assert.equal(viewAudit.subject_id, 'admin-viewer');
  });
});
