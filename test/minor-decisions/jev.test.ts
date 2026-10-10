// Jev at its seam (issue #550): jev_pick.py asks TypeSafe's typesafe_sdk — here the fake one the gate router's tests
// use — one Choice over a decision point's options. Without the key Jev is not available; with it, a missing SDK or
// a failing TypeSafe is an answer that says so, never a throw; a pick outside the options is refused. The key comes from
// the vault's system scope (issue #657), asked at each call; TypeSafe's error never carries it, and a key check is one
// cheap Choice with the key offered.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createJev } from '../../src/minor-decisions/jev.ts';

const FAKE_TYPESAFE = join(import.meta.dirname, '..', 'plugins', 'fixtures', 'fake-typesafe');
const dirs: string[] = [];
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

function jev(env: Record<string, string | undefined>) {
  const dir = mkdtempSync(join(tmpdir(), 'jev-pick-'));
  dirs.push(dir);
  const out = join(dir, 'typesafe.json');
  const j = createJev({ python: 'python3', timeoutMs: 20_000, key: () => env.TYPESAFE_API_KEY, env: { PATH: process.env.PATH, PYTHONPATH: FAKE_TYPESAFE, FAKE_TYPESAFE_OUT: out, ...env } });
  return { j, out };
}
const ASK = {
  point: 'question-answer' as const, instructions: 'Pick the safest option.', state: { question: 'Which?' },
  options: [{ id: '1', label: 'keep it' }, { id: '2', label: 'rename it' }],
};

describe('Jev through TypeSafe', () => {
  it('without a TypeSafe API key it is not available', async () => {
    const { j } = jev({});
    expect(j.available()).toEqual({ available: false, why: 'Jev is off until a TypeSafe API key is set' });
    expect(await j.pick(ASK)).toEqual({ ok: false, why: 'Jev is off until a TypeSafe API key is set' });
  });

  it('a key TypeSafe refuses: the error says so, with the key masked', async () => {
    const { j } = jev({ TYPESAFE_API_KEY: 'ts-bad-0123456789' });
    const r = await j.pick(ASK);
    expect(r).toEqual({ ok: false, why: expect.stringContaining('401 invalid api key') });
    expect(JSON.stringify(r)).not.toContain('ts-bad-0123456789');
  });

  it('a key check: one Choice with the key offered, whatever key is stored', async () => {
    const { j, out } = jev({});
    expect(await j.check('ts-good-123456')).toEqual({ ok: true });
    expect(JSON.parse(readFileSync(out, 'utf8'))).toMatchObject({ questions: ['decision'], key: 'ts-good-123456' });
    const bad = await j.check('ts-bad-123456');
    expect(bad).toEqual({ ok: false, why: expect.stringContaining('401 invalid api key') });
    expect(JSON.stringify(bad)).not.toContain('ts-bad-123456');
  });

  it('with the key: one Choice over the options, keyed by option id; the pick and its confidence', async () => {
    const { j, out } = jev({ TYPESAFE_API_KEY: 'ts-test' });
    expect(j.available()).toEqual({ available: true });
    expect(await j.pick(ASK)).toEqual({ ok: true, pick: '1', confidence: 0.9 });
    const sent = JSON.parse(readFileSync(out, 'utf8')) as { questions: string[]; state: Record<string, unknown>; key: string; model: string };
    expect(sent).toMatchObject({ questions: ['decision'], key: 'ts-test', model: 'jev-latest', state: { question: 'Which?' } });
  });

  it('TypeSafe failing is an answer that says so', async () => {
    const { j } = jev({ TYPESAFE_API_KEY: 'ts-test', FAKE_TYPESAFE_MODE: 'error' });
    expect(await j.pick(ASK)).toEqual({ ok: false, why: expect.stringContaining('401 invalid api key') });
  });

  it('no typesafe_sdk is an answer that says so', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jev-pick-'));
    dirs.push(dir);
    const j = createJev({ python: 'python3', timeoutMs: 20_000, key: () => 'ts-test', env: { PATH: process.env.PATH, PYTHONPATH: dir } });
    expect(await j.pick(ASK)).toEqual({ ok: false, why: expect.stringContaining('typesafe_sdk') });
  });

  it('a python that cannot run is an answer, never a throw', async () => {
    const j = createJev({ python: '/nonexistent/python', timeoutMs: 5000, key: () => 'ts-test', env: { PATH: process.env.PATH } });
    expect(await j.pick(ASK)).toMatchObject({ ok: false });
  });
});
