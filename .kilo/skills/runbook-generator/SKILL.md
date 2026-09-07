---
name: runbook-generator
description: Use for draft EMS runbooks covering offline deployment, Nginx, Next.js, PostgreSQL, LDAP, incidents, maintenance, and recovery.
---

# Runbook Generator (EMS)

## Workflow

1. Identify service, owner, environment, dependencies, trust boundaries, and authorized operators.
2. Draft procedures for prerequisites, health, start/stop, deployment, migration, incident response, maintenance, rollback, backup, recovery, and escalation.
3. For every command specify expected output, safety precondition, access level, and whether it is a dry run.
4. Separate application rollback from database recovery and document offline artifact/provenance checks.
5. Validate in an approved non-production environment, record the actual verification date and evidence, then obtain owner approval.

## EMS restrictions

- A generated runbook is `Draft — не проверено` until an authorized operator executes and records the checks. Never fabricate `Last verified`.
- Include internal LDAP/PostgreSQL/DNS/CA dependencies without adding Internet, CDN, telemetry, or external APIs.
- Do not include secrets, real credentials, production data, destructive commands, or unapproved production instructions.
- Recovery objectives, retention, HA, backup encryption, key management, and emergency access remain policy decisions unless approved.

## Deliverable

Return a versioned draft with owner, prerequisites, commands, expected results, rollback/recovery distinction, verification evidence, and unresolved operational decisions.
