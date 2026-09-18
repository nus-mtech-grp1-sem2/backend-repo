import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createApp, InvalidCallerToken } from './app.js';
import { actions, permits } from './policy.js';
import type { Access } from './policy.js';

test('policy matrix: baseline, helper, organiser, owner', () => {
  for (const action of actions) {
    assert.equal(permits(action, { roles: [], isOwner: false }), action === 'event.create');
    assert.equal(permits(action, { roles: ['event_helper'], isOwner: false }), action === 'event.create' || action.startsWith('ticket.'));
    assert.equal(permits(action, { roles: ['organizer'], isOwner: false }), action !== 'event.team.revoke-organizer');
    assert.equal(permits(action, { roles: ['organizer'], isOwner: true }), true);
  }
});

test('HTTP contract enforces credentials, identity, event isolation, denial and failure', async () => {
  let access: Access = { roles: ['organizer'], isOwner: true };
  let fail = false;
  const workloadToken = 'test-workload-credential-32-characters';
  const app = createApp({ workloadToken, verify: async token => {
    if (token !== 'valid-access-token') throw new InvalidCallerToken();
    return { sub: 'verified-user' };
  }, access: async (sub, eventId) => {
    assert.equal(sub, 'verified-user');
    if (fail) throw new Error('database unavailable');
    return eventId === 12 ? access : { roles: [], isOwner: false };
  } });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}/authorize`;
  const request = (body: unknown, token = 'valid-access-token', credential = workloadToken) => fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'X-Service-Token': credential }, body: JSON.stringify(body),
  });
  try {
    assert.equal((await request({ action: 'event.update', eventId: 12 })).status, 200);
    assert.equal((await request({ action: 'event.update', eventId: 13 })).status, 403);
    assert.equal((await request({ action: 'event.update', eventId: 12 }, 'invalid')).status, 401);
    assert.equal((await request({ action: 'event.update', eventId: 12 }, undefined, 'invalid')).status, 401);
    for (const body of [{ action: 'unknown', eventId: 12 }, { action: 'event.update', eventId: 0 }, { action: 'event.update', eventId: 12, sub: 'other' }, { action: 'event.create', eventId: 12 }]) {
      assert.equal((await request(body)).status, 400);
    }
    access = { roles: [], isOwner: false }; // pending/rejected/revoked rows excluded by repository query
    assert.equal((await request({ action: 'ticket.checkin', eventId: 12 })).status, 403);
    access = { roles: ['event_helper'], isOwner: false };
    const response = await request({ action: 'ticket.checkin', eventId: 12 });
    assert.equal(response.status, 200);
    const result = await response.json() as Record<string, unknown>;
    assert.equal(result.allowed, true); assert.equal(result.policyVersion, '1');
    assert.equal(result.decisionId, response.headers.get('X-Decision-Id'));
    fail = true;
    assert.equal((await request({ action: 'ticket.checkin', eventId: 12 })).status, 503);
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});
