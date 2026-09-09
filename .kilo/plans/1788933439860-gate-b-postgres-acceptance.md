# EMS: Gate B — реальная PostgreSQL-приёмка ядра

## Цель и разрешение владельца

Закрыть Gate B из `.kilo/plans/1788798898301-core-stabilization-roadmap.md` (раздел «Стенд и границы готовности») и подготовительный пункт 4 из `.kilo/plans/1788931545962-project-completeness-audit.md`: реальные PostgreSQL-проверки конкурентности, terminal-состояний provisioning и пагинации аудита, вместо unit-тестов на моках.

**Владелец в этой сессии разрешил** использовать `infra/docker/` как одноразовый стенд приёмки и вызывать `SchemaMigrator.teardownEphemeralSchema()` (`DROP SCHEMA IF EXISTS ems_core CASCADE`) в базе `ems_test` с синтетическими данными. Разрешение ограничено `ems_test`; `ems_dev` не трогать. LDAP (Samba AD) для Gate B не требуется — фасады уже принимают LDAP/оператора через внедряемые порты (`DirectoryAuthenticator`, `DirectoryIdentityResolver`, `LocalOperatorPort`), реальный LDAP вне области.

## Базовое состояние

- HEAD `8295238` («Устранить обход provisioning и усилить приёмку»), рабочее дерево — только untracked `.kilo/plans/1788932272700-provisioning-and-acceptance-honesty.md` (сам план ещё не закоммичен, хотя задачи D2–D6 из него уже в коде).
- D1–D6 из `1788931545962-project-completeness-audit.md` закрыты: `check:boundaries` включён в `pnpm run verify`, `05-provision-app.sh` не обходит инварианты, есть CLI `packages/core/src/cli/migrate.ts`, fallback-строки подключения убраны, `assert.ok(true)` заменён на явный skip, заглушка `pnpm-workspace.yaml` снята.
- Реальный PostgreSQL сейчас покрыт только двумя тестами в `packages/core/src/persistence/pg-integration.test.ts`: цикл миграций (001→002→rollback→reapply) и один конкурентный `INSERT ... ON CONFLICT`. `packages/core/src/facades/facades.test.ts` — только in-memory симулятор (`MockDatabasePool`), не настоящий PostgreSQL.
- Ни один из перечисленных в roadmap §2, §3, §6 сценариев конкурентности/terminal-состояний/пагинации не покрыт реальной БД.

## Разрешённая область

- `packages/core/src/persistence/pg-integration.test.ts` — расширить (terminal-состояния provisioning, конкурентный `provisionClean`, аудит-фильтры и пагинация).
- Новый файл `packages/core/src/facades/facades-pg-integration.test.ts` — интерливинг-сценарии facade-уровня на реальном пуле.
- Новый тестовый helper для барьеров координации (например `packages/core/src/persistence/pg-test-barrier.ts` или `.test-support.ts`, тестовый код, не часть публичного `exports`).
- `packages/core/package.json` (`test:pg`), `tools/run-pg-test.mjs` — включить новые файлы в строгий прогон.
- `docs/specs/ems-core-mvp.md` §13 — обновить статус после фактического прогона (не раньше).
- Не менять публичные DTO/сигнатуры фасадов, не переписывать `001`/`002`, не трогать `ems_dev`.

## Ключевое техническое решение: барьер без sleep

Roadmap требует «координировать соединения явными барьерами, не случайными задержками». Для сценариев, где важен конкретный порядок (login раньше assign / assign раньше login), production-код не даёт точки паузы внутри транзакции фасада — нужен внешний барьер:

1. Отдельным «decoy»-клиентом открыть `BEGIN; SELECT ... FROM ems_core.employees WHERE id = $1 FOR UPDATE;` (или `bootstrap_state WHERE id = 1 FOR UPDATE` для сценариев bootstrap) и держать транзакцию открытой.
2. Запустить первый facade-вызов (тот, что должен выполниться первым) — он заблокируется на том же locked-ряду.
3. Опросом `SELECT ... FROM pg_locks WHERE NOT granted AND relation = 'ems_core.employees'::regclass` (с bounded timeout, poll-интервал мс, не `setTimeout`-угадывание) дождаться, что первый вызов реально встал в очередь ожидания.
4. Запустить второй facade-вызов, аналогично опросом подтвердить, что он тоже встал в очередь позади первого.
5. Закоммитить/откатить decoy — по вытеснению лока Postgres обычно освобождает ожидающих в порядке запроса (FIFO по конфликтующим row-lock). Дождаться завершения обоих промисов, проверить итоговый инвариант и то, какой вызов эффективно был «раньше» по данным в БД (audit/session/version).
6. Для обратного порядка — поменять местами шаги 2 и 4 в отдельном тесте с независимыми данными (новая AD-личность на тест, не переиспользовать employee между тестами).

