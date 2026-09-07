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
3. Bootstrap является отдельной server-only операцией, одноразовой и атомарной. Конкурирующие bootstrap и last-admin операции должны защищаться транзакцией и утвержденным механизмом блокировки/версии.
4. Авторизация на сервере выполняет отдельные проверки: активная сессия, permission, module availability для отдела и resource scope. Клиентские поля subject/department/roles не являются доверенными.
5. Перевод устанавливает ровно один новый отдел и явно выбранные роли, отзывает все сессии и пишет аудит до commit. Старые роли не копируются.
6. Предлагаемый baseline сессии: absolute TTL 8 часов и idle TTL 30 минут. Background requests не считаются активностью. Значения TTL, cookie flags, token format, rotation, CSRF, rate limits и activity definition являются неутвержденными решениями владельца и блокируют реализацию.
7. LDAP outage запрещает новый вход; существующая сессия работает в TTL. При недоступной PostgreSQL защищенный доступ запрещается.
8. Критическое изменение и audit record выполняются в одной транзакции. Успешный вход с созданием сессии также требует audit record. Logout отзывает сессию даже если последующая запись аудита не удалась; точное поведение отказа БД должно быть утверждено.
9. Audit UI read-only, с фильтрами и cursor pagination, отдельным permission и аудитом просмотра. Экспорт/изменение/удаление не входят в MVP.

## Предлагаемые фасады и свойства операций

| Фасад | Permission | Scope | Transaction/idempotency |
| --- | --- | --- | --- |
| `IdentityFacade.login` | публичный login boundary | только входной UPN; субъект из LDAP | транзакция с session+audit; повторный запрос не должен создать дубликат личности |
| `IdentityFacade.bootstrap` | `platform.bootstrap` | выбранная AD-личность и отдел | serializable/эквивалентная защита; одноразовый invariant |
| `AuthorizationFacade.authorize` | вызывается защищенной операцией | ресурсный scope модуля | актуальное чтение PostgreSQL; клиентские claims игнорируются |
| `AdministrationFacade.assignEmployee` | назначенное admin permission | employee и отдел | атомарно с revoke sessions+audit; optimistic version proposal |
| `AdministrationFacade.setModuleAvailability` | назначенное admin permission | module+department | атомарно с audit; повтор должен быть безопасен |
| `AuditFacade.query` | отдельное audit-read permission | разрешенный audit scope | read-only; просмотр аудируется |
| `SessionFacade.logout` | владелец сессии или разрешенный администратор | конкретная session | revoke не откатывается из-за audit failure |

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
