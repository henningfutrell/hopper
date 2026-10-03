import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AnswerRequest } from '../../src/domain/ports.ts';
import type { Question } from '../../src/domain/types.ts';
import { createClaudeCliAnswerer } from '../../src/questions/index.ts';

const BIN = join(import.meta.dirname, 'fake-claude.mjs');
let dir: string;
let out: string;
const saved: Record<string, string | undefined> = {};
const KEYS = ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SESSION', 'FAKE_CLAUDE_OUT', 'FAKE_CLAUDE_MODE', 'KEEP_ME'];

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
});
afterEach(() => {
  for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});

const question = {
  id: 'q1', jobId: 'j1', text: 'Which database should I use?', recentOutput: 'building schema\nneed a db',
  detectedBy: 'marker', status: 'open', tier: 'opus', attempts: [], notifyCount: 0, createdAt: '', updatedAt: '',
} as Question;
const req = (over: Partial<AnswerRequest> = {}): AnswerRequest => ({
  question, jobPrompt: 'Build the invoicing service', jobGoal: 'invoicing', rules: 'RULE: prefer sqlite', previous: [], ...over,
});
const make = (timeoutMs = 5000, model = 'opus') => createClaudeCliAnswerer({ tier: 'opus', model, bin: BIN, cwd: dir, timeoutMs });
const rec = () => JSON.parse(readFileSync(out, 'utf8')) as { argv: string[]; stdin: string; env: Record<string, string>; cwd: string };

describe('createClaudeCliAnswerer', () => {
  it('spawns with the exact argv, --tools "" last', async () => {
    await make().answer(req(), new AbortController().signal);
    const { argv } = rec();
    const schemaAt = argv.indexOf('--json-schema') + 1;
    const schema = JSON.parse(argv[schemaAt]!);
    expect(Object.keys(schema.properties).sort()).toEqual(['answer', 'confident', 'reason', 'risky']);
    // The claude CLI validates --json-schema with a draft-07 validator and rejects a
    // `$schema` it does not know (found live: draft 2020-12 made every tier exit 1).
    expect(schema).toEqual({
      type: 'object',
      properties: {
        answer: { type: 'string' }, confident: { type: 'boolean' },
        risky: { type: 'boolean' }, reason: { type: 'string' },
      },
      required: ['answer', 'confident', 'risky', 'reason'],
      additionalProperties: false,
    });
    const withoutSchema = argv.map((a, i) => (i === schemaAt ? '<schema>' : a));
    expect(withoutSchema).toEqual([
      '-p', '--model', 'opus', '--output-format', 'json', '--json-schema', '<schema>',
      '--no-session-persistence', '--setting-sources', '', '--strict-mcp-config', '--tools', '',
    ]);
  });

  it('puts rules, job prompt, output, question and attempts on stdin; runs in cwd', async () => {
    const previous = [{ tier: 'opus', model: 'opus', startedAt: 'a', outcome: 'escalated', reason: 'unsure about scale' }] as const;
    await make().answer(req({ previous: [...previous] }), new AbortController().signal);
    const r = rec();
    expect(r.stdin).toContain('RULE: prefer sqlite');
    expect(r.stdin).toContain('Build the invoicing service');
    expect(r.stdin).toContain('need a db');
    expect(r.stdin).toContain('Which database should I use?');
    expect(r.stdin).toContain('unsure about scale');
    expect(r.cwd).toBe(dir);
  });

  it('scrubs CLAUDECODE and CLAUDE_CODE_* from the environment, keeps the rest', async () => {
    await make().answer(req(), new AbortController().signal);
    const { env } = rec();
    expect(env.CLAUDECODE).toBeUndefined();
    expect(Object.keys(env).filter((k) => k.startsWith('CLAUDE_CODE_'))).toEqual([]);
    expect(env.KEEP_ME).toBe('yes');
  });

  it('returns the validated structured_output', async () => {
    const res = await make().answer(req(), new AbortController().signal);
    expect(res).toEqual({ answer: 'use postgres', confident: true, risky: false, reason: 'rules' });
  });

  it.each(['malformed', 'invalid', 'exit1'])('%s output returns { error }', async (mode) => {
    process.env.FAKE_CLAUDE_MODE = mode;
    const res = await make().answer(req(), new AbortController().signal);
    expect(res).toEqual({ error: expect.any(String) });
  });

  it('a missing binary returns { error }, never throws', async () => {
    const a = createClaudeCliAnswerer({ tier: 'opus', model: 'opus', bin: join(dir, 'nope'), cwd: dir, timeoutMs: 1000 });
    expect(await a.answer(req(), new AbortController().signal)).toEqual({ error: expect.any(String) });
  });

  it('timeout returns { error }', async () => {
    process.env.FAKE_CLAUDE_MODE = 'hang';
    const res = await make(300).answer(req(), new AbortController().signal);
    expect(res).toEqual({ error: expect.stringMatching(/timeout/i) });
  });

  it('abort returns { error } and kills the child', async () => {
    process.env.FAKE_CLAUDE_MODE = 'hang';
    const ac = new AbortController();
    const p = make(10_000).answer(req(), ac.signal);
    setTimeout(() => ac.abort('cancel'), 300);
    expect(await p).toEqual({ error: expect.stringMatching(/abort/i) });
  });

  it('exposes tier and model', () => {
    expect(make(1000, 'fable')).toMatchObject({ tier: 'opus', model: 'fable' });
  });
});
