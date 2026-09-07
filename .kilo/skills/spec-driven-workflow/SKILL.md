---
name: spec-driven-workflow
description: Use before implementing a new EMS feature, contract, migration, or change with acceptance criteria.
---

# Spec-Driven Workflow (EMS)

## Purpose

Write and approve the specification before implementation. The specification is the source of acceptance criteria, scope, public contracts, security requirements, and test cases.

## Required inputs

- owner and module boundary;
- problem, users, and explicit out of scope;
- affected contracts, data, permissions, events, and dependencies;
- acceptance criteria and applicable checks.

## Workflow

1. Read the root and applicable local `AGENTS.md`, ADRs, contracts, and only the files needed for the task.
2. Record known facts, assumptions, open decisions, and security/data risks separately.
3. Write a versioned spec before code. Include metadata, context, functional and non-functional requirements, acceptance criteria, edge cases, API/facade/event contracts, data ownership, migration needs, permissions, and out of scope.
4. Validate that every requirement is atomic and testable and every acceptance criterion traces to a requirement.
5. Obtain required owner approval. Do not implement while the spec is Draft or In Review.
6. Derive tests from approved criteria, then implement the smallest conforming change.
7. Re-check scope, contracts, permissions, errors, idempotency, and offline constraints before handoff.

## EMS constraints

- Use runtime validation for HTTP, Server Actions, events, database boundaries, and extension inputs; TypeScript types alone are insufficient.
- Specify required permission, resource scope, transactionality, idempotency, compatibility, event version, and error behavior.
- Treat LDAP outage, expired/revoked sessions, forbidden resources, cache isolation, outbox retries, and migration failure as edge cases when relevant.
- Never use ambiguity heuristics to authorize guessing about security, data, contracts, or architecture. Stop and escalate unresolved material decisions.
- A validator or generated test stub is evidence of process only, not approval or passing verification.

## Stop conditions

Stop and escalate when scope expands, a breaking contract or schema change is required, security behavior is unknown, a required dependency is unapproved, or the spec conflicts with an ADR or `AGENTS.md`.

## Handoff

Report spec path/version, approval status, requirement-to-test mapping, changed scope, checks, unresolved risks, and required human decisions. Use only locally available tools and no external fetch during project work.
