#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createReaderMcpServer } from './server.mjs';

let server;
try {
  server = createReaderMcpServer({ maxResponseBytes: process.env.EPUB_READER_MCP_MAX_BYTES
    ? Number(process.env.EPUB_READER_MCP_MAX_BYTES) : undefined });
  process.once('SIGINT', () => { void server.close(); });
  process.once('SIGTERM', () => { void server.close(); });
  await server.connect(new StdioServerTransport());
} catch {
  // stdout belongs exclusively to MCP JSON-RPC. Never echo config/credentials.
  console.error('EPUB Reader MCP could not start; check its local configuration and dependencies.');
  process.exitCode = 1;
}
