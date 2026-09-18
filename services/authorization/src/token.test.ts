import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { test } from 'node:test';
import { CognitoJwtVerifier } from 'aws-jwt-verify';

test('Cognito verifier checks signature, issuer, client, expiry and access token type', () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const verifier = CognitoJwtVerifier.create({ userPoolId: 'ap-southeast-1_TestPool', clientId: 'test-client', tokenUse: 'access' });
  const jwk = publicKey.export({ format: 'jwk' });
  assert.ok(jwk.n && jwk.e);
  verifier.cacheJwks({ keys: [{ kty: 'RSA', n: jwk.n, e: jwk.e, kid: 'test-key', alg: 'RS256', use: 'sig' }] });
  const claims = { iss: 'https://cognito-idp.ap-southeast-1.amazonaws.com/ap-southeast-1_TestPool', sub: 'test-user', client_id: 'test-client', token_use: 'access', exp: Math.floor(Date.now() / 1000) + 60 };
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const token = (overrides: Record<string, unknown> = {}) => {
    const payload = `${encode({ alg: 'RS256', kid: 'test-key' })}.${encode({ ...claims, ...overrides })}`;
    return `${payload}.${sign('RSA-SHA256', Buffer.from(payload), privateKey).toString('base64url')}`;
  };
  assert.equal(verifier.verifySync(token()).sub, 'test-user');
  for (const overrides of [{ iss: 'https://wrong-issuer.example' }, { client_id: 'wrong-client' }, { token_use: 'id', aud: 'test-client' }, { exp: 1 }]) {
    assert.throws(() => verifier.verifySync(token(overrides)));
  }
  const parts = token().split('.');
  assert.throws(() => verifier.verifySync(`${parts[0]}.${parts[1]}.${Buffer.alloc(256).toString('base64url')}`));
});
