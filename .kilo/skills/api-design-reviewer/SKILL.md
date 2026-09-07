---
name: api-design-reviewer
description: Use when reviewing or changing EMS HTTP APIs, server operations, DTOs, facades, events, or extension contracts.
---

# API Design Reviewer (EMS)

## Review workflow

1. Identify the public boundary, consumers, owner, version, and authentication class.
2. Check request/response/error schemas, runtime validation, status behavior, pagination, idempotency, and compatibility.
3. Check required permission and resource scope at the server boundary, independently of UI and middleware.
4. Compare old and new contracts and list consumers, migration steps, and negative tests.
5. Review cache behavior for user, role, and organization leakage; sensitive responses are not public-cache candidates.
6. Record findings by severity and do not sign off on prose alone when an approved local validator or contract test exists.

## EMS rules

- OpenAPI is optional until selected by ADR. Internal facades, Server Actions, events, and extension points also require typed public contracts.
- DTOs must not expose ORM entities or database schema accidentally.
- Prefer backward-compatible additions. Removing/renaming fields, changing meaning/types, required fields, endpoints, or error shapes requires versioning or migration approval.
- Public login is explicitly unauthenticated but must validate input, rate-limit attempts, and avoid account disclosure. Protected operations authenticate and authorize on the server.
- Do not copy upstream examples for bearer tokens, JWT, public caching, HATEOAS, or framework middleware as EMS policy.

## Deliverable

Return contract findings, affected consumers, compatibility decision, required tests, security results, and owner decisions. Do not modify contracts during review without an approved scope.
