import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { nonNegativeInteger, positiveId } from './index.js';

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
});