# ADR-0004: Утверждение frontend и LDAP tooling

- Статус: **Approved**
- Версия решения: 1.1.0
- Владелец решения: владелец проекта
- Утверждено: владельцем проекта (2026-09-09)
- Изменено: 2026-09-09, версия 1.1.0 — `ldapts` понижен с `9.0.0` до `8.2.0` по требованию совместимости с Node.js 20 LTS
- Замещает: ADR-0003, разделы 10 и 71 в части неутвержденного tooling
- Связанные решения: ADR-0006 (целевой runtime этапа 2)
- Связанные требования: NFR-001, NFR-006..007, AC-011..012

## Контекст

Для следующего этапа нужны framework и server-only LDAP adapter. Система поставляется в air-gapped-контур, поэтому разрешение разработки с registry не является разрешением на онлайн-установку или онлайн-запуск в эксплуатации.

## Решение

Утвержден минимальный состав зависимостей:

| Пакет | Exact-версия | Лицензия | Назначение |
| --- | --- | --- | --- |
| `next` | `14.2.35` | MIT | server/client composition root и App Router |
| `react` | `18.3.1` | MIT | UI runtime |
| `ldapts` | `8.2.0` | MIT | server-only LDAP/LDAPS adapter |

Версии и лицензии проверены по npm metadata 2026-09-09. Установка `next` и `react` выполняется отдельной задачей вместе с полным согласованным peer/build-набором; этот ADR не разрешает молча добавлять недостающие зависимости.

### Пересмотр версии `ldapts` (1.1.0)

Версия `9.0.0` из решения 1.0.0 объявляет `engines.node: ">=22"`, что противоречит целевому runtime Node.js 20 LTS из ADR-0006 п.1. Владелец проекта выбрал сохранение Node.js 20 LTS и понижение зависимости до `8.2.0` (`engines.node: ">=20"`).

Проверенная дельта между `8.2.0` и `9.0.0` по распакованным tarball с registry (2026-09-09):

| Свойство | `8.2.0` | `9.0.0` |
| --- | --- | --- |
| `engines.node` | `>=20` | `>=22` |
| Лицензия | MIT | MIT |
| Прямые зависимости | `strict-event-emitter-types@2.0.0` (ISC) | то же |
| `install`/`postinstall` в опубликованном пакете | отсутствуют | отсутствуют |
| Нативные бинарники, CDN, telemetry | отсутствуют | отсутствуют |
| Runtime-импорты | `node:assert`, `node:crypto`, `node:events`, `node:net`, `node:tls`, `node:util` | те же |
| API этапа 2 | `Client.connectTimeout`, `Client.timeout`, `tlsOptions`, `startTLS()`, статический `Filter.escape()`, `escapeFilter` | те же |
| Различия `dist` | содержит polyfill `Symbol.asyncDispose` и deprecated `Filter.prototype.escape()` | оба удалены |

Функциональной потери для S2-FR-001 и S2-FR-002 понижение не создает: требуемые timeouts, TLS-опции, StartTLS и экранирование фильтра присутствуют в `8.2.0`. Используется только статический `Filter.escape()`, поэтому deprecated-метод экземпляра значения не имеет.

Exact-версии и integrity-хэши зафиксированы в lockfile:

- `ldapts@8.2.0`, `sha512-XfKocadpoHc1kNgtbTBBhD+pSh1U9KVTzxcKwDS4ulFFyC7rJkLC3TwIfbQ4rt3my9KHz8qsw9qFXVjcPOGebw==`
- `strict-event-emitter-types@2.0.0`, `sha512-Nk/brWYpD85WlOgzw5h173aci0Teyv8YdIAEtV+N88nDB0dLlazZyJMIsN6eo1/AR61l+p6CJTG1JIyFaoNEEA==`

Возврат к `9.0.0` допустим только после отдельного решения о переходе на Node.js 22 LTS с пересмотром ADR-0006 и compatibility record.

Zod, `node-pg-migrate` и Radix UI этим решением не утверждаются. Временное исключение ADR-0003 §10 становится постоянным решением для текущего MVP: `SchemaMigrator` с PostgreSQL-тестами, включая rollback и terminal-состояния, и локальные строгие runtime-валидаторы остаются штатным механизмом. NFR-001 закрывается этими механизмами. Radix UI выносится в отдельное решение этапа 3.

Разработка допускает доступ к публичному npm registry. В air-gapped-контур передается только собранный релизный bundle с SBOM, контрольными суммами и подписью. `node_modules` и registry в контур не переносятся.

Для зависимостей обязательны exact-версии, коммит lockfile с integrity-хэшами, `pnpm install --frozen-lockfile` в релизной сборке, ревью install/postinstall-скриптов, проверка лицензий, отсутствие CDN, внешних шрифтов, online telemetry и install-time загрузок бинарников. Для Next.js задается `NEXT_TELEMETRY_DISABLED`.

## Последствия и проверки

Утверждение снимает блокер разработки этапа 2, но не является доказательством offline readiness. CI/dependency-audit должен отдельно сделать правила гигиены исполнимыми.

Открытым блокером релиза остается формат подписи bundle и процедура проверки его происхождения при импорте в air-gapped-контур. Без утвержденного provenance этап 4 закрывать нельзя.

## Отклоненные альтернативы

- Zod и `node-pg-migrate`: не утверждены, поскольку текущие локальные механизмы уже покрыты приемочными тестами.
- Radix UI: отложен до отдельного решения этапа 3.
- Онлайн-установка или registry в эксплуатации: запрещены air-gapped-моделью.
- `ldapts@9.0.0` на Node.js 22 LTS: отклонено, поскольку меняет compatibility baseline всего этапа 2, включая будущий набор Next.js/React и офлайн-образ runtime.
- `ldapts@9.0.0` на Node.js 20: отклонено, поскольку это запуск вне заявленной upstream-поддержки и потенциальный отказ при `engine-strict`.
