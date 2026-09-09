# EMS Platform: инспекция завершённости по планам

## Метаданные инспекции

- База: `/home/deeno/Public/Projects/EMS-Platform-Ex`, HEAD `f3fe120`, рабочее дерево чистое (`git status --short` — пусто).
- Метод: статический анализ файлов репозитория и сверка с `.kilo/plans/*.md`, `docs/specs/ems-core-mvp.md`, `docs/adr/0001..0003`, `AGENTS.md`.
- **Runtime-проверки не выполнялись.** Попытки запустить `pnpm run build`, `node --test`, `node tools/check-boundaries.mjs` отклонены политикой разрешений инструмента в этой сессии. Ни один зелёный результат сборки/тестов в этом отчёте не заявляется как проверенный факт.
- `References/` не читался.

## 1. Сводка: что фактически завершено

| Плановый артефакт | Статус | Доказательство |
| --- | --- | --- |
| `1788779726328-agent-project-guidelines` | Завершено | `AGENTS.md` (67 КБ, 15 разделов) |
| `1788779726328-agents-review-fixes` | Завершено | правила ужесточены в `AGENTS.md` |
| `1788779726328-ems-development-skills` | Завершено | 11 навыков в `.kilo/skills/`, матрица в `AGENTS.md` §15 |
| `1788784880617-ems-mvp-specification` (документационная задача) | Завершено | `docs/specs/ems-core-mvp.md` (Approved), `docs/adr/0001..0003` (Approved) |
| `1788794181335-core-review-fixes` (F01–F12) | Закрыто в коде | credential/hash-разделение `subject-auth.ts:10-17`, deny-by-default `module-availability.repository.ts:23`, отказ по `resourceScope` `postgres-authorization.facade.ts:37-39`, `bootstrap_state` singleton `002_core_security_remediation.sql:2-20` |
| `1788795491644-core-security-review-remediation` | Закрыто в коде | миграция 002, `expectedVersion` в обеих админ-операциях, `modules.manage`, `AUDIT_FAILED` при отказе аудита просмотра |
| `1788798898301-core-stabilization-roadmap` **Gate A** | Заявлен достигнутым в `docs/specs/ems-core-mvp.md:224`, **не подтверждён в этой сессии** | код и тесты присутствуют, запуск невозможен |
| `1788798898301` **Gate B** | **Не достигнут** | см. §3 |
| Инфраструктура стенда (commit `71e7f11`, `f338de2`) | Каркас есть | `infra/docker/`, `infra/standalone-ubuntu/`, `infra/certs/` |

Реализованный код: `packages/contracts` (157+40+30 строк типов), `packages/core` (~2000 строк: registry, 5 фасадов, 7 репозиториев, мигратор, 2 миграции), `packages/shell` (37 строк), `packages/shared-controls` (87 строк типов), `packages/demo-module`, `packages/diagnostic-extension`, `apps/web` (39 строк composition root), `tools/` (3 скрипта). Тесты: 42 `test()`/`describe()` блока, из них реальных PostgreSQL — 2.

## 2. Главный вывод

Проект завершён примерно на уровне **«ядро без приложения»**. Реализована серверная доменная логика ядра на TypeScript + `pg`. Не начаты три из четырёх этапов, перечисленных в `1788798898301-core-stabilization-roadmap.md` §«Следующие этапы».

Ключевой факт: **в проекте нет Next.js, React и LDAP-клиента.** `pnpm-lock.yaml` содержит ровно три прямые зависимости на весь монорепозиторий: `typescript`, `@types/node`, `pg` (+`@types/pg`). Файлов `.tsx` в репозитории нет ни одного. `apps/web` — это не Next.js-приложение, а библиотека, экспортирующая функцию `createAppComposition()` (`apps/web/src/index.ts:14`).

Следовательно, утверждение из `docs/specs/ems-core-mvp.md:206` («Стек: … Next.js 14 (App Router) … Zod … ldapts … Radix UI + CSS Modules») описывает утверждённое направление, а не текущее состояние. Это не противоречие само по себе (ADR-0003 §10 фиксирует временное tooling-исключение), но объём незакрытого MVP нужно видеть явно.

## 3. Незакрытые требования спецификации MVP

### 3.1. Полностью не реализовано

