import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import {
  admissionBatchSize,
  admissionDue,
  app,
  availableAdmissionSlots,
  buyerCapacity,
  customerAdmittedEvent,
  parseConfig,
  positiveInteger,
  publishCustomerAdmitted,
} from './index.js';

describe('capacity-based admission batches', () => {
  it('admits ten percent of the original ticket capacity, rounded up', () => {
    assert.equal(admissionBatchSize(100), 10);
    assert.equal(admissionBatchSize(11), 2);
  });

  it('always admits at least one customer for a positive-capacity event', () => {
    assert.equal(admissionBatchSize(10), 1);
    assert.equal(admissionBatchSize(5), 1);
    assert.equal(admissionBatchSize(1), 1);
  });

  it('uses the configured buyer capacity instead of the percentage default', () => {
    assert.equal(buyerCapacity(100, 7), 7);
    assert.equal(buyerCapacity(10, 2), 2);
  });

  it('defaults to ten percent when buyer capacity is not configured', () => {
    assert.equal(buyerCapacity(100, null), 10);
    assert.equal(buyerCapacity(5, null), 1);
  });

  it('does not admit another customer while every buying slot is occupied', () => {
    assert.equal(availableAdmissionSlots(10, 1, 1, 10), 0);
    assert.equal(availableAdmissionSlots(100, 10, 10, 90), 0);
  });

  it('reopens capacity when an active buyer finishes', () => {
    assert.equal(availableAdmissionSlots(10, 1, 0, 9), 1);
    assert.equal(availableAdmissionSlots(100, 10, 8, 92), 2);
  });
});

describe('queue input validation', () => {
  it('accepts a bounded queue configuration', () => {
    assert.deepEqual(parseConfig({
      opensAt: '2026-10-01T04:00:00.000Z', admissionBatchSize: 20, admissionIntervalSec: 30,
    }), {
      opensAt: new Date('2026-10-01T04:00:00.000Z'), admissionBatchSize: 20, admissionIntervalSec: 30,
    });
  });

  it('rejects malformed identifiers and unsafe admission settings', () => {
    assert.equal(positiveInteger('1 OR 1=1'), null);
    assert.equal(parseConfig({ opensAt: 'never', admissionBatchSize: 0, admissionIntervalSec: 30 }), null);
    assert.equal(parseConfig({ opensAt: '2026-10-01', admissionBatchSize: 10_001, admissionIntervalSec: 30 }), null);
  });
});

describe('automatic admission timing', () => {
  const now = Date.parse('2026-09-16T12:00:30.000Z');

  it('admits the first waiting batch immediately', () => {
    assert.equal(admissionDue(null, 30, now), true);
  });

  it('waits for the configured interval between batches', () => {
    assert.equal(admissionDue('2026-09-16T12:00:01.000Z', 30, now), false);
    assert.equal(admissionDue('2026-09-16T12:00:00.000Z', 30, now), true);
  });
});

describe('customer admission events', () => {
  it('builds a versioned event without exposing the admission token', () => {
    const event = customerAdmittedEvent({
      queueEntryId: 41,
      eventId: 7,
      customerSub: 'customer-123',
      occurredAt: new Date('2026-09-16T12:00:00.000Z'),
      tokenExpiresAt: new Date('2026-09-16T12:10:00.000Z'),
    });
    assert.deepEqual(event, {
      type: 'CustomerAdmitted', version: 1, occurredAt: '2026-09-16T12:00:00.000Z',
      queueEntryId: 41, eventId: 7, customerSub: 'customer-123',
      tokenExpiresAt: '2026-09-16T12:10:00.000Z',
    });
    assert.equal('admissionToken' in event, false);
  });

  it('publishes at most ten messages in each SQS batch', async () => {
    const calls: unknown[] = [];
    const events = Array.from({ length: 12 }, (_, index) => customerAdmittedEvent({
      queueEntryId: index + 1,
      eventId: 7,
      customerSub: `customer-${index + 1}`,
      occurredAt: new Date('2026-09-16T12:00:00.000Z'),
      tokenExpiresAt: new Date('2026-09-16T12:10:00.000Z'),
    }));
    const published = await publishCustomerAdmitted(events, 'https://sqs.example/customer-admitted', async (input) => {
      calls.push(input);
      return {};
    });
    assert.equal(published, 12);
    assert.equal(calls.length, 2);
    assert.deepEqual(calls.map((call) => (call as { Entries?: unknown[] }).Entries?.length), [10, 2]);
  });

  it('reports failed SQS batch entries', async () => {
    const event = customerAdmittedEvent({
      queueEntryId: 41,
      eventId: 7,
      customerSub: 'customer-123',
      occurredAt: new Date('2026-09-16T12:00:00.000Z'),
      tokenExpiresAt: new Date('2026-09-16T12:10:00.000Z'),
    });
    await assert.rejects(
      publishCustomerAdmitted([event], 'https://sqs.example/customer-admitted', async () => ({
        Failed: [{ Id: '41-0', Code: 'InternalError' }],
      })),
      /customer_admitted_batch_failed:41-0/,
    );
  });

  it('retries only failed SQS batch entries', async () => {
    const events = [41, 42].map((queueEntryId) => customerAdmittedEvent({
      queueEntryId,
      eventId: 7,
      customerSub: `customer-${queueEntryId}`,
      occurredAt: new Date('2026-09-16T12:00:00.000Z'),
      tokenExpiresAt: new Date('2026-09-16T12:10:00.000Z'),
    }));
    const batchSizes: number[] = [];
    const published = await publishCustomerAdmitted(events, 'https://sqs.example/customer-admitted', async (input) => {
      batchSizes.push(input.Entries?.length ?? 0);
      return batchSizes.length === 1 ? { Failed: [{ Id: '42-1', Code: 'InternalError' }] } : {};
    });
    assert.equal(published, 2);
    assert.deepEqual(batchSizes, [2, 1]);
  });
});

describe('queue HTTP boundary', () => {
  let server: ReturnType<typeof app.listen>;

  before(async () => {
    server = app.listen(0);
    await new Promise<void>((resolve) => server.once('listening', resolve));
  });

  it('rejects an unauthenticated join before accessing persistence', async () => {
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const response = await fetch(`http://127.0.0.1:${address.port}/events/1/queue/join`, { method: 'POST' });
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: 'unauthenticated' });
  });

  it('rejects an unauthenticated attempt to leave before accessing persistence', async () => {
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const response = await fetch(`http://127.0.0.1:${address.port}/events/1/queue/me`, { method: 'DELETE' });
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: 'unauthenticated' });
  });

  it('validates the public queue summary identifier before accessing persistence', async () => {
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const response = await fetch(`http://127.0.0.1:${address.port}/events/not-a-number/queue`);
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: 'invalid_event' });
  });

  it('requires authentication for manual organiser admission', async () => {
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const response = await fetch(`http://127.0.0.1:${address.port}/events/1/queue/admit-next`, {
      method: 'POST',
    });
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: 'unauthenticated' });
  });

  after(() => server?.close());
});
