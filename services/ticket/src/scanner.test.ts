import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type mysql from 'mysql2/promise';
import {
  fakeVerifier,
  authHeader,
  createEventFixture,
  createTicketFixture,
  destroyFixture,
  checkoutPool,
  eventInventoryPool,
  queuePool,
  ticketingPool,
} from './test-helpers.js';

const TEST_SCANNER_SECRET = 'test-only-scanner-session-secret';
process.env.SCANNER_SESSION_SECRET = TEST_SCANNER_SECRET;
const { app, database, __setVerifierForTests } = await import('./index.js');

__setVerifierForTests(fakeVerifier);

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
  await Promise.all([eventInventoryPool.end(), ticketingPool.end(), checkoutPool.end(), queuePool.end(), database.end()]);
});

async function scannerSession(eventId: number, organiserSub: string): Promise<string> {
  const response = await fetch(`${baseUrl}/scanner/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authHeader(organiserSub) },
    body: JSON.stringify({ eventId }),
  });
  assert.equal(response.status, 200);
  const session = await response.json();
  assert.equal(session.eventId, eventId);
  return String(session.sessionToken);
}

async function ticketQrToken(ticketId: number): Promise<string> {
  const [rows] = await ticketingPool.query<mysql.RowDataPacket[]>(
    'SELECT qr_token FROM tickets WHERE ticket_id = ?',
    [ticketId],
  );
  assert.ok(rows[0]?.qr_token);
  return String(rows[0].qr_token);
}

async function scanTicket(sessionToken: string, qrToken: string): Promise<Response> {
  return fetch(`${baseUrl}/tickets/validate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${sessionToken}` },
    body: JSON.stringify({ qrToken }),
  });
}

function signScannerToken(
  session: { sub: string; email: string; eventId: number; role: 'HELPER' | 'ORGANISER'; exp: number },
  secret: string,
): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify(session)).toString('base64url');
  const unsigned = `${header}.${payload}`;
  const signature = createHmac('sha256', secret).update(unsigned).digest('base64url');
  return `${unsigned}.${signature}`;
}

test('accepted event organiser can issue a scanner session and admit an issued ticket exactly once', async () => {
  const fixture = await createEventFixture();
  try {
    const sessionResponse = await fetch(`${baseUrl}/scanner/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeader(fixture.organiserSub) },
      body: JSON.stringify({ eventId: fixture.eventId }),
    });
    assert.equal(sessionResponse.status, 200);
    const session = await sessionResponse.json();
    assert.equal(session.eventId, fixture.eventId);
    assert.equal(session.role, 'ORGANISER');
    assert.match(session.sessionToken, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    assert.ok(Date.parse(session.expiresAt) > Date.now());

    const ticketId = await createTicketFixture({
      eventId: fixture.eventId,
      customerSub: `scanner-customer-${fixture.eventId}`,
    });
    const [ticketRows] = await ticketingPool.query<mysql.RowDataPacket[]>(
      'SELECT qr_token FROM tickets WHERE ticket_id = ?',
      [ticketId],
    );
    const qrToken = String(ticketRows[0]?.qr_token);
    const scanResponse = await fetch(`${baseUrl}/tickets/validate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${session.sessionToken}` },
      body: JSON.stringify({ qrToken }),
    });

    assert.equal(scanResponse.status, 200);
    const result = await scanResponse.json();
    assert.equal(result.outcome, 'SUCCESS');
    assert.equal(result.message, 'Ticket accepted. Welcome in.');
    assert.equal(result.ticket.ticketId, ticketId);
    assert.equal(result.ticket.eventId, fixture.eventId);
    assert.equal(result.ticket.status, 'CHECKED_IN');
    assert.equal(result.ticket.checkedInBySub, fixture.organiserSub);
    assert.ok(Number.isFinite(Date.parse(result.ticket.checkedInAt)));
    assert.ok(Number.isFinite(Date.parse(result.scannedAt)));

    const [savedTickets] = await ticketingPool.query<mysql.RowDataPacket[]>(
      'SELECT status, checked_in_by_sub, checked_in_at FROM tickets WHERE ticket_id = ?',
      [ticketId],
    );
    assert.equal(savedTickets[0]?.status, 'CHECKED_IN');
    assert.equal(savedTickets[0]?.checked_in_by_sub, fixture.organiserSub);
    assert.ok(savedTickets[0]?.checked_in_at instanceof Date);

    const [logs] = await ticketingPool.query<mysql.RowDataPacket[]>(
      'SELECT result, attempted_token FROM check_in_logs WHERE ticket_id = ? ORDER BY log_id DESC LIMIT 1',
      [ticketId],
    );
    assert.equal(logs[0]?.result, 'SUCCESS');
    assert.equal(logs[0]?.attempted_token, qrToken);
  } finally {
    await destroyFixture(fixture.eventId);
  }
});

