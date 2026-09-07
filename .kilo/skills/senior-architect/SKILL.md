---
name: senior-architect
description: Use for EMS architecture proposals, ADRs, dependency boundaries, data flows, and system design reviews.
---

# Senior Architect (EMS)

## Purpose

Produce an evidence-based architecture proposal without silently choosing deferred project decisions.

## Workflow

1. Read `AGENTS.md`, existing ADRs, public contracts, and the minimum relevant package files.
2. Map ownership, trust boundaries, data flows, synchronous ports, events, storage, and composition root.
3. Compare options with explicit constraints, security impact, operational cost, compatibility, offline behavior, and rollback.
4. Write an ADR with context, decision, alternatives, consequences, rejected options, owners, and review date.
5. Validate dependency direction against the EMS matrix and identify required contract or migration work.

## EMS baseline

- `apps/web` is the composition root; core does not import business or extension implementations.
- Contracts are public boundaries, not ORM entities or React component storage.
- Trusted in-process packages are not a sandbox. Process isolation, ACL, and network policy require a separate decision.
- Core owns identity, sessions, authorization, audit, and extension contracts. Shell owns composition/navigation. Modules own their data and scenarios.
- Significant events default to transactional outbox; an alternative needs an approved ADR with equivalent atomicity, delivery, retry, recovery, idempotency, observability, and retention guarantees.

## Restrictions

Do not select exact versions, ORM, package manager, Nx/Turborepo, broker, container topology, HA, tenancy model, LDAP schema, or numerical SLOs unless approved. Cloud-first recommendations and upstream defaults are not EMS decisions.

## Deliverable

Return an ADR or review with evidence, dependency graph, affected consumers, risks, verification plan, and explicit human approvals. Diagrams are text artifacts unless an approved local renderer exists.
