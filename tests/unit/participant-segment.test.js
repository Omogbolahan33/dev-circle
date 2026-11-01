const { test } = require('node:test');
const assert = require('node:assert/strict');
const { segmentForProducts } = require('../../src/utils/participantSegment');

test('participant segments follow the imported CSV product-count rules', () => {
  assert.equal(segmentForProducts([]), 'General / App');
  assert.equal(segmentForProducts(['Mobile App']), 'Single Product');
  assert.equal(segmentForProducts(['Mobile App', 'Yield']), 'Multi-Product');
  assert.equal(segmentForProducts(['Mobile App', 'Yield', 'BNPL']), 'Power Tester');
  assert.equal(segmentForProducts(['Mobile App', 'Yield', 'BNPL', 'Salaried Loans']), 'Power Tester');
});

test('segment counts distinct non-empty product values and accepts stored JSON', () => {
  assert.equal(segmentForProducts(['Mobile App', 'Mobile App', '', null, 'Yield']), 'Multi-Product');
  assert.equal(segmentForProducts('["Mobile App", "Yield", "BNPL"]'), 'Power Tester');
  assert.equal(segmentForProducts(''), 'General / App');
});
