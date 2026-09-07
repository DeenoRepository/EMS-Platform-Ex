import type { Result } from './result.js';

export interface SessionContext {
  readonly sessionId: string;
  readonly employeeId: string;
  readonly departmentId: string | null;
  readonly roleIds: readonly string[];
  readonly permissions: readonly string[];
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly isPending: boolean;
  readonly isBlocked: boolean;
}

export interface LoginInput {
  readonly upn: string;
  readonly password: string;
}

export interface LoginOutput {
  readonly session: SessionContext;
}

export interface BootstrapInput {
  readonly operatorId: string;
  readonly upn: string;
  readonly initialDepartmentId: string;
}

export interface BootstrapOutput {
  readonly employeeId: string;
  readonly departmentId: string;
  readonly roleId: string;
}

export interface AuthorizeInput {
  readonly sessionContext: SessionContext;
  readonly permission: string;
  readonly resourceScope?: string;
  readonly moduleId?: string;
}

export interface AuthorizeOutput {
  readonly allowed: boolean;
  readonly reason?: string;
}

export interface AssignEmployeeInput {
  readonly employeeId: string;
  readonly departmentId: string;
  readonly roleIds: readonly string[];
  readonly expectedVersion?: number;
}

export interface AssignEmployeeOutput {
  readonly employeeId: string;
  readonly departmentId: string;
  readonly roleIds: readonly string[];
  readonly version: number;
}

export interface SetModuleAvailabilityInput {
  readonly moduleId: string;
  readonly departmentId: string;
  readonly enabled: boolean;
  readonly expectedVersion?: number;
}

export interface SetModuleAvailabilityOutput {
  readonly moduleId: string;
  readonly departmentId: string;
  readonly enabled: boolean;
}

export interface AuditQueryInput {
  readonly periodStart?: string;
  readonly periodEnd?: string;
  readonly action?: string;
  readonly subjectId?: string;
  readonly cursor?: string;
  readonly limit?: number;
}

export interface AuditRecord {
  readonly id: string;
  readonly timestamp: string;
  readonly subjectId: string;
  readonly action: string;
  readonly objectType: string;
  readonly objectId: string;
  readonly result: 'SUCCESS' | 'FAILURE';
  readonly correlationId?: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

export interface AuditQueryOutput {
  readonly items: readonly AuditRecord[];
  readonly nextCursor?: string;
}

export interface LogoutInput {
  readonly sessionId: string;
}

export interface IdentityFacade {
  login(input: LoginInput): Promise<Result<LoginOutput>>;
  bootstrap(input: BootstrapInput): Promise<Result<BootstrapOutput>>;
}

export interface AuthorizationFacade {
  authorize(input: AuthorizeInput): Promise<Result<AuthorizeOutput>>;
}

export interface AdministrationFacade {
  assignEmployee(input: AssignEmployeeInput): Promise<Result<AssignEmployeeOutput>>;
  setModuleAvailability(input: SetModuleAvailabilityInput): Promise<Result<SetModuleAvailabilityOutput>>;
}

export interface AuditFacade {
  query(input: AuditQueryInput): Promise<Result<AuditQueryOutput>>;
}

export interface SessionFacade {
  logout(input: LogoutInput): Promise<Result<void>>;
}
