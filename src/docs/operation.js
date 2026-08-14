// ─── Operation builders ─────────────────────────────────────
// Every operation in the specification needs the same furniture: which
// credential it takes, the failure modes that credential implies, and a worked
// example on both the request and the response. Writing that by hand eighty
// times guarantees it drifts, so it is assembled here instead.

const { ref, responses: shared } = require('./components');

const errorRef = name => ({ $ref: `#/components/responses/${name}` });

// A JSON response with a description, a schema and a worked example. The
// example is the part a developer actually reads, so it is never optional.
function json(description, schema, example) {
  return { description, content: { 'application/json': { schema, example } } };
}

function jsonBody(schema, example, { required = true, description } = {}) {
  return {
    required,
    ...(description ? { description } : {}),
    content: { 'application/json': { schema, example } }
  };
}

function fileResponse(description, mediaType, example) {
  return {
    description,
    headers: {
      'Content-Disposition': {
        description: 'Carries the suggested filename',
        schema: { type: 'string', example: 'attachment; filename="devcircle-export.csv"' }
      }
    },
    content: { [mediaType]: { schema: { type: 'string' }, example } }
  };
}

function query(name, description, schema = { type: 'string' }) {
  return { name, in: 'query', required: false, description, schema };
}

function path(name, description, schema = { type: 'string', format: 'uuid' }) {
  return { name, in: 'path', required: true, description, schema };
}

// ─── The operation itself ───────────────────────────────────
// `auth` decides both the security requirement and which failures are worth
// documenting: an endpoint with no credential cannot answer 401, and one with
// no permission gate cannot answer 403.

function op({
  tag,
  summary,
  description = '',
  operationId,
  auth = 'bearer',            // 'bearer' | 'apiKey' | 'none'
  permission,                 // admin permission key, or a list where any one suffices
  scopes,                     // API key scopes accepted, for auth: 'apiKey'
  parameters,
  requestBody,
  responses,
  extras = {}
}) {
  const security =
    auth === 'bearer' ? [{ bearerAuth: [] }] :
    auth === 'apiKey' ? [{ apiKeyAuth: [] }, { bearerAuth: [] }] :
    [];

  const required = permission ? [].concat(permission) : [];

  // The permission is stated three ways on purpose: in prose for whoever is
  // reading, as a vendor extension for whoever is generating, and in the 403
  // body at runtime for whoever is debugging.
  const notes = [description.trim()];
  if (required.length) {
    notes.push(required.length === 1
      ? `**Requires the \`${required[0]}\` permission.**`
      : `**Requires one of: ${required.map(p => `\`${p}\``).join(', ')}.**`);
  }
  if (scopes && scopes.length) {
    notes.push(`**Requires an API key scoped to ${scopes.map(s => `\`${s}\``).join(' or ')}.**`);
  }

  const failures = {
    ...(auth !== 'none' ? { 401: errorRef('Unauthorized') } : {}),
    ...(auth !== 'none' && (required.length || auth === 'apiKey') ? { 403: errorRef('Forbidden') } : {}),
    429: errorRef('TooManyRequests'),
    500: errorRef('ServerError')
  };

  return {
    tags: [tag],
    summary,
    description: notes.filter(Boolean).join('\n\n'),
    ...(operationId ? { operationId } : {}),
    ...(security.length ? { security } : { security: [] }),
    ...(required.length ? { 'x-permission': required } : {}),
    ...(scopes ? { 'x-api-key-scopes': scopes } : {}),
    ...(parameters ? { parameters } : {}),
    ...(requestBody ? { requestBody } : {}),
    responses: { ...responses, ...failures },
    ...extras
  };
}

module.exports = { op, json, jsonBody, fileResponse, query, path, errorRef, ref, shared };
