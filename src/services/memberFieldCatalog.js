// Canonical metadata for the member-declared profile attributes that are
// useful outside the profile form (cohort targeting, exports, and admin views).
// Keep storage, labels, control types, and finite choices together here so a
// new profile field has one definition rather than a form option and a filter
// definition that can drift apart.
const readiness = require('./readiness');
const vocabularies = require('./vocabularies');

const distinct = column => async database => ((await database.prepare(
  `SELECT DISTINCT ${column} AS value FROM users
   WHERE COALESCE(${column}, '') != '' ORDER BY value`
).all()) || []).map(row => row.value);

// `storage` is deliberately constrained to known users-table columns. The
// criteria engine turns these descriptors into SQL; request data never supplies
// a column or expression.
const PROFILE_FIELDS = [
  {
    key: 'age_group', label: 'Age group', type: 'text', storage: { column: 'age_group' },
    input: 'select', values: readiness.AGE_GROUPS, options: readiness.AGE_GROUPS
  },
  {
    key: 'products', label: 'Participant products', type: 'array', storage: { json: 'products' },
    input: 'multi-select', values: readiness.PARTICIPANT_PRODUCTS, options: readiness.PARTICIPANT_PRODUCTS
  },
  {
    key: 'segment', label: 'Participant segment', type: 'text', storage: { column: 'segment' },
    values: readiness.SEGMENTS, derived: true
  },
  {
    key: 'employment', label: 'Employment type', type: 'text', storage: { column: 'employment' },
    input: 'select', values: readiness.EMPLOYMENT_TYPES, options: readiness.EMPLOYMENT_TYPES
  },
  {
    key: 'preferred_research', label: 'Preferred research', type: 'text', storage: { column: 'preferred_research' },
    input: 'select', values: distinct('preferred_research'), vocabulary: 'preferred_research'
  },
  {
    key: 'work_sector', label: 'Work sector', type: 'text', storage: { column: 'work_sector' },
    input: 'select', values: distinct('work_sector'), vocabulary: 'work_sector'
  },
  {
    key: 'location_state', label: 'State', type: 'text', storage: { column: 'location_state' },
    input: 'select', values: distinct('location_state'), vocabulary: 'location_state'
  },
  {
    key: 'gender', label: 'Gender', type: 'text', storage: { column: 'gender' },
    input: 'select', values: distinct('gender'), options: [
      { value: 'female', label: 'Female' },
      { value: 'male', label: 'Male' },
      { value: 'other', label: 'Other' }
    ]
  },
  {
    key: 'api_products', label: 'API product', type: 'array', storage: { json: 'api_products' },
    input: 'multi-select', vocabulary: 'api_products'
  }
];

const PROFILE_FIELD_BY_KEY = Object.freeze(Object.fromEntries(
  PROFILE_FIELDS.map(field => [field.key, Object.freeze(field)])
));

async function profileCatalogue(database, circleId) {
  return Promise.all(PROFILE_FIELDS.filter(field => !field.derived).map(async field => {
    let raw = field.options || field.values;
    if (field.vocabulary) raw = await vocabularies.listFor(field.vocabulary, circleId);
    else if (typeof raw === 'function') raw = await raw(database);
    return {
      key: field.key,
      label: field.label,
      input: field.input,
      values: (raw || []).map(option => typeof option === 'object'
        ? { value: String(option.value), label: String(option.label ?? option.value) }
        : { value: String(option), label: String(option) })
    };
  }));
}

module.exports = { PROFILE_FIELDS, PROFILE_FIELD_BY_KEY, profileCatalogue };
