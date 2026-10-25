import { Context } from '@deepseek-ai/cordis';
import Prompt from '@deepseek-ai/dsh-system-prompt';
import Tools, { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools';
import { selectReaderTools } from './airi/reader-policy.mjs';

// DSH rc.3's raw validator accepts oneOf, but not JSON Schema type arrays.
// Keep the native/AIRI schema intact and translate only at this boundary.
function dshSchema(schema) {
  const node = { ...schema };
  if (node.properties) node.properties = Object.fromEntries(Object.entries(node.properties).map(([key, value]) => [key, dshSchema(value)]));
  if (Array.isArray(node.type)) {
    const types = node.type;
    delete node.type;
    return { oneOf: types.map(type => ({ ...node, type })) };
  }
  return node;
}

// One registry/policy pipeline, no model loop, shell, global profile or memory.
// The native reader remains the authority for book grants and source ownership.
export async function createReaderKernel(catalog, invoke) {
  const ctx = new Context();
  const fibers = [];
  try {
    fibers.push(await ctx.plugin(Prompt));
    fibers.push(await ctx.plugin(Tools));
    const declarations = selectReaderTools(catalog);
    for (const tool of declarations) {
      const parameters = dshSchema(tool.inputSchema);
      ctx.tools.register({ name: tool.name, description: tool.description, parameters,
        output: { schema: { type: 'object', additionalProperties: true },
          render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
        async execute(args, exec) {
          if (validateJsonSchemaValue(parameters, args).length) throw new Error('Invalid reader tool arguments');
          return invoke(tool.name, args, exec.signal);
        },
      });
    }
    return {
      tools: declarations.map(tool => ({ name: tool.name, description: tool.description, parameters: tool.inputSchema })),
      async call(id, name, args, signal) {
        return ctx.tools.execute({ callId: id, name, arguments: args, signal });
      },
      async dispose() { for (const fiber of fibers.reverse()) await fiber.dispose(); },
    };
  } catch (error) { for (const fiber of fibers.reverse()) await fiber.dispose(); throw error; }
}
