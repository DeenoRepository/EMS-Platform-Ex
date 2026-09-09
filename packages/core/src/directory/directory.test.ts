import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Filter } from 'ldapts';
import { normalizeObjectGuid, objectGuidFromBytes } from './object-guid.js';
import {
  DEFAULT_DIRECTORY_TIMEOUT_MS,
  LdapDirectoryAdapter,
  isAcceptableUpn,
  normalizeUpn,
  validateLdapDirectoryConfig,
} from './ldap-directory.adapter.js';
import type {
  DirectoryClient,
  DirectoryClientOptions,
  DirectorySearchOptions,
  DirectorySearchResult,
  LdapDirectoryConfig,
} from './ldap-directory.adapter.js';

const CA = '-----BEGIN CERTIFICATE-----\nsynthetic\n-----END CERTIFICATE-----';
const SERVICE_SECRET = 'synthetic-bind-secret';
const USER_SECRET = 'synthetic-user-secret';
const USER_DN = 'CN=Ivan Petrov,OU=Staff,DC=example,DC=test';

// Синтетический objectGUID: AD отдает его как 16 байт со смешанным порядком.
const GUID_BYTES = Buffer.from([
  0x10, 0x32, 0x54, 0x76,
  0x98, 0xba,
  0xdc, 0xfe,
  0x01, 0x23,
  0x45, 0x67, 0x89, 0xab, 0xcd, 0xef,
]);
const GUID_CANONICAL = '76543210-ba98-fedc-0123-456789abcdef';

function baseConfig(overrides: Partial<LdapDirectoryConfig> = {}): LdapDirectoryConfig {
  return {
    directoryId: 'dir.example.test',
    url: 'ldaps://dc.example.test:636',
    searchBase: 'DC=example,DC=test',
    bindDn: 'CN=ems-service,OU=Service,DC=example,DC=test',
    bindPassword: SERVICE_SECRET,
    tlsCertificateAuthority: CA,
    ...overrides,
  };
}

interface CallLog {
  readonly kind: 'client' | 'startTLS' | 'bind' | 'search' | 'unbind';
  readonly detail?: unknown;
}

interface FakeBehaviour {
  readonly entries?: readonly Record<string, unknown>[];
  readonly searchError?: unknown;
  readonly startTlsError?: unknown;
  /** Отказ bind сервисной учетной записи. */
  readonly serviceBindError?: unknown;
  /** Отказ bind пользователя (второе соединение). */
  readonly userBindError?: unknown;
  /** Задержка операции поиска для проверки дедлайна. */
  readonly searchDelayMs?: number;
  /** Задержка bind пользователя для проверки дедлайна. */
  readonly userBindDelayMs?: number;
}

class InvalidCredentialsLike extends Error {
  public readonly code = 49;

  constructor() {
    super('Invalid credentials during a bind operation. Code: 0x31');
    this.name = 'InvalidCredentialsError';
  }
}

function createHarness(behaviour: FakeBehaviour = {}) {
  const calls: CallLog[] = [];
  const clientOptions: DirectoryClientOptions[] = [];
  let connectionIndex = 0;

  const factory = (options: DirectoryClientOptions): DirectoryClient => {
    clientOptions.push(options);
    const isUserConnection = connectionIndex > 0;
    connectionIndex += 1;
    calls.push({ kind: 'client', detail: options.url });

    return {
      async startTLS(): Promise<void> {
        calls.push({ kind: 'startTLS' });
        if (behaviour.startTlsError) throw behaviour.startTlsError;
      },
      async bind(dn: string, password?: string): Promise<void> {
        calls.push({ kind: 'bind', detail: { dn, password } });
        if (isUserConnection) {
          if (behaviour.userBindDelayMs) {
            await new Promise((resolve) => setTimeout(resolve, behaviour.userBindDelayMs));
          }
          if (behaviour.userBindError) throw behaviour.userBindError;
          return;
        }
        if (behaviour.serviceBindError) throw behaviour.serviceBindError;
      },
      async search(baseDN: string, options: DirectorySearchOptions): Promise<DirectorySearchResult> {
        calls.push({ kind: 'search', detail: { baseDN, options } });
        if (behaviour.searchDelayMs) {
          await new Promise((resolve) => setTimeout(resolve, behaviour.searchDelayMs));
        }
        if (behaviour.searchError) throw behaviour.searchError;
        return { searchEntries: (behaviour.entries ?? []) as DirectorySearchResult['searchEntries'] };
      },
      async unbind(): Promise<void> {
        calls.push({ kind: 'unbind' });
      },
    };
  };

  return { calls, clientOptions, factory };
}

function defaultEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    dn: USER_DN,
    userPrincipalName: 'Ivan.Petrov@example.test',
    objectGUID: GUID_BYTES,
    displayName: 'Иван Петров',
    ...overrides,
  };
}

describe('objectGUID canonicalization (S2-FR-002)', () => {
  test('преобразует 16 байт AD в каноническую строку со смешанным порядком', () => {
    assert.equal(objectGuidFromBytes(GUID_BYTES), GUID_CANONICAL);
    assert.equal(normalizeObjectGuid(GUID_BYTES), GUID_CANONICAL);
  });

  test('одна и та же личность дает один идентификатор из разных представлений', () => {
    const fromBytes = normalizeObjectGuid(GUID_BYTES);
    const fromUpperText = normalizeObjectGuid(GUID_CANONICAL.toUpperCase());
    const fromBracedText = normalizeObjectGuid(`{${GUID_CANONICAL.toUpperCase()}}`);
    assert.equal(fromBytes, GUID_CANONICAL);
    assert.equal(fromUpperText, GUID_CANONICAL);
    assert.equal(fromBracedText, GUID_CANONICAL);
  });

  test('отклоняет длину, отличную от 16 байт, и мусорные значения', () => {
    assert.equal(objectGuidFromBytes(Buffer.alloc(15)), undefined);
    assert.equal(objectGuidFromBytes(Buffer.alloc(17)), undefined);
    assert.equal(normalizeObjectGuid('not-a-guid'), undefined);
    assert.equal(normalizeObjectGuid(''), undefined);
    assert.equal(normalizeObjectGuid(undefined), undefined);
    assert.equal(normalizeObjectGuid(42), undefined);
    assert.equal(normalizeObjectGuid({ objectGuid: GUID_CANONICAL }), undefined);
  });

  test('не принимает GUID с недопустимыми символами', () => {
    assert.equal(normalizeObjectGuid('7654321g-ba98-fedc-0123-456789abcdef'), undefined);
    assert.equal(normalizeObjectGuid('76543210ba98fedc0123456789abcdef'), undefined);
  });
});

