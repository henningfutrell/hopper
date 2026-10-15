// Issue #1295: a test hopper a job starts can take the address of the user's hopper while that one is down, and the
// page open on it then read the test hopper's state as its own. So every answer names the hopper that gave it
// (`x-hopper-instance`, the instance tag), and the event stream opens with it: the page drops what another hopper says.
import { afterEach, describe, expect, it } from 'vitest';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { openSse, type SseClient } from '../support/sse.ts';
import { waitFor } from '../support/wait.ts';

const apps: TestApp[] = [];
const cleanups: (() => void)[] = [];
let sse: SseClient | undefined;

async function start(): Promise<TestApp> {
  const db = tempDbPath();
  cleanups.push(db.cleanup);
  const t = await startTestApp({ dbPath: db.dbPath });
  apps.push(t);
  return t;
}

afterEach(async () => {
  sse?.close();
  sse = undefined;
  for (const t of apps.splice(0)) await t.stop();
  for (const c of cleanups.splice(0)) c();
});

const tagOf = async (url: string): Promise<string | null> => (await fetch(url)).headers.get('x-hopper-instance');

describe('the instance tag (#1295)', () => {
  it('every answer names its hopper, the same tag on each route and the page itself; another hopper has another', async () => {
    const a = await start();
    const health = await tagOf(`${a.url}/api/health`);
    expect(health).toMatch(/^[0-9a-f]{16}$/);
    expect(await tagOf(`${a.url}/`)).toBe(health);
    expect(await tagOf(`${a.url}/ui/api/session`)).toBe(health);
    expect(await tagOf(`${a.url}/api/no-such-route`)).toBe(health);
    const b = await start();
    expect(await tagOf(`${b.url}/api/health`)).not.toBe(health);
  });

  it('the event stream opens with the tag, before any event', async () => {
    const a = await start();
    const tag = await tagOf(`${a.url}/api/health`);
    sse = await openSse(`${a.url}/api/events/stream?after=0`);
    await waitFor(() => sse!.messages.length > 0);
    expect(sse.messages[0]).toEqual({ event: 'hopper.instance', data: JSON.stringify(tag) });
  });
});
