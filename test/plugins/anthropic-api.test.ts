// The escalation level that answers through the Claude API with an API key the runtime gives —
// `anthropic-api` (issue #150): a hopper with no claude CLI (the container) can still settle
// questions below the owner. Against a fake Messages API on loopback; never a real URL.
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AnswerRequest } from '../../src/domain/ports.ts';
import type { Question } from '../../src/domain/types.ts';
import anthropicApi from '../../src/plugins/escalation-level/anthropic-api/index.ts';
import { optionsJsonSchema, parseOptions } from '../../src/plugins/options.ts';
import { fakeKit, fixedClock } from './support.ts';

interface Seen { headers: IncomingMessage['headers']; body: Record<string, unknown> }

let server: Server;
let url: string;
let seen: Seen[];
/** What the fake API answers next: status and JSON body, or `hang`. */
let reply: { status: number; body: unknown } | 'hang';

const message = (text: string, over: Record<string, unknown> = {}) => ({
  id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5-5', stop_reason: 'end_turn', stop_sequence: null,
  content: [{ type: 'text', text }], usage: { input_tokens: 1, output_tokens: 1 }, ...over,
});

beforeEach(async () => {
  seen = [];
  reply = { status: 200, body: message(JSON.stringify({ answer: 'use sqlite', escalate: false, reason: 'the rules say so' })) };
  server = createServer((req, res) => {
    let raw = '';
    req.setEncoding('utf8').on('data', (c: string) => { raw += c; });
    req.on('end', () => {
      seen.push({ headers: req.headers, body: JSON.parse(raw) as Record<string, unknown> });
      if (reply === 'hang') return;
      res.writeHead(reply.status, { 'content-type': 'application/json' }).end(JSON.stringify(reply.body));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
});

const question = {
  id: 'q1', jobId: 'j1', text: 'Which database should I use?', recentOutput: 'need a db',
  detectedBy: 'marker', status: 'open', tier: 'api', attempts: [], notifyCount: 0, createdAt: '', updatedAt: '',
} as Question;
const req: AnswerRequest = { question, jobPrompt: 'Build the invoicing service', rules: 'RULE: prefer sqlite', previous: [], level: { number: 1, of: 1 } };
const signal = () => new AbortController().signal;

function opts(raw: Record<string, unknown>): never {
  const p = parseOptions(anthropicApi, raw);
  if (!p.ok) throw new Error(p.error);
  return p.options as never;
}
const env = (vars: Record<string, string>) => (n: string): string | undefined => vars[n];
const level = (raw: Record<string, unknown> = {}, vars: Record<string, string> = { ANTHROPIC_API_KEY: 'test-key' }) => anthropicApi.create({
  clock: fixedClock, logger: { info() {}, warn() {} }, dataDir: '/nonexistent', userEnv: {}, secretName: (n: string) => n, scratchDir: '/nonexistent', instanceName: 'api',
  env: env(vars), machine: async () => undefined, machines: async () => [], escalationMachine: () => undefined, client: () => undefined,
}, opts({ baseUrl: url, timeoutMs: 5000, ...raw }));

describe('anthropic-api (escalation level)', () => {
  it('options: model (default claude-opus-5-5), apiKeyEnv and baseUrl command-bearing, timeoutMs, effort', () => {
    expect(anthropicApi).toMatchObject({ id: 'anthropic-api', role: 'escalation-level' });
    expect(parseOptions(anthropicApi, {})).toEqual({ ok: true, options: { model: 'claude-opus-5-5', apiKeyEnv: 'ANTHROPIC_API_KEY', timeoutMs: 180_000 } });
    expect(parseOptions(anthropicApi, { effort: 'enormous' }).ok).toBe(false);
    const schema = optionsJsonSchema(anthropicApi) as { properties: Record<string, { commandBearing?: boolean }> };
    expect(schema.properties.apiKeyEnv!.commandBearing).toBe(true);
    expect(schema.properties.baseUrl!.commandBearing).toBe(true);
    expect(schema.properties.model!.commandBearing).toBeUndefined();
  });

  it('asks once with the key from the runtime, the reply schema, and the question on the prompt; answers with the model that ran', async () => {
    expect(await (await level({ effort: 'low' })).answer(req, signal())).toEqual({ answer: 'use sqlite', escalate: false, reason: 'the rules say so', model: 'claude-opus-5-5' });
    expect(seen).toHaveLength(1);
    const [{ headers, body }] = seen as [Seen];
    expect(headers['x-api-key']).toBe('test-key');
    expect(body).toMatchObject({
      model: 'claude-opus-5-5',
      output_config: { effort: 'low', format: { type: 'json_schema', schema: { required: ['answer', 'escalate', 'reason'] } } },
    });
    const prompt = JSON.stringify(body.messages);
    for (const s of ['RULE: prefer sqlite', 'Build the invoicing service', 'Which database should I use?', 'escalation level 1 of 1']) expect(prompt).toContain(s);
  });

  it('the key variable is an option: another name, or its mounted file through the runtime', async () => {
    await (await level({ apiKeyEnv: 'TEAM_KEY' }, { TEAM_KEY: 'team' })).answer(req, signal());
    expect(seen[0]!.headers['x-api-key']).toBe('team');
  });

  it.each([
    ['no key in the runtime', () => level({}, {}), /ANTHROPIC_API_KEY/],
    ['an API error', () => { reply = { status: 401, body: { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } } }; return level(); }, /401/],
    ['a refusal', () => { reply = { status: 200, body: message('', { stop_reason: 'refusal', content: [] }) }; return level(); }, /refus/],
    ['a reply off the schema', () => { reply = { status: 200, body: message('{"answer":"x"}') }; return level(); }, /invalid|missing/i],
    ['a timeout', () => { reply = 'hang'; return level({ timeoutMs: 300 }); }, /tim/i],
  ])('%s returns { error }: the question escalates', async (_n, make, why) => {
    expect(await (await make()).answer(req, signal())).toEqual({ error: expect.stringMatching(why) });
  });

  it('abort returns { error }', async () => {
    reply = 'hang';
    const ac = new AbortController();
    const p = (await level({ timeoutMs: 10_000 })).answer(req, ac.signal);
    setTimeout(() => ac.abort('cancel'), 200);
    expect(await p).toEqual({ error: expect.stringMatching(/abort/i) });
  });
});

describe('detection: the key is there, never a model call', () => {
  it('available when the runtime gives the key; unavailable naming the variable when not', async () => {
    expect(await anthropicApi.detect(fakeKit({ env: (n) => (n === 'ANTHROPIC_API_KEY' ? 'k' : undefined) }), opts({}))).toEqual({
      status: 'available', detail: 'claude-opus-5-5 with the key in ANTHROPIC_API_KEY',
    });
    expect(await anthropicApi.detect(fakeKit({ env: () => undefined }), opts({}))).toEqual({
      status: 'unavailable', reason: 'no API key: set ANTHROPIC_API_KEY or ANTHROPIC_API_KEY_FILE',
    });
  });
});