test('scanner session issuance requires valid caller authentication', async () => {
  const fixture = await createEventFixture();
  try {
    for (const authorization of [null, 'Bearer invalid-test-token']) {
      const response = await fetch(`${baseUrl}/scanner/sessions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(authorization ? { authorization } : {}),
        },
        body: JSON.stringify({ eventId: fixture.eventId }),
      });
      assert.equal(response.status, 401);
      assert.deepEqual(await response.json(), { error: 'unauthenticated' });
    }
  } finally {
    await destroyFixture(fixture.eventId);
  }
});

test('staff from another event and removed organisers cannot obtain scanner sessions', async () => {
  const fixture = await createEventFixture();
  const otherFixture = await createEventFixture();
  try {
    const otherStaffResponse = await fetch(`${baseUrl}/scanner/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeader(otherFixture.organiserSub) },
      body: JSON.stringify({ eventId: fixture.eventId }),
    });
    assert.equal(otherStaffResponse.status, 403);
    assert.deepEqual(await otherStaffResponse.json(), { error: 'not_event_staff' });

    await eventInventoryPool.execute(
      'DELETE FROM event_team_memberships WHERE event_id = ? AND user_sub = ?',
      [fixture.eventId, fixture.organiserSub],
    );
    const removedStaffResponse = await fetch(`${baseUrl}/scanner/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeader(fixture.organiserSub) },
      body: JSON.stringify({ eventId: fixture.eventId }),
    });
    assert.equal(removedStaffResponse.status, 403);
    assert.deepEqual(await removedStaffResponse.json(), { error: 'not_event_staff' });
  } finally {
    await destroyFixture(otherFixture.eventId);
    await destroyFixture(fixture.eventId);
  }
});

test('a cancelled event cannot issue a scanner session even to its accepted organiser', async () => {
  const fixture = await createEventFixture();
  try {
    await eventInventoryPool.execute("UPDATE events SET status = 'CANCELLED' WHERE event_id = ?", [fixture.eventId]);

    const response = await fetch(`${baseUrl}/scanner/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeader(fixture.organiserSub) },
      body: JSON.stringify({ eventId: fixture.eventId }),
    });
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), { error: 'event_not_scannable' });

    const [events] = await eventInventoryPool.query<mysql.RowDataPacket[]>(
      'SELECT status FROM events WHERE event_id = ?',
      [fixture.eventId],
    );
    assert.equal(events[0]?.status, 'CANCELLED');
  } finally {
    await destroyFixture(fixture.eventId);
  }
});

test('a second scan is rejected as duplicate without changing the first admission', async () => {
  const fixture = await createEventFixture();
  try {
    const sessionToken = await scannerSession(fixture.eventId, fixture.organiserSub);
    const ticketId = await createTicketFixture({
      eventId: fixture.eventId,
      customerSub: `duplicate-scan-${fixture.eventId}`,
    });
    const qrToken = await ticketQrToken(ticketId);

    const firstScan = await scanTicket(sessionToken, qrToken);
    const firstResult = await firstScan.json();
    assert.equal(firstScan.status, 200);
    assert.equal(firstResult.outcome, 'SUCCESS');

    const secondScan = await scanTicket(sessionToken, qrToken);
    const secondResult = await secondScan.json();
    assert.equal(secondScan.status, 200);
    assert.equal(secondResult.outcome, 'DUPLICATE');
    assert.equal(secondResult.message, 'This ticket has already been checked in.');

    const [savedTickets] = await ticketingPool.query<mysql.RowDataPacket[]>(
      'SELECT status, checked_in_by_sub FROM tickets WHERE ticket_id = ?',
      [ticketId],
    );
    assert.equal(savedTickets[0]?.status, 'CHECKED_IN');
    assert.equal(savedTickets[0]?.checked_in_by_sub, fixture.organiserSub);

    const [logs] = await ticketingPool.query<mysql.RowDataPacket[]>(
      'SELECT result FROM check_in_logs WHERE ticket_id = ? ORDER BY log_id',
      [ticketId],
    );
    assert.deepEqual(logs.map((row) => row.result), ['SUCCESS', 'DUPLICATE']);
  } finally {
    await destroyFixture(fixture.eventId);
  }
});

