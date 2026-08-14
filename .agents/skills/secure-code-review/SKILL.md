---
name: secure-code-review
description: Perform threat-informed security review of OneStage code, configuration, CI, containers, and infrastructure changes; use when trust boundaries or sensitive data are involved, not as a substitute for functional review.
---
# Secure code review

Inspect the diff, surrounding code, data flows, trust boundaries, dependency and CI configuration, tests, and runtime controls. Do not use as a substitute for correctness and functional review.

1. Prioritize authentication, authorization, tenant/object access, validation, injection, SSRF, XSS, CSRF, secrets, cryptography, logging, supply chain, and CI privilege.
2. Describe exploit preconditions and impact; distinguish confirmed findings from hypotheses and avoid exposing suspected secret values.
3. Assess reliability, scalability, performance, cost, and operational detection or recovery alongside security severity.
4. Run the narrowest safe tests and established static, dependency, secret, container, and IaC scanners; document unavailable coverage and false-positive handling.
5. Never claim a test passed unless it executed successfully. Stop and report suspected secrets. Never implicitly authorize secret access, destructive proof-of-concept activity, deployment, or remediation in production; require human approval.
