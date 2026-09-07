export type Result<T, E = AppError> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

export function fail<E = AppError>(error: E): Result<never, E> {
  return { ok: false, error };
}

export type ErrorCode =
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'NOT_FOUND_OR_FORBIDDEN'
  | 'VALIDATION_FAILED'
  | 'CONFLICT'
  | 'DEPENDENCY_UNAVAILABLE'
  | 'TIMEOUT'
  | 'AUDIT_FAILED'
  | 'INTERNAL_ERROR';

export interface AppError {
  readonly code: ErrorCode;
  readonly message: string;
  readonly retryable: boolean;
  readonly correlationId?: string;
  readonly details?: Readonly<Record<string, unknown>>;
}