describe('Валидация UPN и конфигурации', () => {
  test('normalizeUpn приводит регистр и пробелы к одной форме', () => {
    assert.equal(normalizeUpn('  Ivan.Petrov@Example.TEST '), 'ivan.petrov@example.test');
  });

  test('isAcceptableUpn отклоняет управляющие символы, пробелы и неверную форму', () => {
    assert.equal(isAcceptableUpn('ivan.petrov@example.test'), true);
    assert.equal(isAcceptableUpn(''), false);
    assert.equal(isAcceptableUpn('   '), false);
    assert.equal(isAcceptableUpn('no-at-sign'), false);
    assert.equal(isAcceptableUpn('a@b@c'), false);
    assert.equal(isAcceptableUpn('@example.test'), false);
    assert.equal(isAcceptableUpn('user@'), false);
    assert.equal(isAcceptableUpn('user\u0000@example.test'), false);
    assert.equal(isAcceptableUpn('user name@example.test'), false);
    assert.equal(isAcceptableUpn(`${'x'.repeat(242)}@example.test`), true, 'длина 255 символов допустима для VARCHAR(255)');
    assert.equal(isAcceptableUpn(`${'x'.repeat(243)}@example.test`), false, 'длина 256 символов превышает VARCHAR(255)');
    assert.equal(isAcceptableUpn(undefined), false);
    assert.equal(isAcceptableUpn(123), false);
  });

  test('конфигурация ldap:// без StartTLS отклоняется', () => {
    const result = validateLdapDirectoryConfig(baseConfig({ url: 'ldap://dc.example.test:389' }));
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.error.code, 'VALIDATION_FAILED');
  });

  test('конфигурация ldap:// со StartTLS принимается', () => {
    const result = validateLdapDirectoryConfig(
      baseConfig({ url: 'ldap://dc.example.test:389', startTls: true }),
    );
    assert.equal(result.ok, true);
  });

  test('конфигурация без доверенного CA отклоняется', () => {
    for (const ca of ['', '   ', [] as string[]]) {
      const result = validateLdapDirectoryConfig(baseConfig({ tlsCertificateAuthority: ca }));
      assert.equal(result.ok, false, `CA ${JSON.stringify(ca)} должен быть отклонен`);
    }
  });

  test('незаданные обязательные параметры и некорректный таймаут отклоняются', () => {
    assert.equal(validateLdapDirectoryConfig(baseConfig({ directoryId: '' })).ok, false);
    assert.equal(validateLdapDirectoryConfig(baseConfig({ bindDn: '  ' })).ok, false);
    assert.equal(validateLdapDirectoryConfig(baseConfig({ bindPassword: '' })).ok, false);
    assert.equal(validateLdapDirectoryConfig(baseConfig({ searchBase: '' })).ok, false);
    assert.equal(validateLdapDirectoryConfig(baseConfig({ url: 'https://dc.example.test' })).ok, false);
    assert.equal(validateLdapDirectoryConfig(baseConfig({ timeoutMs: 0 })).ok, false);
    assert.equal(validateLdapDirectoryConfig(baseConfig({ timeoutMs: -1 })).ok, false);
    assert.equal(validateLdapDirectoryConfig(baseConfig({ timeoutMs: Number.NaN })).ok, false);
  });

  test('конструктор отказывает при недопустимой конфигурации', () => {
    const { factory } = createHarness();
    assert.throws(() => new LdapDirectoryAdapter(baseConfig({ url: 'ldap://dc' }), factory));
  });
});

describe('LDAP TLS boundary (S2-FR-001)', () => {
  test('клиент всегда получает rejectUnauthorized и доверенный CA', () => {
    const { clientOptions, factory } = createHarness({ entries: [defaultEntry()] });
    const adapter = new LdapDirectoryAdapter(baseConfig(), factory);
    return adapter.resolveByUpn('ivan.petrov@example.test').then(() => {
      assert.equal(clientOptions.length, 1);
      const options = clientOptions[0]!;
      assert.equal(options.tlsOptions.rejectUnauthorized, true);
      assert.equal(options.tlsOptions.ca, CA);
    });
  });

  test('timeout и connectTimeout по умолчанию равны 5 секундам', async () => {
    const { clientOptions, factory } = createHarness({ entries: [defaultEntry()] });
    const adapter = new LdapDirectoryAdapter(baseConfig(), factory);
    await adapter.resolveByUpn('ivan.petrov@example.test');
    assert.equal(DEFAULT_DIRECTORY_TIMEOUT_MS, 5000);
    assert.equal(clientOptions[0]!.timeout, 5000);
    assert.equal(clientOptions[0]!.connectTimeout, 5000);
  });

  test('StartTLS выполняется до bind для соединения ldap://', async () => {
    const { calls, factory } = createHarness({ entries: [defaultEntry()] });
    const adapter = new LdapDirectoryAdapter(
      baseConfig({ url: 'ldap://dc.example.test:389', startTls: true }),
      factory,
    );
    await adapter.resolveByUpn('ivan.petrov@example.test');
    const kinds = calls.map((call) => call.kind);
    assert.deepEqual(kinds, ['client', 'startTLS', 'bind', 'search', 'unbind']);
  });

  test('отказ StartTLS не приводит к bind и дает DEPENDENCY_UNAVAILABLE', async () => {
    const { calls, factory } = createHarness({
      startTlsError: new Error('unable to verify the first certificate'),
    });
    const adapter = new LdapDirectoryAdapter(
      baseConfig({ url: 'ldap://dc.example.test:389', startTls: true }),
      factory,
    );
    const result = await adapter.authenticate('ivan.petrov@example.test', USER_SECRET);
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.error.code, 'DEPENDENCY_UNAVAILABLE');
    assert.equal(calls.some((call) => call.kind === 'bind'), false);
  });
});

