// The built-in escalation level that runs the `claude` CLI in print mode — `claude-cli` — against a
// fake `claude` executable. It runs locked down: no tools, no MCP, no settings, no session,
// schema-bound output, env scrubbed of the Claude Code markers.
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AnswerRequest } from '../../src/domain/ports.ts';
import type { MachineSnapshot, Question } from '../../src/domain/types.ts';
import claudeCli from '../../src/plugins/escalation-level/claude-cli/index.ts';
import { optionsJsonSchema, parseOptions } from '../../src/plugins/options.ts';
import { testSshAuth } from '../support/ssh.ts';
import { fakeKit, fixedClock } from './support.ts';

const BIN = join(import.meta.dirname, 'fake-claude.mjs');
let dir: string;
let out: string;
const saved: Record<string, string | undefined> = {};
const KEYS = ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SESSION', 'FAKE_CLAUDE_OUT', 'FAKE_CLAUDE_MODE', 'FAKE_CLAUDE_STRUCTURED', 'KEEP_ME'];

beforeEach(() => {
  for (const k of KEYS) saved[k] = process.env[k];
  dir = mkdtempSync(join(tmpdir(), 'jh-claude-'));
  out = join(dir, 'rec.json');
  process.env.FAKE_CLAUDE_OUT = out;
  process.env.CLAUDECODE = '1';
  process.env.CLAUDE_CODE_ENTRYPOINT = 'cli';
  process.env.CLAUDE_CODE_SESSION = 'abc';
  process.env.KEEP_ME = 'yes';
  delete process.env.FAKE_CLAUDE_MODE;
  delete process.env.FAKE_CLAUDE_STRUCTURED;
});
afterEach(() => {
  for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});

const question = {
  id: 'q1', jobId: 'j1', text: 'Which database should I use?', recentOutput: 'building schema\nneed a db',
  detectedBy: 'marker', status: 'open', tier: 'opus', attempts: [], notifyCount: 0, createdAt: '', updatedAt: '',
} as Question;
const req = (over: Partial<AnswerRequest> = {}): AnswerRequest => ({
  question, jobPrompt: 'Build the invoicing service', jobGoal: 'invoicing', rules: 'RULE: prefer sqlite', previous: [], level: { number: 1, of: 2 }, ...over,
});
const ctx = () => ({ clock: fixedClock, logger: { info() {}, warn() {} }, dataDir: dir, scratchDir: join(dir, 'scratch'), instanceName: 'opus', env: (_n: string): string | undefined => undefined, machine: async (): Promise<MachineSnapshot | undefined> => undefined });
const signal = () => new AbortController().signal;
const rec = () => JSON.parse(readFileSync(out, 'utf8')) as { argv: string[]; stdin: string; env: Record<string, string>; cwd: string };

/** The plugin's options as the core validates them (defaults applied). */
function opts(def: typeof claudeCli, raw: Record<string, unknown>): never {
  const p = parseOptions(def, raw);
  if (!p.ok) throw new Error(p.error);
  return p.options as never;
}
const level = (raw: Record<string, unknown> = {}) => claudeCli.create(ctx(), opts(claudeCli, { bin: BIN, timeoutMs: 5000, ...raw }));

/** argv with the --json-schema value replaced, and the parsed schema. */
function argvAndSchema(): { argv: string[]; schema: Record<string, unknown> } {
  const { argv } = rec();
  const at = argv.indexOf('--json-schema') + 1;
  return { argv: argv.map((a, i) => (i === at ? '<schema>' : a)), schema: JSON.parse(argv[at]!) as Record<string, unknown> };
}

const LOCKDOWN_TAIL = ['--no-session-persistence', '--setting-sources', '', '--strict-mcp-config', '--tools', ''];

