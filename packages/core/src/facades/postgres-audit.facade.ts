import crypto from 'node:crypto';
import type {
  AuditFacade,
  AuditQueryInput,
  AuditQueryOutput,
  AuditRecord,
  Result,
} from '@ems/contracts';
import { ok, fail } from '@ems/contracts';
import type { DatabasePool } from '../persistence/db.js';
import { AuditRepository, type AuditRecordRow } from '../persistence/audit.repository.js';
import { verifySubjectCredential, isValidCredentialFormat } from './subject-auth.js';
import { dependencyFailure } from './errors.js';

function isStrictTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match || Number.isNaN(Date.parse(value))) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  return month >= 1 && month <= 12 && day >= 1 && day <= new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export class PostgresAuditFacade implements AuditFacade {
  private readonly auditRepo = new AuditRepository();

  constructor(private readonly pool: DatabasePool) {}

  async query(input: AuditQueryInput): Promise<Result<AuditQueryOutput>> {
    // 1. Runtime-валидация
    if (!input || typeof input !== 'object') {
      return fail({
        code: 'VALIDATION_FAILED',
        message: 'Некорректный запрос журнала аудита',
        retryable: false,
      });
    }

    if (!input.actorCredential || !isValidCredentialFormat(input.actorCredential.value)) {
      return fail({
        code: 'UNAUTHENTICATED',
        message: 'Недействительные учетные данные сессии',
        retryable: false,
      });
    }

    if (input.limit !== undefined) {
      if (typeof input.limit !== 'number' || !Number.isInteger(input.limit) || input.limit < 1 || input.limit > 200) {
        return fail({
          code: 'VALIDATION_FAILED',
          message: 'Параметр limit должен быть целым числом от 1 до 200',
          retryable: false,
        });
      }
    }

    if (input.periodStart !== undefined) {
      if (!isStrictTimestamp(input.periodStart)) {
        return fail({
          code: 'VALIDATION_FAILED',
          message: 'Параметр periodStart должен быть корректной датой ISO',
          retryable: false,
        });
      }
    }

    if (input.periodEnd !== undefined) {
      if (!isStrictTimestamp(input.periodEnd)) {
        return fail({
          code: 'VALIDATION_FAILED',
          message: 'Параметр periodEnd должен быть корректной датой ISO',
          retryable: false,
        });
      }
    }

    if (input.periodStart && input.periodEnd) {
      if (Date.parse(input.periodStart) > Date.parse(input.periodEnd)) {
        return fail({
          code: 'VALIDATION_FAILED',
          message: 'Начало периода (periodStart) не может быть позже окончания (periodEnd)',
          retryable: false,
        });
      }
    }

    if (input.cursor !== undefined && (typeof input.cursor !== 'string' || input.cursor.trim() === '')) {
      return fail({
        code: 'VALIDATION_FAILED',
        message: 'Курсор должен быть непустой строкой',
        retryable: false,
      });
    }

    // 2. Аутентификация и авторизация субъекта (требуется audit.view, активный сотрудник с отделом)
    let authRes: Awaited<ReturnType<typeof verifySubjectCredential>>;
    try {
      authRes = await verifySubjectCredential(this.pool, input.actorCredential, {
        requireActive: true,
        requireDepartment: true,
      });
    } catch {
      return fail(dependencyFailure('Ошибка базы данных при проверке доступа к аудиту'));
    }
    if (!authRes.ok) {
      return fail(authRes.error);
    }

    const { employee: actor, permissions: actorPermissions } = authRes.value;
    if (!actorPermissions.includes('audit.view')) {
      return fail({
        code: 'FORBIDDEN',
        message: 'Недостаточно прав для просмотра журнала аудита (требуется audit.view)',
        retryable: false,
      });
    }

    // 3. Выполнение запроса к журналу аудита
    let queryResult: { items: readonly AuditRecordRow[]; nextCursor?: string };
    try {
      queryResult = await this.auditRepo.query(this.pool, {
        periodStart: input.periodStart,
        periodEnd: input.periodEnd,
        action: input.action,
        subjectId: input.subjectId,
        cursor: input.cursor,
        limit: input.limit,
      });
    } catch (err: any) {
      if (err?.message === 'INVALID_CURSOR') {
        return fail({
          code: 'VALIDATION_FAILED',
          message: 'Недопустимый формат курсора пагинации аудита',
          retryable: false,
        });
      }
      return fail({
        code: 'DEPENDENCY_UNAVAILABLE',
        message: 'Ошибка базы данных при чтении журнала аудита',
        retryable: true,
      });
    }

    // 4. Обязательная регистрация факта просмотра журнала аудита (FR-030, план 5.3)
    // При сбое регистрации просмотр отклоняется кодом AUDIT_FAILED без выдачи данных
    try {
      await this.auditRepo.insert(this.pool, {
        id: crypto.randomUUID(),
        subjectId: actor.id,
        action: 'AUDIT_QUERY_VIEWED',
        objectType: 'audit_log',
        objectId: 'query',
        result: 'SUCCESS',
        details: {
          periodStart: input.periodStart,
          periodEnd: input.periodEnd,
          filterAction: input.action,
          returnedCount: queryResult.items.length,
        },
      });
    } catch {
      return fail({
        code: 'AUDIT_FAILED',
        message: 'Сбой регистрации просмотра журнала аудита',
        retryable: false,
      });
    }

    // 5. Формирование безопасного выходного DTO с маскировкой устаревших ID объектов сессий (план 5.4)
    const records: AuditRecord[] = queryResult.items.map((row) => {
      const isLegacy = row.format_version === 1;
      const isSession = row.object_type === 'session';
      const objectId = isLegacy && isSession ? '[REDACTED_LEGACY_SESSION_ID]' : row.object_id;

      let sanitizedDetails = row.details;
      if (isLegacy && sanitizedDetails && typeof sanitizedDetails === 'object') {
        if ('sessionId' in sanitizedDetails) {
          sanitizedDetails = { ...sanitizedDetails, sessionId: '[REDACTED_LEGACY_SESSION_ID]' };
        }
      }

      return {
        id: row.id,
        timestamp: row.timestamp_iso ?? row.timestamp,
        subjectId: row.subject_id,
        action: row.action,
        objectType: row.object_type,
        objectId,
        result: row.result,
        correlationId: row.correlation_id ?? undefined,
        details: sanitizedDetails ?? undefined,
      };
    });

    return ok({
      items: records,
      nextCursor: queryResult.nextCursor,
    });
  }
}
