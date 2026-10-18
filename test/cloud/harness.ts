// The hopper.io test harness (issue #463): a real store (Postgres), a real server (Fastify, by inject), and GitHub as a
// fake on loopback; a browser's whole trip through GitHub, and the rows the store keeps.
import type { LightMyRequestResponse } from 'fastify';
import pg from 'pg';
import type { CloudConfig } from '../../cloud/config.ts';
import type { CloudLinkAnswers } from '../../cloud/link.ts';
import { createRegistrationRequests } from '../../cloud/requests.ts';
import { SESSION_COOKIE, SIGN_IN_COOKIE, cloudServer, cookiesOf } from '../../cloud/server.ts';
import { createInstanceStates } from '../../cloud/states.ts';
import { openCloudStore } from '../../cloud/store.ts';
import { testDatabaseUrl } from '../support/database.ts';
import { createFakeGitHub } from '../support/fake-forges.ts';
import { rawRequest } from '../support/http.ts';

export const SECRET = 'hosted-app-secret-for-tests';
export const PUBLIC = 'http://127.0.0.1:8099';
const stops: (() => Promise<void>)[] = [];
/** For afterEach: stops what each setUp started, the last first. */
export async function stopAll(): Promise<void> { for (const s of stops.splice(0).reverse()) await s(); }

export async function setUp() {
  const github = await createFakeGitHub({ clientId: 'hosted-app', clientSecret: SECRET });
  stops.push(() => github.close());
  const databaseUrl = testDatabaseUrl();
  const store = await openCloudStore(databaseUrl);
  stops.push(() => store.close());
  const config: CloudConfig = { databaseUrl, publicUrl: PUBLIC, githubUrl: github.url, clientId: 'hosted-app', clientSecret: SECRET, host: '127.0.0.1', port: 0, trustProxy: false };
  const requests = createRegistrationRequests();
  const states = createInstanceStates();
  const server = await cloudServer({ config, store, requests, states });
  stops.push(() => server.close());
  return { github, store, server, databaseUrl, requests, states };
}

export type Set = Awaited<ReturnType<typeof setUp>>;
export const setCookies = (h: string | string[] | number | undefined): Map<string, string> =>
  cookiesOf((Array.isArray(h) ? h : [String(h ?? '')]).map((c) => c.split(';')[0]).join('; '));

/** A browser's trip from `start` (a redirect to GitHub) through GitHub to the callback. */
export async function viaGitHub(s: Set, start: LightMyRequestResponse, cookie = '') {
  const state = setCookies(start.headers['set-cookie']).get(SIGN_IN_COOKIE)!;
  const to = new URL(String(start.headers.location));
  const atGitHub = await rawRequest(s.github.url, { path: to.pathname + to.search });
  const back = new URL(String(atGitHub.headers.location));
  const callback = await s.server.inject({ method: 'GET', url: back.pathname + back.search, headers: { cookie: `${cookie}${SIGN_IN_COOKIE}=${state}` } });
  return { start, state, callback, session: setCookies(callback.headers['set-cookie']).get(SESSION_COOKIE) || undefined };
}

/** A browser's whole sign-in: hopper.io → GitHub → the callback. */
export async function signIn(s: Set) {
  return viaGitHub(s, await s.server.inject({ method: 'GET', url: '/auth/github' }));
}

export const account = (s: Set, session: string | undefined) =>
  s.server.inject({ method: 'GET', url: '/api/account', ...(session ? { headers: { cookie: `${SESSION_COOKIE}=${session}` } } : {}) });

/** Every row of the store's tables, as JSON: [account, session, sign_in, record, registration, registration_tombstone,
 * machine_name]. */
export async function rows(databaseUrl: string): Promise<string> {
  const u = new URL(databaseUrl);
  const schema = u.searchParams.get('schema')!;
  u.searchParams.delete('schema');
  const c = new pg.Client({ connectionString: u.toString() });
  await c.connect();
  try {
    const out: unknown[] = [];
    for (const t of ['account', 'session', 'sign_in', 'record', 'registration', 'registration_tombstone', 'machine_name']) out.push((await c.query(`SELECT row_to_json(x) AS r FROM "${schema}".${t} x`)).rows);
    return JSON.stringify(out);
  } finally { await c.end(); }
}

/** The fake GitHub's own answer for `login`: the numeric id the account must be keyed by. */
export async function rawUser(s: Set, login = 'octo-user'): Promise<{ id: number }> {
  const { accessToken } = s.github.mint(login);
  const r = await rawRequest(s.github.url, { path: '/api/v3/user', headers: { authorization: `token ${accessToken}` } });
  return JSON.parse(r.text) as { id: number };
}

/** The owner of `githubUserId` enters a code for the instance, and the instance answers `answer` (default `registered`). */
export async function registerAs(s: Set, link: CloudLinkAnswers, githubUserId: string, installId: string, now: Date,
  answer = JSON.stringify({ type: 'registration', outcome: 'registered' })): Promise<boolean> {
  const login = (await s.store.account(githubUserId))!.login;
  s.requests.enter({ githubUserId, login, installId, code: 'c0de'.repeat(16), now });
  return link.registration({ installId, account: login, answer, now });
}
