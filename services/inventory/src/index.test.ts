import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  MAX_RESERVED_GRID_DIM,
  MAX_RESERVED_SEATS,
  nonNegativeInteger,
  parseGridDims,
  positiveId,
  reservedSeatCount,
} from './index.js';

describe('inventory input validation', () => {
  it('accepts positive integer ids and rejects invalid values', () => {
    assert.equal(positiveId('12'), 12);
    assert.equal(positiveId(0), null);
    assert.equal(positiveId('not-an-id'), null);
  });

  it('accepts zero-priced inventory and rejects invalid prices', () => {
    assert.equal(nonNegativeInteger(0), 0);
    assert.equal(nonNegativeInteger('25'), 25);
    assert.equal(nonNegativeInteger(-1), null);
  });

  it('counts reserved seats across every zone for the 400-seat limit', () => {
    assert.equal(reservedSeatCount([{ gridRowSpan: 20, gridColSpan: 20 }]), MAX_RESERVED_SEATS);
    assert.equal(
      reservedSeatCount([
        { gridRowSpan: 20, gridColSpan: 20 },
        { gridRowSpan: 1, gridColSpan: 1 },
      ]),
      MAX_RESERVED_SEATS + 1,
    );
  });

  it('accepts reserved grids up to 20x20 and rejects either dimension above 20', () => {
    const fallback = { gridRows: 6, gridCols: 8 };
    assert.deepEqual(
      parseGridDims({ gridRows: 20, gridCols: 20 }, fallback, MAX_RESERVED_GRID_DIM),
      { gridRows: 20, gridCols: 20 },
    );
    assert.equal(parseGridDims({ gridRows: 21, gridCols: 20 }, fallback, MAX_RESERVED_GRID_DIM), null);
    assert.equal(parseGridDims({ gridRows: 20, gridCols: 21 }, fallback, MAX_RESERVED_GRID_DIM), null);
  });
});
