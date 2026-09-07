---
name: senior-frontend
description: Use for EMS Shell, shared controls, React/Next.js UI contributions, accessibility, and client bundle review.
---

# Senior Frontend (EMS)

## Workflow

1. Identify whether the component is Shell, shared control, or a business-module UI contribution.
2. Read only the owning package, public UI contract, and relevant design/accessibility rules.
3. Prefer Server Components unless state, effects, event handlers, or browser APIs require a Client Component.
4. Keep server-only dependencies, secrets, permissions, and sensitive data out of client code.
5. Implement loading, error, empty, keyboard, focus, semantic, responsive, and failure states.
6. Test public behavior with accessible queries and verify the server authorization path independently.

## EMS restrictions

- Shell may display server-provided capabilities but never decides authorization. Shared controls contain no SQL, LDAP, domain permissions, or business-module calls.
- UI contributions enter through a declarative, versioned registry contract and approved server/client entry points.
- Do not use Google Fonts, CDN assets, remote images, `latest` dependencies, or upstream scaffolding defaults. Use approved local assets.
- Do not invent WCAG targets, bundle budgets, rendering mode, design system, or library versions; record them as decisions required from the owner.
- React components must not appear in independent DTOs or domain events.

## Deliverable

Report changed UI boundary, accessibility checks, client/server dependency review, test evidence, and any required contract or design decision.
