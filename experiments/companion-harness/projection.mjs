/** Only current-turn protocol crosses this port. The app supplies the role,
 * question and bounded historical context once, at its provider boundary. */
export function projectProtocol(messages) {
  return messages.flatMap(message => {
    if (message.role === 'system' || message.role === 'user' && message.source?.kind === 'user') return [];
    if (message.role === 'developer' && message.content.every(block => ['tool-addition', 'tool-removal'].includes(block.type))) return [];
    if (!['assistant', 'tool', 'user'].includes(message.role)) throw new Error('Unsupported harness message role');
    if (message.role === 'user' && message.source?.kind !== 'epub-policy') throw new Error('Unexpected harness context producer');
    const content = message.content.filter(block => block.type === 'text').map(block => block.text).join('');
    if (message.content.some(block => !['text', 'reasoning', 'tool-call'].includes(block.type))) throw new Error('Unsupported harness content');
    const calls = message.content.filter(block => block.type === 'tool-call').map(block => ({
      id: block.id, type: 'function', function: { name: block.name, arguments: block.arguments },
    }));
    const reasoning = message.content.filter(block => block.type === 'reasoning');
    return [{ role: message.role, content: content || null,
      ...(calls.length ? { tool_calls: calls } : {}),
      ...(reasoning.length || message.source?.replayState?.response?.reasoningPresent
        ? { reasoning_content: reasoning.map(block => block.text).join('') } : {}),
      ...(message.role === 'tool' ? { tool_call_id: message.toolCallId } : {}),
    }];
  });
}

export function* replyChunks(reply) {
  const blocks = [
    ...(Object.hasOwn(reply, 'reasoning_content') ? [{ type: 'reasoning', text: reply.reasoning_content }] : []),
    ...(reply.content ? [{ type: 'text', text: reply.content }] : []),
    ...(reply.tool_calls ?? []).map(call => ({ type: 'tool-call', id: call.id, name: call.function.name, arguments: call.function.arguments })),
  ];
  for (const [index, block] of blocks.entries()) {
    yield { type: 'block-start', index, blockType: block.type };
    if (block.type === 'text' || block.type === 'reasoning') yield { type: `${block.type}-delta`, index, text: block.text };
    else yield { type: 'tool-call-delta', index, id: block.id, name: block.name, argumentsDelta: block.arguments };
    yield { type: 'block-end', index, block };
  }
  yield { type: 'finish', reason: { kind: reply.tool_calls?.length ? 'tool-calls' : 'stop' },
    replayState: { response: { reasoningPresent: Object.hasOwn(reply, 'reasoning_content') } } };
}
