/**
 * Server-only LDAP adapter (S2-FR-001, S2-FR-002).
 *
 * Файл выполняется только на сервере: он открывает TCP/TLS-соединение со службой
 * каталога и обращается к секрету сервисной учетной записи. Он не должен попадать
 * в browser bundle (S2-NFR-002).
 *
 * Адаптер реализует публичные порты `@ems/contracts` и не содержит бизнес-логики:
 * роли, разрешения и статусы сотрудников остаются в PostgreSQL и проверяются ядром.
 */

import type { ConnectionOptions as TlsConnectionOptions } from 'node:tls';
import type {
  AppError,
  DirectoryAuthenticator,
  DirectoryIdentity,
  DirectoryIdentityResolver,
  Result,
} from '@ems/contracts';
import { ok, fail } from '@ems/contracts';
import { Client, Filter } from 'ldapts';
import { normalizeObjectGuid } from './object-guid.js';

/** Значение атрибута записи каталога в том виде, в каком его возвращает клиент. */
export type DirectoryAttributeValue = Buffer | Buffer[] | string | string[];

/** Запись каталога. Ключ `dn` присутствует всегда. */
export interface DirectoryEntry {
  readonly dn: string;
  readonly [attribute: string]: DirectoryAttributeValue | undefined;
}

export interface DirectorySearchOptions {
  readonly scope: 'sub';
  readonly filter: string;
  readonly attributes: readonly string[];
  readonly explicitBufferAttributes: readonly string[];
  readonly sizeLimit: number;
  readonly timeLimit: number;
}

export interface DirectorySearchResult {
  readonly searchEntries: readonly DirectoryEntry[];
}

/**
 * Минимальная поверхность LDAP-клиента, которая нужна адаптеру.
 * Структурно совместима с `ldapts.Client`, но позволяет подставить
 * детерминированный двойник в offline unit-тестах без реального каталога.
 */
export interface DirectoryClient {
  startTLS(options?: TlsConnectionOptions): Promise<void>;
  bind(dn: string, password?: string): Promise<void>;
  search(baseDN: string, options: DirectorySearchOptions): Promise<DirectorySearchResult>;
  unbind(): Promise<void>;
}

export interface DirectoryClientOptions {
  readonly url: string;
  readonly timeout: number;
  readonly connectTimeout: number;
  readonly tlsOptions: TlsConnectionOptions;
}

export type DirectoryClientFactory = (options: DirectoryClientOptions) => DirectoryClient;

export interface LdapDirectoryConfig {
  /**
   * Стабильный идентификатор экземпляра каталога. Вместе с `objectGUID` образует
   * ключ личности в PostgreSQL, поэтому менять его после ввода в эксплуатацию нельзя.
   */
  readonly directoryId: string;
  /** `ldaps://host:636` либо `ldap://host:389` в паре с `startTls: true`. */
  readonly url: string;
  /** Требовать StartTLS для соединения `ldap://`. */
  readonly startTls?: boolean;
  /** База поиска, например `DC=example,DC=test`. */
  readonly searchBase: string;
  /** DN сервисной учетной записи с минимальными правами чтения. */
  readonly bindDn: string;
  /** Секрет сервисной учетной записи. Не логируется и не возвращается наружу. */
  readonly bindPassword: string;
  /**
   * Доверенный внутренний CA. Обязателен: проверка сертификата отключаться не может
   * (AGENTS.md §4, ADR-0006 п.2).
   */
  readonly tlsCertificateAuthority: string | Buffer | readonly (string | Buffer)[];
  /** Имя хоста для проверки сертификата, если оно отличается от хоста URL. */
  readonly tlsServerName?: string;
  /** Ограничение на connect/bind/search. Baseline 5 секунд (ADR-0006 п.2). */
  readonly timeoutMs?: number;
}

export const DEFAULT_DIRECTORY_TIMEOUT_MS = 5000;

const MAX_UPN_LENGTH = 256;
const UPN_ATTRIBUTE = 'userPrincipalName';
const GUID_ATTRIBUTE = 'objectGUID';
const DISPLAY_NAME_ATTRIBUTE = 'displayName';
const COMMON_NAME_ATTRIBUTE = 'cn';
const REQUESTED_ATTRIBUTES: readonly string[] = [
  UPN_ATTRIBUTE,
  GUID_ATTRIBUTE,
  DISPLAY_NAME_ATTRIBUTE,
  COMMON_NAME_ATTRIBUTE,
];

