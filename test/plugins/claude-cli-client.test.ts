// claude-cli on a client target (issue #482): the level runs through the client (`POST /level`), which runs
// its own claude locked down. The level that names the client, and the level that names none where the
// client is the only machine that can run it (a container hopper: no `local`, no ssh), answer; the trail
// says which machine and why. A container target is still refused. The client is real; claude is the fake.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mintToken } from '../../src/client/signature.ts';
import type { AnswerRequest } from '../../src/domain/ports.ts';
import type { MachineSnapshot, Question } from '../../src/domain/types.ts';
import { WHY_JOB, WHY_ONLY } from '../../src/domain/machine-pick.ts';
import claudeCli from '../../src/plugins/escalation-level/claude-cli/index.ts';
import { parseOptions } from '../../src/plugins/options.ts';
import { startTestClient, type TestClient } from '../support/client.ts';
import { fixedClock } from './support.ts';

const CLAUDE = join(import.meta.dirname, 'fake-claude.mjs');
const TOKEN = mintToken();
const STUDIO: MachineSnapshot = { id: 'studio', label: 'studio', maxLanes: 1, online: true, executors: ['herdr-claude'], client: {} };
const DESK: MachineSnapshot = { id: 'desk', label: 'desk', maxLanes: 1, online: true, executors: ['herdr-claude'], ssh: 'desk.example' };
const BOX: MachineSnapshot = { id: 'box', label: 'box', maxLanes: 1, online: true, executors: [], docker: 'box' };

const question = { id: 'q1', jobId: 'j1', text: 'Which database?', recentOutput: '', detectedBy: 'marker', status: 'open', tier: 'level-1', attempts: [], notifyCount: 0, createdAt: '', updatedAt: '' } as Question;
const req = (over: Partial<AnswerRequest> = {}): AnswerRequest => ({ question, jobPrompt: 'Build it', jobGoal: 'it', rules: 'RULE: prefer sqlite', previous: [], level: { number: 1, of: 2 }, ...over });
const signal = () => new AbortController().signal;

let dir: string;
let tc: TestClient | undefined;
const saved = { ...process.env };

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'jh-cli-client-'));
  process.env.FAKE_CLAUDE_OUT = join(dir, 'rec.json');
  process.env.FAKE_CLAUDE_STRUCTURED = JSON.stringify({ answer: 'use sqlite', escalate: false, reason: 'rules', confidence: 'high' });
  delete process.env.FAKE_CLAUDE_MODE;
  tc = await startTestClient({ token: () => TOKEN, herdrBin: '/nonexistent/herdr', claudeBin: CLAUDE, session: 'hopper' });
});
afterEach(async () => {
  await tc?.stop();
  tc = undefined;
  process.env = { ...saved };
  rmSync(dir, { recursive: true, force: true });
});

async function level(raw: Record<string, unknown>, machines: MachineSnapshot[], o: { dialledIn?: boolean } = {}) {
  const p = parseOptions(claudeCli, { bin: '/nonexistent/claude', ...raw });
  if (!p.ok) throw new Error(p.error);
  return claudeCli.create({
    clock: fixedClock, logger: { info() {}, warn() {} }, dataDir: dir, userEnv: {}, secretName: (n: string) => n, scratchDir: join(dir, 'scratch'), instanceName: 'level-1',
    env: () => undefined, machine: async (id: string) => machines.find((m) => m.id === id), machines: async () => machines, escalationMachine: () => undefined,
    client: (id: string) => (id === 'studio' && o.dialledIn !== false ? tc!.transport(TOKEN, 'studio') : undefined),
  }, p.options as never);
}

const rec = () => JSON.parse(readFileSync(join(dir, 'rec.json'), 'utf8')) as { argv: string[]; stdin: string };

describe('claude-cli on a client target (issue #482)', () => {
  it('a level that names the client: answered by the client\'s claude, locked down, the prompt on stdin', async () => {
    const reply = await (await level({ machine: 'studio' }, [STUDIO])).answer(req(), signal());
    expect(reply).toEqual({ answer: 'use sqlite', escalate: false, reason: 'rules', confidence: 'high', model: 'claude-opus-resolved' });
    expect(rec().argv.slice(0, 3)).toEqual(['-p', '--model', 'opus']);
    expect(rec().argv.slice(-2)).toEqual(['--tools', '']);
    expect(rec().stdin).toContain('Which database?');
  });

  it('a container hopper whose only machine is the client, the level naming none: the client is picked, and the reply says so', async () => {
    const reply = await (await level({}, [STUDIO])).answer(req(), signal());
    expect(reply).toMatchObject({ answer: 'use sqlite', machine: { id: 'studio', why: WHY_ONLY } });
  });

  it('an ssh machine and the client: the job\'s machine is picked, and the reply says which and why', async () => {
    const reply = await (await level({}, [DESK, STUDIO])).answer(req({ jobMachine: 'studio' }), signal());
    expect(reply).toMatchObject({ answer: 'use sqlite', machine: { id: 'studio', why: WHY_JOB } });
  });

  it('the client offline, or not dialled in: the level does not run, and says why in plain words', async () => {
    expect(await (await level({ machine: 'studio' }, [{ ...STUDIO, online: false }])).answer(req(), signal())).toEqual({ error: expect.stringMatching(/^machine studio is offline/) });
    expect(await (await level({ machine: 'studio' }, [STUDIO], { dialledIn: false })).answer(req(), signal())).toEqual({ error: expect.stringMatching(/^machine studio: client studio is not dialled in/) });
  });

  it('a run past the level\'s timeout is killed on the client and reported as a timeout', async () => {
    process.env.FAKE_CLAUDE_MODE = 'hang';
    expect(await (await level({ machine: 'studio', timeoutMs: 500 }, [STUDIO])).answer(req(), signal())).toEqual({ error: 'machine studio: claude timed out after 500 ms' });
  });

  it('a container target is still refused, with how to fix it', async () => {
    expect(await (await level({ machine: 'box' }, [BOX])).answer(req(), signal())).toEqual({ error: expect.stringMatching(/machine box is a container target: .*Pick another machine/) });
  });
});
