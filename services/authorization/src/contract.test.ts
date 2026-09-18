import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { actions } from './policy.js';

test('OpenAPI action vocabulary and response/security contract match producer', () => {
  const document = JSON.parse(readFileSync(new URL('../openapi/openapi.json', import.meta.url), 'utf8'));
  const operation = document.paths['/authorize'].post;
  const variants = operation.requestBody.content['application/json'].schema.oneOf;
  assert.deepEqual(variants.flatMap((variant: { properties: { action: { enum: string[] } } }) => variant.properties.action.enum), [...actions]);
  assert.deepEqual(operation.security, [{ workloadToken: [], cognitoAccessToken: [] }]);
  assert.deepEqual(operation.responses['200'].content['application/json'].schema.required, ['allowed', 'decisionId', 'policyVersion']);
  const operationIds = Object.values(document.paths).flatMap(path => Object.values(path as Record<string, { operationId: string }>).map(operation => operation.operationId));
  assert.equal(new Set(operationIds).size, operationIds.length);
  // This self-contained contract deliberately contains no unresolved $refs.
  assert.equal(JSON.stringify(document).includes('"$ref"'), false);
});
