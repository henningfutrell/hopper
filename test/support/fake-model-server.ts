// A fake model server on loopback (issue #1958): the real agent CLIs talk to it in place of a model, with a dummy key.
// It speaks the Anthropic Messages API (`POST /v1/messages`) and the OpenAI Responses API (`POST /v1/responses`) and
// Chat Completions API (`POST /v1/chat/completions`), streaming or not, and answers a script: each turn of the
// conversation is one step — text, a tool call — or a fault: 429, overloaded, a stream cut mid-delta, slow tokens, a
// malformed event. A request that is not the conversation's (a CLI's own side call: a title, a quota check, its tools
// off) gets a short text and takes no step. It is also the run's proxy: HTTPS_PROXY names it, so a request to anywhere
// else is refused here and recorded, never sent off the machine.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { anthropicAnswer, type Answer } from './fake-model-anthropic.ts';
import { chatAnswer, responsesAnswer } from './fake-model-openai.ts';

/**
 * One step of the script: what the model says at that turn. `thinking` streams reasoning before the text (a thinking block
 * on the Messages API, `reasoning_content` on Chat Completions; the Responses API leaves it out). `delayMs` waits before
 * each event: slow tokens.
 */
export type ModelStep =
  | { text: string; thinking?: string; delayMs?: number }
  | { tool: { name: string; input: Record<string, unknown> }; text?: string }
  | { fault: ModelFault; text?: string };

/**
 * `rate-limited` answers 429, `overloaded` the provider's overloaded error (529 for Anthropic, 503 for OpenAI), `cut`
 * ends the stream mid-delta (or the connection, when no stream was asked for), `malformed` sends an event that is not JSON in place of a text delta, `server-error` answers 500.
 */
export type ModelFault = 'rate-limited' | 'overloaded' | 'cut' | 'malformed' | 'server-error';

/** One request the server took, its API, whether it took a step, and its body. */
export interface ModelRequest { api: 'anthropic' | 'responses' | 'chat'; path: string; step: boolean; body: Record<string, unknown> }

export interface FakeModelServer {
  /** The base URL, for example `http://127.0.0.1:PORT`. */
  url: string;
  /** Replace the script; the steps are taken in turn. */
  script(steps: ModelStep[]): void;
  /** The steps not taken yet. */
  left(): number;
  requests: ModelRequest[];
  /** Hosts a CLI asked the proxy to reach: refused, never reached. */
  refused: string[];
  close(): Promise<void>;
}

/** The text a side call gets, and the step after the script ends: a CLI that asks once more is told so. */
const SIDE_TEXT = 'ok';
const SCRIPT_ENDED = 'fake model server: the script has no step left';

function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      try { resolve(raw ? JSON.parse(raw) as Record<string, unknown> : {}); } catch (e) { reject(e as Error); }
    });
    req.on('error', reject);
  });
}

/** Whether a request is the conversation's: it offers the agent's tools. A side call offers none. */
function isTurn(body: Record<string, unknown>): boolean {
  return Array.isArray(body.tools) && body.tools.length > 0;
}

/** Writes an answer: a JSON body, or server-sent events with a delay between them and a fault on the way. */
async function send(res: ServerResponse, a: Answer): Promise<void> {
  if ('drop' in a) { res.socket?.destroy(); return; }
  if ('raw' in a) {
    res.writeHead(a.status, { 'content-type': 'application/json' });
    res.end(a.raw);
    return;
  }
  if ('json' in a) {
    res.writeHead(a.status, { 'content-type': 'application/json', ...(a.headers ?? {}) });
    res.end(JSON.stringify(a.json));
    return;
  }
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  for (const chunk of a.events) {
    if (a.delayMs) await new Promise((r) => setTimeout(r, a.delayMs));
    if (res.destroyed) return;
    // Each event flushed before the next: a cut ends a stream the CLI already read.
    await new Promise<void>((resolve) => res.write(chunk, () => resolve()));
  }
  // A cut stream: the connection ends with no final event.
  if (a.cut) { res.socket?.destroy(); return; }
  res.end();
}

/**
 * `isTurn`: which requests are the conversation's, in place of the default (it offers tools): for a CLI locked down to no
 * tools (a draft, issue #2862), whose conversation offers none.
 */
export async function startFakeModelServer(steps: ModelStep[] = [], o: { isTurn?: (body: Record<string, unknown>) => boolean } = {}): Promise<FakeModelServer> {
  let queue = [...steps];
  const requests: ModelRequest[] = [];
  const refused: string[] = [];
  const sockets = new Set<Socket>();

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    // A plain proxy request names a whole URL: refused as a CONNECT is.
    if (/^https?:/.test(req.url ?? '')) { refused.push(req.url!); res.writeHead(403); res.end(); return; }
    const path = (req.url ?? '/').split('?')[0]!;
    const api = path.endsWith('/messages') ? 'anthropic' : path.endsWith('/responses') ? 'responses' : path.endsWith('/chat/completions') ? 'chat' : undefined;
    if (req.method !== 'POST' || !api) {
      // A CLI's own reads (a model list, a health check): nothing a test scripts.
      res.writeHead(path.endsWith('/models') ? 200 : 404, { 'content-type': 'application/json' });
      res.end(JSON.stringify(path.endsWith('/models') ? { data: [], object: 'list' } : { error: { message: `no such route: ${path}` } }));
      return;
    }
    const body = await readBody(req);
    const turn = (o.isTurn ?? isTurn)(body);
    requests.push({ api, path, step: turn, body });
    const step: ModelStep = turn ? (queue.shift() ?? { fault: 'server-error', text: SCRIPT_ENDED }) : { text: SIDE_TEXT };
    const stream = body.stream === true;
    const answer = api === 'anthropic' ? anthropicAnswer(step, body, stream) : api === 'responses' ? responsesAnswer(step, body, stream) : chatAnswer(step, body, stream);
    await send(res, answer);
  };

  const server: Server = createServer((req, res) => {
    handle(req, res).catch((e: unknown) => {
      if (!res.headersSent) res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: String(e) } }));
    });
  });
  // The proxy: a CONNECT to anywhere is refused and recorded, so nothing leaves the machine.
  server.on('connect', (req: IncomingMessage, socket: Socket) => {
    refused.push(req.url ?? '');
    socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
  });
  // A CLI that drops its connection mid-answer (a cut, its own timeout) is no error of the server's.
  server.on('connection', (s: Socket) => { sockets.add(s); s.on('error', () => {}); s.on('close', () => sockets.delete(s)); });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    script(next) { queue = [...next]; },
    left: () => queue.length,
    requests,
    refused,
    close: () => new Promise<void>((resolve) => {
      for (const s of sockets) s.destroy();
      server.close(() => resolve());
    }),
  };
}
