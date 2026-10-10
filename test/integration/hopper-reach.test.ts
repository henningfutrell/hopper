// Issue #698: a machine's probe asks the hopper's reach path at each of the hopper's addresses, to learn which one
// its jobs reach the hopper at. The route answers 204 behind the Host guard, with no token, and changes nothing.
//
// Feature: a machine finds where it reaches the hopper
//   Scenario: the reach path answers 204 with nothing in it
//   Scenario: a misdirected Host is refused there as anywhere
import { afterEach, describe, expect, it } from 'vitest';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { rawRequest } from '../support/http.ts';
import { REACH_PATH } from '../../src/machines/hopper-reach.ts';

const apps: TestApp[] = [];
const cleanups: (() => void)[] = [];
afterEach(async () => {
  for (const a of apps.splice(0)) await a.stop();
  for (const c of cleanups.splice(0)) c();
});

async function start(): Promise<TestApp> {
  const { dbPath, cleanup } = tempDbPath();
  cleanups.push(cleanup);
  const t = await startTestApp({ dbPath });
  apps.push(t);
  return t;
}

describe('the reach path', () => {
  it('answers 204 with nothing in it', async () => {
    const t = await start();
    const res = await fetch(`${t.url}${REACH_PATH}`);
    expect(res.status).toBe(204);
    expect(await res.text()).toBe('');
  });

  it('a misdirected Host is refused there as anywhere', async () => {
    const t = await start();
    const res = await rawRequest(t.url, { method: 'GET', path: REACH_PATH, headers: { host: 'elsewhere.example:1' } });
    expect(res.status).toBe(421);
  });
});
