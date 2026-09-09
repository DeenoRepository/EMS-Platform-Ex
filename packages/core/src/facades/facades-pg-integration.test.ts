import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DatabasePool } from '../persistence/db.js';
import { SchemaMigrator } from '../persistence/migrator.js';
import { EmployeeRepository } from '../persistence/employee.repository.js';
import { PostgresAdministrationFacade } from './postgres-administration.facade.js';
import { ADMIN_ROLE_ID, PostgresIdentityFacade } from './postgres-identity.facade.js';
import { PostgresAuditFacade } from './postgres-audit.facade.js';
import { ok, type DirectoryAuthenticator, type DirectoryIdentityResolver, type LocalOperatorPort } from '@ems/contracts';
import { blockedRowPredicate, withDecoyLock, waitUntilBlocked } from '../persistence/pg-test-barrier.js';

const isOptIn = process.env.EMS_TEST_PG_INTEGRATION === 'true';
const migrationUrl = process.env.EMS_TEST_PG_MIGRATION_URL;
const runtimeUrl = process.env.EMS_TEST_PG_RUNTIME_URL;
const isAcceptanceRun = process.env.EMS_TEST_PG_REQUIRED === 'true';

describe('PostgreSQL facade concurrency acceptance', () => {
  if (!isOptIn || !migrationUrl || !runtimeUrl) {
    if (isAcceptanceRun) {
      throw new Error('PostgreSQL acceptance requires EMS_TEST_PG_INTEGRATION=true, EMS_TEST_PG_MIGRATION_URL and EMS_TEST_PG_RUNTIME_URL');
    }
    test('PostgreSQL фасадный стенд не настроен', { skip: 'Изолированный PostgreSQL стенд не настроен' }, () => undefined);
    return;
  }

  const migrationsDir = new URL('../../migrations/', import.meta.url);
  const up001 = fs.readFileSync(new URL('001_core_schema.sql', migrationsDir), 'utf8');
  const down001 = fs.readFileSync(new URL('001_core_schema.down.sql', migrationsDir), 'utf8');
  const up002 = fs.readFileSync(new URL('002_core_security_remediation.sql', migrationsDir), 'utf8');
  const down002 = fs.readFileSync(new URL('002_core_security_remediation.down.sql', migrationsDir), 'utf8');

  let migrationPool: DatabasePool;
  let runtimePool: DatabasePool;
  let migrator: SchemaMigrator;
  let identity: PostgresIdentityFacade;
  let administration: PostgresAdministrationFacade;
  let audit: PostgresAuditFacade;
  let sequence = 0;

  const directory: DirectoryAuthenticator & DirectoryIdentityResolver = {
    async authenticate(upn) { return identityFor(upn); },
    async resolveByUpn(upn) { return identityFor(upn); },
  };
  const operator: LocalOperatorPort = {
    async resolveOperator() {
      return ok({ operatorId: 'local-operator', permissions: ['platform.bootstrap'] });
    },
  };

  function identityFor(upn: string) {
    return ok({ directoryId: 'corp.local', objectGuid: `guid-${upn}`, upn, displayName: `Display ${upn}` });
  }

  function unique(prefix: string): string {
    sequence += 1;
    return `${prefix}-${sequence}@corp.local`;
  }

  async function clean() {
    await migrator.teardownEphemeralSchema();
    await migrator.provisionClean([
      { id: '001_core_schema', upSql: up001, downSql: down001 },
      { id: '002_core_security_remediation', upSql: up002, downSql: down002 },
    ]);
  }

  async function login(upn: string) {
    const result = await identity.login({ upn, password: 'synthetic-password' });
    if (!result.ok) throw new Error(result.error.message);
    return result.value;
  }

  async function bootstrap(upn: string, departmentId: string) {
    const result = await identity.bootstrap({ upn, initialDepartmentId: departmentId });
    if (!result.ok) throw new Error(result.error.message);
    return result.value;
  }

  async function employee(id: string) {
    return new EmployeeRepository().findById(runtimePool, id);
  }

  before(async () => {
    migrationPool = new DatabasePool({ connectionString: migrationUrl });
    runtimePool = new DatabasePool({ connectionString: runtimeUrl });
    migrator = new SchemaMigrator(migrationPool);
    identity = new PostgresIdentityFacade(runtimePool, directory, directory, operator);
    administration = new PostgresAdministrationFacade(runtimePool);
    audit = new PostgresAuditFacade(runtimePool);
  });
  beforeEach(clean);
  after(async () => {
    await migrator.teardownEphemeralSchema();
    await runtimePool.close();
    await migrationPool.close();
  });

  test('login -> assign: назначение видит сотрудника после входа и отзывает его сессию', async () => {
    const adminUpn = unique('admin');
    const targetUpn = unique('target');
    const targetId = 'employee-login-assign';
    await bootstrap(adminUpn, 'dept-admin');
    const adminSession = await login(adminUpn);
    await runtimePool.query(
      `INSERT INTO ems_core.employees (id, directory_id, object_guid, upn, display_name, status)
       VALUES ($1, 'corp.local', $2, $3, $4, 'PENDING')`,
      [targetId, `guid-${targetUpn}`, targetUpn, `Display ${targetUpn}`],
    );
    const result = await withDecoyLock(
      runtimePool,
      'SELECT id FROM ems_core.employees WHERE id = $1 FOR UPDATE',
      [targetId],
      async (release) => {
        const loginPromise = login(targetUpn);
        await waitUntilBlocked(runtimePool, blockedRowPredicate('ems_core.employees'));
        const assignPromise = administration.assignEmployee({
          actorCredential: adminSession.credential,
          employeeId: targetId,
          departmentId: 'dept-admin',
          roleIds: [],
          expectedVersion: 1,
        });
        await waitUntilBlocked(runtimePool, blockedRowPredicate('ems_core.employees'));
        await release();
        return Promise.all([loginPromise, assignPromise]);
      },
    );
    assert.equal(result[1].ok, true);
    const target = await employee(targetId);
    assert.equal(target?.department_id, 'dept-admin');
    const session = await runtimePool.query<{ revoked_at: string | null; revocation_reason: string | null }>(
      `SELECT s.revoked_at, s.revocation_reason FROM ems_core.sessions s WHERE s.employee_id = $1`, [targetId],
    );
    assert.equal(session.rows[0]?.revocation_reason, 'ASSIGNMENT_TRANSFERRED');
    const transfer = await runtimePool.query<{ details: Record<string, unknown> }>(
      `SELECT details FROM ems_core.audit_log WHERE action = 'ASSIGN_EMPLOYEE' AND object_id = $1`, [targetId],
    );
    assert.equal(transfer.rows[0]?.details.previousDepartmentId, null);
    assert.deepEqual(transfer.rows[0]?.details.previousRoleIds, []);
  });

  test('assign -> login: вход видит новое назначение', async () => {
    const adminUpn = unique('admin');
    const targetUpn = unique('target');
    await bootstrap(adminUpn, 'dept-admin');
    const adminSession = await login(adminUpn);
    const targetLogin = await login(targetUpn);
    await runtimePool.query("INSERT INTO ems_core.departments (id, name, code) VALUES ('dept-new', 'New', 'NEW')");
    const result = await withDecoyLock(
      runtimePool,
      'SELECT id FROM ems_core.employees WHERE id = $1 FOR UPDATE',
      [targetLogin.session.employeeId],
      async (release) => {
        const assignPromise = administration.assignEmployee({
          actorCredential: adminSession.credential,
          employeeId: targetLogin.session.employeeId,
          departmentId: 'dept-new',
          roleIds: [],
          expectedVersion: 1,
        });
        await waitUntilBlocked(runtimePool, blockedRowPredicate('ems_core.employees'));
        const loginPromise = login(targetUpn);
        await waitUntilBlocked(runtimePool, blockedRowPredicate('ems_core.employees'));
        await release();
        return Promise.all([assignPromise, loginPromise]);
      },
    );
    assert.equal(result[0].ok, true);
    const fresh = result[1];
    assert.equal(fresh.session.departmentId, 'dept-new');
    assert.deepEqual(fresh.session.roleIds, []);
  });

  test('login -> bootstrap: bootstrap активирует существующую PENDING-личность и отзывает сессию', async () => {
    const upn = unique('same-identity');
    const logged = await login(upn);
    const boot = await bootstrap(upn, 'dept-bootstrap');
    assert.equal(boot.employeeId, logged.session.employeeId);
    const row = await employee(boot.employeeId);
    assert.equal(row?.status, 'ACTIVE');
    const sessions = await runtimePool.query<{ reason: string | null }>(
      'SELECT revocation_reason AS reason FROM ems_core.sessions WHERE employee_id = $1', [boot.employeeId],
    );
    assert.equal(sessions.rows[0]?.reason, 'BOOTSTRAP_COMPLETED');
  });

  test('bootstrap -> login: login получает ACTIVE-администратора', async () => {
    const upn = unique('bootstrap-first');
    await bootstrap(upn, 'dept-bootstrap');
    const logged = await login(upn);
    assert.equal(logged.session.isPending, false);
    assert.equal(logged.session.departmentId, 'dept-bootstrap');
    assert.deepEqual(logged.session.roleIds, [ADMIN_ROLE_ID]);
  });

  test('bootstrap существующего ACTIVE-сотрудника назначает администратора перед входом', async () => {
    const existingUpn = unique('existing-employee');
    await runtimePool.query(`
      INSERT INTO ems_core.departments (id, name, code) VALUES ('dept-existing', 'Existing', 'EXISTING');
      INSERT INTO ems_core.employees (id, directory_id, object_guid, upn, display_name, status, department_id)
      VALUES ('employee-existing', 'corp.local', $1, $2, $3, 'ACTIVE', 'dept-existing');
    `, [`guid-${existingUpn}`, existingUpn, `Display ${existingUpn}`]);
    const boot = await bootstrap(existingUpn, 'dept-bootstrap');
    const target = await employee(boot.employeeId);
    assert.equal(target?.status, 'ACTIVE');
    assert.equal(target?.department_id, 'dept-bootstrap');
    const roles = await runtimePool.query<{ role_id: string }>(
      'SELECT role_id FROM ems_core.employee_roles WHERE employee_id = $1', [boot.employeeId],
    );
    assert.deepEqual(roles.rows.map((row) => row.role_id), [ADMIN_ROLE_ID]);
    const fresh = await login(existingUpn);
    assert.equal(fresh.session.departmentId, 'dept-bootstrap');
    assert.deepEqual(fresh.session.roleIds, [ADMIN_ROLE_ID]);
  });

  test('два конкурентных bootstrap: ровно один успех и один конфликт FR-012', async () => {
    const first = unique('bootstrap-a');
    const second = unique('bootstrap-b');
    const results = await Promise.all([identity.bootstrap({ upn: first, initialDepartmentId: 'dept-a' }), identity.bootstrap({ upn: second, initialDepartmentId: 'dept-b' })]);
    assert.equal(results.filter((result) => result.ok).length, 1);
    const conflict = results.find((result) => !result.ok);
    assert.equal(conflict?.ok, false);
    if (conflict && !conflict.ok) assert.match(conflict.error.message, /FR-012/);
    const admins = await runtimePool.query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM ems_core.employees e JOIN ems_core.employee_roles r ON r.employee_id = e.id WHERE e.status = 'ACTIVE' AND r.role_id = $1`, [ADMIN_ROLE_ID]);
    assert.equal(admins.rows[0]?.count, '1');
  });

  test('конкурентное снятие последней админ-роли сохраняет FR-019-инвариант', async () => {
    const adminA = unique('admin-a');
    const adminB = unique('admin-b');
    const boot = await bootstrap(adminA, 'dept-a');
    const sessionA = await login(adminA);
    await runtimePool.query("INSERT INTO ems_core.departments (id, name, code) VALUES ('dept-b', 'B', 'B')");
    const pendingB = await login(adminB);
    const assignedB = await administration.assignEmployee({ actorCredential: sessionA.credential, employeeId: pendingB.session.employeeId, departmentId: 'dept-b', roleIds: [ADMIN_ROLE_ID], expectedVersion: 1 });
    assert.equal(assignedB.ok, true);
    const sessionB = await login(adminB);
    const a = await employee(boot.employeeId);
    const b = await employee(pendingB.session.employeeId);
    const results = await Promise.all([
      administration.assignEmployee({ actorCredential: sessionA.credential, employeeId: boot.employeeId, departmentId: 'dept-a', roleIds: [], expectedVersion: a!.version }),
      administration.assignEmployee({ actorCredential: sessionB.credential, employeeId: pendingB.session.employeeId, departmentId: 'dept-b', roleIds: [], expectedVersion: b!.version }),
    ]);
    assert.ok(results.some((result) => !result.ok && result.error.code === 'CONFLICT'));
    const admins = await runtimePool.query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM ems_core.employees e JOIN ems_core.employee_roles r ON r.employee_id = e.id WHERE e.status = 'ACTIVE' AND r.role_id = $1`, [ADMIN_ROLE_ID]);
    assert.notEqual(admins.rows[0]?.count, '0');
  });

  test('конкурентный setModuleAvailability с одинаковой версией: один успех, один конфликт', async () => {
    const upn = unique('module-admin');
    await bootstrap(upn, 'dept-module');
    const session = await login(upn);
    const initial = await administration.setModuleAvailability({ actorCredential: session.credential, moduleId: 'module-a', departmentId: 'dept-module', enabled: true, expectedVersion: 0 });
    assert.equal(initial.ok, true);
    const results = await Promise.all([
      administration.setModuleAvailability({ actorCredential: session.credential, moduleId: 'module-a', departmentId: 'dept-module', enabled: false, expectedVersion: 1 }),
      administration.setModuleAvailability({ actorCredential: session.credential, moduleId: 'module-a', departmentId: 'dept-module', enabled: true, expectedVersion: 1 }),
    ]);
    assert.equal(results.filter((result) => result.ok).length, 1);
    assert.ok(results.some((result) => !result.ok && result.error.code === 'CONFLICT' && /версии/.test(result.error.message)));
  });

  test('два конкурентных login новой AD-личности используют одну запись employee', async () => {
    const upn = unique('concurrent-login');
    const results = await Promise.all([login(upn), login(upn)]);
    assert.equal(results[0].session.employeeId, results[1].session.employeeId);
    assert.notEqual(results[0].session.sessionId, results[1].session.sessionId);
    const employees = await runtimePool.query<{ count: string }>('SELECT COUNT(*)::text AS count FROM ems_core.employees WHERE directory_id = $1 AND object_guid = $2', ['corp.local', `guid-${upn}`]);
    assert.equal(employees.rows[0]?.count, '1');
  });

  test('audit facade работает с реальным runtime pool', async () => {
    const upn = unique('audit-admin');
    await bootstrap(upn, 'dept-audit');
    const session = await login(upn);
    const result = await audit.query({ actorCredential: session.credential, action: 'BOOTSTRAP', limit: 10 });
    assert.equal(result.ok, true);
  });
});
