# Реестр источников навыков

## Upstream

- Репозиторий: `https://github.com/alirezarezvani/claude-skills`
- Закрепленная ревизия: `19392f7a08264ed00486a251f5b2098321771f94`
- Лицензия: MIT, copyright 2025 Alireza Rezvani. Полный текст: `UPSTREAM-LICENSE.txt`.
- Дата получения: 2026-09-07.
- Ревизия GitHub была проверена API, но это не является утверждением о безопасности или одобрением для production.

## Выбранные навыки

Каждый локальный `SKILL.md` является адаптацией upstream-инструкции под EMS. Upstream-скрипты, installers, профили, fixtures и автоматические загрузки не импортированы.

| Локальный навык | Upstream path на закрепленной ревизии | Адаптация |
| --- | --- | --- |
| `spec-driven-workflow` | `engineering/skills/spec-driven-workflow/SKILL.md` | Contract-first, runtime-валидация, права, события и offline-ограничения |
| `senior-architect` | `engineering-team/skills/senior-architect/SKILL.md` | EMS-границы, ADR и запрет неутвержденных решений |
| `monorepo-navigator` | `engineering/skills/monorepo-navigator/SKILL.md` | Матрица EMS; manifest-анализ отделен от проверки фактических импортов |
| `api-design-reviewer` | `engineering/skills/api-design-reviewer/SKILL.md` | HTTP, фасады, Server Actions, события, права и cache isolation |
| `senior-backend` | `engineering-team/skills/senior-backend/SKILL.md` | Next.js server-only, LDAP, PostgreSQL и transactional outbox |
| `senior-frontend` | `engineering-team/skills/senior-frontend/SKILL.md` | Shell, shared controls, accessibility, client/server boundaries |
| `senior-qa` | `engineering-team/skills/senior-qa/SKILL.md` | LDAP, права, события, миграции, forbidden imports и no-egress smoke |
| `senior-security` | `engineering-team/skills/senior-security/SKILL.md` | LDAP/session trust flow, threat modeling и секреты без доступа к References |
| `dependency-auditor` | `engineering/skills/dependency-auditor/SKILL.md` | Offline provenance, licenses, SBOM, install-time behavior |
| `migration-architect` | `engineering/skills/migration-architect/SKILL.md` | PostgreSQL ownership, expand-contract и recovery |
| `runbook-generator` | `engineering/skills/runbook-generator/SKILL.md` | Offline deployment, Nginx, LDAP/PostgreSQL и draft verification |

## Локальные SHA-256

Хеши рассчитываются после создания файлов командой `Get-FileHash -Algorithm SHA256`. Реестр не хеширует сам себя; изменение любого навыка требует обновления соответствующей строки и повторного ревью.

| Файл | SHA-256 |
| --- | --- |
| `UPSTREAM-LICENSE.txt` | `A20126646F93D32A8989C3CF4772D59194F405034F7BABE7DAEBEAC22B8AB151` |
| `spec-driven-workflow/SKILL.md` | `7D1D32432938C4DADE24F0CBDCC4AB7C98E32843F0E6B826A7E64839DE0015C0` |
| `senior-architect/SKILL.md` | `864418FB8ACDED59AEC220B29E8756CE7E9D734E50AFF75771B23D3B4A5FB23B` |
| `monorepo-navigator/SKILL.md` | `EC9CAA846F6D99CFB7B8608613DF2D453EB37F0BC1B70E88A0F8A26D921377B3` |
| `api-design-reviewer/SKILL.md` | `8D775D0880D78B09A7F36C2816EA8505C5ACEAA5D7DE666284DC4D38C1C255B7` |
| `senior-backend/SKILL.md` | `72CF8BCF1B2E4DAF1F46A0EA5DFA0969135810AAF77A9941CA671C1F2F11AF18` |
| `senior-frontend/SKILL.md` | `DE019D0AD04034F3E6140C642715D355AC7762C14884ED5EDA52C5AD3F7C174B` |
| `senior-qa/SKILL.md` | `6A046D74FD8EBE65B6350BFE70D0ED03735C29C4DA7C31D7A3EA44319C1BBEF0` |
| `senior-security/SKILL.md` | `B58CC84D3F4E1C3CE21BCB3DD0DDF4A61CAF582348D2C0CC44D3B999E3CE6FB7` |
| `dependency-auditor/SKILL.md` | `BF96B3C164E41C4A950EB9B821928B9E5C6ADFCE1BC4A22CB6ABEA347FF3DD1F` |
| `migration-architect/SKILL.md` | `95222C72DD08930D78C78E9D29F21DDB87409BC3DE9BBAF9F5AAC6854B063B75` |
| `runbook-generator/SKILL.md` | `74437D23D51174A542B0890A946600432019F202E8C2EFF44FC2B04221879AB6` |
