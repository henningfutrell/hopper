// The demo hopper's doubles (issue #353), beyond the ones the integration tests already share: the seal
// that keeps it on this machine, the sped-up clock of its warm-up, the escalation levels it asks, and the
// usage it reads. Example data only.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { delimiter, join } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import type { EscalationLevel, SettableUsageSource } from '../../src/domain/ports.ts';
import type { UsageReading } from '../../src/domain/types.ts';
import { createFakeLevel } from '../../src/questions/index.ts';

/** The name this machine shows as (the local machine's label is its hostname). */
export const DEMO_HOST = 'home-server';

/** On PATH before the real ones: they refuse, so no part reaches another machine or runs a real agent. */
const GUARD = `#!/bin/sh
echo "$(basename "$0") $*" >> "$(dirname "$0")/calls.log"
echo "demo: $(basename "$0") is never run" >&2
exit 255
`;

/**
 * Nothing about the machine the screenshots are taken on reaches them, and nothing leaves it: HOME is a
 * throwaway dir, the hostname is the demo's, ssh and claude refuse, and fetch() refuses any non-loopback
 * host (as test/support/isolate.ts does for the tests).
 */
export function seal(github: { login: string; org: string; repos: string[] }): void {
  const home = mkdtempSync(join(os.tmpdir(), 'hopper-demo-home-'));
  process.env.HOME = home;
  for (const v of ['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME']) delete process.env[v];
  const guards = join(home, '.guards');
  mkdirSync(guards, { mode: 0o700 });
  for (const bin of ['ssh', 'claude', 'herdr']) writeFileSync(join(guards, bin), GUARD, { mode: 0o755 });
  process.env.PATH = `${guards}${delimiter}${process.env.PATH ?? ''}`;
  os.hostname = () => DEMO_HOST;
  os.homedir = () => home;
  syncBuiltinESMExports();
  const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);
  const realFetch = globalThis.fetch;
  globalThis.fetch = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin === 'https://api.github.com') {
      const answer = installations(github, url.pathname);
      if (answer) return Promise.resolve(Response.json(answer));
    }
    if (!LOOPBACK.has(url.hostname)) return Promise.reject(new Error(`demo: refused non-loopback request to ${url.origin}`));
    return realFetch(input, init);
  };
}

/** GitHub's answer to where the hopper's app is installed (the Sources view asks): on the demo org, for its repos. */
function installations(github: { org: string; repos: string[] }, path: string): unknown {
  if (path === '/user/installations') {
    return {
      total_count: 1,
      installations: [{
        id: 1, account: { login: github.org }, repository_selection: 'selected',
        html_url: `https://github.com/organizations/${github.org}/settings/installations/1`,
        permissions: { issues: 'write', pull_requests: 'write', contents: 'write', metadata: 'read' },
      }],
    };
  }
  if (path === '/user/installations/1/repositories') {
    const repositories = [...github.repos, 'design-system'].map((r) => ({ full_name: `${github.org}/${r}` }));
    return { total_count: repositories.length, repositories };
  }
  return undefined;
}

/**
 * This process's clock, `speed` times faster for `warmupMs` of wall time, starting as far in the past as
 * that gains, so it meets the wall clock as the warm-up ends; normal speed after, or once settled.
 */
export function warpClock(speed: number, warmupMs: number): { settle(): void } {
  const RealDate = Date;
  const start = RealDate.now();
  let settled = false;
  const now = (): number => {
    const real = RealDate.now();
    if (settled || real - start >= warmupMs) return real;
    return start - (speed - 1) * warmupMs + speed * (real - start);
  };
  class WarpDate extends RealDate {
    constructor(...args: unknown[]) {
      if (args.length === 0) super(now());
      else super(...(args as [number]));
    }
    static override now(): number { return now(); }
  }
  globalThis.Date = WarpDate as DateConstructor;
  return { settle() { settled = true; } };
}

/**
 * The escalation levels, named as the defaults are: `opus` answers what it can and passes on a question
 * that says "unsure" or "risky"; `fable` answers the unsure ones and leaves the risky ones to the owner.
 */
export function demoLevels(): EscalationLevel[] {
  const level = (name: string, passes: RegExp, answerTo: (question: string) => string, why: string) => createFakeLevel({
    name, model: name,
    script: (req) => {
      const escalate = passes.test(req.question.text);
      return { answer: answerTo(req.question.text), escalate, reason: escalate ? why : 'answered from the repository\'s own conventions' };
    },
  });
  return [
    level('opus', /\b(unsure|risky)\b/i, () => 'Keep the current behaviour and note the open question in the pull request.',
      'the question turns on a product decision the repository does not record'),
    level('fable', /\brisky\b/i, (q) => /TLS/.test(q)
      ? 'Keep accepting TLS 1.1 for now; the gateway\'s own docs still list it as supported.'
      : 'Add the grace period: read both stores until every session has moved, then drop the old table.',
      'it changes what signed-in users see; the owner decides that'),
  ];
}

/** A plan's usage, as the claude-plan source reads it: a session window and a week, for every machine. */
export function demoUsage(clock: { now(): Date }): SettableUsageSource & { setAll(sessionUsed: number): void } {
  const readings = new Map<string, UsageReading>();
  const at = () => clock.now().toISOString();
  const resets = (h: number) => new Date(clock.now().getTime() + h * 3_600_000).toISOString();
  const copies = (): UsageReading[] => [...readings.values()].map((r) => ({ ...r }));
  const setAll = (sessionUsed: number): void => {
    readings.set('session', { source: 'claude-plan', window: 'session', used: sessionUsed, limit: 100, unit: '%', resetsAt: resets(2.4), at: at() });
    readings.set('week', { source: 'claude-plan', window: 'week', used: 41, limit: 100, unit: '%', resetsAt: resets(80), at: at() });
  };
  setAll(20);
  return {
    name: 'claude-plan',
    poll: async () => copies(),
    set(reading) {
      readings.set(reading.window ?? 'session', { ...reading, source: 'claude-plan', at: at() });
      return copies();
    },
    setAll,
  };
}
