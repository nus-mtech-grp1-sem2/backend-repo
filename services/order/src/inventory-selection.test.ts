import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { selectAvailableZone } from './index.js';

const blueZone = { inventoryItemId: 1, priceCents: 2000, totalQty: 20, reservedQty: 0, soldQty: 20 };
const redZone = { inventoryItemId: 2, priceCents: 5000, totalQty: 8, reservedQty: 0, soldQty: 0 };

describe('selectAvailableZone', () => {
  it('falls through to a pricier zone once the cheapest one is sold out', () => {
    // Blue (20 seats, cheaper) is fully sold; red (8 seats) still has room.
    // Buying seat 21+ must land on red, not 409 just because blue is full.
    const picked = selectAvailableZone([blueZone, redZone], 1, null);
    assert.equal(picked?.inventoryItemId, 2);
  });

  it('prefers the cheapest zone with enough capacity when none is requested', () => {
    const roomyBlue = { ...blueZone, soldQty: 5 };
    const picked = selectAvailableZone([roomyBlue, redZone], 1, null);
    assert.equal(picked?.inventoryItemId, 1);
  });

  it('honours an explicit zone request even if a cheaper one exists', () => {
    const roomyBlue = { ...blueZone, soldQty: 5 };
    const picked = selectAvailableZone([roomyBlue, redZone], 1, 2);
    assert.equal(picked?.inventoryItemId, 2);
  });

  it('returns null when the requested zone lacks capacity, instead of silently substituting', () => {
    const picked = selectAvailableZone([blueZone, redZone], 1, 1);
    assert.equal(picked, null);
  });

  it('returns null when no zone has enough capacity for the requested quantity', () => {
    const picked = selectAvailableZone([blueZone, redZone], 100, null);
    assert.equal(picked, null);
  });
});
