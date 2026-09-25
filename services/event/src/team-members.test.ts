import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
// test-helpers MUST be imported first: it forces NODE_ENV=test and loads
// real DB creds from .env before index.ts's top-level code runs.
import {
  fakeVerifier,
  fakeCognito,
  registerFakeCognitoUser,
  authHeader,
  createEventFixture,
  createTeamMembershipFixture,
  destroyFixture,
  eventInventoryPool,
} from './test-helpers.js';
import { app, database, __setVerifierForTests, __setCognitoForTests } from './index.js';

__setVerifierForTests(fakeVerifier);
__setCognitoForTests(fakeCognito);

let baseUrl: string;
let server: Server;

before(async () => {
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  const closed = new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  server.closeAllConnections();
  await closed;
  await Promise.all([eventInventoryPool.end(), database.end()]);
});

test('event organiser sees each team member\'s name, email, role, and who granted it', async () => {
  const fixture = await createEventFixture();
  try {
    // User subs scoped to this fixture's event id so this test can't collide
    // with another test file's global roster data on the shared DB.
    const helperSub = `helper-${fixture.eventId}`;
    registerFakeCognitoUser(helperSub, 'Helper Person');
    await createTeamMembershipFixture({
      eventId: fixture.eventId,
      userSub: helperSub,
      role: 'HELPER',
      grantedBySub: fixture.organiserSub,
    });
    registerFakeCognitoUser(fixture.organiserSub, 'Organiser Person');

    const res = await fetch(`${baseUrl}/events/${fixture.eventId}/team-members`, {
      headers: { ...authHeader(fixture.organiserSub) },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.members.length, 2);
    const helper = body.members.find((m: { user_sub: string }) => m.user_sub === helperSub);
    assert.equal(helper.name, 'Helper Person');
    assert.equal(helper.user_email, `${helperSub}@test.example`);
    assert.equal(helper.role, 'HELPER');
    assert.equal(helper.granted_by_sub, fixture.organiserSub);
  } finally {
    await destroyFixture(fixture.eventId);
  }
});

test('someone outside the event team cannot see its roster', async () => {
  const fixture = await createEventFixture();
  try {
    const res = await fetch(`${baseUrl}/events/${fixture.eventId}/team-members`, {
      headers: { ...authHeader('stranger-1') },
    });
    assert.equal(res.status, 403);
  } finally {
    await destroyFixture(fixture.eventId);
  }
});
