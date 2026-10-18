// The fake model server (issue #1958) on its own: each API's answer to a step, streamed and not, each fault, the side
// call that takes no step, and the proxy that refuses the rest. The real CLIs' run against it is test/acceptance/.
import { request } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { startFakeModelServer, type FakeModelServer } from './fake-model-server.ts';

let server: FakeModelServer;
afterEach(() => server.close());

const TOOLS = [{ name: 'Bash', type: 'function' }];
const post = (path: string, body: object) =>
  fetch(`${server.url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

/** The data of each server-sent event, parsed where it parses, else as it came. */
async function events(r: Response): Promise<unknown[]> {
  const text = await r.text();
  return text.split('\n\n').map((e) => e.split('\n').find((l) => l.startsWith('data: '))?.slice(6)).filter((d): d is string => d !== undefined)
    .map((d) => { try { return JSON.parse(d) as unknown; } catch { return d; } });
}

describe('the Anthropic Messages API', () => {
  it('streams a text step as text deltas, then a tool step as a tool_use block', async () => {
    server = await startFakeModelServer([{ text: 'Hello there, friend.' }, { tool: { name: 'Bash', input: { command: 'ls' } } }]);
    const first = await events(await post('/v1/messages', { model: 'm', stream: true, tools: TOOLS }));
    const text = first.filter((e) => (e as { delta?: { type: string } }).delta?.type === 'text_delta').map((e) => (e as { delta: { text: string } }).delta.text).join('');
    expect(text).toBe('Hello there, friend.');
    expect(first.at(-2)).toMatchObject({ type: 'message_delta', delta: { stop_reason: 'end_turn' } });
    const second = await events(await post('/v1/messages', { model: 'm', stream: true, tools: TOOLS }));
    expect(second).toContainEqual(expect.objectContaining({ type: 'content_block_start', content_block: expect.objectContaining({ type: 'tool_use', name: 'Bash' }) }));
    expect(second).toContainEqual(expect.objectContaining({ delta: { type: 'input_json_delta', partial_json: '{"command":"ls"}' } }));
    expect(server.left()).toBe(0);
  });

  it('answers a side call (no tools) with a short text and takes no step', async () => {
    server = await startFakeModelServer([{ text: 'the step' }]);
    const r = await post('/v1/messages', { model: 'm', max_tokens: 1 });
    expect(await r.json()).toMatchObject({ type: 'message', content: [{ type: 'text', text: 'ok' }] });
    expect(server.left()).toBe(1);
    expect(server.requests).toMatchObject([{ api: 'anthropic', step: false }]);
  });

  it('answers 429 and 529 as the API does, and 500 once the script ends', async () => {
    server = await startFakeModelServer([{ fault: 'rate-limited' }, { fault: 'overloaded' }]);
    const limited = await post('/v1/messages', { tools: TOOLS });
    expect(limited.status).toBe(429);
    expect(await limited.json()).toMatchObject({ type: 'error', error: { type: 'rate_limit_error' } });
    const overloaded = await post('/v1/messages', { tools: TOOLS });
    expect(overloaded.status).toBe(529);
    expect(await overloaded.json()).toMatchObject({ error: { type: 'overloaded_error' } });
    const ended = await post('/v1/messages', { tools: TOOLS });
    expect(ended.status).toBe(500);
    expect(JSON.stringify(await ended.json())).toContain('the script has no step left');
  });

  it('a malformed event takes the place of a delta, and a body asked for whole is not JSON', async () => {
    server = await startFakeModelServer([{ fault: 'malformed', text: 'one two three four five' }, { fault: 'malformed', text: 'x' }]);
    const streamed = await events(await post('/v1/messages', { stream: true, tools: TOOLS }));
    expect(streamed.filter((e) => typeof e === 'string')).toHaveLength(1);
    const deltas = streamed.filter((e) => (e as { delta?: { type: string } }).delta?.type === 'text_delta').map((e) => (e as { delta: { text: string } }).delta.text).join('');
    expect(deltas).not.toBe('one two three four five');
    const whole = await post('/v1/messages', { tools: TOOLS });
    await expect(whole.json()).rejects.toThrow();
  });

  it('a cut stream ends after its first delta, with no message_stop', async () => {
    server = await startFakeModelServer([{ fault: 'cut', text: 'a long answer that never ends' }]);
    const r = await post('/v1/messages', { stream: true, tools: TOOLS });
    await expect(r.text()).rejects.toThrow();
  });

  it('slow tokens wait between the events', async () => {
    server = await startFakeModelServer([{ text: 'sixteen chars ok', delayMs: 40 }]);
    const t = Date.now();
    await events(await post('/v1/messages', { stream: true, tools: TOOLS }));
    expect(Date.now() - t).toBeGreaterThanOrEqual(40 * 6);
  });
});

describe('the OpenAI APIs', () => {
  it('Responses: streams the text deltas and the whole item, then response.completed', async () => {
    server = await startFakeModelServer([{ text: 'Hello there.' }, { tool: { name: 'exec_command', input: { cmd: 'ls' } } }]);
    const first = await events(await post('/v1/responses', { model: 'm', stream: true, tools: TOOLS }));
    expect(first.filter((e) => (e as { type: string }).type === 'response.output_text.delta').map((e) => (e as { delta: string }).delta).join('')).toBe('Hello there.');
    expect(first).toContainEqual(expect.objectContaining({ type: 'response.output_item.done', item: expect.objectContaining({ type: 'message' }) }));
    expect(first.at(-1)).toMatchObject({ type: 'response.completed', response: { status: 'completed' } });
    const second = await events(await post('/v1/responses', { model: 'm', stream: true, tools: TOOLS }));
    expect(second).toContainEqual(expect.objectContaining({ item: expect.objectContaining({ type: 'function_call', name: 'exec_command', arguments: '{"cmd":"ls"}' }) }));
  });

  it('Chat Completions: streams content chunks, a tool call, and [DONE]', async () => {
    server = await startFakeModelServer([{ text: 'Hi.' }, { tool: { name: 'bash', input: { command: 'ls' } } }]);
    const first = await events(await post('/v1/chat/completions', { model: 'm', stream: true, tools: TOOLS }));
    expect(first.at(-1)).toBe('[DONE]');
    expect(first).toContainEqual(expect.objectContaining({ choices: [expect.objectContaining({ finish_reason: 'stop' })] }));
    const second = await post('/v1/chat/completions', { model: 'm', tools: TOOLS });
    expect(await second.json()).toMatchObject({ choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [{ function: { name: 'bash', arguments: '{"command":"ls"}' } }] } }] });
  });

  it('answers 429 and 503 as the API does', async () => {
    server = await startFakeModelServer([{ fault: 'rate-limited' }, { fault: 'overloaded' }]);
    expect((await post('/v1/responses', { tools: TOOLS })).status).toBe(429);
    expect((await post('/v1/chat/completions', { tools: TOOLS })).status).toBe(503);
  });
});

describe('the proxy', () => {
  it('refuses a CONNECT to anywhere and records the host', async () => {
    server = await startFakeModelServer();
    const { port, hostname } = new URL(server.url);
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const req = request({ host: hostname, port, method: 'CONNECT', path: 'api.example.com:443' });
      req.on('connect', (res, socket) => { socket.destroy(); resolve(res.statusCode); });
      req.on('error', reject);
      req.end();
    });
    expect(status).toBe(403);
    expect(server.refused).toEqual(['api.example.com:443']);
  });
});