describe('claude-cli (escalation level)', () => {
  it('is an escalation level; options bin, model (default opus), timeoutMs, effort (optional)', async () => {
    expect(claudeCli).toMatchObject({ id: 'claude-cli', role: 'escalation-level' });
    expect(parseOptions(claudeCli, {})).toEqual({ ok: true, options: { bin: 'claude', model: 'opus', timeoutMs: 180_000, sshBin: 'ssh' } });
    expect(parseOptions(claudeCli, { effort: 'high' })).toMatchObject({ ok: true, options: { effort: 'high' } });
    expect(parseOptions(claudeCli, { effort: 'enormous' }).ok).toBe(false);
  });

  it('spawns locked down with the reply schema { answer, escalate, reason }, --tools "" last, in the data dir', async () => {
    await (await level()).answer(req(), signal());
    const { argv, schema } = argvAndSchema();
    expect(argv).toEqual(['-p', '--model', 'opus', '--output-format', 'json', '--json-schema', '<schema>', ...LOCKDOWN_TAIL]);
    // Literal draft-07 shape: the claude CLI rejects a `$schema` it does not know.
    expect(schema).toEqual({
      type: 'object',
      properties: { answer: { type: 'string' }, escalate: { type: 'boolean' }, reason: { type: 'string' } },
      required: ['answer', 'escalate', 'reason'],
      additionalProperties: false,
    });
    expect(rec().cwd).toBe(dir);
  });

  it('passes --effort when set, before the lockdown flags', async () => {
    await (await level({ effort: 'low', model: 'sonnet' })).answer(req(), signal());
    expect(argvAndSchema().argv).toEqual(['-p', '--model', 'sonnet', '--effort', 'low', '--output-format', 'json', '--json-schema', '<schema>', ...LOCKDOWN_TAIL]);
  });

  it('puts rules, job prompt, output, question, the trail and its place in the levels on stdin', async () => {
    const previous = [{ tier: 'haiku', role: 'level' as const, startedAt: 'a', answer: 'use sqlite', escalate: true, outcome: 'escalated' as const, reason: 'unsure about scale' }];
    await (await level()).answer(req({ previous, level: { number: 2, of: 3 } }), signal());
    const { stdin } = rec();
    for (const s of ['RULE: prefer sqlite', 'Build the invoicing service', 'need a db', 'Which database should I use?', 'use sqlite', 'unsure about scale', 'escalation level 2 of 3']) expect(stdin).toContain(s);
  });

  it('scrubs CLAUDECODE and CLAUDE_CODE_* from the environment, keeps the rest', async () => {
    await (await level()).answer(req(), signal());
    const { env } = rec();
    expect(env.CLAUDECODE).toBeUndefined();
    expect(Object.keys(env).filter((k) => k.startsWith('CLAUDE_CODE_'))).toEqual([]);
    expect(env.KEEP_ME).toBe('yes');
  });

  it.each([
    [{ answer: 'use sqlite', escalate: false, reason: 'routine' }, { answer: 'use sqlite', escalate: false, reason: 'routine', model: 'claude-opus-resolved' }],
    [{ answer: 'pick option 1', escalate: true, reason: 'irreversible' }, { answer: 'pick option 1', escalate: true, reason: 'irreversible', model: 'claude-opus-resolved' }],
  ])('returns a schema-valid reply %j, with the model the CLI reports it ran (modelUsage)', async (structured, want) => {
    process.env.FAKE_CLAUDE_STRUCTURED = JSON.stringify(structured);
    expect(await (await level()).answer(req(), signal())).toEqual(want);
  });

  it.each([
    ['escalate as a string', { answer: 'a', escalate: 'false', reason: 'r' }],
    ['escalate missing', { answer: 'a', reason: 'r' }],
    ['reason missing', { answer: 'a', escalate: false }],
    ['answer missing', { escalate: false, reason: 'r' }],
  ])('%s returns { error }', async (_n, structured) => {
    process.env.FAKE_CLAUDE_STRUCTURED = JSON.stringify(structured);
    expect(await (await level()).answer(req(), signal())).toEqual({ error: expect.any(String) });
  });

  it.each(['malformed', 'invalid', 'exit1'])('%s output returns { error }', async (mode) => {
    process.env.FAKE_CLAUDE_MODE = mode;
    expect(await (await level()).answer(req(), signal())).toEqual({ error: expect.any(String) });
  });

  it('a missing binary returns { error }; a timeout returns { error }', async () => {
    expect(await (await level({ bin: join(dir, 'nope') })).answer(req(), signal())).toEqual({ error: expect.any(String) });
    process.env.FAKE_CLAUDE_MODE = 'hang';
    expect(await (await level({ timeoutMs: 300 })).answer(req(), signal())).toEqual({ error: expect.stringMatching(/timeout/i) });
  });

  it('abort returns { error } and kills the child', async () => {
    process.env.FAKE_CLAUDE_MODE = 'hang';
    const ac = new AbortController();
    const p = (await level({ timeoutMs: 10_000 })).answer(req(), ac.signal);
    setTimeout(() => ac.abort('cancel'), 300);
    expect(await p).toEqual({ error: expect.stringMatching(/abort/i) });
  });
});