| Требование | Что отсутствует |
| --- | --- |
| FR-001..003, FR-007, NFR-002 | Нет LDAP-адаптера. `DirectoryAuthenticator` и `DirectoryIdentityResolver` — только интерфейсы (`packages/contracts/src/facades.ts:35-41`), реализаций нет. TLS/CA, защита фильтров от инъекций, таймауты не реализованы и не проверены. |
| FR-005, FR-018, FR-030, FR-037..041 | Нет UI вообще. Нет App Router, Route Handlers, Server Actions, страниц, компонентов. `shared-controls` содержит только TypeScript-интерфейсы пропсов (`src/types.ts`), ни одного компонента и ни одной галереи. |
| FR-024 | Session cookie transport, ротация, CSRF, rate limits, определение пользовательской активности — не реализованы и остаются открытым решением. |
| NFR-003 (клиентская часть) | Проверка отсутствия server-only кода в client bundle невозможна: bundle не существует. Отрицательный browser-build-тест отсутствует. |
| NFR-006 (offline build/smoke) | Нет production-сборки, нет offline bundle, нет SBOM, нет манифеста релиза, нет подписей/provenance. AC-013 закрыт частично (только DDL-цикл). |
| AGENTS.md §9 | Из обязательных автоматических ограничителей есть только boundary-checker. Нет CI (`.github/workflows` отсутствует), secret scanning, проверки лицензий, SBOM, состава bundle, воспроизводимой offline-сборки. |
| AGENTS.md §10 | Локальные `AGENTS.md` пакетов отсутствуют (0 файлов). Требование `1788794181335` §6 не выполнено. |

### 3.2. Gate B: конкретные пропуски против `1788798898301`

Roadmap §2 требует детерминированные interleaving-тесты на реальной PostgreSQL с явными барьерами для: обоих порядков login/assign; login/bootstrap существующей и новой личности; двух bootstrap; двух снятий последних администраторов.

Фактически в `packages/core/src/persistence/pg-integration.test.ts` два теста: цикл миграций (строка 41) и один конкурентный `INSERT ... ON CONFLICT` (строка 74). **Ни один из перечисленных roadmap-сценариев конкурентности не покрыт.**

Roadmap §6 требует проверить audit-фильтры и микросекундную пагинацию на реальной PostgreSQL, «не mock, игнорирующем WHERE». Такого теста нет — пагинация проверяется только in-memory симулятором в `facades.test.ts`.

Roadmap §3 требует тесты `completed`, `locked-legacy`, пустой существующей схемы, частичной установки и двух конкурентных provisioning. В `migrator.test.ts` есть только `provisionClean → ready` (строка 218) и отказы для существующей схемы/пустого набора (строка 199). Терминальные состояния и конкурентный provisioning не покрыты.

**Вывод: Gate B не достигнут, и это корректно отражено в `docs/specs/ems-core-mvp.md:224`.** Спецификация не переоценивает состояние.

## 4. Дефекты и расхождения, выявленные инспекцией

### D1 (High) — фиктивный отрицательный тест boundary-checker

**Статус: закрыт коммитом `57bc527`.** Отрицательные проверки выполняются реальными fixture-каталогами через `tools/check-boundaries-fixtures.mjs`; текущий план D2–D6 сохраняет этот результат и не изменяет D1.

`tools/check-boundaries.mjs:114-118`:

```js
if (fixture === '--fixture-forbidden') {
  errors.length = 0;
  errors.push('fixture: forbidden dependency @ems/core from @ems/contracts');
}
```

Флаг не анализирует никакой fixture — он стирает реальные ошибки и подставляет константную строку. Это не доказывает, что checker блокирует запрещённый импорт. Требование `1788798898301` §89 («Проверять каждый запрещённый класс отрицательной fixture») и `AGENTS.md` §9 («Каждый автоматический ограничитель должен иметь хотя бы один отрицательный тест») **не выполнены**. Хуже: сброс `errors.length = 0` означает, что при этом флаге реальные нарушения маскируются.

### D2 (High) — деплой-скрипт обходит инварианты provisioning

`infra/standalone-ubuntu/scripts/05-provision-app.sh:83-93` при отсутствии активных администраторов принудительно выставляет `bootstrap_state = 'ready'` через `ON CONFLICT DO UPDATE`.

Это прямо противоречит:
- решению roadmap `1788798898301:18` — «Обычный upgrade не переводит существующий bootstrap в `ready`. `completed` и `locked-legacy` не сбрасываются процедурой provisioning»;
- логике миграции `002_core_security_remediation.sql:10-20`, которая специально ставит `locked-legacy` при отсутствии администраторов;
- защите `SchemaMigrator.provisionClean()` (`migrator.ts:59-64`), которая отказывает при существующей схеме.

Скрипт также применяет миграции напрямую через `psql` (строки 64-80), минуя `SchemaMigrator`, то есть без advisory lock, без проверки закреплённых checksum (`PINNED_HISTORICAL_CHECKSUMS`) и без проверки чистоты установки. Практический риск: повторный запуск `05-provision-app.sh` на стенде, где администратор был заблокирован, разблокирует одноразовый bootstrap.