/**
 * Единое сообщение для несуществующей учетной записи и неверного пароля.
 * Разные тексты позволили бы перечислять пользователей каталога (S2-FR-002).
 */
const GENERIC_AUTH_FAILURE = 'Неверное имя пользователя или пароль';

class DirectoryTimeoutError extends Error {
  constructor(public readonly operation: string) {
    super(`Операция службы каталога превысила лимит времени: ${operation}`);
    this.name = 'DirectoryTimeoutError';
  }
}

function invalid(message: string): AppError {
  return { code: 'VALIDATION_FAILED', message, retryable: false };
}

function unavailable(message: string): AppError {
  return { code: 'DEPENDENCY_UNAVAILABLE', message, retryable: true };
}

/**
 * Приводит UPN к сравнимой форме. Используется и адаптером, и серверным
 * throttling ключом, чтобы регистр не создавал независимых счетчиков (S2-FR-003).
 */
export function normalizeUpn(upn: string): string {
  return upn.trim().toLowerCase();
}

/**
 * Проверяет UPN до обращения к каталогу.
 *
 * Экранирование фильтра выполняется отдельно и всегда, но заведомо некорректное
 * значение отклоняется раньше, чтобы не тратить соединение и не давать наблюдаемых
 * различий по времени между классами мусорного ввода.
 */
export function isAcceptableUpn(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_UPN_LENGTH) return false;
  // Управляющие символы, пробелы и переводы строк в UPN недопустимы.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\s]/.test(trimmed)) return false;
  return trimmed.split('@').length === 2 && !trimmed.startsWith('@') && !trimmed.endsWith('@');
}

function readSingleString(value: DirectoryAttributeValue | undefined): string | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    const first = value[0];
    if (typeof first === 'string') return first;
    if (first instanceof Uint8Array) return Buffer.from(first).toString('utf8');
    return undefined;
  }
  if (value instanceof Uint8Array) return Buffer.from(value).toString('utf8');
  return undefined;
}

function readGuid(value: DirectoryAttributeValue | undefined): string | undefined {
  if (Array.isArray(value)) return normalizeObjectGuid(value[0]);
  return normalizeObjectGuid(value);
}

async function withDeadline<T>(operation: string, timeoutMs: number, action: () => Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      action(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new DirectoryTimeoutError(operation));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function defaultClientFactory(options: DirectoryClientOptions): DirectoryClient {
  return new Client({
    url: options.url,
    timeout: options.timeout,
    connectTimeout: options.connectTimeout,
    tlsOptions: options.tlsOptions,
  }) as unknown as DirectoryClient;
}

/**
 * Проверяет конфигурацию до создания адаптера.
 * Возвращает ошибку вместо исключения, чтобы composition root мог отказать в старте
 * с диагностируемой причиной, не раскрывая значений секретов.
 */
export function validateLdapDirectoryConfig(config: LdapDirectoryConfig): Result<LdapDirectoryConfig> {
  if (!config || typeof config !== 'object') {
    return fail(invalid('Конфигурация службы каталога не задана'));
  }
  const requiredStrings: readonly (keyof LdapDirectoryConfig)[] = [
    'directoryId', 'url', 'searchBase', 'bindDn', 'bindPassword',
  ];
  for (const key of requiredStrings) {
    const value = config[key];
    if (typeof value !== 'string' || value.trim() === '') {
      return fail(invalid(`Не задан обязательный параметр службы каталога: ${String(key)}`));
    }
  }

  const url = config.url.trim().toLowerCase();
  const isSecureUrl = url.startsWith('ldaps://');
  const isPlainUrl = url.startsWith('ldap://');
  if (!isSecureUrl && !isPlainUrl) {
    return fail(invalid('URL службы каталога должен использовать схему ldaps:// или ldap://'));
  }
  if (isPlainUrl && config.startTls !== true) {
    return fail(invalid('Соединение ldap:// допускается только с обязательным StartTLS'));
  }

  const ca = config.tlsCertificateAuthority;
  const hasCa = typeof ca === 'string'
    ? ca.trim() !== ''
    : ca instanceof Uint8Array
      ? ca.length > 0
      : Array.isArray(ca) && ca.length > 0;
  if (!hasCa) {
    return fail(invalid('Не задан доверенный CA для проверки сертификата службы каталога'));
  }

  const timeoutMs = config.timeoutMs ?? DEFAULT_DIRECTORY_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return fail(invalid('Таймаут службы каталога должен быть положительным числом миллисекунд'));
  }

  return ok(config);
}

