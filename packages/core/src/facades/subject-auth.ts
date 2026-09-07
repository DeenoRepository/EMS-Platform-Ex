import crypto from 'node:crypto';
import type { SessionCredential, Result } from '@ems/contracts';
import { ok, fail } from '@ems/contracts';
import type { Queryable } from '../persistence/db.js';
import { SessionRepository, type SessionRow } from '../persistence/session.repository.js';
import { EmployeeRepository, type EmployeeRow } from '../persistence/employee.repository.js';
import { RoleRepository } from '../persistence/role.repository.js';

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
  const session = await sessionRepo.findActiveByCredentialHash(q, hash);
  if (!session) {
    return fail({
      code: 'UNAUTHENTICATED',
      message: 'Сессия не найдена, истекла или была отозвана',
      retryable: false,
    });
  }

  const employeeRepo = new EmployeeRepository();
  const employee = await employeeRepo.findById(q, session.employee_id);
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
  const roleIds = await employeeRepo.getRolesForEmployee(q, employee.id);
  const permissions = await roleRepo.getPermissionsForRoles(q, roleIds);

  return ok({
    session,
    employee,
    roleIds,
    permissions,
  });
}