Для сценариев, где порядок неважен, а важен только итоговый инвариант (два bootstrap; два снятия последней админ-роли; конкурентный CAS `setModuleAvailability`), барьер не нужен — эти операции уже сериализуются существующими блокировками (`bootstrap_state FOR UPDATE`, версия `module_availability`), достаточно `Promise.all` двух вызовов и проверки, что ровно один успешен, а другой получил ожидаемый `CONFLICT`.

Для «два логина новой AD-личности» уже есть паттерн в текущем `pg-integration.test.ts` (`ON CONFLICT DO NOTHING` + `Promise.all`) — расширить его до facade-уровня (`login()` целиком, не сырой SQL), не требует decoy-барьера, так как конфликт разрешается на уровне constraint.

## Задачи

### 1. Базовая сверка перед изменениями

- Прочитать навыки `senior-qa`, `migration-architect`, `senior-security` по области работ.
- Проверить `git status`/`git log -5`, подтвердить HEAD `8295238` и отсутствие незапланированных изменений.
- Выполнить `pnpm run verify` (typecheck → check:boundaries → check:boundaries:fixtures → test) и зафиксировать текущий зелёный baseline до правок.
- Закоммитить или явно отметить как отдельный шаг файл `.kilo/plans/1788932272700-provisioning-and-acceptance-honesty.md`, который сейчас untracked (не входит в эту задачу по содержанию, но не должен быть случайно потерян/смешан с новым коммитом Gate B — согласовать с владельцем порядок коммитов, если он не был закоммичен намеренно).

### 2. Поднять стенд

- `bash infra/docker/scripts/stand-up.sh` (poднимает postgres, samba-ad, nginx контейнеры; для Gate B нужен только postgres, но скрипт стартует полный стенд — это ожидаемо и не требует правок).
- Взять `EMS_TEST_PG_MIGRATION_URL` / `EMS_TEST_PG_RUNTIME_URL` из `infra/docker/.env` (создаётся из `.env.example` при первом запуске `stand-up.sh`).
- Убедиться, что используется база `ems_test`, не `ems_dev`.

### 3. Барьер-хелпер для тестов

Новый тестовый модуль (не публичный export пакета) с функциями:

- `withDecoyLock(pool, sql, params, fn)` — открывает decoy-транзакцию с `FOR UPDATE`, вызывает `fn()` (внутри которого стартуют реальные facade-промисы и опрос `pg_locks`), затем коммитит/откатывает decoy.
- `waitUntilBlocked(pool, predicateSql, timeoutMs)` — опрашивает `pg_locks`/`pg_stat_activity` с фиксированным poll-интервалом (например 25мс) до срабатывания предиката или таймаута; при таймауте — явный `assert.fail` с диагностикой, не тихий проход.

Тест на сам хелпер не обязателен отдельно — он покрывается использованием в задачах 4–5.

### 4. `packages/core/src/facades/facades-pg-integration.test.ts` — интерливинг-сценарии

Каждый сценарий — отдельный `test()`, использует реальный `DatabasePool` к `EMS_TEST_PG_RUNTIME_URL`/`MIGRATION_URL`, fake `DirectoryAuthenticator`/`DirectoryIdentityResolver`/`LocalOperatorPort` (как в `facades.test.ts`, in-process, не реальный LDAP), `migrator.teardownEphemeralSchema()` + `provisionClean()` в `beforeEach`/начале файла для чистого состояния.

Обязательные сценарии (сопоставление с roadmap §2 и AC-006/007):

