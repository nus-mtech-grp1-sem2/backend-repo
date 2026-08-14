---
name: angular-change
description: Govern changes to the OneStage Angular SPA, including components, routing, state, accessibility, tests, builds, and browser behavior; use for frontend implementation or review, not backend-only or infrastructure-only work.
---
# Angular change

Inspect `package.json`, the lockfile, `angular.json`, TypeScript configs, nearby code, tests, and CI before editing. Do not use this skill for backend-only or infrastructure-only changes.

1. Preserve the detected Angular version, package manager, architecture, lint rules, formatter, and test runner. Do not invent commands or replace established tooling.
2. Define behavior, API dependencies, accessibility, loading/error states, and browser compatibility. Make the smallest cohesive change.
3. Assess security (XSS and sensitive data), reliability, scalability, performance (bundle/render/network), cost, and operational supportability.
4. Run the narrowest relevant test, then the repository-defined lint, format check, unit test, production build, and dependency audit when available.
5. Report commands and outcomes. Never claim a test passed unless it executed successfully. Never implicitly authorize secret access, deployment, or destructive action; require human approval.
