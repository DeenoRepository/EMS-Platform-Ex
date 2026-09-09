import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DatabasePool } from '../persistence/db.js';
import { SchemaMigrator } from '../persistence/migrator.js';
import { EmployeeRepository } from '../persistence/employee.repository.js';
import { PostgresAdministrationFacade } from './postgres-administration.facade.js';
import { ADMIN_ROLE_ID, PostgresIdentityFacade } from './postgres-identity.facade.js';
import { PostgresAuthorizationFacade } from './postgres-authorization.facade.js';
import { PostgresAuditFacade } from './postgres-audit.facade.js';
import { ok, type DirectoryAuthenticator, type DirectoryIdentityResolver, type LocalOperatorPort } from '@ems/contracts';
import { blockedByPredicate, blockedRowPredicate, withDecoyLock, waitUntilBlocked } from '../persistence/pg-test-barrier.js';
import { hashCredential } from './subject-auth.js';

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
      async (release, blockerPid, track) => {
        const loginPromise = track(login(targetUpn));
        await waitUntilBlocked(runtimePool, blockedRowPredicate('ems_core.employees', blockerPid));
        const assignPromise = track(administration.assignEmployee({
          actorCredential: adminSession.credential,
          employeeId: targetId,
          departmentId: 'dept-admin',
          roleIds: [],
          expectedVersion: 1,
        }));
        await waitUntilBlocked(runtimePool, blockedRowPredicate('ems_core.employees', blockerPid), 10000, 2);
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
      async (release, blockerPid, track) => {
        const assignPromise = track(administration.assignEmployee({
          actorCredential: adminSession.credential,
          employeeId: targetLogin.session.employeeId,
          departmentId: 'dept-new',
          roleIds: [],
          expectedVersion: 1,
        }));
        await waitUntilBlocked(runtimePool, blockedRowPredicate('ems_core.employees', blockerPid));
        const loginPromise = track(login(targetUpn));
        await waitUntilBlocked(runtimePool, blockedRowPredicate('ems_core.employees', blockerPid), 10000, 2);
        await release();
        return Promise.all([assignPromise, loginPromise]);
      },
    );
    assert.equal(result[0].ok, true);
    const fresh = result[1];
    assert.equal(fresh.session.departmentId, 'dept-new');
    assert.deepEqual(fresh.session.roleIds, []);
  });

  test('login -> bootstrap: обе операции достигают row-lock и bootstrap отзывает созданную сессию', async () => {
    const upn = unique('same-identity');
    const initial = await login(upn);
    const [logged, boot] = await withDecoyLock(
      runtimePool,
      'SELECT id FROM ems_core.employees WHERE id = $1 FOR UPDATE',
      [initial.session.employeeId],
      async (release, blockerPid, track) => {
        const loginPromise = track(login(upn));
        await waitUntilBlocked(runtimePool, blockedRowPredicate('ems_core.employees', blockerPid));
        const bootstrapPromise = track(bootstrap(upn, 'dept-bootstrap'));
        await waitUntilBlocked(runtimePool, blockedRowPredicate('ems_core.employees', blockerPid), 10000, 2);
        await release();
        return Promise.all([loginPromise, bootstrapPromise]);
      },
    );
    assert.equal(boot.employeeId, logged.session.employeeId);
    const row = await employee(boot.employeeId);
    assert.equal(row?.status, 'ACTIVE');
    const sessions = await runtimePool.query<{ reason: string | null }>(
      'SELECT revocation_reason AS reason FROM ems_core.sessions WHERE employee_id = $1', [boot.employeeId],
    );
    assert.equal(sessions.rows[0]?.reason, 'BOOTSTRAP_COMPLETED');
  });

  test('bootstrap -> login: login ожидает bootstrap и получает ACTIVE-администратора', async () => {
    const upn = unique('bootstrap-first');
    const initial = await login(upn);
    const [boot, logged] = await withDecoyLock(
      runtimePool,
      'SELECT id FROM ems_core.employees WHERE id = $1 FOR UPDATE',
      [initial.session.employeeId],
      async (release, blockerPid, track) => {
        const bootstrapPromise = track(bootstrap(upn, 'dept-bootstrap'));
        await waitUntilBlocked(runtimePool, blockedRowPredicate('ems_core.employees', blockerPid));
        const loginPromise = track(login(upn));
        await waitUntilBlocked(runtimePool, blockedRowPredicate('ems_core.employees', blockerPid), 10000, 2);
        await release();
        return Promise.all([bootstrapPromise, loginPromise]);
      },
    );
    assert.equal(boot.employeeId, logged.session.employeeId);
    assert.equal(logged.session.isPending, false);
    assert.equal(logged.session.departmentId, 'dept-bootstrap');
    assert.deepEqual(logged.session.roleIds, [ADMIN_ROLE_ID]);
  });

  test('bootstrap существующего ACTIVE-сотрудника назначает администратора перед входом', async () => {
    const existingUpn = unique('existing-employee');
    await runtimePool.query("INSERT INTO ems_core.departments (id, name, code) VALUES ('dept-existing', 'Existing', 'EXISTING')");
    await runtimePool.query(
      `INSERT INTO ems_core.employees (id, directory_id, object_guid, upn, display_name, status, department_id)
       VALUES ('employee-existing', 'corp.local', $1, $2, $3, 'ACTIVE', 'dept-existing')`,
      [`guid-${existingUpn}`, existingUpn, `Display ${existingUpn}`],
    );
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

  test('конкурентное назначение одного сотрудника сохраняет optimistic-lock invariant', async () => {
    const adminA = unique('admin-a');
    const adminB = unique('admin-b');
    const targetUpn = unique('assignment-target');
    await bootstrap(adminA, 'dept-a');
    const sessionA = await login(adminA);
    await runtimePool.query("INSERT INTO ems_core.departments (id, name, code) VALUES ('dept-b', 'B', 'B')");
    const pendingB = await login(adminB);
    const assignedB = await administration.assignEmployee({ actorCredential: sessionA.credential, employeeId: pendingB.session.employeeId, departmentId: 'dept-b', roleIds: [ADMIN_ROLE_ID], expectedVersion: 1 });
    assert.equal(assignedB.ok, true);
    const sessionB = await login(adminB);
    const targetLogin = await login(targetUpn);
    const targetRow = await employee(targetLogin.session.employeeId);
    const results = await Promise.all([
      administration.assignEmployee({ actorCredential: sessionA.credential, employeeId: targetLogin.session.employeeId, departmentId: 'dept-a', roleIds: [], expectedVersion: targetRow!.version }),
      administration.assignEmployee({ actorCredential: sessionB.credential, employeeId: targetLogin.session.employeeId, departmentId: 'dept-b', roleIds: [], expectedVersion: targetRow!.version }),
    ]);
    assert.equal(results.filter((result) => result.ok).length, 1);
    assert.ok(results.some((result) => !result.ok && result.error.code === 'CONFLICT'));
  });

  test('взаимное конкурентное снятие admin-ролей сохраняет одного администратора', async () => {
    const adminA = unique('mutual-admin-a');
    const adminB = unique('mutual-admin-b');
    await bootstrap(adminA, 'dept-mutual-a');
    const sessionA = await login(adminA);
    const pendingB = await login(adminB);
    const assignedB = await administration.assignEmployee({
      actorCredential: sessionA.credential,
      employeeId: pendingB.session.employeeId,
      departmentId: 'dept-mutual-a',
      roleIds: [ADMIN_ROLE_ID],
      expectedVersion: 1,
    });
    assert.equal(assignedB.ok, true);
    const sessionB = await login(adminB);
    const rowA = await employee(sessionA.session.employeeId);
    const rowB = await employee(sessionB.session.employeeId);
    const assignmentAuditBefore = await runtimePool.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM ems_core.audit_log WHERE action = 'ASSIGN_EMPLOYEE'",
    );
    const results = await withDecoyLock(
      runtimePool,
      'SELECT id FROM ems_core.bootstrap_state WHERE id = 1 FOR UPDATE',
      [],
      async (release, blockerPid, track) => {
        const first = track(administration.assignEmployee({
          actorCredential: sessionA.credential,
          employeeId: sessionB.session.employeeId,
          departmentId: 'dept-mutual-a',
          roleIds: [],
          expectedVersion: rowB!.version,
        }));
        await waitUntilBlocked(runtimePool, blockedByPredicate(blockerPid));
        const second = track(administration.assignEmployee({
          actorCredential: sessionB.credential,
          employeeId: sessionA.session.employeeId,
          departmentId: 'dept-mutual-a',
          roleIds: [],
          expectedVersion: rowA!.version,
        }));
        const operations = Promise.all([first, second]);
        await waitUntilBlocked(runtimePool, blockedByPredicate(blockerPid), 10000, 2);
        await release();
        return operations;
      },
    );
    assert.equal(results.filter((result) => result.ok).length, 1);
    assert.equal(results.filter((result) => !result.ok && result.error.code === 'UNAUTHENTICATED').length, 1);

    const admins = await runtimePool.query<{ employee_id: string }>(
      `SELECT e.id AS employee_id
       FROM ems_core.employees e
       JOIN ems_core.employee_roles er ON er.employee_id = e.id
       WHERE e.status = 'ACTIVE' AND er.role_id = $1`,
      [ADMIN_ROLE_ID],
    );
    assert.equal(admins.rows.length, 1);
    const survivorId = admins.rows[0]!.employee_id;
    assert.ok([sessionA.session.employeeId, sessionB.session.employeeId].includes(survivorId));
    const removedId = survivorId === sessionA.session.employeeId
      ? sessionB.session.employeeId
      : sessionA.session.employeeId;
    const survivorBefore = survivorId === sessionA.session.employeeId ? rowA! : rowB!;
    const survivorAfter = await employee(survivorId);
    assert.equal(survivorAfter?.version, survivorBefore.version);
    assert.equal(survivorAfter?.department_id, survivorBefore.department_id);
    const revoked = await runtimePool.query<{ revoked_at: string | null }>(
      'SELECT revoked_at::text FROM ems_core.sessions WHERE employee_id = $1 AND revoked_at IS NOT NULL',
      [removedId],
    );
    assert.ok(revoked.rows.length >= 1);
    const survivorSession = await runtimePool.query<{ revoked_at: string | null }>(
      'SELECT revoked_at::text FROM ems_core.sessions WHERE id = $1',
      [survivorId === sessionA.session.employeeId ? sessionA.session.sessionId : sessionB.session.sessionId],
    );
    assert.equal(survivorSession.rows[0]?.revoked_at, null);
    const assignmentAuditAfter = await runtimePool.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM ems_core.audit_log WHERE action = 'ASSIGN_EMPLOYEE'",
    );
    assert.equal(
      Number(assignmentAuditAfter.rows[0]?.count),
      Number(assignmentAuditBefore.rows[0]?.count) + 1,
    );
  });

  test('обратный порядок взаимного снятия admin-ролей сохраняет одного администратора', async () => {
    const adminA = unique('reverse-admin-a');
    const adminB = unique('reverse-admin-b');
    await bootstrap(adminA, 'dept-reverse-admin');
    const sessionA = await login(adminA);
    const pendingB = await login(adminB);
    const assignedB = await administration.assignEmployee({
      actorCredential: sessionA.credential,
      employeeId: pendingB.session.employeeId,
      departmentId: 'dept-reverse-admin',
      roleIds: [ADMIN_ROLE_ID],
      expectedVersion: 1,
    });
    assert.equal(assignedB.ok, true);
    const sessionB = await login(adminB);
    const rowA = await employee(sessionA.session.employeeId);
    const rowB = await employee(sessionB.session.employeeId);
    const results = await withDecoyLock(
      runtimePool,
      'SELECT id FROM ems_core.bootstrap_state WHERE id = 1 FOR UPDATE',
      [],
      async (release, blockerPid, track) => {
        const first = track(administration.assignEmployee({
          actorCredential: sessionB.credential,
          employeeId: sessionA.session.employeeId,
          departmentId: 'dept-reverse-admin',
          roleIds: [],
          expectedVersion: rowA!.version,
        }));
        await waitUntilBlocked(runtimePool, blockedByPredicate(blockerPid));
        const second = track(administration.assignEmployee({
          actorCredential: sessionA.credential,
          employeeId: sessionB.session.employeeId,
          departmentId: 'dept-reverse-admin',
          roleIds: [],
          expectedVersion: rowB!.version,
        }));
        await waitUntilBlocked(runtimePool, blockedByPredicate(blockerPid), 10000, 2);
        await release();
        return Promise.all([first, second]);
      },
    );
    assert.equal(results.filter((result) => result.ok).length, 1);
    assert.equal(results.filter((result) => !result.ok && result.error.code === 'UNAUTHENTICATED').length, 1);
    const admins = await runtimePool.query<{ employee_id: string }>(
      `SELECT e.id AS employee_id FROM ems_core.employees e
       JOIN ems_core.employee_roles er ON er.employee_id = e.id
       WHERE e.status = 'ACTIVE' AND er.role_id = $1`,
      [ADMIN_ROLE_ID],
    );
    assert.equal(admins.rows.length, 1);
    assert.equal(admins.rows[0]?.employee_id, sessionB.session.employeeId);
  });

  test('отказ аудита откатывает login и assignment на PostgreSQL', async () => {
    const adminUpn = unique('fault-admin');
    const targetUpn = unique('fault-target');
    await bootstrap(adminUpn, 'dept-fault');
    const adminSession = await login(adminUpn);
    const targetSession = await login(targetUpn);
    await migrationPool.query(`
      CREATE OR REPLACE FUNCTION ems_core.reject_audit_insert() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic audit failure'; END; $$;
      CREATE TRIGGER reject_audit_insert BEFORE INSERT ON ems_core.audit_log
      FOR EACH ROW EXECUTE FUNCTION ems_core.reject_audit_insert();
    `);
    try {
      const faultLoginUpn = unique('fault-login');
      const loginResult = await identity.login({ upn: faultLoginUpn, password: 'synthetic-password' });
      assert.equal(loginResult.ok, false);
      const loginCount = await runtimePool.query<{ count: string }>(
        'SELECT COUNT(*)::text AS count FROM ems_core.employees WHERE upn = $1', [faultLoginUpn],
      );
      assert.equal(loginCount.rows[0]?.count, '0');

      const before = await employee(targetSession.session.employeeId);
      const assignment = await administration.assignEmployee({
        actorCredential: adminSession.credential,
        employeeId: targetSession.session.employeeId,
        departmentId: 'dept-fault',
        roleIds: [],
        expectedVersion: before!.version,
      });
      assert.equal(assignment.ok, false);
      const after = await employee(targetSession.session.employeeId);
      assert.equal(after?.version, before?.version);
      assert.equal(after?.department_id, before?.department_id);
      const sessions = await runtimePool.query<{ revoked_at: string | null }>(
        'SELECT revoked_at::text FROM ems_core.sessions WHERE employee_id = $1', [targetSession.session.employeeId],
      );
      assert.equal(sessions.rows.some((row) => row.revoked_at !== null), false);
    } finally {
      await migrationPool.query('DROP TRIGGER IF EXISTS reject_audit_insert ON ems_core.audit_log; DROP FUNCTION IF EXISTS ems_core.reject_audit_insert();');
    }
  });

  test('отказ аудита откатывает bootstrap и setModuleAvailability на PostgreSQL', async () => {
    await migrationPool.query(`
      CREATE OR REPLACE FUNCTION ems_core.reject_audit_insert() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic audit failure'; END; $$;
      CREATE TRIGGER reject_audit_insert BEFORE INSERT ON ems_core.audit_log
      FOR EACH ROW EXECUTE FUNCTION ems_core.reject_audit_insert();
    `);
    try {
      const bootstrapUpn = unique('fault-bootstrap');
      const bootstrapResult = await identity.bootstrap({ upn: bootstrapUpn, initialDepartmentId: 'dept-fault-bootstrap' });
      assert.equal(bootstrapResult.ok, false);
      const bootstrapState = await runtimePool.query<{ status: string }>(
        'SELECT status FROM ems_core.bootstrap_state WHERE id = 1',
      );
      const bootstrapEmployee = await runtimePool.query<{ count: string }>(
        'SELECT COUNT(*)::text AS count FROM ems_core.employees WHERE upn = $1',
        [bootstrapUpn],
      );
      const bootstrapDepartment = await runtimePool.query<{ count: string }>(
        "SELECT COUNT(*)::text AS count FROM ems_core.departments WHERE id = 'dept-fault-bootstrap'",
      );
      const bootstrapRole = await runtimePool.query<{ count: string }>(
        'SELECT COUNT(*)::text AS count FROM ems_core.roles WHERE id = $1',
        [ADMIN_ROLE_ID],
      );
      const bootstrapPermissions = await runtimePool.query<{ count: string }>(
        'SELECT COUNT(*)::text AS count FROM ems_core.role_permissions WHERE role_id = $1',
        [ADMIN_ROLE_ID],
      );
      const bootstrapSessions = await runtimePool.query<{ count: string }>(
        'SELECT COUNT(*)::text AS count FROM ems_core.sessions',
      );
      assert.equal(bootstrapState.rows[0]?.status, 'ready');
      assert.equal(bootstrapEmployee.rows[0]?.count, '0');
      assert.equal(bootstrapDepartment.rows[0]?.count, '0');
      assert.equal(bootstrapRole.rows[0]?.count, '0');
      assert.equal(bootstrapPermissions.rows[0]?.count, '0');
      assert.equal(bootstrapSessions.rows[0]?.count, '0');
    } finally {
      await migrationPool.query('DROP TRIGGER IF EXISTS reject_audit_insert ON ems_core.audit_log;');
    }

    const adminUpn = unique('fault-module-admin');
    await bootstrap(adminUpn, 'dept-fault-module');
    const adminSession = await login(adminUpn);
    await migrationPool.query('CREATE TRIGGER reject_audit_insert BEFORE INSERT ON ems_core.audit_log FOR EACH ROW EXECUTE FUNCTION ems_core.reject_audit_insert();');
    try {
      const availability = await administration.setModuleAvailability({
        actorCredential: adminSession.credential,
        moduleId: 'fault-module',
        departmentId: 'dept-fault-module',
        enabled: true,
        expectedVersion: 0,
      });
      assert.equal(availability.ok, false);
      const rows = await runtimePool.query<{ count: string }>(
        "SELECT COUNT(*)::text AS count FROM ems_core.module_availability WHERE module_id = 'fault-module'",
      );
      assert.equal(rows.rows[0]?.count, '0');
    } finally {
      await migrationPool.query('DROP TRIGGER IF EXISTS reject_audit_insert ON ems_core.audit_log; DROP FUNCTION IF EXISTS ems_core.reject_audit_insert();');
    }
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

  test('делегирование роли с modules.manage отклоняется оператору без этого права', async () => {
    const adminUpn = unique('delegation-admin');
    const targetUpn = unique('delegation-target');
    await bootstrap(adminUpn, 'dept-delegation');
    const adminSession = await login(adminUpn);
    const targetSession = await login(targetUpn);
    await runtimePool.query(
      `INSERT INTO ems_core.roles (id, name, description, is_system)
       VALUES ('role.module.manager', 'Module manager', NULL, false)
       ON CONFLICT (id) DO NOTHING`,
    );
    await runtimePool.query(
      `INSERT INTO ems_core.role_permissions (role_id, permission_id)
       VALUES ('role.module.manager', 'modules.manage') ON CONFLICT DO NOTHING`,
    );
    await runtimePool.query(
      `DELETE FROM ems_core.employee_roles WHERE employee_id = $1`,
      [adminSession.session.employeeId],
    );
    await runtimePool.query(
      `INSERT INTO ems_core.roles (id, name, description, is_system)
       VALUES ('role.employee.manager', 'Employee manager', NULL, false)
       ON CONFLICT (id) DO NOTHING`,
    );
    await runtimePool.query(
      `INSERT INTO ems_core.role_permissions (role_id, permission_id)
       VALUES ('role.employee.manager', 'employees.manage') ON CONFLICT DO NOTHING`,
    );
    await runtimePool.query(
      `INSERT INTO ems_core.employee_roles (employee_id, role_id)
       VALUES ($1, 'role.employee.manager')`,
      [adminSession.session.employeeId],
    );

    const result = await administration.assignEmployee({
      actorCredential: adminSession.credential,
      employeeId: targetSession.session.employeeId,
      departmentId: 'dept-delegation',
      roleIds: ['role.module.manager'],
      expectedVersion: 1,
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, 'FORBIDDEN');
  });

  test('BLOCKED сотрудник не реактивируется и не получает побочных эффектов назначения', async () => {
    const adminUpn = unique('blocked-guard-admin');
    const targetUpn = unique('blocked-guard-target');
    await bootstrap(adminUpn, 'dept-blocked-guard');
    const adminSession = await login(adminUpn);
    const targetSession = await login(targetUpn);
    await runtimePool.query(
      "UPDATE ems_core.employees SET status = 'BLOCKED' WHERE id = $1",
      [targetSession.session.employeeId],
    );
    const before = await employee(targetSession.session.employeeId);
    const auditBefore = await runtimePool.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM ems_core.audit_log WHERE action = 'ASSIGN_EMPLOYEE' AND object_id = $1",
      [targetSession.session.employeeId],
    );
    const result = await administration.assignEmployee({
      actorCredential: adminSession.credential,
      employeeId: targetSession.session.employeeId,
      departmentId: 'dept-blocked-guard',
      roleIds: [],
      expectedVersion: before!.version,
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, 'FORBIDDEN');
    const after = await employee(targetSession.session.employeeId);
    const session = await runtimePool.query<{ revoked_at: string | null }>(
      'SELECT revoked_at::text FROM ems_core.sessions WHERE id = $1',
      [targetSession.session.sessionId],
    );
    const auditAfter = await runtimePool.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM ems_core.audit_log WHERE action = 'ASSIGN_EMPLOYEE' AND object_id = $1",
      [targetSession.session.employeeId],
    );
    assert.equal(after?.status, 'BLOCKED');
    assert.equal(after?.version, before?.version);
    assert.equal(after?.department_id, before?.department_id);
    assert.equal(session.rows[0]?.revoked_at, null);
    assert.equal(auditAfter.rows[0]?.count, auditBefore.rows[0]?.count);
  });

  test('оператор только с employees.manage не реактивирует BLOCKED администратора с неизменной ролью', async () => {
    const firstAdminUpn = unique('blocked-admin-owner');
    const blockedAdminUpn = unique('blocked-admin-target');
    const managerUpn = unique('blocked-admin-manager');
    await bootstrap(firstAdminUpn, 'dept-blocked-admin');
    const firstAdminSession = await login(firstAdminUpn);
    const blockedPending = await login(blockedAdminUpn);
    const blockedAssigned = await administration.assignEmployee({
      actorCredential: firstAdminSession.credential,
      employeeId: blockedPending.session.employeeId,
      departmentId: 'dept-blocked-admin',
      roleIds: [ADMIN_ROLE_ID],
      expectedVersion: 1,
    });
    assert.equal(blockedAssigned.ok, true);
    const managerPending = await login(managerUpn);
    await runtimePool.query(
      `INSERT INTO ems_core.roles (id, name, is_system)
       VALUES ('role.employee.manager.r1', 'R1 employee manager', false)`,
    );
    await runtimePool.query(
      `INSERT INTO ems_core.role_permissions (role_id, permission_id)
       VALUES ('role.employee.manager.r1', 'employees.manage')`,
    );
    await runtimePool.query(
      `UPDATE ems_core.employees
       SET status = 'ACTIVE', department_id = 'dept-blocked-admin', version = version + 1
       WHERE id = $1`,
      [managerPending.session.employeeId],
    );
    await runtimePool.query(
      `INSERT INTO ems_core.employee_roles (employee_id, role_id)
       VALUES ($1, 'role.employee.manager.r1')`,
      [managerPending.session.employeeId],
    );
    const managerSession = await login(managerUpn);
    await runtimePool.query(
      "UPDATE ems_core.employees SET status = 'BLOCKED' WHERE id = $1",
      [blockedPending.session.employeeId],
    );
    const before = await employee(blockedPending.session.employeeId);
    const rolesBefore = await runtimePool.query<{ role_id: string }>(
      'SELECT role_id FROM ems_core.employee_roles WHERE employee_id = $1 ORDER BY role_id',
      [blockedPending.session.employeeId],
    );
    const result = await administration.assignEmployee({
      actorCredential: managerSession.credential,
      employeeId: blockedPending.session.employeeId,
      departmentId: 'dept-blocked-admin',
      roleIds: [ADMIN_ROLE_ID],
      expectedVersion: before!.version,
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, 'FORBIDDEN');
    const after = await employee(blockedPending.session.employeeId);
    const rolesAfter = await runtimePool.query<{ role_id: string }>(
      'SELECT role_id FROM ems_core.employee_roles WHERE employee_id = $1 ORDER BY role_id',
      [blockedPending.session.employeeId],
    );
    assert.equal(after?.status, 'BLOCKED');
    assert.equal(after?.version, before?.version);
    assert.deepEqual(rolesAfter.rows, rolesBefore.rows);
  });

  test('заблокированный login сохраняет аудит без сессии, а отказ аудита возвращает AUDIT_FAILED', async () => {
    const upn = unique('blocked-login-pg');
    const first = await login(upn);
    await runtimePool.query("UPDATE ems_core.employees SET status = 'BLOCKED' WHERE id = $1", [first.session.employeeId]);
    const sessionsBefore = await runtimePool.query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM ems_core.sessions WHERE employee_id = $1',
      [first.session.employeeId],
    );
    const blocked = await identity.login({ upn, password: 'synthetic-password' });
    assert.equal(blocked.ok, false);
    if (!blocked.ok) assert.equal(blocked.error.code, 'FORBIDDEN');
    const auditCount = await runtimePool.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM ems_core.audit_log WHERE action = 'LOGIN_BLOCKED' AND object_id = $1",
      [first.session.employeeId],
    );
    const sessionsAfter = await runtimePool.query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM ems_core.sessions WHERE employee_id = $1',
      [first.session.employeeId],
    );
    assert.equal(auditCount.rows[0]?.count, '1');
    assert.equal(sessionsAfter.rows[0]?.count, sessionsBefore.rows[0]?.count);

    await migrationPool.query(`
      CREATE OR REPLACE FUNCTION ems_core.reject_audit_insert() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic audit failure'; END; $$;
      CREATE TRIGGER reject_audit_insert BEFORE INSERT ON ems_core.audit_log
      FOR EACH ROW EXECUTE FUNCTION ems_core.reject_audit_insert();
    `);
    try {
      const failedAudit = await identity.login({ upn, password: 'synthetic-password' });
      assert.equal(failedAudit.ok, false);
      if (!failedAudit.ok) assert.equal(failedAudit.error.code, 'AUDIT_FAILED');
    } finally {
      await migrationPool.query('DROP TRIGGER IF EXISTS reject_audit_insert ON ems_core.audit_log; DROP FUNCTION IF EXISTS ems_core.reject_audit_insert();');
    }
  });

  test('успешная авторизация продлевает idle TTL, но не за absolute TTL', async () => {
    const upn = unique('idle-admin');
    await bootstrap(upn, 'dept-idle');
    const session = await login(upn);
    const expiresAt = new Date(Date.now() + 10_000);
    const idleBefore = new Date(Date.now() + 1_000);
    await runtimePool.query(
      `UPDATE ems_core.sessions
       SET expires_at = $2, idle_expires_at = $3
       WHERE credential_hash = $1`,
      [hashCredential(session.credential.value), expiresAt.toISOString(), idleBefore.toISOString()],
    );
    const authorization = new PostgresAuthorizationFacade(runtimePool);
    const result = await authorization.authorize({ credential: session.credential, permission: 'platform.admin' });
    assert.equal(result.ok, true);
    const row = await runtimePool.query<{ idle_expires_at: string; expires_at: string }>(
      `SELECT idle_expires_at::text, expires_at::text FROM ems_core.sessions
       WHERE credential_hash = $1`,
      [hashCredential(session.credential.value)],
    );
    assert.ok(new Date(row.rows[0]!.idle_expires_at) > idleBefore);
    assert.ok(new Date(row.rows[0]!.idle_expires_at) <= new Date(row.rows[0]!.expires_at));
  });

  test('background/denied authorize не продлевают idle TTL, absolute deadline не обновляется', async () => {
    const upn = unique('idle-background-admin');
    await bootstrap(upn, 'dept-idle-background');
    const session = await login(upn);
    const authorization = new PostgresAuthorizationFacade(runtimePool);
    const hash = hashCredential(session.credential.value);
    const expiresAt = new Date(Date.now() + 10_000);
    const idleBefore = new Date(Date.now() + 1_000);
    await runtimePool.query(
      'UPDATE ems_core.sessions SET expires_at = $2, idle_expires_at = $3 WHERE credential_hash = $1',
      [hash, expiresAt.toISOString(), idleBefore.toISOString()],
    );
    const initial = await runtimePool.query<{ idle_expires_at: string; xmin: string }>(
      'SELECT idle_expires_at::text, xmin::text FROM ems_core.sessions WHERE credential_hash = $1',
      [hash],
    );
    const background = await authorization.authorizeBackground({ credential: session.credential, permission: 'platform.admin' });
    assert.deepEqual(background, { ok: true, value: { allowed: true } });
    const denied = await authorization.authorize({ credential: session.credential, permission: 'missing.permission' });
    assert.equal(denied.ok, true);
    if (denied.ok) assert.equal(denied.value.allowed, false);
    const unchanged = await runtimePool.query<{ idle_expires_at: string; xmin: string }>(
      'SELECT idle_expires_at::text, xmin::text FROM ems_core.sessions WHERE credential_hash = $1',
      [hash],
    );
    assert.deepEqual(unchanged.rows[0], initial.rows[0]);

    await runtimePool.query('UPDATE ems_core.sessions SET idle_expires_at = expires_at WHERE credential_hash = $1', [hash]);
    const atDeadline = await runtimePool.query<{ xmin: string }>(
      'SELECT xmin::text FROM ems_core.sessions WHERE credential_hash = $1',
      [hash],
    );
    const foreground = await authorization.authorize({ credential: session.credential, permission: 'platform.admin' });
    assert.deepEqual(foreground, { ok: true, value: { allowed: true } });
    const afterDeadline = await runtimePool.query<{ xmin: string }>(
      'SELECT xmin::text FROM ems_core.sessions WHERE credential_hash = $1',
      [hash],
    );
    assert.equal(afterDeadline.rows[0]?.xmin, atDeadline.rows[0]?.xmin);
  });

  test('ошибка idle renewal не отменяет уже разрешенную авторизацию', async () => {
    const upn = unique('idle-renewal-failure');
    await bootstrap(upn, 'dept-idle-renewal-failure');
    const session = await login(upn);
    const hash = hashCredential(session.credential.value);
    await runtimePool.query(
      "UPDATE ems_core.sessions SET idle_expires_at = NOW() + INTERVAL '1 minute' WHERE credential_hash = $1",
      [hash],
    );
    await migrationPool.query(`
      CREATE OR REPLACE FUNCTION ems_core.reject_session_update() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic renewal failure'; END; $$;
      CREATE TRIGGER reject_session_update BEFORE UPDATE ON ems_core.sessions
      FOR EACH ROW EXECUTE FUNCTION ems_core.reject_session_update();
    `);
    try {
      const result = await new PostgresAuthorizationFacade(runtimePool).authorize({
        credential: session.credential,
        permission: 'platform.admin',
      });
      assert.deepEqual(result, { ok: true, value: { allowed: true } });
    } finally {
      await migrationPool.query('DROP TRIGGER IF EXISTS reject_session_update ON ems_core.sessions; DROP FUNCTION IF EXISTS ems_core.reject_session_update();');
    }
  });

  test('foreground и background authorization отклоняют expired и revoked сессии без renewal', async () => {
    const upn = unique('inactive-session-admin');
    await bootstrap(upn, 'dept-inactive-session');
    const expiredSession = await login(upn);
    const revokedSession = await login(upn);
    const authorization = new PostgresAuthorizationFacade(runtimePool);
    const expiredHash = hashCredential(expiredSession.credential.value);
    const revokedHash = hashCredential(revokedSession.credential.value);
    await runtimePool.query(
      "UPDATE ems_core.sessions SET expires_at = NOW() - INTERVAL '1 second', idle_expires_at = NOW() - INTERVAL '1 second' WHERE credential_hash = $1",
      [expiredHash],
    );
    await runtimePool.query(
      "UPDATE ems_core.sessions SET revoked_at = NOW(), revocation_reason = 'TEST_REVOCATION' WHERE credential_hash = $1",
      [revokedHash],
    );
    const before = await runtimePool.query<{ credential_hash: string; xmin: string }>(
      'SELECT credential_hash, xmin::text FROM ems_core.sessions WHERE credential_hash = ANY($1::text[]) ORDER BY credential_hash',
      [[expiredHash, revokedHash]],
    );
    const results = await Promise.all([
      authorization.authorize({ credential: expiredSession.credential, permission: 'platform.admin' }),
      authorization.authorizeBackground({ credential: expiredSession.credential, permission: 'platform.admin' }),
      authorization.authorize({ credential: revokedSession.credential, permission: 'platform.admin' }),
      authorization.authorizeBackground({ credential: revokedSession.credential, permission: 'platform.admin' }),
    ]);
    for (const result of results) {
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.error.code, 'UNAUTHENTICATED');
    }
    const after = await runtimePool.query<{ credential_hash: string; xmin: string }>(
      'SELECT credential_hash, xmin::text FROM ems_core.sessions WHERE credential_hash = ANY($1::text[]) ORDER BY credential_hash',
      [[expiredHash, revokedHash]],
    );
    assert.deepEqual(after.rows, before.rows);
  });
});
