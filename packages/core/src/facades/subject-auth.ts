import crypto from 'node:crypto';
import type { SessionCredential, Result } from '@ems/contracts';
import { ok, fail } from '@ems/contracts';
import type { Queryable } from '../persistence/db.js';
import { SessionRepository, type SessionRow } from '../persistence/session.repository.js';
import { EmployeeRepository, type EmployeeRow } from '../persistence/employee.repository.js';
import { RoleRepository } from '../persistence/role.repository.js';
import { dependencyFailure } from './errors.js';

export function hashCredential(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

export function isValidCredentialFormat(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  return /^[a-f0-9]{64}$/i.test(value);
}

export interface AuthenticatedSubject {
  readonly session: SessionRow;
  readonly employee: EmployeeRow;
  readonly roleIds: readonly string[];
  readonly permissions: readonly string[];
}

export async function verifySubjectCredential(
  q: Queryable,
  credential: SessionCredential | undefined | null,
  options?: { requireActive?: boolean; requireDepartment?: boolean },
): Promise<Result<AuthenticatedSubject>> {
  if (!credential || !isValidCredentialFormat(credential.value)) {
    return fail({
      code: 'UNAUTHENTICATED',
      message: 'Недействительные учетные данные сессии',
      retryable: false,
    });
  }

  const hash = hashCredential(credential.value);
  const sessionRepo = new SessionRepository();
  let session: SessionRow | null;
  try {
    session = await sessionRepo.findActiveByCredentialHash(q, hash);
  } catch {
    return fail(dependencyFailure('Ошибка базы данных при проверке сессии'));
  }
  if (!session) {
    return fail({
      code: 'UNAUTHENTICATED',
      message: 'Сессия не найдена, истекла или была отозвана',
      retryable: false,
    });
  }

  const employeeRepo = new EmployeeRepository();
  let employee: EmployeeRow | null;
  try {
    employee = await employeeRepo.findById(q, session.employee_id);
  } catch {
    return fail(dependencyFailure('Ошибка базы данных при проверке сотрудника'));
  }
  if (!employee) {
    return fail({
      code: 'UNAUTHENTICATED',
      message: 'Сотрудник сессии не найден',
      retryable: false,
    });
  }

  if (options?.requireActive && employee.status !== 'ACTIVE') {
    return fail({
      code: 'FORBIDDEN',
      message: `Сотрудник находится в статусе '${employee.status}', операция запрещена`,
      retryable: false,
    });
  }

  if (options?.requireDepartment && !employee.department_id) {
    return fail({
      code: 'FORBIDDEN',
      message: 'У сотрудника не назначен активный отдел',
      retryable: false,
    });
  }

  const roleRepo = new RoleRepository();
  let roleIds: readonly string[];
  let permissions: readonly string[];
  try {
    roleIds = await employeeRepo.getRolesForEmployee(q, employee.id);
    permissions = await roleRepo.getPermissionsForRoles(q, roleIds);
  } catch {
    return fail(dependencyFailure('Ошибка базы данных при проверке полномочий'));
  }

  return ok({
    session,
    employee,
    roleIds,
    permissions,
  });
}
