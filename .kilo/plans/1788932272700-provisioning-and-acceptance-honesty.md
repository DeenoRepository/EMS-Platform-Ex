# EMS: честный provisioning и обязательная последовательность приёмки (D2–D6)

## Цель

Закрыть дефекты D2–D6 из `.kilo/plans/1788931545962-project-completeness-audit.md`: убрать обход инвариантов bootstrap в деплой-скрипте, устранить fallback-строки подключения, заменить фиктивную приёмку явным skip, включить проверки границ в обязательную последовательность и снять заглушку в `pnpm-workspace.yaml`.

Это подготовительный шаг перед Gate B. Без него любой прогон PostgreSQL-приёмки недоказуем: `check:boundaries` ничем не блокируется, а `pnpm test` показывает зелёный тест, который ничего не проверяет.

## Базовое состояние (проверено в этой сессии)

- HEAD `57bc527`, рабочее дерево содержит только untracked `.kilo/plans/1788931545962-project-completeness-audit.md`.
- **D1 уже закрыт коммитом `57bc527`** и в аудите отражён устаревшим статусом. `tools/check-boundaries.mjs:6-13` принимает `--fixture <dir>`, реально переносит корень анализа; `tools/check-boundaries-fixtures.mjs` перебирает `tools/fixtures/boundaries/*` и требует ненулевой exit. Подстановки `errors.length = 0` больше нет. Переделывать D1 не нужно.
- D2–D6 подтверждены как открытые по фактическому коду (ссылки ниже).

Ключевой факт, определяющий форму исправления D2: на действительно чистой БД миграция `002_core_security_remediation.sql:10-18` не находит активного администратора и ставит `locked-legacy`. В `ready` состояние переводит только `SchemaMigrator.provisionClean()` (`migrator.ts:71-75`). Скрипт `05-provision-app.sh` применяет миграции сырым `psql`, минуя мигратор, поэтому чистый стенд оказался бы заперт — и автор добавил принудительный сброс. Правильное исправление — развести clean-install и upgrade по разным путям, а не чинить сам сброс.

## Согласованные решения

1. Объём шага — батч D2–D6. D7 (пакеты без тестов) и D8 (статическая диагностика) остаются вне области.
2. `locked-legacy` на существующей БД: `05-provision-app.sh` **отказывает** с диагностикой и ненулевым кодом, ничего не меняя. Снятие — ручная операторская процедура в `RUNBOOK.md` под решение владельца. Автоматической команды разблокировки не создаём: это создало бы штатный путь повторного захвата администратора и потребовало бы отдельного ADR.
3. Миграции на стенде применяются только через `SchemaMigrator`. Для этого `packages/core` получает исполняемый CLI-вход — библиотечного `index.ts` недостаточно, а `tools/` не входит в офлайн-bundle.

## Область изменений

Разрешено:

- `packages/core/src/cli/` (новый), `packages/core/package.json` (bin + subpath export + scripts), тесты core.
- `infra/standalone-ubuntu/scripts/05-provision-app.sh`, `infra/standalone-ubuntu/RUNBOOK.md`.
- `infra/docker/scripts/run-acceptance.sh` и `run-acceptance.ps1`.
- `packages/core/src/persistence/pg-integration.test.ts`.
- Корневой `package.json`, `pnpm-workspace.yaml`.
- `.kilo/plans/1788931545962-project-completeness-audit.md` — отметить D1 как закрытый в `57bc527`.

Запрещено: менять публичные DTO и сигнатуры фасадов, переписывать миграции `001`/`002`, добавлять зависимости, читать `References/`, подключаться к произвольной БД, выполнять push/merge/release.

## Задачи

### 1. Migration CLI в `packages/core` (основа для D2)

Создать `packages/core/src/cli/migrate.ts` — тонкую обёртку над `SchemaMigrator`, без новой доменной логики.

