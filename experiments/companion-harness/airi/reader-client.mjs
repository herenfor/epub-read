import { readFile } from 'node:fs/promises';
import { request } from 'node:http';
import { randomUUID } from 'node:crypto';

// Native HTTP, without an ambient proxy. Discovery is re-read per request so
// app restart rotates credentials without copying them into AIRI settings.
export function createReaderClient(connectionFile) {
  return async function call(path, input, signal) {
    signal?.throwIfAborted();
    const connection = JSON.parse(await readFile(connectionFile, 'utf8'));
    const endpoint = new URL(connection.endpoint);
    if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1' || endpoint.username || endpoint.password
      || !connection.token || !/^\/(tools|call|status)$/.test(path)) throw new Error('Invalid reader connection');
    const body = input ? JSON.stringify({ requestId: randomUUID(), ...input }) : undefined;
    return new Promise((resolve, reject) => {
      const req = request(new URL(path, endpoint), { method: body ? 'POST' : 'GET', signal,
        headers: { Authorization: `Bearer ${connection.token}`, ...(body ? {
          'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body),
        } : {}) } }, res => {
        const chunks = []; let bytes = 0;
        res.on('data', chunk => {
          bytes += chunk.length;
          if (bytes > 4 * 1024 * 1024) res.destroy(new Error('Reader response too large'));
          else chunks.push(chunk);
        });
        res.once('error', reject);
        res.once('end', () => {
          try {
            const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            if (res.statusCode !== 200) throw new Error('Reader host refused the request');
            resolve(value);
          } catch { reject(new Error('Reader response is unavailable')); }
        });
      });
      req.setTimeout(125_000, () => req.destroy(new Error('Reader request timed out')));
      req.once('error', () => reject(new Error(signal?.aborted ? 'Reader call cancelled' : 'Reader host is unavailable')));
      req.end(body);
    });
  };
}
