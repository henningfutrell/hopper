// A draft probe (issue #474): before a draft, whether the provider the user picked can draft on the machine they picked
// — installed, signed in, the machine usable — and the models it lists there, against fake CLIs. It makes no model call
// and reads no login: of claude's status it takes only whether it is signed in, never the account it names.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { MachineSnapshot } from '../../src/domain/types.ts';
import { probeOn } from '../../src/drafting/probe.ts';
import type { DraftProvider } from '../../src/drafting/providers.ts';
import type { DraftHost } from '../../src/drafting/run.ts';
import { testSshAuth } from '../support/ssh.ts';

const FAKE = join(import.meta.dirname, 'fake-probe-cli.mjs');
const FAKE_SSH = join(import.meta.dirname, '..', 'herdr', 'fake-ssh-bin.mjs');

const HERE: MachineSnapshot = { id: 'local', label: 'local', maxLanes: 1, online: true, executors: [] };
const DESK: MachineSnapshot = { id: 'desk', label: 'desk', maxLanes: 1, online: true, executors: [], ssh: 'desk' };
const STUDIO: MachineSnapshot = { id: 'studio', label: 'studio', maxLanes: 1, online: true, executors: [], client: {} };

let dir: string;
const saved = { ...process.env };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'jh-draft-probe-'));
  Object.assign(process.env, { FAKE_PROBE_DIR: dir, FAKE_HERDR_DIR: dir });
  delete process.env.FAKE_PROBE_MODE;
});
afterEach(() => {
  process.env = { ...saved };
  rmSync(dir, { recursive: true, force: true });
});

function host(machines: MachineSnapshot[], over: Partial<DraftHost> = {}): DraftHost {
  return {
    machine: async (id) => machines.find((m) => m.id === id),
    client: (id) => (id === 'studio' ? ({} as ReturnType<DraftHost['client']>) : undefined),
    dataDir: dir, env: () => undefined, userEnv: {}, sshBin: FAKE_SSH, sshAuth: testSshAuth(join(dir, 'auth')), ...over,
  };
}

const probe = (provider: DraftProvider, machine = 'local', over: { bin?: string; timeoutMs?: number; host?: DraftHost } = {}) => {
  process.env.FAKE_PROBE_KIND = provider;
  return probeOn(over.host ?? host([HERE, DESK, STUDIO]), { provider, machine, bin: over.bin ?? FAKE, timeoutMs: over.timeoutMs ?? 10_000 }, new AbortController().signal);
};

