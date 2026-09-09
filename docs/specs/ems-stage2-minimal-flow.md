# EMS Stage 2: минимальный сквозной сценарий

## Метаданные

- Статус: **Approved**
- Версия: 1.0.0
- Владелец и утверждающий: владелец проекта
- Утверждено: 2026-09-09
- Базовая ревизия: `2d0e42e`
- Решения: ADR-0001..0006

## Цель

Реализовать минимальный путь `Browser -> Nginx -> Next.js server boundary -> LDAP/core -> PostgreSQL -> read-only UI` для входа, состояний `PENDING`/`ACTIVE`/`BLOCKED`, защищенной навигации и logout без административного UI.

## Область

- Server-only LDAP adapter на `ldapts` 9.0.0.
- Login Route Handler с runtime validation, throttling и безопасной ошибкой.
- Защищенная cookie-сессия и server authorization boundary.
- Read-only страницы login, pending, blocked и доступного демо-модуля.
- App-owned route map для framework-neutral UI contributions.
- Интеграционные, security-negative и client-boundary тесты.

## Вне области

- Управление отделами, ролями, сотрудниками и module availability через UI.
- Shared-controls gallery и Radix UI.
- Resource scope бизнес-модулей.
- Распределенный rate-limit storage, HA и production topology.
- Offline release bundle, SBOM, подпись, provenance и эксплуатационный релиз.

## Требования

- **S2-FR-001** LDAP adapter принимает UPN/password, использует LDAPS/StartTLS с CA validation и timeout 5 секунд для connect/bind/search.
- **S2-FR-002** LDAP adapter экранирует filter values, нормализует `objectGUID` в стабильное представление и не раскрывает различие bad password/not found.
- **S2-FR-003** Login ограничивается по `normalized UPN + trusted source`: пять неудач, затем exponential delay 1..60 секунд; успешный вход сбрасывает состояние.
- **S2-FR-004** Успешный login устанавливает credential cookie с политикой ADR-0006; ответ и логи не содержат credential.
- **S2-FR-005** Каждая защищенная server operation вызывает core authorization. Middleware и UI используются только для маршрутизации/отображения.
- **S2-FR-006** Pending видит только pending/logout; blocked и revoked/expired session не получают защищенные данные.
- **S2-FR-007** Мутирующие browser operations проверяют Origin и Fetch Metadata до бизнес-операции.
- **S2-FR-008** Background endpoints используют `authorizeBackground()`; клиент не передает activity mode.
- **S2-FR-009** Навигация строится сервером по permissions и module availability отдела.
- **S2-FR-010** `apps/web` связывает contribution ID с React components; contracts остаются framework-neutral.
- **S2-NFR-001** Node.js 20 LTS является целевым runtime; exact dependencies фиксируются lockfile.
- **S2-NFR-002** LDAP, PostgreSQL, secrets и server-only modules отсутствуют в browser bundle.
- **S2-NFR-003** Чувствительные ответы не кешируются публично и не переиспользуются между субъектами.
- **S2-NFR-004** Сборка и smoke не требуют CDN, внешних шрифтов, API или telemetry.

## Контракты и ошибки

- Публичные core facade DTO версии 1.0.0 сохраняются.
- HTTP input проходит локальную runtime validation до вызова facade.
- Безопасные ответы различают `VALIDATION_FAILED`, `UNAUTHENTICATED`, `FORBIDDEN`, `DEPENDENCY_UNAVAILABLE`, `TIMEOUT`, `AUDIT_FAILED`, но login UI использует обобщенное сообщение для bad password/not found.
- Route map является внутренней деталью `apps/web`, не публичным DTO и не extension point core.

## Приемка

| ID | Сценарий | Требования |
| --- | --- | --- |
| S2-AC-001 | Успешный LDAP login создает/находит identity и secure cookie | S2-FR-001..004 |
| S2-AC-002 | Bad password, missing user, outage, timeout и invalid CA дают безопасный отказ без cookie | S2-FR-001..004 |
| S2-AC-003 | Пятая неудача включает backoff; успех сбрасывает limiter | S2-FR-003 |
| S2-AC-004 | Pending/blocked/direct URL/revoked/expired закрыты сервером | S2-FR-005..006 |
| S2-AC-005 | Cross-site mutation отклоняется до facade; same-origin проходит | S2-FR-007 |
| S2-AC-006 | Polling не продлевает idle, пользовательская операция продлевает | S2-FR-008 |
| S2-AC-007 | Навигация учитывает permission и module availability | S2-FR-009 |
| S2-AC-008 | Browser graph не содержит LDAP/PG; DTO не импортируют React | S2-FR-010, S2-NFR-002 |
| S2-AC-009 | Production build и Nginx smoke работают без внешнего egress | S2-NFR-001..004 |

## Последовательность реализации

1. Добавить и проверить `ldapts` 9.0.0, реализовать adapter и unit/integration tests.
2. Утвердить полный Next.js peer/build dependency set, установить exact versions и зафиксировать lockfile.
3. Реализовать cookie, CSRF и login throttling server utilities с negative tests.
4. Создать App Router composition, route map и read-only UI.
5. Выполнить PostgreSQL + Samba AD + Nginx acceptance и независимое security/QA review.