- Команды: `provision-clean` (полный набор через `provisionClean()`), `upgrade` (последовательный `applyMigration()` без `cleanProvision`), `status` (вывод `schema_migrations` и `bootstrap_state.status`).
- Строка подключения — только из явной переменной окружения миграционной роли. При её отсутствии — ненулевой код. Никаких localhost-defaults, никакого чтения ambient `PG*`. Строку подключения не печатать (roadmap §86).
- Миграции читать из каталога `packages/core/migrations` относительно расположения пакета; `001`/`002` в фиксированном порядке версий.
- Ненулевой exit при любой ошибке мигратора; `pool.close()` в `finally`.
- Зарегистрировать subpath export `./cli` и `bin` в `packages/core/package.json`. Корневой `.` export не менять (roadmap §90).
- После добавления export обязательно прогнать `check:boundaries` — CLI не должен тянуть ничего сверх `@ems/contracts`, `pg`, `node:*`.

Тест: `provision-clean` на существующей схеме отказывает; `upgrade` не трогает `bootstrap_state`; отсутствие переменной подключения даёт ненулевой код. Достаточно fake-пула по образцу `migrator.test.ts`.

### 2. D2 — `05-provision-app.sh` перестаёт обходить инварианты

Файл: `infra/standalone-ubuntu/scripts/05-provision-app.sh:32-96`.

- Удалить блок 82-93 целиком (принудительный `ON CONFLICT DO UPDATE SET status='ready'`).
- Удалить ручное `CREATE SCHEMA`/`CREATE TABLE schema_migrations` (54-61) и цикл сырого применения `001`/`002` через `psql` (63-80). Этот путь идёт без advisory lock, без проверки `PINNED_HISTORICAL_CHECKSUMS` и без проверки чистоты.
- Заменить на вызов CLI из задачи 1:
  - схема `ems_core` отсутствует → `provision-clean` (создаёт схему и корректный `ready` в одной транзакции);
  - схема есть → `upgrade`; терминальные `completed` и `locked-legacy` сохраняются.
- После `upgrade` прочитать `bootstrap_state.status`. При `locked-legacy` — вывести диагностику со ссылкой на раздел RUNBOOK и завершиться ненулевым кодом до `systemctl restart ems-web`. Ничего не записывать.
- Проверку наличия схемы делать по `pg_namespace`, а не по наличию администраторов: количество админов вообще не должно влиять на provisioning.

### 3. D2 — операторская процедура в RUNBOOK

Файл: `infra/standalone-ubuntu/RUNBOOK.md`.

- Обновить шаг 3.6 (строки 116-121) под новый CLI и два режима.
- Новый раздел «Обработка `locked-legacy`»: как отличить чистую установку от legacy-БД, диагностический запрос, требование решения владельца до любой записи, ручной SQL с фиксацией в протоколе, явное предупреждение о повторном захвате администратора.
- В разделе 4 (Bootstrap) указать, что `ready` возникает исключительно из `provision-clean`.

### 4. D3 — убрать fallback-строки подключения

Файлы: `infra/docker/scripts/run-acceptance.sh:9-10`, аналогичное место в `run-acceptance.ps1`.

- Убрать значения по умолчанию с учётными данными. Если `EMS_TEST_PG_MIGRATION_URL`/`EMS_TEST_PG_RUNTIME_URL` не заданы — сообщение с именами переменных (без значений) и ненулевой код.
- `tools/require-pg-acceptance.mjs` больше не должен обходиться подстановкой в обёртке.
- Проверить, что `infra/docker/.env.example` остаётся единственным местом с синтетическими примерами.

### 5. D4 — честный skip вместо `assert.ok(true)`

Файл: `packages/core/src/persistence/pg-integration.test.ts:22-31`.

