// ─── Criteria builder ───────────────────────────────────────
// One component, used by the cohort builder and the export drawer. Both used
// to keep their own list of fields and their own idea of what values each one
// allowed, which is how "suspended" ended up typed by hand on one screen and
// picked from a list on the other.
//
// Everything it renders comes from the catalogue the server publishes:
// which fields exist, which operators each accepts, and — the part that was
// missing — the values to choose between. This file decides how that looks,
// never what it contains.
//
//   const builder = Criteria.attach(element, { fields, onChange });
//   builder.add('status', 'active');
//   builder.rules();   // → { match: 'all', rules: [...] } or null

const Criteria = (() => {
  const OPERATOR_LABELS = {
    eq: 'is',
    neq: 'is not',
    contains: 'contains',
    gte: 'is at least',
    lte: 'is at most',
    gt: 'is more than',
    lt: 'is less than'
  };

  // Membership reads better as "is in" than "is"
  const MEMBERSHIP_LABELS = { eq: 'is in', neq: 'is not in' };

  // Arrays hold several values, so "is" means "includes"
  const ARRAY_LABELS = { eq: 'includes', neq: 'does not include' };

  function operatorLabel(type, op) {
    if (type === 'membership') return MEMBERSHIP_LABELS[op] || OPERATOR_LABELS[op];
    if (type === 'array') return ARRAY_LABELS[op] || OPERATOR_LABELS[op];
    return OPERATOR_LABELS[op] || op;
  }

  function escape(value) {
    const div = document.createElement('div');
    div.textContent = String(value ?? '');
    return div.innerHTML;
  }

  function attach(container, { fields, onChange = () => {}, matchSelect = null } = {}) {
    if (!container) throw new Error('Criteria.attach needs a container element');

    const byKey = new Map(fields.map(f => [f.field, f]));

    function fieldOptions(selected) {
      return fields.map(f =>
        `<option value="${escape(f.field)}"${f.field === selected ? ' selected' : ''}>${escape(f.label)}</option>`
      ).join('');
    }

    // The value control follows from the field: a fixed set becomes a
    // dropdown, a number becomes a number input, and only genuinely open text
    // stays a text box.
    function renderValue(row) {
      const spec = byKey.get(row.querySelector('.criterion-field').value);
      const slot = row.querySelector('.criterion-value');
      const previous = row.dataset.pendingValue ?? slot.querySelector('.criterion-input')?.value ?? '';
      delete row.dataset.pendingValue;

      if (spec.values) {
        if (!spec.values.length) {
          // A known set that is empty: nobody holds a value yet, so there is
          // nothing to pick and typing one would match nobody. Say so.
          slot.innerHTML =
            `<span class="criterion-empty">No ${escape(spec.label.toLowerCase())} recorded yet</span>` +
            '<input type="hidden" class="criterion-input" value="">';
        } else {
          const options = spec.values.map(v =>
            `<option value="${escape(v.value)}"${String(v.value) === String(previous) ? ' selected' : ''}>${escape(v.label)}</option>`
          ).join('');
          slot.innerHTML = `<select class="input criterion-input">${options}</select>`;
        }
      } else if (spec.type === 'number') {
        slot.innerHTML =
          `<input type="number" class="input criterion-input" value="${escape(previous)}" ` +
          `placeholder="${escape(spec.unit || 'Number')}">`;
      } else {
        slot.innerHTML =
          `<input type="text" class="input criterion-input" value="${escape(previous)}" placeholder="Value">`;
      }

      const input = slot.querySelector('.criterion-input');
      input.addEventListener('input', onChange);
      input.addEventListener('change', onChange);
    }

    function renderOperators(row) {
      const spec = byKey.get(row.querySelector('.criterion-field').value);
      row.querySelector('.criterion-op').innerHTML = spec.operators
        .map(op => `<option value="${op}">${escape(operatorLabel(spec.type, op))}</option>`)
        .join('');
    }

    function add(field, value, op) {
      const first = fields[0];
      const key = byKey.has(field) ? field : first.field;

      const row = document.createElement('div');
      row.className = 'criterion';
      if (value !== undefined && value !== null) row.dataset.pendingValue = value;

      row.innerHTML = `
        <select class="input criterion-field">${fieldOptions(key)}</select>
        <select class="input criterion-op"></select>
        <span class="criterion-value"></span>
        <button type="button" class="criterion-remove" title="Remove this criterion" aria-label="Remove this criterion">×</button>`;

      row.querySelector('.criterion-field').addEventListener('change', () => {
        renderOperators(row);
        renderValue(row);
        onChange();
      });
      row.querySelector('.criterion-op').addEventListener('change', onChange);
      row.querySelector('.criterion-remove').addEventListener('click', () => {
        row.remove();
        onChange();
      });

      container.appendChild(row);
      renderOperators(row);
      if (op) row.querySelector('.criterion-op').value = op;
      renderValue(row);
      onChange();
      return row;
    }

    function clear() {
      container.innerHTML = '';
      onChange();
    }

    function rules() {
      const collected = Array.from(container.querySelectorAll('.criterion')).map(row => ({
        field: row.querySelector('.criterion-field').value,
        op: row.querySelector('.criterion-op').value,
        value: row.querySelector('.criterion-input')?.value ?? ''
      })).filter(rule => rule.value !== '');

      if (!collected.length) return null;

      return {
        match: matchSelect ? matchSelect.value : 'all',
        rules: collected
      };
    }

    function count() {
      return container.querySelectorAll('.criterion').length;
    }

    if (matchSelect) matchSelect.addEventListener('change', onChange);

    return { add, clear, rules, count, fields: byKey };
  }

  async function load(endpoint) {
    const data = await api.get(endpoint);
    // The cohort endpoint answers { fields }, the export one { criteria }
    return data.fields || data.criteria;
  }

  return { attach, load, operatorLabel };
})();
