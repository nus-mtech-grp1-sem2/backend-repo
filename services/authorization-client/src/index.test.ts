import assert from 'node:assert/strict';
import { test } from 'node:test';
import express from 'express';
import type { Request, Response } from 'express';
import type { Server } from 'node:http';
import { createAuthorizationGuard } from './index.js';
import { createApp, InvalidCallerToken } from '../../authorization/src/app.js';

const serviceToken = 'local-test-service-credential-32-characters';
async function listen(app: ReturnType<typeof express>): Promise<{ server: Server; url: string }> {
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  return { server, url: `http://127.0.0.1:${address.port}/authorize` };
}
async function close(server: Server) {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}
function boundary(token = 'access-token') {
  let status = 0;
  let body: unknown;
  const req = { header: (name: string) => name.toLowerCase() === 'authorization' ? (token ? `Bearer ${token}` : undefined) : 'test-request' } as unknown as Request;
  const res = { status: (value: number) => { status = value; return res; }, json: (value: unknown) => { body = value; return res; } } as unknown as Response;
  return { req, res, status: () => status, body: () => body };
}

test('client interoperates with producer and preserves verified identity/event scope', async () => {
  let unavailable = false;
  const { server, url } = await listen(createApp({ workloadToken: serviceToken,
    verify: async token => { if (token !== 'access-token') throw new InvalidCallerToken(); return { sub: 'verified-user' }; },
    access: async (sub, eventId) => {
      assert.equal(sub, 'verified-user');
      if (unavailable) throw new Error('database unavailable');
      return { roles: eventId === 101 ? ['event_helper'] : [], isOwner: false };
    },
  }));
  const guard = createAuthorizationGuard({ url, serviceToken, timeoutMs: 2000 });
  try {
    for (const [token, action, eventId, expected] of [
      ['access-token', 'ticket.checkin', 101, 0],
      ['access-token', 'ticket.checkin', 102, 403],
      ['access-token', 'event.update', 101, 403],
      ['invalid-token', 'ticket.checkin', 101, 401],
      ['', 'ticket.checkin', 101, 401],
      ['access-token', 'unknown-action', 101, 503],
    ] as const) {
      const b = boundary(token);
      assert.equal(await guard(b.req, b.res, action, eventId), expected === 0);
      assert.equal(b.status(), expected);
    }
    const b = boundary();
    const badCredential = createAuthorizationGuard({ url, serviceToken: 'incorrect-workload-credential-32-characters' });
    assert.equal(await badCredential(b.req, b.res, 'ticket.checkin', 101), false);
    assert.equal(b.status(), 503);
    unavailable = true;
    const failure = boundary();
    assert.equal(await guard(failure.req, failure.res, 'ticket.checkin', 101), false);
    assert.equal(failure.status(), 503);
  } finally { await close(server); }
});

test('timeouts, redirects and malformed or inconsistent decisions fail closed without retries', async () => {
  const app = express(); let count = 0; let mode = 'malformed';
  app.post('/authorize', (req, res) => {
    count++;
    assert.equal(req.header('X-Request-Id'), 'test-request');
    if (mode === 'timeout') return; // remain open until the client's deadline
    if (mode === 'redirect') { res.redirect('/other'); return; }
    if (mode === 'oversize') { res.send('x'.repeat(8193)); return; }
    if (mode === 'malformed') { res.send('not-json'); return; }
    res.json({ allowed: false, decisionId: '00000000-0000-0000-0000-000000000001', policyVersion: '1' });
  });
  const { server, url } = await listen(app);
  try {
    for (mode of ['malformed', 'inconsistent', 'oversize', 'redirect', 'timeout']) {
      const b = boundary(); const previous = count;
      const guard = createAuthorizationGuard({ url, serviceToken, timeoutMs: mode === 'timeout' ? 100 : 2000 });
      assert.equal(await guard(b.req, b.res, 'ticket.checkin', 101), false);
      assert.equal(b.status(), 503); assert.equal(count, previous + 1);
    }
  } finally { await close(server); }
  const b = boundary();
  assert.equal(await createAuthorizationGuard({ url, serviceToken })(b.req, b.res, 'ticket.checkin', 101), false);
  assert.equal(b.status(), 503);
});

test('invalid startup configuration is rejected', () => {
  assert.throws(() => createAuthorizationGuard({ url: 'file:///tmp/check', serviceToken }));
  assert.throws(() => createAuthorizationGuard({ url: 'http://localhost/authorize', serviceToken: '' }));
  assert.throws(() => createAuthorizationGuard({ url: 'http://localhost/authorize', serviceToken, timeoutMs: 0 }));
});