/**
 * Адаптер службы каталога поверх `ldapts`.
 *
 * Каждая операция открывает собственное соединение и закрывает его в `finally`.
 * Пул соединений и переиспользование bind сознательно не вводятся: пароль
 * пользователя не должен переживать операцию, а `autoRebind` хранит последние
 * учетные данные в памяти клиента.
 */
export class LdapDirectoryAdapter implements DirectoryAuthenticator, DirectoryIdentityResolver {
  private readonly timeoutMs: number;

  constructor(
    private readonly config: LdapDirectoryConfig,
    private readonly createClient: DirectoryClientFactory = defaultClientFactory,
  ) {
    const validated = validateLdapDirectoryConfig(config);
    if (!validated.ok) throw new Error(validated.error.message);
    this.timeoutMs = config.timeoutMs ?? DEFAULT_DIRECTORY_TIMEOUT_MS;
  }

  /**
   * Подтверждает личность парой UPN/пароль.
   *
   * Порядок: поиск записи под сервисной учетной записью, затем bind под DN
   * найденной записи. Bind напрямую по UPN не используется, поскольку он не дает
   * ни DN, ни `objectGUID`, а также по-разному ведет себя у разных каталогов.
   */
  async authenticate(upn: string, password: string): Promise<Result<DirectoryIdentity>> {
    if (!isAcceptableUpn(upn) || typeof password !== 'string' || password === '') {
      return fail({ code: 'UNAUTHENTICATED', message: GENERIC_AUTH_FAILURE, retryable: false });
    }

    const lookup = await this.lookupIdentity(upn);
    if (!lookup.ok) {
      // Отсутствие записи не отличается от неверного пароля.
      if (lookup.error.code === 'NOT_FOUND_OR_FORBIDDEN') {
        return fail({ code: 'UNAUTHENTICATED', message: GENERIC_AUTH_FAILURE, retryable: false });
      }
      return fail(lookup.error);
    }

    const { identity, entryDn } = lookup.value;

    let client: DirectoryClient | undefined;
    try {
      client = this.openClient();
      await this.establishSecureChannel(client);
      await withDeadline('bind', this.timeoutMs, () => client!.bind(entryDn, password));
      return ok(identity);
    } catch (error) {
      return fail(this.mapError(error, { genericAuthFailure: true }));
    } finally {
      await this.closeQuietly(client);
    }
  }

  /**
   * Находит личность по UPN без проверки пароля.
   * Используется bootstrap-сценарием ядра под локальным оператором.
   */
  async resolveByUpn(upn: string): Promise<Result<DirectoryIdentity>> {
    if (!isAcceptableUpn(upn)) {
      return fail(invalid('Некорректный UPN'));
    }
    const lookup = await this.lookupIdentity(upn);
    if (!lookup.ok) return fail(lookup.error);
    return ok(lookup.value.identity);
  }