1. **login → assign (assign видит результат login)**: барьер держит login первым, assign — вторым на той же личности; после — сотрудник в новом отделе/ролях, сессия login отозвана assign'ом (`revoked_at` не null, `revocation_reason = 'ASSIGNMENT_TRANSFERRED'`), аудит `ASSIGN_EMPLOYEE` содержит корректный `previousDepartmentId`/`previousRoleIds` из состояния, созданного login.
2. **assign → login (login видит результат assign)**: обратный порядок; после — login получает уже новые роли/отдел в `SessionContext` (не старые/дефолтные), сессия login не задета отзывом assign (assign завершился раньше).
3. **login → bootstrap той же новой AD-личности**: bootstrap должен либо успешно превратить PENDING-сотрудника, созданного login, в администратора и отозвать его сессию (FR-020-подобный эффект через `revokeAllForEmployee` в bootstrap), либо (если bootstrap первый) login видит уже ACTIVE-администратора. Оба порядка — отдельные тесты.
4. **bootstrap → login существующей (уже ACTIVE, не admin) личности**: аналогично п.3 для `existingEmployee`-ветки bootstrap.
5. **Два конкурентных bootstrap** (`Promise.all`, без барьера — сериализуется через `bootstrap_state FOR UPDATE`): ровно один `ok`, второй — `CONFLICT` с сообщением про FR-012; в БД остаётся ровно один активный администратор.
6. **Два конкурентных снятия последней активной админ-роли**: bootstrap создаёт админа A, `assignEmployee` добавляет админ-роль B (актор — A). Затем конкурентно `assignEmployee(A, roleIds=[])` и `assignEmployee(B, roleIds=[])` (акторы — соответственно B и A). Инвариант: хотя бы один из двух вызовов получает `CONFLICT` (FR-019), в БД не остаётся 0 активных администраторов.
7. **Конкурентный `setModuleAvailability` CAS**: два вызова с одинаковым `expectedVersion` на одну пару `(moduleId, departmentId)` — один `ok`, другой `CONFLICT` с сообщением о версии.
8. **Два логина новой AD-личности на facade-уровне** (расширение существующего repository-уровня теста до полного `login()`): ровно одна запись сотрудника, ровно одна активная сессия по каждому из двух `credential.value` не создаётся дважды на одну и ту же строку — оба вызова `login()` успешны (по одному на каждый параллельный запрос) с разными `sessionId`, но связаны с одним `employee.id`.

### 5. `packages/core/src/persistence/pg-integration.test.ts` — terminal-состояния и аудит

Добавить (не удаляя существующие 2 теста):

1. **`upgrade` на `completed`**: применить `provisionClean`, вручную bootstrap-подобным SQL создать активного админа и `completed` (или переиспользовать facade bootstrap), затем вызвать `applyMigration` для уже применённых версий — `bootstrap_state.status` остаётся `completed`.
2. **`upgrade` на `locked-legacy`**: применить только `001` напрямую (без `provisionClean`), затем применить `002` через `applyMigration` (не `provisionClean`) — по логике `002_core_security_remediation.sql` без активных админов должен установиться `locked-legacy`; повторный `applyMigration` не переводит его в `ready`.
3. **Пустая существующая схема**: `CREATE SCHEMA ems_core;` без таблиц, затем `provisionClean(...)` — отказ (уже покрыто в `migrator.test.ts` на моке; здесь — то же на реальной БД: `pg_namespace` видит схему → отказ до какой-либо записи).
4. **Частичная установка / атомарный откат**: вызвать `provisionClean` со списком миграций, где вторая — заведомо невалидный SQL (например синтетическая миграция с опечаткой, не изменяя `001`/`002`) — транзакция откатывается целиком, `ems_core` полностью отсутствует после сбоя (проверить через `pg_namespace`), повторный корректный `provisionClean` после этого проходит успешно.
5. **Два конкурентных `provisionClean`** (`Promise.all`, без decoy — сериализуется advisory lock `ems_core.migration_lock`): ровно один успешен, второй получает ошибку «absent ems_core schema» (он видит уже созданную первым схему).
6. **Аудит: фильтры и микросекундная пагинация на реальной БД**: вставить через `AuditRepository.insert` (или facade) не менее 5 записей с явно заданными `timestamp` с разницей в микросекундах (использовать `Date` с точностью до мс — для микросекундного различия внутри одной миллисекунды опираться на `id`-tiebreaker курсора, который уже часть контракта курсора `(timestamp, id)`), затем: (a) фильтр по `action`, (b) фильтр по `subjectId`, (c) фильтр по периоду `periodStart`/`periodEnd`, (d) постраничный обход через `nextCursor` с `limit` меньше общего числа записей — проверить отсутствие дублей/пропусков между страницами и корректный порядок (DESC по времени, затем по id).

