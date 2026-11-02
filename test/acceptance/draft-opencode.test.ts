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
const CANARY = 'skill-text-the-draft-must-not-read';
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
  // A skill of the user's: its text must not reach the draft's turn, though opencode 2.2 offers its skill tool even when denied.
  for (const skills of ['skill', 'skills']) {
    mkdirSync(join(dir, skills, 'canary'), { recursive: true });
    writeFileSync(join(dir, skills, 'canary', 'SKILL.md'), `---\nname: canary\ndescription: a test skill\n---\n${CANARY}\n`);
  }
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
    server.script([opencode.write(file, 'pwned'), { tool: { name: 'skill', input: { id: 'canary' } } }, { text: JSON.stringify(DRAFT) }]);
    const from = server.requests.length;
    const r = await draftOn(host, { provider: 'opencode', machine: 'local', bin: bin!, model: opencode.model, timeoutMs: TURN_MS },
      { repo: 'acme/widgets', text: 'The export button does nothing.' }, { repos: ['acme/widgets'] }, new AbortController().signal);
    expect(r).toMatchObject({ draft: DRAFT });
    expect(existsSync(file)).toBe(false);
    // The model was told each tool call was refused: its result, an error, came back in the next request. Locked down,
    // opencode offers no tool that acts, so the shell call names one it does not have. opencode 2.2.5 offers its skill tool
    // whatever the config says: its call is refused too, and the skill's text never comes back.
    const outputs = server.requests.slice(from).flatMap((q) => (Array.isArray(q.body.input) ? q.body.input as Record<string, unknown>[] : []))
      .filter((i) => i.type === 'function_call_output').map((i) => String(i.output));
    expect(outputs.find((o) => o.includes('shell'))).toMatch(/"error".*No tool named \\"shell\\" is currently available/);
    expect(outputs.length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(server.requests.slice(from).map((q) => q.body))).not.toContain(CANARY);
    const offered = server.requests.filter((q) => q.step).flatMap((q) => (Array.isArray(q.body.tools) ? q.body.tools as { name?: string }[] : [])).map((t) => t.name);
    expect(offered.filter((t) => t !== 'skill')).toEqual([]);
    if (offered.includes('skill')) expect(outputs.at(-1)).toMatch(/Permission denied: skill/);
    expect(server.left()).toBe(0);
  }, TURN_MS * 2);
});
