const loopback = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

/** One volatile snapshot for the local AI development session; never writes user data to disk. */
export function installCompanionDiagnostics(server) {
  let snapshot = { schemaVersion: 1, updatedAt: 0, context: null, history: [], turns: [] };
  server.middlewares.use("/__ai-companion/diagnostics", async (request, response) => {
    const origin = `http://${request.headers.host}`;
    if (!loopback.has(request.socket.remoteAddress) || !/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(request.headers.host ?? "")
      || (request.headers.origin && request.headers.origin !== origin)) {
      response.writeHead(403); response.end(); return;
    }
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    if (request.method === "GET") { response.end(JSON.stringify(snapshot)); return; }
    if (request.method !== "PUT") { response.writeHead(405); response.end(); return; }
    try {
      const chunks = [];
      let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > 4 * 1024 * 1024) { response.writeHead(413); response.end(); return; }
        chunks.push(chunk);
      }
      const next = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (next.schemaVersion !== 1) throw new Error("Unknown diagnostic schema");
      snapshot = next;
      response.writeHead(204); response.end();
    } catch { response.writeHead(400); response.end(); }
  });
}