const calls = (): { argv: string[]; stdin: string }[] =>
  readFileSync(join(dir, 'probe-calls.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { argv: string[]; stdin: string });

describe('probeOn: a provider signed in lists its models', () => {
  const MODELS: Record<DraftProvider, string[]> = {
    claude: ['opus', 'haiku'],
    codex: ['gpt-x', 'gpt-y'],
    'cursor-agent': ['auto', 'gpt-x', 'sonnet-x-thinking'],
    opencode: ['opencode/big-pickle', 'opencode/glm-flash-free', 'anthropic/claude-x'],
    omp: ['anthropic/claude-x', 'openai/gpt-x'],
  };
  for (const provider of ['claude', 'codex', 'cursor-agent', 'opencode', 'omp'] as const) {
    it(`${provider}: usable here, with the models it lists`, async () => {
      const r = await probe(provider);
      expect(r).toMatchObject({ usable: true });
      expect('models' in r && r.models.map((m) => m.value)).toEqual(MODELS[provider]);
      // A status and a model list, or a model list only: never a prompt.
      for (const c of calls()) expect(c.stdin).not.toContain('Answer with');
    });
  }

  it('labels come from the CLI: codex its display names, cursor-agent its names, omp its names; hidden codex models are left out', async () => {
    expect(await probe('codex')).toMatchObject({ models: [{ value: 'gpt-x', label: 'GPT-X', description: 'Frontier work.' }, { value: 'gpt-y', label: 'GPT-Y' }] });
    expect(await probe('cursor-agent')).toMatchObject({ models: [{ value: 'auto', label: 'Auto' }, { value: 'gpt-x', label: 'GPT-X' }, { value: 'sonnet-x-thinking', label: 'Sonnet X Thinking' }] });
    expect(await probe('omp')).toMatchObject({ models: [{ value: 'anthropic/claude-x', label: 'Claude X' }, { value: 'openai/gpt-x', label: 'GPT-X' }] });
  });

  it('claude: only whether it is signed in is read, never the account it names', async () => {
    const r = await probe('claude');
    expect(JSON.stringify(r)).not.toContain('example.com');
    expect(calls()[0]!.argv).toEqual(['auth', 'status', '--json']);
  });

  it('opencode: its model list runs standalone, with the draft\'s lockdown (opencode 2, issue #2862)', async () => {
    expect(await probe('opencode')).toMatchObject({ usable: true });
    expect(calls().map((c) => c.argv)).toEqual([['models', '--standalone']]);
  });

  it('a CLI that lists no models is still usable: it runs its own default', async () => {
    process.env.FAKE_PROBE_MODE = 'no-models';
    expect(await probe('codex')).toEqual({ usable: true, models: [] });
  });

  it('over ssh: the probe runs there, through the machine\'s connection', async () => {
    expect(await probe('codex', 'desk')).toMatchObject({ usable: true, models: [{ value: 'gpt-x' }, { value: 'gpt-y' }] });
    const ssh = readFileSync(join(dir, 'ssh-calls.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { argv: string[] });
    expect(ssh.map((s) => s.argv.at(-1))).toEqual([expect.stringMatching(/'login' 'status'$/), expect.stringMatching(/'debug' 'models'$/)]);
  });
});

describe('probeOn: why a provider cannot draft, in plain words', () => {
  it('not signed in: says so, and how to sign it in', async () => {
    process.env.FAKE_PROBE_MODE = 'signed-out';
    expect(await probe('claude')).toEqual({ usable: false, reason: 'claude is not signed in on this machine. Sign it in there (claude, then /login), then draft again.' });
    expect(await probe('codex')).toEqual({ usable: false, reason: 'codex is not signed in on this machine. Sign it in there (codex login), then draft again.' });
    expect(await probe('cursor-agent', 'desk')).toEqual({ usable: false, reason: 'cursor-agent is not signed in on machine desk. Sign it in there (cursor-agent login), then draft again.' });
  });

  it('not installed: says so', async () => {
    expect(await probe('omp', 'local', { bin: join(dir, 'no-such-omp') })).toEqual({ usable: false, reason: expect.stringMatching(/^omp is not installed on this machine/) });
    expect(await probe('codex', 'desk', { bin: join(dir, 'no-such-codex') })).toEqual({ usable: false, reason: expect.stringMatching(/^codex is not installed on machine desk/) });
  });

  it('a machine that cannot draft is refused before anything runs', async () => {
    expect(await probe('codex', 'desk', { host: host([{ ...DESK, online: false }]) })).toEqual({ usable: false, reason: 'machine desk is offline. Bring it back, or pick another machine.' });
    expect(await probe('codex', 'studio')).toEqual({ usable: false, reason: expect.stringMatching(/^machine studio is a joined machine/) });
    expect(await probe('codex', 'local', { host: host([HERE], { userEnv: { CLAUDE_CONFIG_DIR: dir } }) })).toEqual({ usable: false, reason: expect.stringMatching(/only your own claude login/) });
  });

  it('a probe past its timeout says so', async () => {
    process.env.FAKE_PROBE_MODE = 'hang';
    expect(await probe('opencode', 'local', { timeoutMs: 300 })).toEqual({ usable: false, reason: 'opencode on this machine: timed out after 300 ms' });
  });
});

describe('probeOn: client targets', () => {
  it('claude on a client dialled in is usable, unchecked: the client has no probe call', async () => {
    expect(await probe('claude', 'studio')).toEqual({ usable: true, models: [], unchecked: expect.stringMatching(/the draft itself says whether claude is signed in/) });
  });

  it('a client not dialled in says so', async () => {
    expect(await probe('claude', 'studio', { host: host([STUDIO], { client: () => undefined }) })).toEqual({ usable: false, reason: expect.stringMatching(/^machine studio: its client is not dialled in/) });
  });
});
