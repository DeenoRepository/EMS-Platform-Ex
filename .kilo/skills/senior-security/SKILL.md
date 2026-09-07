---
name: senior-security
description: Use for EMS threat modeling, trust boundaries, LDAP/session risks, secrets, authorization review, and security escalation.
---

# Senior Security (EMS)

## Workflow

1. Scope assets, actors, trust boundaries, flows, data stores, and allowed operations.
2. Model LDAP identity, core session, PostgreSQL permissions, Nginx ingress, module trust, client bundle, audit, and offline release boundaries.
3. Analyze STRIDE-style threats and rank impact, likelihood, affected scope, and required mitigation owner.
4. Review server authorization, resource scope, input validation, TLS/certificate validation, logging, cache isolation, secret handling, and denial-of-service controls.
5. Define negative tests and an independent review gate for high-risk changes.

## EMS restrictions

- A secret scan must not read `References/`, production logs, real LDAP exports, or other classified data without separate authorization and minimization.
- Do not rotate credentials, change ACLs, access production, or execute penetration tests without explicit authorization and an approved target.
- LDAPS/StartTLS certificate validation is mandatory; disabling verification is prohibited.
- DREAD/STRIDE results and scanner output are evidence, not approval. Human security approval remains required.

## Deliverable

Return data-flow scope, findings, severity, mitigation owner, negative tests, assumptions, and human approval requirements. Never include secret values or sensitive logs.
