import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv-provider.js';

// Each registration owns its compiled validator; refreshing/unloading a plugin
// can release it rather than accumulating schemas in a global cache.
export function createReaderArgumentValidator(schema) {
  const validate = new AjvJsonSchemaValidator().getValidator(schema);
  return value => validate(value).valid;
}
