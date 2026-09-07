---
name: dependency-auditor
description: Use before adding, updating, licensing, packaging, or releasing a runtime or build dependency for EMS.
---

# Dependency Auditor (EMS)

## Workflow

1. Identify package, version, source, license, direct owner, transitive impact, and offline artifact source.
2. Inspect manifests and lockfiles without contacting online advisory services from the air-gapped environment.
3. Check provenance, hashes/signatures, license compatibility, install/postinstall scripts, native binaries, telemetry, CDN/font/API access, and client-bundle exposure.
4. Assess compatibility with Next.js, PostgreSQL, LDAP, Nginx, package boundaries, and the approved release process.
5. Record findings and a rollback/upgrade plan. Require owner approval for new external dependencies.

## Guardrails

Offline pattern databases are only a smoke layer, not complete SCA or legal advice. Do not assume support for a lockfile format. Do not install `latest`, run package-manager network commands, publish packages, or apply an upgrade automatically. An approved dependency does not permit runtime Internet access.

## Deliverable

Return exact version and source, lockfile evidence, license/provenance/SBOM status, script and egress review, compatibility, tests, and approval/blockers.
