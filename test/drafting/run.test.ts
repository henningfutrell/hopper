// A draft run on the user's own AI CLI (issue #474): each provider — claude, codex, Cursor's agent, opencode, omp — run
// locked down on the machine the user picked, against fake CLIs. A valid draft comes back checked; an answer that is no
// draft, a CLI not signed in or not installed, an offline machine, a timeout and a cancel each end in plain words; a
// client target runs claude through its client and refuses the others; a stopped run is stopped on the machine too
// and leaves no run dir there (issue #472); a user added later runs claude with their own
// config dir, and is refused another CLI on this machine, which would run on someone else's login.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mintToken } from '../../src/client/signature.ts';
import type { MachineSnapshot } from '../../src/domain/types.ts';
import type { DraftProvider } from '../../src/drafting/providers.ts';
import { draftOn, type DraftChoice, type DraftHost } from '../../src/drafting/run.ts';
import { NOT_A_DRAFT } from '../../src/run-skills/draft.ts';
import { loadRunSkill } from '../../src/run-skills/index.ts';
import { startTestClient, type TestClient } from '../support/client.ts';
import { gone } from '../support/sweep.ts';
import { testSshAuth } from '../support/ssh.ts';

const FAKE_AGENT = join(import.meta.dirname, '..', 'adapters', 'fake-print-agent.mjs');
const FAKE_CURSOR = join(import.meta.dirname, '..', 'adapters', 'fake-cursor-agent.mjs');
const FAKE_CLAUDE = join(import.meta.dirname, '..', 'plugins', 'fake-claude.mjs');
const FAKE_SSH = join(import.meta.dirname, '..', 'herdr', 'fake-ssh-bin.mjs');
const TOKEN = mintToken();

const HERE: MachineSnapshot = { id: 'local', label: 'local', maxLanes: 1, online: true, executors: [] };
const DESK: MachineSnapshot = { id: 'desk', label: 'desk', maxLanes: 1, online: true, executors: [], ssh: 'desk' };
const STUDIO: MachineSnapshot = { id: 'studio', label: 'studio', maxLanes: 1, online: true, executors: [], client: {} };
const BOX: MachineSnapshot = { id: 'box', label: 'box', maxLanes: 1, online: true, executors: [], containerImage: 'box' };

const DRAFT = { title: 'Export button does nothing', body: '## Summary\n\nThe export button does nothing.', notes: 'rephrased' };
const input = { repo: 'acme/widgets', text: 'The export button does nothing.' };
const scope = { repos: ['acme/widgets'] };
const signal = () => new AbortController().signal;

let dir: string;
let tc: TestClient | undefined;
const saved = { ...process.env };

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'jh-drafting-'));
  mkdirSync(join(dir, 'claude-config'));
  Object.assign(process.env, {
    FAKE_AGENT_DIR: dir, FAKE_CURSOR_DIR: dir, FAKE_HERDR_DIR: dir, FAKE_CLAUDE_OUT: join(dir, 'claude.json'),
    FAKE_AGENT_REPLY: JSON.stringify(DRAFT), FAKE_CURSOR_REPLY: `\`\`\`json\n${JSON.stringify(DRAFT)}\n\`\`\``, FAKE_CLAUDE_STRUCTURED: JSON.stringify(DRAFT),
  });
  for (const k of ['FAKE_AGENT_MODE', 'FAKE_CURSOR_MODE', 'FAKE_CLAUDE_MODE']) delete process.env[k];
  tc = await startTestClient({ token: () => TOKEN, herdrBin: '/nonexistent/herdr', claudeBin: FAKE_CLAUDE, session: 'hopper' });
});
afterEach(async () => {
  await tc?.stop();
  tc = undefined;
  process.env = { ...saved };
  rmSync(dir, { recursive: true, force: true });
});

const BINS: Record<DraftProvider, string> = { claude: FAKE_CLAUDE, codex: FAKE_AGENT, 'cursor-agent': FAKE_CURSOR, opencode: FAKE_AGENT, omp: FAKE_AGENT };

function host(machines: MachineSnapshot[], over: Partial<DraftHost> = {}): DraftHost {
  return {
    machine: async (id) => machines.find((m) => m.id === id),
    client: (id) => (id === 'studio' ? tc!.transport(TOKEN, 'studio') : undefined),
    dataDir: dir, env: () => undefined, userEnv: {}, sshBin: FAKE_SSH, sshAuth: testSshAuth(join(dir, 'auth')), ...over,
  };
}