- Заменить `assert.ok(true)` на `test(..., { skip: '...' })` node:test, чтобы прогон отражался как skipped, а не passed.
- Исправить текст на строке 28: переменной `EMS_TEST_PG_URL` не существует, актуальны `EMS_TEST_PG_MIGRATION_URL` и `EMS_TEST_PG_RUNTIME_URL`.
- Строгий путь (`EMS_TEST_PG_REQUIRED=true` → throw, строки 19-21) сохранить без изменений.

### 6. D5 — включить проверки границ в обязательную последовательность

Файл: корневой `package.json:6-13`.

- Добавить `verify`, последовательно выполняющий `typecheck` → `check:boundaries` → `check:boundaries:fixtures` → `test`. Последовательно, не параллельно: общие артефакты `tsc -b`.
- Обе boundary-проверки должны быть недостижимы для пропуска в приёмке.
- В `check-boundaries.mjs:14-22` захардкожен список пакетов: новый пакет молча не проверяется. Заменить на чтение `pnpm-workspace.yaml`-глобов либо добавить сверку, что каждый найденный `packages/*`/`apps/*` присутствует в `packageRoots`, иначе ошибка. Матрицу `allowed` (строки 47-55) оставить явной — это политика, она не выводится автоматически.

### 7. D6 — снять заглушку workspace

Файл: `pnpm-workspace.yaml:4-5`.

- `esbuild: set this to true or false` — не boolean. `esbuild` в `pnpm-lock.yaml` отсутствует, запись лишняя: удалить ключ `allowBuilds` целиком.
- Если после удаления `pnpm install` требует решения по build-скриптам — зафиксировать явный boolean, не оставлять текст.

### 8. Синхронизировать аудит

В `.kilo/plans/1788931545962-project-completeness-audit.md` пометить D1 закрытым коммитом `57bc527` со ссылкой на `tools/check-boundaries-fixtures.mjs`. Не переписывать остальной отчёт.

## Обязательные проверки

Выполнить фактически и зафиксировать exit codes; невыполненное указать с причиной.

- `pnpm run typecheck`
- `pnpm run build`
- `pnpm run check:boundaries` (ожидается 0)
- `pnpm run check:boundaries:fixtures` (каждая fixture отклонена)
- `pnpm run test`
- `pnpm run verify` (новый агрегат)
- `bash -n` для изменённых shell-скриптов
- `git diff --check`

`test:pg` в этом шаге не запускается: разрешение владельца на одноразовый стенд с `DROP SCHEMA` не получено. Это отражается как blocked, а не как passed.

Ручная проверка D2 без стенда невозможна — фиксируется как остаточный риск. Логику clean/upgrade покрыть тестами CLI из задачи 1.

## Риски

- CLI добавляет исполняемый вход в `packages/core`. Ошибка в резолвинге каталога миграций в bundle-раскладке (`/opt/ems/app/packages/core/migrations`) проявится только на стенде — путь вычислять от расположения модуля, а не от cwd.
- Отказ при `locked-legacy` сделает повторный `05-provision-app.sh` на уже развёрнутом стенде без админов не проходящим. Это намеренно: раньше он молча разблокировал одноразовый bootstrap.
- Изменение `check-boundaries.mjs` под автообнаружение пакетов может вскрыть ранее не проверявшиеся нарушения. Реальные нарушения чинить, проверку не ослаблять.

## Требуемые решения владельца (вне этого шага)

1. Разрешение на `infra/docker/` как одноразовый стенд приёмки, включая `teardownEphemeralSchema()` (`DROP SCHEMA`) — блокирует Gate B.
2. Утверждение текста операторской процедуры снятия `locked-legacy` из задачи 3.
3. Tooling-approval на Next.js/React/ldapts/Zod (ADR-0003 §10, §71) — блокирует этапы 2–4 дорожной карты.

## После завершения

Коммит на русском с изменениями только этой задачи (`AGENTS.md` §5.2). Следующий шаг — Gate B: interleaving-тесты, терминальные состояния provisioning, реальные audit-фильтры и микросекундная пагинация; требует решения владельца №1.
