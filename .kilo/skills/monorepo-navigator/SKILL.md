---
name: monorepo-navigator
description: Use for EMS package boundaries, dependency graphs, affected checks, imports, exports, and monorepo changes.
---

# Monorepo Navigator (EMS)

## Workflow

1. Identify the target package and permitted files before searching.
2. Read package manifests, exports, TypeScript/build configuration, and the root `AGENTS.md`.
3. Build a declared dependency graph and separately inspect actual imports and public entry points.
4. Compute affected packages and checks; do not run the entire workspace without reason.
5. Validate the graph against the EMS matrix and report forbidden edges, cycles, deep imports, and undeclared dependencies.

## EMS dependency matrix

- `contracts` has no implementation, ORM, Next.js, UI, or database dependency.
- `core` depends on `contracts`; `shell` depends on `contracts` and `shared-controls`.
- Business modules depend on `contracts` and may use `shared-controls` only for UI contribution.
- Core extensions depend on public `contracts` and may use `shared-controls` only for UI contribution.
- `apps/web` composes implementations, ports, facades, and registries.
- Core accepts extension implementations through public contracts and does not import their implementations.

## Guardrails

Manifest absence is not an import boundary. Check exports, resolver/build settings, actual imports, cycles, and negative forbidden-import cases. Public subpath exports are allowed only when explicitly declared; private deep imports and relative boundary bypasses are forbidden.

Do not assume pnpm, Turborepo, Nx, remote cache, Changesets, or a package manager. Do not enable remote cache or publish workflows in air-gapped EMS without approval. Analyzer output is advisory and never replaces enforced lint/CI checks.

## Deliverable

Report target package, graph, affected scope, violations, checks run, and unresolved architecture decisions. Never read `References/` unless explicitly authorized and minimized.