describe('Экранирование LDAP-фильтра (S2-FR-002)', () => {
  test('метасимволы UPN экранируются перед отправкой в каталог', async () => {
    const { calls, factory } = createHarness({ entries: [] });
    const adapter = new LdapDirectoryAdapter(baseConfig(), factory);
    const injected = 'a*)(objectClass=*@example.test';
    await adapter.resolveByUpn(injected);

    const search = calls.find((call) => call.kind === 'search');
    assert.ok(search);
    const filter = (search!.detail as { options: DirectorySearchOptions }).options.filter;
    // Значение сначала нормализуется (нижний регистр), затем экранируется.
    assert.equal(filter, '(userPrincipalName=a\\2a\\29\\28objectclass=\\2a@example.test)');
    assert.equal(filter.includes('*)'), false);
    assert.equal(filter.includes('(objectclass'), false);
    assert.equal(filter.split('(').length, 2, 'фильтр не должен содержать вложенных выражений');
    assert.equal(filter.split(')').length, 2, 'фильтр не должен содержать лишних закрывающих скобок');
  });

  test('обратный слэш и NUL не попадают в фильтр в исходном виде', () => {
    assert.equal(Filter.escape('a\\b'), 'a\\5cb');
    assert.equal(Filter.escape('a\u0000b'), 'a\\00b');
  });

  test('поиск ограничен sizeLimit и base из конфигурации', async () => {
    const { calls, factory } = createHarness({ entries: [defaultEntry()] });
    const adapter = new LdapDirectoryAdapter(baseConfig(), factory);
    await adapter.resolveByUpn('ivan.petrov@example.test');
    const search = calls.find((call) => call.kind === 'search')!.detail as {
      baseDN: string;
      options: DirectorySearchOptions;
    };
    assert.equal(search.baseDN, 'DC=example,DC=test');
    assert.equal(search.options.sizeLimit, 2);
    assert.equal(search.options.scope, 'sub');
    assert.deepEqual([...search.options.explicitBufferAttributes], ['objectGUID']);
  });
});