test('concurrent scans admit an issued ticket only once and audit both attempts', async () => {
  const fixture = await createEventFixture();
  try {
    const sessionToken = await scannerSession(fixture.eventId, fixture.organiserSub);
    const ticketId = await createTicketFixture({
      eventId: fixture.eventId,
      customerSub: `concurrent-scan-${fixture.eventId}`,
    });
    const qrToken = await ticketQrToken(ticketId);

    const responses = await Promise.all([
      scanTicket(sessionToken, qrToken),
      scanTicket(sessionToken, qrToken),
    ]);
    for (const response of responses) assert.equal(response.status, 200);
    const results = await Promise.all(responses.map((response) => response.json()));
    assert.deepEqual(results.map((result) => result.outcome).sort(), ['DUPLICATE', 'SUCCESS']);
    for (const result of results) {
      assert.equal(result.ticket.ticketId, ticketId);
      assert.equal(result.ticket.status, 'CHECKED_IN');
      assert.equal(result.ticket.checkedInBySub, fixture.organiserSub);
    }

    const [tickets] = await ticketingPool.query<mysql.RowDataPacket[]>(
      'SELECT status, checked_in_at, checked_in_by_sub FROM tickets WHERE ticket_id = ?',
      [ticketId],
    );
    assert.equal(tickets[0]?.status, 'CHECKED_IN');
    assert.ok(tickets[0]?.checked_in_at instanceof Date);
    assert.equal(tickets[0]?.checked_in_by_sub, fixture.organiserSub);

    const [logs] = await ticketingPool.query<mysql.RowDataPacket[]>(
      'SELECT result, scanned_by_sub, attempted_token FROM check_in_logs WHERE ticket_id = ? ORDER BY log_id',
      [ticketId],
    );
    assert.deepEqual(logs.map((row) => row.result), ['SUCCESS', 'DUPLICATE']);
    for (const log of logs) {
      assert.equal(log.scanned_by_sub, fixture.organiserSub);
      assert.equal(log.attempted_token, qrToken);
    }
  } finally {
    await destroyFixture(fixture.eventId);
  }
});

test('a scanner cannot admit a ticket belonging to another event', async () => {
  const scannerFixture = await createEventFixture();
  const ticketFixture = await createEventFixture();
  try {
    const sessionToken = await scannerSession(scannerFixture.eventId, scannerFixture.organiserSub);
    const ticketId = await createTicketFixture({
      eventId: ticketFixture.eventId,
      customerSub: `wrong-event-scan-${ticketFixture.eventId}`,
    });
    const qrToken = await ticketQrToken(ticketId);

    const response = await scanTicket(sessionToken, qrToken);
    const result = await response.json();
    assert.equal(response.status, 200);
    assert.equal(result.outcome, 'WRONG_EVENT');
    assert.equal(result.message, 'This ticket belongs to a different event.');
    assert.equal(result.ticket.eventId, ticketFixture.eventId);
    assert.equal(result.ticket.status, 'ISSUED');

    const [savedTickets] = await ticketingPool.query<mysql.RowDataPacket[]>(
      'SELECT status, checked_in_at, checked_in_by_sub FROM tickets WHERE ticket_id = ?',
      [ticketId],
    );
    assert.equal(savedTickets[0]?.status, 'ISSUED');
    assert.equal(savedTickets[0]?.checked_in_at, null);
    assert.equal(savedTickets[0]?.checked_in_by_sub, null);

    const [logs] = await ticketingPool.query<mysql.RowDataPacket[]>(
      'SELECT result FROM check_in_logs WHERE ticket_id = ? ORDER BY log_id DESC LIMIT 1',
      [ticketId],
    );
    assert.equal(logs[0]?.result, 'WRONG_EVENT');
  } finally {
    await destroyFixture(ticketFixture.eventId);
    await destroyFixture(scannerFixture.eventId);
  }
});

