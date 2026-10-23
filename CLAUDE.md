<!-- ONESTAGE-AI:START managed; do not edit -->
# OneStage managed rules

Follow the central policy version in `onestage-ai.json`. Inspect before editing; use the relevant generated skill. Never commit or push directly to the `main` branch; create a separate branch and submit every change through a pull request. Never expose secrets, bypass checks, deploy, migrate data, or change IAM/networking without explicit human approval. For HTTP API changes, update and validate the OpenAPI contract in the same change; backend code owns accurate operations and schemas, while frontend code must remain compatible with the published contract. Report executed verification accurately.
<!-- ONESTAGE-AI:END managed -->