describe('resolveByUpn', () => {
  test('возвращает канонизированную личность из записи каталога', async () => {
    const { factory } = createHarness({ entries: [defaultEntry()] });
    const adapter = new LdapDirectoryAdapter(baseConfig(), factory);
    const result = await adapter.resolveByUpn('IVAN.PETROV@EXAMPLE.TEST');
    assert.equal(result.ok, true);
    assert.deepEqual(result.ok === true && result.value, {
      directoryId: 'dir.example.test',
      objectGuid: GUID_CANONICAL,
      upn: 'Ivan.Petrov@example.test',
      displayName: 'Иван Петров',
    });
  });

  test('использует cn, если displayName отсутствует', async () => {
    const entry = defaultEntry({ displayName: undefined, cn: 'Ivan Petrov' });
    const { factory } = createHarness({ entries: [entry] });
    const adapter = new LdapDirectoryAdapter(baseConfig(), factory);
    const result = await adapter.resolveByUpn('ivan.petrov@example.test');
    assert.equal(result.ok === true && result.value.displayName, 'Ivan Petrov');
  });

  test('отсутствие записи дает NOT_FOUND_OR_FORBIDDEN', async () => {
    const { factory } = createHarness({ entries: [] });
    const adapter = new LdapDirectoryAdapter(baseConfig(), factory);
    const result = await adapter.resolveByUpn('ivan.petrov@example.test');
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.error.code, 'NOT_FOUND_OR_FORBIDDEN');
  });

  test('неоднозначный UPN отклоняется, а не разрешается произвольной записью', async () => {
    const { factory } = createHarness({
      entries: [defaultEntry(), defaultEntry({ dn: 'CN=Other,DC=example,DC=test' })],
    });
    const adapter = new LdapDirectoryAdapter(baseConfig(), factory);
    const result = await adapter.resolveByUpn('ivan.petrov@example.test');
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.error.code, 'DEPENDENCY_UNAVAILABLE');
  });

  test('запись без пригодного objectGUID отклоняется', async () => {
    for (const guid of [undefined, Buffer.alloc(8), 'garbage']) {
      const { factory } = createHarness({ entries: [defaultEntry({ objectGUID: guid })] });
      const adapter = new LdapDirectoryAdapter(baseConfig(), factory);
      const result = await adapter.resolveByUpn('ivan.petrov@example.test');
      assert.equal(result.ok, false);
      assert.equal(result.ok === false && result.error.code, 'DEPENDENCY_UNAVAILABLE');
    }
  });

  test('запись без DN или без userPrincipalName отклоняется', async () => {
    const withoutDn = createHarness({ entries: [defaultEntry({ dn: '  ' })] });
    const first = await new LdapDirectoryAdapter(baseConfig(), withoutDn.factory)
      .resolveByUpn('ivan.petrov@example.test');
    assert.equal(first.ok, false);

    const withoutUpn = createHarness({ entries: [defaultEntry({ userPrincipalName: undefined })] });
    const second = await new LdapDirectoryAdapter(baseConfig(), withoutUpn.factory)
      .resolveByUpn('ivan.petrov@example.test');
    assert.equal(second.ok, false);

    const overlyLongUpn = createHarness({
      entries: [defaultEntry({ userPrincipalName: `${'x'.repeat(243)}@example.test` })],
    });
    const third = await new LdapDirectoryAdapter(baseConfig(), overlyLongUpn.factory)
      .resolveByUpn('ivan.petrov@example.test');
    assert.equal(third.ok, false);
    assert.equal(third.ok === false && third.error.code, 'DEPENDENCY_UNAVAILABLE');
  });

  test('некорректный UPN не доходит до каталога', async () => {
    const { calls, factory } = createHarness({ entries: [defaultEntry()] });
    const adapter = new LdapDirectoryAdapter(baseConfig(), factory);
    const result = await adapter.resolveByUpn('нет-собаки');
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.error.code, 'VALIDATION_FAILED');
    assert.equal(calls.length, 0);
  });
});