### D3 (Medium) — hardcoded fallback строк подключения с паролями

`infra/docker/scripts/run-acceptance.sh:9-10` подставляет по умолчанию `postgresql://ems_migration:migration_secret@localhost:5432/ems_test`. Roadmap `1788798898301` §86 требует: «До любого соединения… проверить явную migration/runtime-конфигурацию; не допускать fallback к ambient PG-переменным или localhost defaults. Не выводить строки подключения.»

Учётные данные синтетические (`infra/docker/.env.example`), поэтому это не утечка секрета, но правило нарушено, и `tools/require-pg-acceptance.mjs` (который как раз требует явных переменных) обходится подстановкой значений в обёртке.

### D4 (Medium) — `assert.ok(true)` как заглушка приёмки

`packages/core/src/persistence/pg-integration.test.ts:30`. Roadmap §85 явно запрещает: «Не использовать `assert.ok(true)` вместо приёмки». Строгий путь `test:pg` защищён (`EMS_TEST_PG_REQUIRED` вызывает throw, строка 19-21), поэтому обман приёмки исключён, но обычный `pnpm test` показывает зелёный тест, который ничего не проверяет. Формулировка предупреждения на строках 26-28 к тому же ссылается на несуществующую переменную `EMS_TEST_PG_URL`.

### D5 (Medium) — boundary-checker не включён в обязательную последовательность

`check:boundaries` объявлен в `package.json:11` как отдельный root-скрипт, но не вызывается ни из `test`, ни из pretest-хука, ни из CI (CI отсутствует). Roadmap §90 требует подключения «в обязательную последовательность приёмки». Сейчас его пропуск ничем не блокируется.

Дополнительно: список пакетов в checker захардкожен (`check-boundaries.mjs:7-15`) — новый пакет не будет проверен, пока его не добавят вручную, и это не приведёт к ошибке.

### D6 (Low) — незакрытая заглушка `pnpm-workspace.yaml`

```yaml
allowBuilds:
  esbuild: set this to true or false
```

Нерешённое текстовое значение вместо boolean. Дефект зафиксирован ещё в `1788794181335` §31 и §6 и не устранён. `esbuild` в lockfile отсутствует, то есть запись, вероятно, лишняя.

### D7 (Low) — пакеты без тестов

Root `test` = `pnpm -r run test`, но скрипт `test` определён только в `packages/core` и `apps/web`. У `contracts`, `shell`, `shared-controls`, `demo-module`, `diagnostic-extension` тестов нет вовсе. `filterNavigationForUser` (`packages/shell/src/navigation.ts:22`) проверяется только косвенно через `apps/web/src/composition.test.ts:31`.

### D8 (Low) — статическая диагностика выдаётся за проверку здоровья

`packages/diagnostic-extension/src/index.ts:42-46` всегда возвращает `SUBSYSTEMS_OPERATIONAL` без каких-либо проверок. Roadmap §113 это уже отмечает («Статический `SUBSYSTEMS_OPERATIONAL` не считать реальной проверкой здоровья»), и `apps/web/src/composition.test.ts:19` утверждает этот результат как ожидаемый. Расхождения с планом нет, но артефакт нельзя использовать как health check.

## 5. Что признано корректным

- Матрица зависимостей в `check-boundaries.mjs:40-48` соответствует `AGENTS.md` §3.2 и спецификации §2; `contracts` и `shared-controls` объявлены без зависимостей.
- Разделение публичного `sessionId` и секретного credential реализовано: хранится только SHA-256 (`subject-auth.ts:10-17`, `002_...sql:26-29`), lookup идёт по хэшу.
- Deny-by-default для доступности модуля соблюдён (`module-availability.repository.ts:23`).
- Неподдерживаемый `resourceScope` даёт отказ, а не `allowed: true` (`postgres-authorization.facade.ts:37-39`).
- Отказ БД нормализуется в безопасный `Result`, а не в raw exception (`subject-auth.ts:44,59,92`).
- Миграция 002 отзывает все старые сессии при upgrade (`002_...sql:32-35`) и не выводит `ready` из отсутствия администраторов.
- `rollbackMigration` удаляет метаданные до `downSql` внутри транзакции и проверяет порядок версий (`migrator.ts:92-112`) — дефект F08 закрыт.
- Backfill исторического checksum ограничен закреплённым артефактом (`migrator.ts:10-12, 133-145`).
- В репозитории нет секретов: `.gitignore` исключает `References/`, `.env`, `*.key`, `*.pem`; в `infra/certs/` закоммичены только публичные сертификаты.

## 6. Рекомендованный порядок дальнейших работ

