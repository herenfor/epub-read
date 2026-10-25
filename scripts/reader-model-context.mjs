/** Runtime-neutral last gate. The caller supplies its actual assembled messages
 * and a provider-aware tokenizer or a proven conservative upper bound. There is
 * deliberately no character/token heuristic or model invocation in this module. */
export async function admitReaderModelInput({ request, countInputTokens, contextTokens, reservedTokens, safetyTokens = 256 }) {
  if (typeof countInputTokens !== 'function' || !Number.isSafeInteger(contextTokens) || contextTokens <= 0
    || !Number.isSafeInteger(reservedTokens) || reservedTokens < 0
    || !Number.isSafeInteger(safetyTokens) || safetyTokens < 0) throw new TypeError('A reliable input counter and explicit context/reserve limits are required');
  // Freeze the complete JSON wire payload, including top-level tool schemas.
  // Concurrent UI/history changes cannot alter what was counted before send.
  const body = JSON.stringify(request);
  const snapshot = JSON.parse(body);
  const pending = [snapshot];
  while (pending.length) {
    const value = pending.pop();
    if (!value || typeof value !== 'object') continue;
    Object.freeze(value);
    pending.push(...Object.values(value));
  }
  const inputTokens = await countInputTokens(snapshot);
  if (!Number.isSafeInteger(inputTokens) || inputTokens < 0) throw new TypeError('The input counter returned an invalid token count');
  if (inputTokens > contextTokens - reservedTokens - safetyTokens) {
    const error = new Error('The assembled request exceeds the available model context; reduce reader response size or compact context before sending');
    error.code = 'MODEL_CONTEXT_LIMIT';
    throw error;
  }
  return { request: snapshot, body, inputTokens, remainingTokens: contextTokens - inputTokens - reservedTokens - safetyTokens };
}