### 6. Обвязка запуска

- `packages/core/package.json` → `test:pg`: включить компиляцию и запуск обоих новых/расширенных файлов.
- `tools/run-pg-test.mjs`: передать все PG-тестовые файлы (`dist/persistence/pg-integration.test.js`, `dist/facades/facades-pg-integration.test.js`) с **последовательным** выполнением (не полагаться на конкурентность `node --test` по умолчанию — она может выполнять переданные файлы параллельно и столкнуть два `teardownEphemeralSchema()` на одной `ems_test`). Явно задать `--test-concurrency=1` либо запускать файлы последовательными `spawnSync`-вызовами с проверкой exit code каждого.
- Убедиться, что `EMS_TEST_PG_REQUIRED=true` (уже проставляется `tools/run-pg-test.mjs`) по-прежнему приводит к явному throw при отсутствии стенда — не менять этот путь.

### 7. Прогон и фиксация результатов

Выполнить и записать фактические exit code (не оценочно):

- `pnpm run verify` (regression-проверка, что новые тестовые файлы не сломали существующую цепочку).
- `bash infra/docker/scripts/run-acceptance.sh` (обёртка над `pnpm --filter @ems/core run test:pg` с `EMS_TEST_PG_INTEGRATION=true` и явными URL).
- Убедиться, что после прогона стенд можно поднять повторно с нуля (`stand-down.sh` → `stand-up.sh` → повторный `run-acceptance.sh`) без остаточного состояния — это дополнительно подтверждает атомарность отката из задачи 5.4.

### 8. Обновить статус документации

- `docs/specs/ems-core-mvp.md` §13 — заменить формулировку «Реальный PostgreSQL concurrency/rollback/upgrade acceptance не заявляется выполненным» на фактический статус по итогам прогона задачи 7, с явным перечислением выполненных сценариев и датой. Не объявлять Gate B «принятым» самостоятельно — по roadmap §7 (`Gate B: стабилизация принята`) требуется независимое ревью и подтверждение владельца; зафиксировать только «код и тесты реализованы, PostgreSQL-прогон пройден, ожидает независимого ревью и подтверждения владельца».
- Не редактировать исторические `.kilo/plans/1788798898301-*.md` и `1788931545962-*.md` по содержанию, кроме статусной пометки, если владелец отдельно попросит.

## Обязательные проверки (зафиксировать фактические результаты)

- `pnpm run typecheck`
- `pnpm run check:boundaries` и `pnpm run check:boundaries:fixtures`
- `pnpm run test` (обычный прогон, PG-тесты — skip, как сейчас)
- `pnpm run verify`
- `bash infra/docker/scripts/run-acceptance.sh` (реальный PostgreSQL, `ems_test`)
- `git diff --check`

## Риски и остаточные ограничения

- Decoy-lock + `pg_locks`-опрос — стандартный, но не 100%-гарантированный Postgres паттерн (FIFO-порядок ожидающих блокировок — фактическое поведение планировщика блокировок, не документированная гарантия). Если порядок наблюдаемо нестабилен в CI-подобной среде, тест должен явно проверять оба возможных исхода как «допустимые» и падать только если инвариант (данные) нарушен, а не если конкретный порядок не совпал — фиксировать это как известное ограничение в комментарии теста.
- `05-provision-app.sh` на реальном Ubuntu-стенде (`infra/standalone-ubuntu/`) этим планом не проверяется — для этого нужен отдельный Ubuntu-стенд, не `infra/docker/`; остаётся остаточным риском, как и было отмечено в `1788932272700-*.md`.
- Реальный LDAP (Samba AD) не участвует в Gate B — LDAP-адаптер (`ldapts`) всё ещё не реализован (см. `1788931545962-*.md` §3.1); это отдельный последующий этап дорожной карты, не блокирует Gate B по PostgreSQL.
- Независимое ревью и подтверждение владельца для итогового статуса «Gate B принят» — вне полномочий исполнителя этой задачи; исполнитель фиксирует только факт выполненных проверок.

## После завершения

Коммит на русском языке с изменениями только этой задачи (`AGENTS.md` §5.2, §13). Если `.kilo/plans/1788932272700-provisioning-and-acceptance-honesty.md` всё ещё untracked к моменту работы — согласовать с владельцем, включать ли его в этот коммит или коммитить отдельно первым шагом.