Задачи упорядочены; каждая требует отдельного исполняемого плана, если затрагивает контракты, схему или релиз.

1. **Закрыть D1** — заменить фейковый `--fixture-forbidden` реальными fixture-каталогами (по одному на класс нарушения: forbidden dependency, deep import, undeclared dependency, relative cross-package import, cycle) и проверять ненулевой exit code для каждой. Убрать `errors.length = 0`. Область: `tools/`, новые fixtures.
2. **Закрыть D2** — согласовать с владельцем инфраструктуры: `05-provision-app.sh` не должен сбрасывать `bootstrap_state`. Clean-provision выполнять только через `SchemaMigrator.provisionClean()` на подтверждённо пустой БД; upgrade оставляет `locked-legacy` для операторской процедуры. Область: `infra/standalone-ubuntu/scripts/`. Требует решения владельца: кто и как снимает `locked-legacy`.
3. **Закрыть D3, D4, D5, D6** — убрать fallback-строки подключения; заменить `assert.ok(true)` явным `skip` node:test и исправить текст про `EMS_TEST_PG_URL`; включить `check:boundaries` в обязательную последовательность (pretest либо явный `verify`-скрипт); разрешить `allowBuilds`.
4. **Gate B: дописать PostgreSQL-приёмку** — interleaving-тесты (login/assign в обоих порядках, login/bootstrap новой и существующей личности, два bootstrap, два снятия последних админов, конкурентный availability CAS), тесты терминальных состояний provisioning, реальная проверка audit-фильтров и микросекундной пагинации. Координация соединений — явными барьерами, не sleep. Требует разрешённого одноразового стенда: `infra/docker/` уже даёт кандидата, но разрешение оператора на очистку схемы должно быть зафиксировано владельцем.
5. **Этап 1 roadmap: утвердить отложенные контракты** — делегирование ролей и самоназначение, критерий пригодного последнего администратора, lifecycle ролей/отделов, механизм idle TTL и ротации сессии, CSRF, rate limits, LDAP timeouts, server/client entry points, UI contribution contract, compatibility record стека. Без этого этапы 6–8 начинать нельзя.
6. **Этап 2 roadmap: сквозной сценарий** — установка Next.js/React/ldapts/Zod (требует отдельного tooling-approval с exact versions, лицензиями и provenence по ADR-0003 §10 и §71), LDAP-адаптер с TLS/CA, cookie-транспорт, protected boundary, read-only UI. Негативные проверки: bad password, outage, неверный сертификат, pending/blocked, отзыв, изоляция кеша.
7. **Этап 3 roadmap: административный MVP и галерея** — реализация `shared-controls` как компонентов, галерея, admin-операции отделов/ролей/назначений/доступности, audit UI, доступность с клавиатуры.
8. **Этап 4 roadmap: офлайн-приёмка** — SBOM, лицензии, provenance, bundle с контрольными суммами и подписью, Nginx smoke без egress, clean install/upgrade/recovery, отрицательный browser-build-тест на server-only код.
9. **Параллельно** — локальные `AGENTS.md` пакетов (D7 частично), тесты для `shell`, secret scanning и CI-последовательность (AGENTS.md §9).

## 7. Обязательные проверки при исполнении

Так как в этой сессии запуск команд был заблокирован, исполнитель обязан фактически выполнить и зафиксировать exit codes:

- `pnpm run typecheck`, `pnpm run build`, `pnpm run test` из корня (последовательно, не параллельно — общие артефакты сборки);
- `pnpm run check:boundaries` плюс каждый новый отрицательный fixture (ожидаемый ненулевой код);
- `pnpm --filter @ems/core run test:pg` на разрешённом одноразовом стенде с явными `EMS_TEST_PG_INTEGRATION`, `EMS_TEST_PG_MIGRATION_URL`, `EMS_TEST_PG_RUNTIME_URL`;
- `git diff --check`.

Невыполненные проверки указывать явно с причиной. Не заявлять Gate B без реальных PostgreSQL-результатов.

## 8. Требуемые решения владельца

1. Разрешение на использование `infra/docker/` как одноразового стенда приёмки, включая явное разрешение на `teardownEphemeralSchema()` (DROP SCHEMA) в `ems_test`.
2. Операторская процедура снятия `locked-legacy` — до неё D2 нельзя закрывать «удобным» автосбросом.
3. Tooling-approval на Next.js, React, ldapts, Zod, node-pg-migrate, Radix UI: exact versions, лицензии, offline-источник и способ подтверждения provenance. Без него этапы 6–8 заблокированы (ADR-0003 §71).
4. Отложенные IAM-решения из §5 списка выше — они блокируют реализацию административного UI.
