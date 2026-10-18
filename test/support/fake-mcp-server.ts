// An MCP server double on loopback (issue #1958): the real agent CLIs call its tools as they would a real MCP server's,
// and the test reads each call from memory. It speaks MCP's Streamable HTTP transport with plain JSON answers (no event
// stream): `initialize`, `tools/list` and `tools/call`; a notification is taken with 202. Its one tool, `echo`, answers
// `echo: <text>`.
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';

/** One call of a tool, as the CLI sent it. */
export interface McpToolCall { name: string; arguments: Record<string, unknown> }

export interface FakeMcpServer {
  /** The server's URL, for a CLI's MCP config. */
  url: string;
  /** Every tool call, in order. */
  calls: McpToolCall[];
  /** Every JSON-RPC method the CLI called, in order. */
  methods: string[];
  close(): Promise<void>;
}

export const ECHO_TOOL = {
  name: 'echo',
  description: 'Answers the text it is given.',
  inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
};

type Rpc = { jsonrpc: '2.0'; id?: number | string; method: string; params?: Record<string, unknown> };

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** The result of one request; undefined for a method it does not know. */
function resultOf(rpc: Rpc, calls: McpToolCall[]): Record<string, unknown> | undefined {
  if (rpc.method === 'initialize') {
    const version = typeof rpc.params?.protocolVersion === 'string' ? rpc.params.protocolVersion : '2025-06-18';
    return { protocolVersion: version, capabilities: { tools: {} }, serverInfo: { name: 'double', version: '1.0.0' } };
  }
  if (rpc.method === 'tools/list') return { tools: [ECHO_TOOL] };
  if (rpc.method === 'tools/call') {
    const name = String(rpc.params?.name);
    const args = (rpc.params?.arguments ?? {}) as Record<string, unknown>;
    calls.push({ name, arguments: args });
    if (name !== ECHO_TOOL.name) return { content: [{ type: 'text', text: `no such tool: ${name}` }], isError: true };
    return { content: [{ type: 'text', text: `echo: ${String(args.text)}` }] };
  }
  if (rpc.method === 'ping') return {};
  return undefined;
}

export async function startFakeMcpServer(): Promise<FakeMcpServer> {
  const calls: McpToolCall[] = [];
  const methods: string[] = [];
  const sockets = new Set<Socket>();
  const server: Server = createServer((req, res) => {
    // No event stream from the server (GET), and a session's end (DELETE) needs nothing kept.
    if (req.method === 'DELETE') { res.writeHead(200); res.end(); return; }
    if (req.method !== 'POST') { res.writeHead(405, { allow: 'POST, DELETE' }); res.end(); return; }
    void readBody(req).then((raw) => {
      const rpc = JSON.parse(raw) as Rpc;
      methods.push(rpc.method);
      if (rpc.id === undefined) { res.writeHead(202); res.end(); return; }
      const result = resultOf(rpc, calls);
      const answer = result ? { jsonrpc: '2.0', id: rpc.id, result } : { jsonrpc: '2.0', id: rpc.id, error: { code: -32601, message: `no such method: ${rpc.method}` } };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(answer));
    }).catch(() => { res.writeHead(400); res.end(); });
  });
  server.on('connection', (s: Socket) => { sockets.add(s); s.on('error', () => {}); s.on('close', () => sockets.delete(s)); });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    calls,
    methods,
    close: () => new Promise<void>((resolve) => {
      for (const s of sockets) s.destroy();
      server.close(() => resolve());
    }),
  };
}