const pick = (provider: DraftProvider, machine = 'local', over: Partial<DraftChoice> = {}): DraftChoice => {
  if (provider !== 'claude' && provider !== 'cursor-agent') process.env.FAKE_AGENT_KIND = provider;
  return { provider, machine, bin: BINS[provider], timeoutMs: 10_000, ...over };
};

type Call = { argv: string[]; cwd: string; stdin?: string };
const lastCall = (provider: DraftProvider): Call => {
  if (provider === 'claude') return JSON.parse(readFileSync(join(dir, 'claude.json'), 'utf8')) as Call;
  const file = join(dir, provider === 'cursor-agent' ? 'cursor-calls.jsonl' : 'agent-calls.jsonl');
  return JSON.parse(readFileSync(file, 'utf8').trim().split('\n').at(-1)!) as Call;
};

/** The lockdown each CLI's argv must carry. */
const LOCKDOWN: Record<DraftProvider, string[]> = {
  claude: ['--no-session-persistence', '--strict-mcp-config', '--tools'],
  codex: ['exec', '--json', '--ephemeral', '--ignore-user-config', '--ignore-rules', '--sandbox', 'read-only'],
  'cursor-agent': ['-p', '--mode', 'ask', '--sandbox', 'enabled'],
  opencode: ['run', '--standalone', '--format', 'json', '--pure'],
  omp: ['-p', '--no-tools', '--no-session', '--no-skills', '--no-rules', '--no-extensions'],
};

describe('draftOn: each provider, locked down', () => {
  for (const provider of ['claude', 'codex', 'cursor-agent', 'opencode', 'omp'] as const) {
    it(`${provider}: the skill goes to it locked down, in a fresh dir removed after, and the draft comes back checked`, async () => {
      const r = await draftOn(host([HERE]), pick(provider), input, scope, signal());
      expect(r).toMatchObject({ draft: DRAFT, findings: [], skill: { name: 'file-issue', id: loadRunSkill('file-issue').id } });
      const call = lastCall(provider);
      expect(call.argv).toEqual(expect.arrayContaining(LOCKDOWN[provider]));
      const prompt = provider === 'claude' || provider === 'codex' || provider === 'opencode' ? call.stdin! : call.argv.at(-1)!;
      expect(prompt).toContain('The export button does nothing.');
      expect(prompt).toContain(loadRunSkill('file-issue').id);
      expect(call.cwd).not.toBe(dir);
      expect(existsSync(call.cwd)).toBe(false);
    });
  }

  it('over ssh: the same locked-down turn runs there, through the machine\'s connection', async () => {
    const r = await draftOn(host([DESK]), pick('codex', 'desk'), input, scope, signal());
    expect(r).toMatchObject({ draft: DRAFT });
    const ssh = JSON.parse(readFileSync(join(dir, 'ssh-calls.jsonl'), 'utf8').trim().split('\n').at(-1)!) as { argv: string[] };
    expect(ssh.argv.slice(ssh.argv.indexOf('--') + 1, -1)).toEqual(['desk.example']);
    expect(ssh.argv.at(-1)).toContain('--ephemeral');
  });

  it('a model and an effort go to the CLI in its own flags', async () => {
    await draftOn(host([HERE]), pick('codex', 'local', { model: 'gpt-x', effort: 'max' }), input, scope, signal());
    expect(lastCall('codex').argv).toEqual(expect.arrayContaining(['--model', 'gpt-x', '-c', 'model_reasoning_effort="xhigh"']));
    await draftOn(host([HERE]), pick('omp', 'local', { effort: 'high' }), input, scope, signal());
    expect(lastCall('omp').argv).toContain('--thinking=high');
    await draftOn(host([HERE]), pick('claude', 'local', { model: 'fable', effort: 'low' }), input, scope, signal());
    expect(lastCall('claude').argv).toEqual(expect.arrayContaining(['--model', 'fable', '--effort', 'low']));
  });
});