test('invalid scanner requests are rejected before ticket mutation or audit logging', async () => {
  const fixture = await createEventFixture();
  try {
    const sessionToken = await scannerSession(fixture.eventId, fixture.organiserSub);
    const ticketId = await createTicketFixture({
      eventId: fixture.eventId,
      customerSub: `invalid-request-${fixture.eventId}`,
    });
    const qrToken = await ticketQrToken(ticketId);
    const invalidRequests = [
      { body: {}, detail: 'Either ticketId or qrToken is required.' },
      { body: { ticketId: null, qrToken: null }, detail: 'Either ticketId or qrToken is required.' },
      { body: { ticketId, qrToken }, detail: 'Send either ticketId or qrToken, not both.' },
      { body: { qrToken, eventId: fixture.eventId }, detail: 'Unexpected field(s): eventId.' },
      { body: { ticketId: -1 }, detail: 'ticketId must be a positive integer.' },
      { body: { qrToken: '   ' }, detail: 'qrToken must be a non-empty string of at most 255 characters.' },
      { body: { qrToken: 123 }, detail: 'qrToken must be a non-empty string of at most 255 characters.' },
      { body: { qrToken: 'x'.repeat(256) }, detail: 'qrToken must be a non-empty string of at most 255 characters.' },
    ];

    for (const { body, detail } of invalidRequests) {
      const response = await fetch(`${baseUrl}/tickets/validate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${sessionToken}` },
        body: JSON.stringify(body),
      });
      assert.equal(response.status, 422, detail);
      assert.deepEqual(await response.json(), { error: 'invalid_checkin_request', detail });

      const [tickets] = await ticketingPool.query<mysql.RowDataPacket[]>(
        'SELECT status, checked_in_at, checked_in_by_sub FROM tickets WHERE ticket_id = ?',
        [ticketId],
      );
      assert.equal(tickets[0]?.status, 'ISSUED', detail);
      assert.equal(tickets[0]?.checked_in_at, null, detail);
      assert.equal(tickets[0]?.checked_in_by_sub, null, detail);

      const [logs] = await ticketingPool.query<mysql.RowDataPacket[]>(
        'SELECT COUNT(*) AS count FROM check_in_logs WHERE scanned_by_sub = ?',
        [fixture.organiserSub],
      );
      assert.equal(Number(logs[0]?.count), 0, detail);
    }
  } finally {
    await ticketingPool.execute('DELETE FROM check_in_logs WHERE scanned_by_sub = ?', [fixture.organiserSub]);
    await destroyFixture(fixture.eventId);
  }
});

test('a voided ticket is rejected and audited without being admitted', async () => {
  const fixture = await createEventFixture();
  try {
    const sessionToken = await scannerSession(fixture.eventId, fixture.organiserSub);
    const ticketId = await createTicketFixture({
      eventId: fixture.eventId,
      customerSub: `void-scan-${fixture.eventId}`,
    });
    await ticketingPool.execute("UPDATE tickets SET status = 'VOID' WHERE ticket_id = ?", [ticketId]);
    const qrToken = await ticketQrToken(ticketId);

    const response = await scanTicket(sessionToken, qrToken);
    const result = await response.json();
    assert.equal(response.status, 200);
    assert.equal(result.outcome, 'INVALID');
    assert.equal(result.message, 'This ticket is not valid for entry.');
    assert.equal(result.ticket.ticketId, ticketId);
    assert.equal(result.ticket.status, 'VOID');

    const [tickets] = await ticketingPool.query<mysql.RowDataPacket[]>(
      'SELECT status, checked_in_at, checked_in_by_sub FROM tickets WHERE ticket_id = ?',
      [ticketId],
    );
    assert.equal(tickets[0]?.status, 'VOID');
    assert.equal(tickets[0]?.checked_in_at, null);
    assert.equal(tickets[0]?.checked_in_by_sub, null);

    const [logs] = await ticketingPool.query<mysql.RowDataPacket[]>(
      'SELECT result, scanned_by_sub, attempted_token FROM check_in_logs WHERE ticket_id = ?',
      [ticketId],
    );
    assert.equal(logs.length, 1);
    assert.equal(logs[0]?.result, 'INVALID');
    assert.equal(logs[0]?.scanned_by_sub, fixture.organiserSub);
    assert.equal(logs[0]?.attempted_token, qrToken);
  } finally {
    await destroyFixture(fixture.eventId);
  }
});

