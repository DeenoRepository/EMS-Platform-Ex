# ADR-0006: Server boundary минимального сквозного сценария

- Статус: **Approved**
- Версия решения: 1.0.0
- Владелец решения: владелец проекта
- Утверждено: владельцем проекта (2026-09-09)
- Связанные решения: ADR-0002, ADR-0004, ADR-0005
- Связанные требования: FR-001..008, FR-016, FR-022..025, NFR-002..004, AC-001..005, AC-011..012

## Контекст

После закрытия Gate B следующий этап связывает LDAP, cookie-сессию, защищенную Next.js server boundary, core/PostgreSQL и минимальный read-only UI. Клиент не является доверенным источником личности, прав, отдела, типа активности или proxy metadata.

## Решение

1. Целевой runtime этапа 2: Node.js 20 LTS. Локальные проверки на Node.js 24 являются дополнительными и не изменяют compatibility baseline.
2. LDAP adapter использует `ldapts` 9.0.0 только на сервере, LDAPS или StartTLS с обязательной проверкой сертификата доверенного CA. Connect, bind и search ограничиваются конфигурируемым timeout с baseline 5 секунд. LDAP filter values экранируются, bind secret и пароль пользователя не логируются.
3. Login throttling применяется по нормализованной паре `UPN + источник`. После пяти последовательных неудач включается экспоненциальная задержка от 1 до 60 секунд. Успешный вход сбрасывает счетчик. Реализация storage должна быть server-owned; in-memory storage допустим только для локального MVP в одном процессе и не заявляется распределенной защитой.
4. Мутирующие Route Handlers и Server Actions проверяют доверенный `Origin` и Fetch Metadata (`Sec-Fetch-Site`). Разрешены same-origin и явно настроенный origin ingress. Отсутствующие или противоречивые metadata закрывают доступ, кроме отдельно описанных server-to-server операций. `X-Forwarded-*` учитываются только за доверенным Nginx.
5. Cookie содержит только 64-символьный credential и получает `HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/`, без `Domain`. Ошибки входа удаляют потенциально устаревшую cookie. Logout отзывает credential через core и удаляет cookie независимо от результата записи audit, согласно FR-028.
6. `authorize()` используется только для действий пользователя; `authorizeBackground()` применяется для server-classified polling/keepalive. Клиентский параметр не выбирает режим активности.
7. Framework-neutral `UIContributionDeclaration` остается metadata-контрактом без React. `apps/web` владеет route map, которая связывает contribution ID с React Server/Client Components. Пакеты контрактов и shared controls не импортируют Next.js, LDAP или PostgreSQL.
8. Чувствительные ответы получают запрет публичного кеширования. Данные защищенных страниц извлекаются после серверной проверки актуальной сессии и прав.

## Последствия

- Для реального Next.js приложения потребуется полный согласованный dependency set с `react-dom` и типами, exact versions и lockfile integrity. ADR-0004 не считается разрешением молча добавлять отсутствующие peer/build зависимости.
- In-memory login throttling не подходит для нескольких процессов. Переход на общее хранилище требует отдельного решения о топологии.
- Формат подписи offline bundle, provenance, SBOM и эксплуатационная конфигурация остаются блокерами релиза, а не разработки этапа 2.

## Проверки

- LDAP: bad password, outage, timeout, invalid certificate, filter escaping, UPN rename и новый objectGUID.
- Boundary: cookie flags, invalid credential, pending/blocked, revoked/expired session, direct URL, Origin/Fetch Metadata, foreground/background activity.
- Static: LDAP/DB отсутствуют в client graph; contribution DTO не содержит React.
- Integration: Samba AD с синтетическими учетными записями, PostgreSQL 16 и Nginx; без внешнего egress.
