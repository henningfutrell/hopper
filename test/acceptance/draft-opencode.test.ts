// Issue #2862: a draft on the real opencode CLI (opencode 2), through the real draft run, against the fake model server on
// loopback with a dummy key. The draft comes back, and a tool call the model makes in that turn is refused by the
// draft's lockdown, even with the user's own config allowing every tool. opencode not installed here skips.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MachineSnapshot } from '../../src/domain/types.ts';
import { draftOn, type DraftHost } from '../../src/drafting/run.ts';
import { startFakeModelServer, type FakeModelServer } from '../support/fake-model-server.ts';
import { REAL_AGENTS, realBin } from '../support/real-agents.ts';

const HERE: MachineSnapshot = { id: 'local', label: 'local', maxLanes: 1, online: true, executors: [] };
const DRAFT = { title: 'Export button does nothing', body: '## Summary\n\nThe export button does nothing.', notes: 'rephrased' };
const TURN_MS = 90_000;
const bin = realBin('opencode');
const opencode = REAL_AGENTS.find((a) => a.agent === 'opencode')!;

let server: FakeModelServer;
const saved = { ...process.env };

beforeAll(async () => {
  // Locked down, opencode offers the model no tools, so the conversation's requests are told apart by their system
  // prompt: opencode's title calls have another one, which changes between releases (2.1.2 and 2.1.4 differ).
  server = await startFakeModelServer([], { isTurn: (body) => String(body.instructions ?? '').includes('running in OpenCode') });
  // The user's own config, in the test's HOME: the fake server as the provider, and every tool allowed.
  const config = JSON.parse(opencode.env(server.url).OPENCODE_CONFIG_CONTENT!) as Record<string, unknown>;
  const dir = join(process.env.XDG_CONFIG_HOME!, 'opencode');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'opencode.json'), JSON.stringify({ ...config, permission: { '*': 'allow' } }));
  const { OPENCODE_CONFIG_CONTENT: _content, ...env } = opencode.env(server.url);
  Object.assign(process.env, env);
});
afterAll(async () => {
  process.env = { ...saved };
  await server.close();
});

const host: DraftHost = { machine: async (id) => (id === HERE.id ? HERE : undefined), client: () => undefined, dataDir: process.env.HOME!, env: () => undefined, userEnv: {} };

describe('a draft on the real opencode CLI', () => {
  it.skipIf(!bin)('returns the draft, and a tool call in its turn is refused', async () => {
    const file = join(process.env.HOME!, 'pwned.txt');
    server.script([opencode.write(file, 'pwned'), { text: JSON.stringify(DRAFT) }]);
    const from = server.requests.length;
    const r = await draftOn(host, { provider: 'opencode', machine: 'local', bin: bin!, model: opencode.model, timeoutMs: TURN_MS },
      { repo: 'acme/widgets', text: 'The export button does nothing.' }, { repos: ['acme/widgets'] }, new AbortController().signal);
    expect(r).toMatchObject({ draft: DRAFT });
    expect(existsSync(file)).toBe(false);
    // The model was told the tool call was refused: its result, an error, came back in the next request. Locked down,
    // opencode offers no tool at all, so the call names one it does not have.
    const outputs = server.requests.slice(from).flatMap((q) => (Array.isArray(q.body.input) ? q.body.input as Record<string, unknown>[] : []))
      .filter((i) => i.type === 'function_call_output').map((i) => String(i.output));
    expect(outputs).toEqual([expect.stringMatching(/"error".*No tool named \\"shell\\" is currently available/)]);
    expect(server.requests.filter((q) => q.step).every((q) => !Array.isArray(q.body.tools) || q.body.tools.length === 0)).toBe(true);
    expect(server.left()).toBe(0);
  }, TURN_MS * 2);
});