describe('authenticate', () => {
  test('успешный вход выполняет bind под DN записи и не сохраняет пароль в результате', async () => {
    const { calls, factory } = createHarness({ entries: [defaultEntry()] });
    const adapter = new LdapDirectoryAdapter(baseConfig(), factory);
    const result = await adapter.authenticate('ivan.petrov@example.test', USER_SECRET);

    assert.equal(result.ok, true);
    assert.equal(result.ok === true && result.value.objectGuid, GUID_CANONICAL);

    const binds = calls.filter((call) => call.kind === 'bind')
      .map((call) => call.detail as { dn: string; password?: string });
    assert.equal(binds.length, 2);
    assert.equal(binds[0]!.dn, 'CN=ems-service,OU=Service,DC=example,DC=test');
    assert.equal(binds[1]!.dn, USER_DN);
    assert.equal(binds[1]!.password, USER_SECRET);
    assert.equal(JSON.stringify(result).includes(USER_SECRET), false);
    assert.equal(JSON.stringify(result).includes(SERVICE_SECRET), false);
  });

  test('оба соединения закрываются после успешного входа', async () => {
    const { calls, factory } = createHarness({ entries: [defaultEntry()] });
    const adapter = new LdapDirectoryAdapter(baseConfig(), factory);
    await adapter.authenticate('ivan.petrov@example.test', USER_SECRET);
    assert.equal(calls.filter((call) => call.kind === 'client').length, 2);
    assert.equal(calls.filter((call) => call.kind === 'unbind').length, 2);
  });

  test('неверный пароль и отсутствующий пользователь неразличимы (S2-FR-002)', async () => {
    const badPassword = createHarness({
      entries: [defaultEntry()],
      userBindError: new InvalidCredentialsLike(),
    });
    const wrongPassword = await new LdapDirectoryAdapter(baseConfig(), badPassword.factory)
      .authenticate('ivan.petrov@example.test', 'wrong');

    const missing = createHarness({ entries: [] });
    const missingUser = await new LdapDirectoryAdapter(baseConfig(), missing.factory)
      .authenticate('nobody@example.test', USER_SECRET);

    assert.equal(wrongPassword.ok, false);
    assert.equal(missingUser.ok, false);
    assert.equal(
      wrongPassword.ok === false && wrongPassword.error.code,
      missingUser.ok === false && missingUser.error.code,
    );
    assert.equal(
      wrongPassword.ok === false && wrongPassword.error.message,
      missingUser.ok === false && missingUser.error.message,
    );
    assert.equal(wrongPassword.ok === false && wrongPassword.error.code, 'UNAUTHENTICATED');
  });

  test('пустой пароль отклоняется тем же обобщенным сообщением без обращения к каталогу', async () => {
    const { calls, factory } = createHarness({ entries: [defaultEntry()] });
    const adapter = new LdapDirectoryAdapter(baseConfig(), factory);
    const result = await adapter.authenticate('ivan.petrov@example.test', '');
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.error.code, 'UNAUTHENTICATED');
    assert.equal(calls.length, 0);
  });

  test('недоступность каталога отличается от неверных учетных данных', async () => {
    const { factory } = createHarness({ searchError: new Error('ECONNREFUSED 10.0.0.1:636') });
    const adapter = new LdapDirectoryAdapter(baseConfig(), factory);
    const result = await adapter.authenticate('ivan.petrov@example.test', USER_SECRET);
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.error.code, 'DEPENDENCY_UNAVAILABLE');
    assert.equal(result.ok === false && result.error.retryable, true);
  });

  test('внутренние детали ошибки каталога не попадают наружу', async () => {
    const { factory } = createHarness({
      searchError: new Error('connect ECONNREFUSED 10.20.30.40:636 for CN=ems-service'),
    });
    const adapter = new LdapDirectoryAdapter(baseConfig(), factory);
    const result = await adapter.authenticate('ivan.petrov@example.test', USER_SECRET);
    const serialized = JSON.stringify(result);
    assert.equal(serialized.includes('10.20.30.40'), false);
    assert.equal(serialized.includes('ems-service'), false);
    assert.equal(serialized.includes('ECONNREFUSED'), false);
  });

  test('зависший поиск прерывается по дедлайну с кодом TIMEOUT', async () => {
    const { factory } = createHarness({ entries: [defaultEntry()], searchDelayMs: 200 });
    const adapter = new LdapDirectoryAdapter(baseConfig({ timeoutMs: 20 }), factory);
    const result = await adapter.authenticate('ivan.petrov@example.test', USER_SECRET);
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.error.code, 'TIMEOUT');
    assert.equal(result.ok === false && result.error.retryable, true);
  });

  test('зависший bind пользователя прерывается по дедлайну с кодом TIMEOUT', async () => {
    const { factory } = createHarness({ entries: [defaultEntry()], userBindDelayMs: 200 });
    const adapter = new LdapDirectoryAdapter(baseConfig({ timeoutMs: 20 }), factory);
    const result = await adapter.authenticate('ivan.petrov@example.test', USER_SECRET);
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.error.code, 'TIMEOUT');
  });

  test('соединение закрывается даже при отказе операции', async () => {
    const { calls, factory } = createHarness({ searchError: new Error('boom') });
    const adapter = new LdapDirectoryAdapter(baseConfig(), factory);
    await adapter.authenticate('ivan.petrov@example.test', USER_SECRET);
    assert.equal(calls.filter((call) => call.kind === 'unbind').length, 1);
  });

  test('отказ сервисного bind классифицируется как отказ инфраструктуры, а не пользователя', async () => {
    const { factory } = createHarness({ serviceBindError: new InvalidCredentialsLike() });
    const adapter = new LdapDirectoryAdapter(baseConfig(), factory);
    const result = await adapter.resolveByUpn('ivan.petrov@example.test');
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.error.code, 'DEPENDENCY_UNAVAILABLE');
    assert.equal(result.ok === false && result.error.retryable, true);
    assert.equal(
      result.ok === false && result.error.message,
      'Служба каталога отклонила учетные данные сервисного доступа',
    );
  });
});
