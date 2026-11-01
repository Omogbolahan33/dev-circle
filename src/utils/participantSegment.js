// Participant segment is derived from distinct participant products, never
// supplied by a person or an import column. The CSV's observed mapping is:
// 0 products = General / App, 1 = Single Product, 2 = Multi-Product, 3+ = Power Tester.
const SEGMENT_RULES = Object.freeze([
  Object.freeze({ min_products: 0, max_products: 0, value: 'General / App' }),
  Object.freeze({ min_products: 1, max_products: 1, value: 'Single Product' }),
  Object.freeze({ min_products: 2, max_products: 2, value: 'Multi-Product' }),
  Object.freeze({ min_products: 3, max_products: null, value: 'Power Tester' })
]);

function participantProducts(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) return parsed;
  } catch {}
  // Accept delimited values as well as the canonical JSON column shape.
  return value.split(/[;|]/);
}

function segmentForProducts(products) {
  const count = new Set(participantProducts(products)
    .map(product => String(product ?? '').trim())
    .filter(Boolean)).size;
  return SEGMENT_RULES.find(rule => count >= rule.min_products
    && (rule.max_products === null || count <= rule.max_products)).value;
}

module.exports = { SEGMENT_RULES, participantProducts, segmentForProducts };
