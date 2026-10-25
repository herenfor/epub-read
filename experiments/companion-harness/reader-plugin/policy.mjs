import { READING_GUIDANCE as guidance } from 'epub-reader-agent-tools/policy';
export { READ_TOOLS, selectReadTools } from 'epub-reader-agent-tools/policy';

// DSH rc.3 accepts oneOf but rejects JSON Schema type arrays. Translate only
// the DSH-facing copy, including array items; keep the source schema unchanged.
export function dshSchema(schema) {
  const node = { ...schema };
  if (node.properties) node.properties = Object.fromEntries(Object.entries(node.properties).map(([key, value]) => [key, dshSchema(value)]));
  if (node.items) node.items = dshSchema(node.items);
  for (const key of ['oneOf', 'anyOf', 'allOf']) if (node[key]) node[key] = node[key].map(dshSchema);
  if (Array.isArray(node.type)) {
    const types = node.type;
    delete node.type;
    return { oneOf: types.map(type => ({ ...node, type })) };
  }
  return node;
}

export const READING_GUIDANCE = guidance + '\nUse reader_refresh_tools after the local reader starts/restarts. If it is unavailable, continue ordinary conversation and say when book evidence could not be checked.';
