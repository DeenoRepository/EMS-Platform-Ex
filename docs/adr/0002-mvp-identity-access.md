# ADR-0002: Идентичность, доступ и аудит MVP

- Статус: **Approved**
- Версия решения: 1.0.0
- Владелец решения: владелец проекта
- Утверждено: владельцем проекта (2026-09-07)
- Дата пересмотра: до реализации LDAP/session/authz
- Связанные требования: FR-001..031, NFR-002..004

## Контекст

LDAP подтверждает личность, а PostgreSQL является источником актуальных ролей, отделов, назначений и доступности модулей. UI и middleware не могут быть границей авторизации. Необходимо сохранить исторический контекст аудита и безопасно обработать bootstrap, перевод и конкуренцию за последнего администратора.

## Предлагаемое решение

1. Идентифицировать сотрудника по настроенному идентификатору каталога и AD `objectGUID`; UPN хранить как изменяемый атрибут, не как первичный идентификатор.
2. Первый успешный LDAP-вход создает ожидающую локальную запись без доступа. Заблокированная запись не активируется повторным входом.
3. Bootstrap является отдельной server-only операцией, одноразовой и атомарной. Оператор и право `platform.bootstrap` подтверждаются внедряемым портом оператора `LocalOperatorPort`, а AD-личность — внедряемым `DirectoryIdentityResolver`. Состояние singleton (`ready`, `completed`, `locked-legacy`) и общий `SELECT ... FOR UPDATE` барьер защищают bootstrap и изменения административного состава.
4. Авторизация на сервере выполняет отдельные проверки по SHA-256 хэшу credential: активная сессия, permission, module availability для отдела и resource scope. Клиентские контексты и claims игнорируются.
5. Перевод сотрудника требует `employees.manage`, а назначение/снятие `role.platform.admin` — обладания этой ролью; запрещено снимать роль у последнего активного администратора. Требуется обязательный `expectedVersion`. Перевод атомарно устанавливает отдел, роли, отзывает все сессии сотрудника и пишет аудит до commit.
6. Управление доступностью модулей требует отдельного права `modules.manage` (не выводится автоматически из `platform.admin`) и обязательного `expectedVersion`.
7. Утвержденный baseline сессии: absolute TTL 8 часов и idle TTL 30 минут. При входе генерируется случайный 256-битный credential, в БД хранится его SHA-256 хэш. Публичный sessionId отделен от секрета. При upgrade старые сессии отзываются.
8. LDAP outage запрещает новый вход; существующая сессия работает в TTL. При недоступной PostgreSQL защищенный доступ запрещается.
9. Критическое изменение и audit record выполняются в одной транзакции. Успешный вход с созданием сессии также требует audit record. Logout отзывает сессию вызывающего credential даже если последующая запись аудита не удалась; отказ БД не дает ложного успеха.
10. Audit query защищен `audit.view`, использует составной opaque-курсор (timestamp/id с микросекундами) и регистрирует аудит просмотра; отказ записи аудита возвращает `AUDIT_FAILED` без выдачи данных.

## Предлагаемые фасады и свойства операций

| Фасад | Permission | Scope | Transaction/idempotency |
| --- | --- | --- | --- |
| `IdentityFacade.login` | публичный login boundary | входной UPN, субъект из AD | транзакция с session+audit; возвращает sessionContext и 256-битный credential; повторный запрос не создает дубликат |
| `IdentityFacade.bootstrap` | `platform.bootstrap` через `LocalOperatorPort` | подтвержденная AD-личность и отдел | singleton lock `SELECT ... FOR UPDATE`; состояния ready->completed; одноразовый invariant |
| `AuthorizationFacade.authorize` | вызывается защищенной операцией | ресурсный scope модуля | актуальное чтение PostgreSQL по credential_hash; клиентские claims игнорируются |
| `AdministrationFacade.assignEmployee` | `employees.manage` (+ `role.platform.admin` для админ-ролей) | employee и отдел | singleton lock, проверка last active admin, обязательный expectedVersion, атомарно с revoke sessions+audit |
| `AdministrationFacade.setModuleAvailability` | отдельное `modules.manage` | module+department | обязательный expectedVersion (CAS), атомарно с audit |
| `AuditFacade.query` | отдельное `audit.view` | разрешенный audit scope | read-only, пагинация по составному opaque-курсору, обязательный аудит просмотра (при отказе — `AUDIT_FAILED`) |
| `SessionFacade.logout` | владелец сессии (actorCredential) | собственная сессия | отзыв сессии по credential_hash; revoke не откатывается из-за audit failure |

Ошибки должны использовать стабильные обобщенные коды. `NOT_FOUND_OR_FORBIDDEN` предлагается для предотвращения раскрытия существования чужого ресурса. Все входы и ответы получают runtime validation. Для каждой операции до реализации должны быть определены входное состояние, атомарная граница, результат конфликта/сбоя и обязательная audit-запись.

## Рассмотренные альтернативы

- LDAP-группы как источник ролей: отклонено; права должны быть явно назначены в PostgreSQL.
- Роль/отдел в cookie или клиентском запросе: отклонено; это недоверенный ввод.
- Долгоживущий offline login при AD outage: отклонен для MVP.
- Скрытие пунктов меню вместо серверной проверки: отклонено.
- Отдельный audit commit после бизнес-изменения: отклонено для критических действий из-за рассинхронизации.
- Немедленный глобальный отзыв всех уже начатых операций: не обещается в MVP; отзыв действует со следующей операции.

## Риски и открытые решения

- Не утверждены token/cookie механика, rotation, CSRF, activity definition, rate limits, таймауты и LDAP status checks; TTL 8 часов/30 минут являются только baseline proposal.
- Last-admin invariant требует точной модели активного администратора и конкурентного протокола.
- Нужно определить повторный вход для состояний pending/active/blocked, атомарную границу FR-004/FR-021, полный перечень критических действий и точную семантику resource scope.
- Нужно утвердить жизненный цикл отделов/ролей, поля исторического отдела и retention аудита.
- Блокировка только в AD может быть замечена лишь при следующем входе; это явное ограничение MVP.

## Проверка приемки

- LDAP integration: success, bad password, outage, invalid certificate, UPN rename, new `objectGUID`.
- Negative authorization: pending/blocked, expired/idle session, wrong department, unavailable module, missing permission, forged client subject/role.
- Concurrency tests: simultaneous bootstrap and removing last active admin.
- Transaction failure tests: audit failure, PostgreSQL outage, failed session creation, logout failure path.
- Cache tests for cross-user/role/department leakage and audit access tests.

## Требуемое утверждение

Утвердить identity key, state model, concurrency policy, session/cookie and CSRF design, audit fields/retention, exact permissions and delegation. До утверждения реализация и миграции запрещены.
