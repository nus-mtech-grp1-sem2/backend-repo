import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

import { app, parseConfig, positiveInteger } from './index.js';

describe('queue input validation', () => {
  it('accepts a bounded queue configuration', () => {
    assert.deepEqual(parseConfig({
      opensAt: '2026-10-01T04:00:00.000Z', admissionBatchSize: 20, admissionIntervalSec: 30,
    }), {
      opensAt: '2026-10-01T04:00:00.000Z', admissionBatchSize: 20, admissionIntervalSec: 30,
    });
  });

  it('rejects malformed identifiers and unsafe admission settings', () => {
    assert.equal(positiveInteger('1 OR 1=1'), null);
    assert.equal(parseConfig({ opensAt: 'never', admissionBatchSize: 0, admissionIntervalSec: 30 }), null);
    assert.equal(parseConfig({ opensAt: '2026-10-01', admissionBatchSize: 10_001, admissionIntervalSec: 30 }), null);
  });
});

describe('queue HTTP boundary', () => {
  let server: ReturnType<typeof app.listen>;

  it('rejects an unauthenticated join before accessing persistence', async () => {
    server = app.listen(0);
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const response = await fetch(`http://127.0.0.1:${address.port}/events/1/queue/join`, { method: 'POST' });
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: 'unauthenticated' });
  });

  after(() => server?.close());
});
