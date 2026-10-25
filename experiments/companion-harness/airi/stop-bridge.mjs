// AIRI 0.12's plugin tool RPC drops the model's AbortSignal. Bind this at the
// renderer integration point, not by observing global clicks or the keyboard.
// The app's visible chat state and the execution/memory owners stay separate.
/**
 * @param {{ $onAction: (callback: (action: {name: string}) => void) => (() => void) }} chat
 * @param {{ tools: Array<{id: string}> }} tools
 * @param {(input: {ownerExtensionId: string, name: string, input: object}) => Promise<unknown>} invoke
 * @param {(error: unknown) => void} [onError]
 */
export function bindReaderStop(chat, tools, invoke, onError = () => {}) {
  return chat.$onAction(({ name }) => {
    if (!['cancelTurn', 'cancelPendingSends'].includes(name)) return;
    if (!tools.tools.some(tool => tool.id === 'plugin:epub-reader-tools:reader_stop_lookup')) return;
    void invoke({ ownerExtensionId: 'epub-reader-tools', name: 'reader_stop_lookup', input: {} }).catch(onError);
  });
}
