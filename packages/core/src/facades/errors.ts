import crypto from 'node:crypto';
import type { AppError, ErrorCode, Result } from '@ems/contracts';
import { fail } from '@ems/contracts';

const SAFE_CODES = new Set<ErrorCode>([
  'UNAUTHENTICATED', 'FORBIDDEN', 'NOT_FOUND_OR_FORBIDDEN', 'VALIDATION_FAILED',
  'CONFLICT', 'DEPENDENCY_UNAVAILABLE', 'TIMEOUT', 'AUDIT_FAILED', 'INTERNAL_ERROR',
]);

export function dependencyFailure(message: string, retryable = true): AppError {
  return { code: 'DEPENDENCY_UNAVAILABLE', message, retryable, correlationId: crypto.randomUUID() };
}

export function normalizeDependencyResult<T>(result: unknown, message: string): Result<T> {
  if (!result || typeof result !== 'object' || typeof (result as { ok?: unknown }).ok !== 'boolean') {
    return fail(dependencyFailure(message));
  }
  if ((result as { ok: boolean }).ok) {
    return { ok: true, value: (result as { value: T }).value };
  }
  const error = (result as { error?: unknown }).error;
  if (!error || typeof error !== 'object') return fail(dependencyFailure(message));
  const candidate = error as Partial<AppError>;
  if (
    typeof candidate.code !== 'string' || !SAFE_CODES.has(candidate.code as ErrorCode) ||
    typeof candidate.message !== 'string' || typeof candidate.retryable !== 'boolean'
  ) {
    return fail(dependencyFailure(message));
  }
  return fail({
    code: candidate.code as ErrorCode,
    message: candidate.message,
    retryable: candidate.retryable,
    correlationId: typeof candidate.correlationId === 'string' ? candidate.correlationId : undefined,
  });
}

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