describe('detection: which + version, never a model call', () => {
  it('available with the version when the bin is on PATH', async () => {
    const calls: string[][] = [];
    const kit = fakeKit({ version: async (bin, args) => { calls.push([bin, ...(args ?? [])]); return '2.1.0 (Claude Code)'; } });
    expect(await claudeCli.detect(kit, opts(claudeCli, {}))).toEqual({ status: 'available', detail: '2.1.0 (Claude Code)' });
    expect(calls).toEqual([['claude', '--version']]);
  });

  it('unavailable when the bin is missing or its --version fails', async () => {
    expect(await claudeCli.detect(fakeKit({ which: async () => undefined }), opts(claudeCli, { bin: 'claude' }))).toEqual({
      status: 'unavailable', reason: expect.stringContaining('claude'),
    });
    expect(await claudeCli.detect(fakeKit({ version: async () => undefined }), opts(claudeCli, {}))).toMatchObject({ status: 'unavailable' });
  });
});

describe('claude-cli on a designated machine (issue #150)', () => {
  const FAKE_SSH = join(import.meta.dirname, '..', 'herdr', 'fake-ssh-bin.mjs');
  const LAPTOP: MachineSnapshot = { id: 'laptop', label: 'laptop', maxLanes: 1, online: true, executors: ['herdr-claude'], ssh: 'laptop' };
  const savedSsh = process.env.FAKE_HERDR_DIR;
  let sshDir: string;
  beforeEach(() => {
    sshDir = mkdtempSync(join(tmpdir(), 'jh-ssh-'));
    process.env.FAKE_HERDR_DIR = sshDir;
  });
  afterEach(() => {
    if (savedSsh === undefined) delete process.env.FAKE_HERDR_DIR; else process.env.FAKE_HERDR_DIR = savedSsh;
  });

  const onMachine = (machines: MachineSnapshot[], raw: Record<string, unknown> = {}) => {
    const auth = testSshAuth(join(sshDir, 'auth'))();
    const c = {
      ...ctx(), env: (n: string) => (n === 'HOPPER_SSH_KEY_FILE' ? auth.identityFile : undefined),
      machine: async (id: string) => machines.find((m) => m.id === id),
    };
    return claudeCli.create(c, opts(claudeCli, { bin: BIN, timeoutMs: 5000, machine: 'laptop', sshBin: FAKE_SSH, ...raw }));
  };
  const sshCalls = () => readFileSync(join(sshDir, 'ssh-calls.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { argv: string[] });

  it('options machine (optional, editable in the UI) and sshBin (command-bearing)', () => {
    expect(parseOptions(claudeCli, { machine: 'laptop' })).toMatchObject({ ok: true, options: { machine: 'laptop', sshBin: 'ssh' } });
    const schema = optionsJsonSchema(claudeCli) as { properties: Record<string, { commandBearing?: boolean }> };
    expect(schema.properties.machine!.commandBearing).toBeUndefined();
    expect(schema.properties.sshBin!.commandBearing).toBe(true);
  });

  it('runs claude over the machine\'s connection, locked down, the prompt on stdin, in a fresh dir removed after', async () => {
    process.env.FAKE_CLAUDE_STRUCTURED = JSON.stringify({ answer: 'use sqlite', escalate: false, reason: 'rules' });
    expect(await (await onMachine([LAPTOP])).answer(req(), signal())).toEqual({ answer: 'use sqlite', escalate: false, reason: 'rules', model: 'claude-opus-resolved' });
    const [call] = sshCalls();
    expect(call!.argv.slice(call!.argv.indexOf('--') + 1, -1)).toEqual(['laptop.example']);
    const { argv, schema } = argvAndSchema();
    expect(argv).toEqual(['-p', '--model', 'opus', '--output-format', 'json', '--json-schema', '<schema>', ...LOCKDOWN_TAIL]);
    expect(schema).toMatchObject({ required: ['answer', 'escalate', 'reason'] });
    expect(rec().stdin).toContain('Which database should I use?');
    expect(rec().cwd).not.toBe(dir);
    expect(existsSync(rec().cwd)).toBe(false);
  });

  it('detection never looks for claude here: claude runs on that machine', async () => {
    const kit = fakeKit({ which: async () => undefined });
    expect(await claudeCli.detect(kit, opts(claudeCli, { machine: 'laptop' }))).toEqual({ status: 'available', detail: 'claude on machine laptop' });
  });

  it.each([
    ['not configured', [] as MachineSnapshot[], /machine laptop is not configured/],
    ['offline', [{ ...LAPTOP, online: false }], /machine laptop is offline/],
    ['a client target', [{ id: 'laptop', label: 'laptop', maxLanes: 1, online: true, executors: [], client: { tokenEnv: 'T' } }], /client target/],
    ['a container target', [{ id: 'laptop', label: 'laptop', maxLanes: 1, online: true, executors: [], docker: 'box' }], /container target/],
  ])('a machine %s returns { error }: the question escalates', async (_n, machines, why) => {
    expect(await (await onMachine(machines)).answer(req(), signal())).toEqual({ error: expect.stringMatching(why) });
  });
});
