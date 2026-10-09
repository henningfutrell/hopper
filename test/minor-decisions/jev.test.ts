// Jev at its seam (issue #550): jev_pick.py asks TypeSafe's typesafe_sdk — here the fake one the gate router's tests
// use — one Choice over a decision point's options. Without the key Jev is not available; with it, a missing SDK or
// a failing TypeSafe is an answer that says so, never a throw; a pick outside the options is refused.
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
  const j = createJev({ python: 'python3', timeoutMs: 20_000, secret: (n) => env[n], env: { PATH: process.env.PATH, PYTHONPATH: FAKE_TYPESAFE, FAKE_TYPESAFE_OUT: out, ...env } });
  return { j, out };
}
const ASK = {
  point: 'question-answer' as const, instructions: 'Pick the safest option.', state: { question: 'Which?' },
  options: [{ id: '1', label: 'keep it' }, { id: '2', label: 'rename it' }],
};

describe('Jev through TypeSafe', () => {
  it('without TYPESAFE_API_KEY it is not available', async () => {
    const { j } = jev({});
    expect(j.available()).toEqual({ available: false, why: 'Jev is off until TYPESAFE_API_KEY is set' });
    expect(await j.pick(ASK)).toEqual({ ok: false, why: 'Jev is off until TYPESAFE_API_KEY is set' });
  });

  it('names the variable as the runtime knows it: a user added later has their own prefix', async () => {
    const j = createJev({ python: 'python3', timeoutMs: 5000, secret: () => undefined, secretName: (n) => `HOPPER_USER_ANA_${n}`, env: {} });
    expect(j.available()).toEqual({ available: false, why: 'Jev is off until HOPPER_USER_ANA_TYPESAFE_API_KEY is set' });
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
    const j = createJev({ python: 'python3', timeoutMs: 20_000, secret: () => 'ts-test', env: { PATH: process.env.PATH, PYTHONPATH: dir } });
    expect(await j.pick(ASK)).toEqual({ ok: false, why: expect.stringContaining('typesafe_sdk') });
  });

  it('a python that cannot run is an answer, never a throw', async () => {
    const j = createJev({ python: '/nonexistent/python', timeoutMs: 5000, secret: () => 'ts-test', env: { PATH: process.env.PATH } });
    expect(await j.pick(ASK)).toMatchObject({ ok: false });
  });
});