describe('draftOn: nothing of the run kept on the machine', () => {
  it('opencode: the session the run kept is deleted after it, with the same lockdown', async () => {
    expect(await draftOn(host([HERE]), pick('opencode'), input, scope, signal())).toMatchObject({ draft: DRAFT });
    const deleted = readFileSync(join(dir, 'opencode-deleted.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { id: string; env: Record<string, string> });
    expect(deleted).toEqual([{ id: 'ses_1', env: expect.objectContaining({ OPENCODE_PERMISSION: '{"*":"deny"}', OPENCODE_DISABLE_PROJECT_CONFIG: '1' }) }]);
  });

  it('opencode: a failed run\'s session is deleted too', async () => {
    process.env.FAKE_AGENT_MODE = 'error';
    expect(await draftOn(host([HERE]), pick('opencode'), input, scope, signal())).toMatchObject({ error: expect.any(String) });
    expect(readFileSync(join(dir, 'opencode-deleted.jsonl'), 'utf8')).toContain('"id":"ses_1"');
  });

  it('cursor-agent: its chat for the run dir is removed after, and its project data stays in the run dir', async () => {
    const config = join(dir, 'cursor-config');
    Object.assign(process.env, { CURSOR_CONFIG_DIR: config, FAKE_CURSOR_KEEP: '1' });
    expect(await draftOn(host([HERE]), pick('cursor-agent'), input, scope, signal())).toMatchObject({ draft: DRAFT });
    const call = lastCall('cursor-agent') as Call & { env: { CURSOR_DATA_DIR?: string } };
    expect(call.env.CURSOR_DATA_DIR).toBe(join(call.cwd, '.cursor-data'));
    expect(readdirSync(join(config, 'chats'))).toEqual([]);
    expect(existsSync(call.cwd)).toBe(false);
  });

  it('cursor-agent over ssh: the chat is removed there too', async () => {
    const config = join(dir, 'cursor-config');
    Object.assign(process.env, { CURSOR_CONFIG_DIR: config, FAKE_CURSOR_KEEP: '1' });
    expect(await draftOn(host([DESK]), pick('cursor-agent', 'desk'), input, scope, signal())).toMatchObject({ draft: DRAFT });
    expect(readdirSync(join(config, 'chats'))).toEqual([]);
  });
});

describe('draftOn: what goes wrong, in plain words', () => {
  it('an answer that is not a draft is refused', async () => {
    process.env.FAKE_AGENT_REPLY = 'Here is your issue: it is about the export button.';
    expect(await draftOn(host([HERE]), pick('omp'), input, scope, signal())).toEqual({ error: 'omp on this machine gave no draft: omp answered no JSON object' });
    process.env.FAKE_AGENT_REPLY = JSON.stringify({ title: 'x' });
    expect(await draftOn(host([HERE]), pick('codex'), input, scope, signal())).toEqual({ error: NOT_A_DRAFT });
    process.env.FAKE_CLAUDE_MODE = 'malformed';
    expect(await draftOn(host([HERE]), pick('claude'), input, scope, signal())).toEqual({ error: 'claude on this machine gave no draft: claude printed no JSON result' });
  });

  it('a CLI that is not signed in says so, and how to sign it in', async () => {
    process.env.FAKE_AGENT_MODE = 'error';
    expect(await draftOn(host([HERE]), pick('codex'), input, scope, signal())).toEqual({ error: 'codex is not signed in on this machine. Sign it in there (codex login), then draft again.' });
    expect(await draftOn(host([HERE]), pick('omp'), input, scope, signal())).toEqual({ error: 'omp is not signed in on this machine. Sign it in there (omp, then /login), then draft again.' });
    process.env.FAKE_CURSOR_MODE = 'exit1';
    expect(await draftOn(host([DESK]), pick('cursor-agent', 'desk'), input, scope, signal())).toEqual({ error: 'cursor-agent is not signed in on machine desk. Sign it in there (cursor-agent login), then draft again.' });
    process.env.FAKE_CLAUDE_MODE = 'exit1';
    expect(await draftOn(host([HERE]), pick('claude'), input, scope, signal())).toEqual({ error: expect.stringMatching(/^claude is not signed in on this machine/) });
  });

  it('a CLI that is not installed says so', async () => {
    expect(await draftOn(host([HERE]), pick('opencode', 'local', { bin: join(dir, 'no-such-opencode') }), input, scope, signal()))
      .toEqual({ error: expect.stringMatching(/^opencode is not installed on this machine/) });
  });

  it('an offline, unknown or container machine is refused before anything runs', async () => {
    expect(await draftOn(host([{ ...DESK, online: false }]), pick('codex', 'desk'), input, scope, signal())).toEqual({ error: 'machine desk is offline. Bring it back, or pick another machine.' });
    expect(await draftOn(host([]), pick('codex', 'desk'), input, scope, signal())).toEqual({ error: 'machine desk is not configured. Pick another machine.' });
    expect(await draftOn(host([BOX]), pick('claude', 'box'), input, scope, signal())).toEqual({ error: expect.stringMatching(/^machine box is a container target/) });
    expect(existsSync(join(dir, 'agent-calls.jsonl'))).toBe(false);
  });

  it('a run past its timeout is stopped, and says so', async () => {
    process.env.FAKE_AGENT_MODE = 'hang';
    expect(await draftOn(host([HERE]), pick('codex', 'local', { timeoutMs: 500 }), input, scope, signal())).toEqual({ error: 'codex on this machine: timed out after 500 ms' });
  });

  for (const [where, m, on] of [['this machine', HERE, 'this machine'], ['an ssh target', DESK, 'machine desk']] as const) {
    it(`a run stopped on ${where} is stopped there too, and leaves no run dir (issue #472)`, async () => {
      process.env.FAKE_AGENT_MODE = 'hang';
      expect(await draftOn(host([m]), pick('codex', m.id, { timeoutMs: 1500 }), input, scope, signal())).toEqual({ error: `codex on ${on}: timed out after 1500 ms` });
      const call = lastCall('codex') as Call & { sandbox: { pid: number } };
      // Killed, it can stay a zombie a moment, until its new parent reaps it.
      await expect.poll(() => gone(call.sandbox.pid), { timeout: 2000 }).toBe(true);
      expect(existsSync(call.cwd)).toBe(false);
    });
  }

  it('a cancelled run is stopped, and says so', async () => {
    process.env.FAKE_AGENT_MODE = 'hang';
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 300);
    expect(await draftOn(host([HERE]), pick('opencode'), input, scope, ac.signal)).toEqual({ error: 'opencode on this machine: cancelled' });
  });
});

describe('draftOn: client machines and users added later', () => {
  it('a client target drafts with claude through its client, locked down, the prompt on stdin', async () => {
    const r = await draftOn(host([STUDIO]), pick('claude', 'studio'), input, scope, signal());
    expect(r).toMatchObject({ draft: DRAFT, model: 'claude-opus-resolved' });
    const call = lastCall('claude');
    expect(call.argv.slice(-2)).toEqual(['--tools', '']);
    expect(call.stdin).toContain('The export button does nothing.');
  });

  it('a client target refuses another CLI, and a client not dialled in says so', async () => {
    expect(await draftOn(host([STUDIO]), pick('codex', 'studio'), input, scope, signal())).toEqual({ error: expect.stringMatching(/^machine studio is a joined machine: its client runs only claude/) });
    expect(await draftOn(host([STUDIO], { client: () => undefined }), pick('claude', 'studio'), input, scope, signal())).toEqual({ error: expect.stringMatching(/^machine studio: its client is not dialled in/) });
  });

  it('a user added later runs claude here with their own config dir, and no other CLI here', async () => {
    // A user added later keeps only the machine's variables of the daemon's: the fakes' own go with their dirs.
    const fakes = { FAKE_CLAUDE_OUT: process.env.FAKE_CLAUDE_OUT!, FAKE_CLAUDE_STRUCTURED: process.env.FAKE_CLAUDE_STRUCTURED! };
    const userEnv = { CLAUDE_CONFIG_DIR: join(dir, 'claude-config'), GH_CONFIG_DIR: join(dir, 'gh'), ...fakes };
    expect(await draftOn(host([HERE], { userEnv }), pick('claude'), input, scope, signal())).toMatchObject({ draft: DRAFT });
    const env = (JSON.parse(readFileSync(join(dir, 'claude.json'), 'utf8')) as { env: Record<string, string> }).env;
    expect(env.CLAUDE_CONFIG_DIR).toBe(userEnv.CLAUDE_CONFIG_DIR);
    expect(await draftOn(host([HERE], { userEnv }), pick('codex'), input, scope, signal())).toEqual({ error: expect.stringMatching(/only your own claude login: codex here would run on another account/) });
    expect(await draftOn(host([DESK], { userEnv }), pick('codex', 'desk'), input, scope, signal())).toMatchObject({ draft: DRAFT });
  });
});
