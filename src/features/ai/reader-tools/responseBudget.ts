import { ReaderToolError, type ReaderToolReply } from "./contracts";

export const DEFAULT_READER_RESPONSE_BYTES = 32 * 1024;
export const MAX_READER_RESPONSE_BYTES = 256 * 1024;
const size = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;

/** Bounds the complete serialized tool reply, not an approximate token count. */
export function readerReplyBudget(requestId: string, maxBytes = DEFAULT_READER_RESPONSE_BYTES) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1024 || maxBytes > MAX_READER_RESPONSE_BYTES) {
    throw new ReaderToolError("INVALID_ARGUMENTS", "maxResponseBytes须为1024至262144之间的整数字节数");
  }
  const success = (data: unknown, limited: boolean): ReaderToolReply => ({ apiVersion: "1", requestId,
    responseBudget: { maxBytes, limited }, ok: true, data });
  return {
    maxBytes,
    fits: (data: unknown, limited = false) => size(success(data, limited)) <= maxBytes,
    reply(data: unknown, limited = false): ReaderToolReply {
      const result = success(data, limited);
      if (size(result) > maxBytes) throw new ReaderToolError("RESPONSE_BUDGET_EXCEEDED", "响应预算不足，请提高maxResponseBytes或缩小请求范围");
      return result;
    },
    failure(code: string, message: string, retryable: boolean): ReaderToolReply {
      const result: ReaderToolReply = { apiVersion: "1", requestId, responseBudget: { maxBytes, limited: false },
        ok: false, error: { code, message, retryable } };
      return size(result) <= maxBytes ? result : { apiVersion: "1", requestId, ok: false,
        error: { code: "RESPONSE_BUDGET_EXCEEDED", message: "请缩小请求范围", retryable: false } };
    },
  };
}

/** Return the largest fitting prefix without modifying source text. A caller
 * building a page must derive its next cursor from the actual returned count. */
export function fitReaderItems<T, R>(items: T[], limit: number, build: (items: T[]) => R,
  fits: (data: R, limited: boolean) => boolean): { data: R; limited: boolean } {
  const initial = Math.min(items.length, limit);
  for (let count = initial; count >= (items.length ? 1 : 0); count--) {
    const data = build(items.slice(0, count));
    const limited = count < initial;
    if (fits(data, limited)) return { data, limited };
  }
  throw new ReaderToolError("RESPONSE_BUDGET_EXCEEDED", "响应预算不足以返回一项，请提高maxResponseBytes或先检索较短片段");
}