test('an unknown QR token is rejected with a ticketless audit log', async () => {
  const fixture = await createEventFixture();
  try {
    const sessionToken = await scannerSession(fixture.eventId, fixture.organiserSub);
    const ticketId = await createTicketFixture({
      eventId: fixture.eventId,
      customerSub: `unknown-scan-${fixture.eventId}`,
    });
    const qrToken = `unknown-qr-${fixture.organiserSub}`;

    const response = await scanTicket(sessionToken, qrToken);
    const result = await response.json();
    assert.equal(response.status, 200);
    assert.equal(result.outcome, 'INVALID');
    assert.equal(result.message, 'This ticket is not valid for entry.');
    assert.equal(result.ticket, null);
    assert.ok(Number.isFinite(Date.parse(result.scannedAt)));

    const [tickets] = await ticketingPool.query<mysql.RowDataPacket[]>(
      'SELECT status, checked_in_at, checked_in_by_sub FROM tickets WHERE ticket_id = ?',
      [ticketId],
    );
    assert.equal(tickets[0]?.status, 'ISSUED');
    assert.equal(tickets[0]?.checked_in_at, null);
    assert.equal(tickets[0]?.checked_in_by_sub, null);

    const [logs] = await ticketingPool.query<mysql.RowDataPacket[]>(
      'SELECT ticket_id, result, attempted_token FROM check_in_logs WHERE scanned_by_sub = ?',
      [fixture.organiserSub],
    );
    assert.equal(logs.length, 1);
    assert.equal(logs[0]?.ticket_id, null);
    assert.equal(logs[0]?.result, 'INVALID');
    assert.equal(logs[0]?.attempted_token, qrToken);
  } finally {
    await ticketingPool.execute('DELETE FROM check_in_logs WHERE scanned_by_sub = ?', [fixture.organiserSub]);
    await destroyFixture(fixture.eventId);
  }
});

test('forged and expired scanner sessions are rejected before changing ticket state', async () => {
  const fixture = await createEventFixture();
  try {
    const ticketId = await createTicketFixture({
      eventId: fixture.eventId,
      customerSub: `expired-session-${fixture.eventId}`,
    });
    const qrToken = await ticketQrToken(ticketId);
    const session = {
      sub: fixture.organiserSub,
      email: `${fixture.organiserSub}@test.example`,
      eventId: fixture.eventId,
      role: 'ORGANISER' as const,
      exp: Math.floor(Date.now() / 1000) + 60,
    };
    const forgedToken = signScannerToken(session, 'different-signing-secret');
    const expiredToken = signScannerToken({ ...session, exp: Math.floor(Date.now() / 1000) - 60 }, TEST_SCANNER_SECRET);

    for (const token of [forgedToken, expiredToken]) {
      const response = await scanTicket(token, qrToken);
      assert.equal(response.status, 401);
      assert.deepEqual(await response.json(), { error: 'invalid_scanner_session' });
    }

    const [tickets] = await ticketingPool.query<mysql.RowDataPacket[]>(
      'SELECT status, checked_in_at, checked_in_by_sub FROM tickets WHERE ticket_id = ?',
      [ticketId],
    );
    assert.equal(tickets[0]?.status, 'ISSUED');
    assert.equal(tickets[0]?.checked_in_at, null);
    assert.equal(tickets[0]?.checked_in_by_sub, null);

    const [logs] = await ticketingPool.query<mysql.RowDataPacket[]>(
      'SELECT COUNT(*) AS count FROM check_in_logs WHERE ticket_id = ?',
      [ticketId],
    );
    assert.equal(Number(logs[0]?.count), 0);
  } finally {
    await destroyFixture(fixture.eventId);
  }
});