  private async lookupIdentity(
    upn: string,
  ): Promise<Result<{ identity: DirectoryIdentity; entryDn: string }>> {
    let client: DirectoryClient | undefined;
    try {
      client = this.openClient();
      await this.establishSecureChannel(client);
      await withDeadline('bind', this.timeoutMs, () =>
        client!.bind(this.config.bindDn, this.config.bindPassword));

      // Значение всегда экранируется, даже после проверки формата (S2-FR-002).
      const filter = `(${UPN_ATTRIBUTE}=${Filter.escape(normalizeUpn(upn))})`;
      const result = await withDeadline('search', this.timeoutMs, () =>
        client!.search(this.config.searchBase, {
          scope: 'sub',
          filter,
          attributes: REQUESTED_ATTRIBUTES,
          // objectGUID обязан прийти двоичным, иначе канонизация невозможна.
          explicitBufferAttributes: [GUID_ATTRIBUTE],
          sizeLimit: 2,
          timeLimit: Math.max(1, Math.ceil(this.timeoutMs / 1000)),
        }));

      const entries = result?.searchEntries ?? [];
      if (entries.length === 0) {
        return fail({ code: 'NOT_FOUND_OR_FORBIDDEN', message: 'Личность не найдена в каталоге', retryable: false });
      }
      if (entries.length > 1) {
        // Неоднозначный UPN означает нарушение уникальности в каталоге.
        // Выбор произвольной записи допустил бы захват чужой личности.
        return fail(unavailable('Каталог вернул несколько записей для одного UPN'));
      }

      const entry = entries[0] as DirectoryEntry;
      const entryDn = typeof entry.dn === 'string' ? entry.dn.trim() : '';
      if (entryDn === '') {
        return fail(unavailable('Каталог вернул запись без DN'));
      }

      const objectGuid = readGuid(entry[GUID_ATTRIBUTE]);
      if (!objectGuid) {
        return fail(unavailable('Каталог вернул запись без пригодного objectGUID'));
      }

      const directoryUpn = readSingleString(entry[UPN_ATTRIBUTE])?.trim();
      if (!directoryUpn) {
        return fail(unavailable('Каталог вернул запись без userPrincipalName'));
      }

      const displayName = readSingleString(entry[DISPLAY_NAME_ATTRIBUTE])?.trim()
        || readSingleString(entry[COMMON_NAME_ATTRIBUTE])?.trim()
        || directoryUpn;

      return ok({
        identity: {
          directoryId: this.config.directoryId,
          objectGuid,
          upn: directoryUpn,
          displayName,
        },
        entryDn,
      });
    } catch (error) {
      return fail(this.mapError(error, { genericAuthFailure: false }));
    } finally {
      await this.closeQuietly(client);
    }
  }

  private openClient(): DirectoryClient {
    return this.createClient({
      url: this.config.url,
      timeout: this.timeoutMs,
      connectTimeout: this.timeoutMs,
      tlsOptions: this.tlsOptions(),
    });
  }

  private tlsOptions(): TlsConnectionOptions {
    const ca = this.config.tlsCertificateAuthority;
    const options: TlsConnectionOptions = {
      // Проверка сертификата обязательна и не конфигурируется.
      rejectUnauthorized: true,
      ca: Array.isArray(ca) ? [...ca] : (ca as string | Buffer),
    };
    if (this.config.tlsServerName) {
      return { ...options, servername: this.config.tlsServerName };
    }
    return options;
  }

  private async establishSecureChannel(client: DirectoryClient): Promise<void> {
    if (this.config.startTls === true) {
      await withDeadline('startTLS', this.timeoutMs, () => client.startTLS(this.tlsOptions()));
    }
  }

  private async closeQuietly(client: DirectoryClient | undefined): Promise<void> {
    if (!client) return;
    try {
      await withDeadline('unbind', this.timeoutMs, () => client.unbind());
    } catch {
      // Закрытие соединения не должно подменять результат операции.
    }
  }

  /**
   * Преобразует ошибку клиента в безопасный `AppError`.
   * Исходное сообщение каталога наружу не передается: оно может содержать DN,
   * внутренние имена хостов и детали конфигурации.
   */
  private mapError(error: unknown, options: { genericAuthFailure: boolean }): AppError {
    if (error instanceof DirectoryTimeoutError) {
      return { code: 'TIMEOUT', message: 'Служба каталога не ответила за отведенное время', retryable: true };
    }

    const name = error instanceof Error ? error.name : '';
    const code = (error as { code?: unknown } | null)?.code;

    if (name === 'InvalidCredentialsError' || code === 49) {
      return options.genericAuthFailure
        ? { code: 'UNAUTHENTICATED', message: GENERIC_AUTH_FAILURE, retryable: false }
        : { code: 'UNAUTHENTICATED', message: 'Служба каталога отклонила учетные данные', retryable: false };
    }

    return unavailable('Служба каталога недоступна');
  }
}
