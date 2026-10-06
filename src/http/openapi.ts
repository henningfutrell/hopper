// The API reference (issue #68, design.md "API reference"): an OpenAPI 3.1 document of every route
// under /api/ and /ui/. Parameters and request bodies are the zod schemas the routes parse with,
// turned into JSON Schema, so they cannot drift; summaries and answers are written here. The daemon
// refuses to start when a route and this document disagree (`referenceDrift`, checked on ready).
import { z } from 'zod';
import { ENVELOPE_SCHEMA } from '../events/index.ts';
import type { UiRole } from '../domain/types.ts';
import { jobsQuery } from './jobs.ts';
import { questionsQuery } from './questions.ts';
import { streamQuery } from './sse.ts';
import { decisionsQuery, eventsQuery } from './state.ts';
import { SESSION_HEADER } from './ui/guard.ts';
import {
  answerBody, deviceLinkBody, ghLoginBody, queueGateBody, queueOrderBody, machineDefaultsBody, machinesEditBody, pluginStoreBody, pluginsEditBody, passwordChangeBody, realmsEditBody, routerModeBody, routingEditBody, rulesBody, updateBody, usersEditBody, webhooksEditBody,
} from './ui/index.ts';
import { completeBody, loginBody, passwordBody, startQuery } from './ui/sign-in.ts';
import { deliveriesQuery } from './webhooks.ts';

type Tag = 'State' | 'Jobs' | 'Questions' | 'Machines and usage' | 'Plugins and routing' | 'Webhooks' | 'Events' | 'Self-update' | 'Users' | 'Sign-in';

interface Operation {
  method: 'get' | 'post';
  /** Fastify's form: `/api/jobs/:id`. */
  path: string;
  tag: Tag;
  summary: string;
  description?: string;
  query?: z.ZodObject;
  body?: z.ZodType;
  /** Body media type; default JSON. */
  form?: boolean;
  /** What a 200 carries. */
  returns: string;
  /** Answer media type; default JSON. */
  answers?: 'html' | 'sse' | 'xml' | 'redirect';
  /** A UI mutation: the least UI role that may make it. */
  role?: UiRole;
  /** Error statuses beyond the guards'. */
  errors?: number[];
}

const id = (what: string) => ({ name: 'id', in: 'path', required: true, description: `the ${what}'s id`, schema: { type: 'string' } });
const name = { name: 'name', in: 'path', required: true, description: 'the realm, as the sign-in config names it', schema: { type: 'string' } };

const OPERATIONS: Operation[] = [
  { method: 'get', path: '/api/health', tag: 'State', summary: 'Health and version', description: 'A loopback read without a session on a hopper with several users reads the instance\'s part only: `{ ok, version, uptimeS }`.', returns: '`{ ok, version, routerMode, router, fallback, executors, uptimeS }`' },
  { method: 'get', path: '/api/queue', tag: 'State', summary: 'The queue', returns: '`{ waiting, running, waitingAnswer, ended, gate, presort }`: each list a `Job[]`, `waiting` in queue order (the user order first), `ended` the last 24 h; `gate` the `QueueGate`; `presort` the `PreSort` of the waiting jobs not yet accepted' },
  { method: 'get', path: '/api/decisions', tag: 'State', summary: 'Recent decisions', query: decisionsQuery, returns: '`{ decisions: Decision[] }`, newest first' },
  { method: 'get', path: '/api/decisions/:id', tag: 'State', summary: 'One decision', returns: '`Decision`', errors: [404] },
  { method: 'get', path: '/api/router', tag: 'State', summary: 'Router mode and status', returns: '`{ mode, router, plugin, fallback, reason? }`' },
  { method: 'get', path: '/api/accounts', tag: 'State', summary: 'Who each part acts as', description: 'Each usage source\'s and job source\'s account on an outside service. Never a token.', returns: '`{ accounts: PartAccount[] }`' },
  { method: 'get', path: '/api/sources', tag: 'Jobs', summary: 'Job sources and their sync status', returns: '`{ sources: SourceStatus[] }`' },
  { method: 'get', path: '/api/gh-login', tag: 'Jobs', summary: 'The gh CLI\'s login', description: 'Logged in (with the account), logged out, failed, or waiting with the device code to approve at github.com/login/device.', returns: '`GhLoginStatus`' },
  { method: 'post', path: '/ui/api/gh-login', tag: 'Jobs', summary: 'Log the gh CLI in to GitHub, or cancel', description: '`start` runs gh\'s device flow and answers once it shows the device code; a waiting login answers its own code. gh keeps the token; the hopper keeps none.', role: 'admin', body: ghLoginBody, returns: '`GhLoginStatus`', errors: [409] },
  { method: 'get', path: '/api/jobs', tag: 'Jobs', summary: 'List jobs', description: 'Jobs come only from job sources; no route creates one.', query: jobsQuery, returns: '`{ jobs: Job[] }`, newest first' },
  { method: 'get', path: '/api/jobs/:id', tag: 'Jobs', summary: 'One job', returns: '`Job`', errors: [404] },
  { method: 'post', path: '/ui/api/jobs/:id/cancel', tag: 'Jobs', summary: 'Cancel a job', role: 'operator', returns: 'the `Job`', errors: [404, 409] },
  { method: 'post', path: '/ui/api/jobs/:id/approve', tag: 'Jobs', summary: 'Approve a held job', role: 'operator', returns: 'the `Job`', errors: [404, 409] },
  { method: 'post', path: '/ui/api/jobs/:id/reject', tag: 'Jobs', summary: 'Reject a waiting job', description: 'The job ends `rejected`: kept, never run; its source is told (on GitHub, the `hopper:rejected` label).', role: 'operator', returns: 'the `Job`', errors: [404, 409] },
  { method: 'post', path: '/ui/api/queue/order', tag: 'Jobs', summary: 'Order the queue', description: 'The user order: these waiting jobs, first to last, run before every other. A job not yet accepted is accepted; a waiting job ranked before and not named loses its rank.', role: 'operator', body: queueOrderBody, returns: '`{ jobs: Job[] }`', errors: [409] },
  { method: 'post', path: '/ui/api/queue/accept-presort', tag: 'Jobs', summary: 'Accept the pre-sort', description: 'Every waiting job not yet accepted: rejected when the pre-sort rejects it, else accepted, in its order.', role: 'operator', returns: '`{ presort: PreSort }`, as it was applied' },
  { method: 'post', path: '/ui/api/queue-gate', tag: 'Jobs', summary: 'Set the queue gate', description: '`auto-accept`: the pre-sort is applied as jobs arrive, at most `autoAcceptPerHour` an hour (null: no limit). `review`: each job waits for the user.', role: 'admin', body: queueGateBody, returns: '`{ gate: QueueGate }`' },
  { method: 'get', path: '/api/questions', tag: 'Questions', summary: 'List questions', query: questionsQuery, returns: '`{ questions: Question[] }`' },
  { method: 'get', path: '/api/questions/:id', tag: 'Questions', summary: 'One question, with its escalation trail', returns: '`Question`', errors: [404] },
  { method: 'get', path: '/api/question-gates', tag: 'Questions', summary: 'The rules and the risk rules', returns: '`QuestionGatesView`' },
  { method: 'post', path: '/ui/api/questions/:id/answer', tag: 'Questions', summary: 'Answer an open question', role: 'operator', body: answerBody, returns: 'the `Question`', errors: [404, 409] },
  { method: 'post', path: '/ui/api/questions/:id/close', tag: 'Questions', summary: 'Close an open question', role: 'operator', returns: 'the `Question`', errors: [404, 409] },
  { method: 'post', path: '/ui/api/questions/:id/dismiss', tag: 'Questions', summary: 'Dismiss an open question', role: 'operator', returns: 'the `Question`', errors: [404, 409] },
  { method: 'post', path: '/ui/api/questions/:id/seen', tag: 'Questions', summary: 'Mark a question seen', role: 'operator', returns: 'the `Question`', errors: [404] },
  { method: 'post', path: '/ui/api/rules', tag: 'Questions', summary: 'Replace the rules', description: '`version` is the one read from GET /api/question-gates.', role: 'admin', body: rulesBody, returns: 'the new rules view', errors: [409] },
  { method: 'get', path: '/api/machines', tag: 'Machines and usage', summary: 'Machines, their lanes and usage', returns: '`{ machines: (MachineSnapshot & { lanes, usage })[] }`' },
  { method: 'get', path: '/api/machines/config', tag: 'Machines and usage', summary: 'What the Machines view edits', returns: 'every machine (name, connection, options), the executors, the machine defaults, the detected ssh targets, the plugins config version' },
  { method: 'post', path: '/ui/api/machines', tag: 'Machines and usage', summary: 'Attach a machine over ssh (edit or remove it through /ui/api/plugins)', role: 'admin', body: machinesEditBody, returns: 'the new machines config', errors: [409] },
  { method: 'post', path: '/ui/api/machines/defaults', tag: 'Machines and usage', summary: 'Set what a machine attached here starts with: its lanes and executors', role: 'admin', body: machineDefaultsBody, returns: 'the new machines config', errors: [409] },
  { method: 'get', path: '/api/usage', tag: 'Machines and usage', summary: 'Usage readings', returns: '`UsageReport`' },
  { method: 'get', path: '/api/plugins', tag: 'Plugins and routing', summary: 'Every role, instance and plugin', returns: '`PluginsReport`' },
  { method: 'get', path: '/api/plugin-store', tag: 'Plugins and routing', summary: 'The plugin store: its catalogue and the store installs', returns: '`PluginStoreReport`' },
  { method: 'post', path: '/ui/api/plugin-store', tag: 'Plugins and routing', summary: 'Install, update or remove a plugin from the plugin store', description: 'Read the plugin store again, install a plugin its catalogue lists into the plugin dir (again: an update to the store\'s head), or remove a store install that the plugins config does not name.', role: 'admin', body: pluginStoreBody, returns: 'the new `PluginStoreReport`', errors: [404, 409] },
  { method: 'post', path: '/ui/api/plugins', tag: 'Plugins and routing', summary: 'Edit plugin instances', description: 'Set an instance\'s options (every one, command-bearing ones too; a machine also takes a new name, `rename`), select the plugin of a one-instance role, add or remove an instance, or rescan.', role: 'admin', body: pluginsEditBody, returns: 'the new `PluginsReport`', errors: [404, 409] },
  { method: 'get', path: '/api/routing', tag: 'Plugins and routing', summary: 'Routing rules', returns: 'the rules as configured and their report' },
  { method: 'post', path: '/ui/api/routing', tag: 'Plugins and routing', summary: 'Replace the routing rules', description: 'Applies to new jobs only.', role: 'admin', body: routingEditBody, returns: 'the new routing report', errors: [409] },
  { method: 'post', path: '/ui/api/router-mode', tag: 'Plugins and routing', summary: 'Switch the router mode', role: 'admin', body: routerModeBody, returns: 'the router view, as GET /api/router' },
  { method: 'get', path: '/api/webhooks', tag: 'Webhooks', summary: 'Webhook subscriptions', description: 'Each with the variable its secret is in, and why the runtime gives none if so. Never a secret.', returns: '`{ subscriptions }`' },
  { method: 'get', path: '/api/webhooks/deliveries', tag: 'Webhooks', summary: 'Webhook deliveries', query: deliveriesQuery, returns: '`{ deliveries }`, newest first' },
  { method: 'post', path: '/ui/api/webhooks', tag: 'Webhooks', summary: 'Add, edit or remove a subscription', role: 'admin', body: webhooksEditBody, returns: 'the new view, as GET /api/webhooks', errors: [404, 409] },
  { method: 'get', path: '/api/events', tag: 'Events', summary: 'The event log', description: 'Without `after`: the newest `limit` events, oldest first.', query: eventsQuery, returns: '`{ events: DomainEvent[] }` (envelope schema below; `data` per type in docs/schemas)' },
  { method: 'get', path: '/api/events/stream', tag: 'Events', summary: 'Live events (server-sent events)', description: 'Replays after `after` (or `Last-Event-ID`), then live. Also `delivery.updated` and `source.updated` without an id, and a ping comment every 15 s. Beyond loopback the session goes in the `session` query parameter: EventSource sends no headers.', query: streamQuery, answers: 'sse', returns: 'an event stream' },
  { method: 'get', path: '/api/update', tag: 'Self-update', summary: 'Installed version and available update', returns: '`UpdateStatus`' },
  { method: 'post', path: '/ui/api/update', tag: 'Self-update', summary: 'Check, apply, or change update settings', role: 'admin', body: updateBody, returns: '`UpdateStatus`', errors: [409] },
  { method: 'get', path: '/api/users', tag: 'Users', summary: 'The users of this hopper', description: 'Id, name and when each was added: nothing of a user\'s own data. Loopback, or a UI session with role **admin**.', returns: '`{ users: UserView[] }`, oldest first', errors: [403] },
  { method: 'get', path: '/api/instance', tag: 'Users', summary: 'The totals across every user', description: 'Users, jobs not ended by status, open questions, lanes (open and busy): summed over every user, never one user\'s share, nothing named. What an admin reads of the users\' work. Loopback, or a UI session with role **admin**.', returns: '`InstanceTotals`', errors: [403] },
  { method: 'post', path: '/ui/api/users', tag: 'Users', summary: 'Add a user', description: 'A user of its own: its jobs, questions, events, plugins, webhooks and credentials apart from every other user\'s. Answers a one-time login link for it per UI origin, to hand over (none when local sign-in is off).', role: 'admin', body: usersEditBody, returns: '`UserAdded`: `{ user, links }`', errors: [409] },
  { method: 'get', path: '/ui/api/session', tag: 'Sign-in', summary: 'This session (logged out: whose work a read shows), the sign-in on offer, and whether several users make sign-in required', returns: '`SessionView`' },
  { method: 'post', path: '/ui/login', tag: 'Sign-in', summary: 'Sign in with a one-time login code', description: 'Mint a code with `hopper login-code`. Answers a page that stores the session token for the UI.', body: loginBody, form: true, answers: 'html', returns: 'a page holding the session token' },
  { method: 'post', path: '/ui/auth/none', tag: 'Sign-in', summary: 'Start a session with no sign-in (the sign-in config `none`)', returns: '`{ token, expiresAt, user }`' },
  { method: 'post', path: '/ui/auth/gateway', tag: 'Sign-in', summary: 'Start a session from the token an auth gateway forwards', description: 'For a hopper behind an auth gateway (a gateway realm): the gateway signs people in and adds their token to the request; the gateway realms that are on check it, in order (a JWT against the issuer\'s keys, or token introspection), and the first that accepts it signs in. 403 for no token or one refused; 502 when none accepted it and an issuer could not be reached.', returns: '`{ token, expiresAt, user }`', errors: [502] },
  { method: 'post', path: '/ui/auth/password', tag: 'Sign-in', summary: 'Sign in with a username and password', description: 'Tried against the password and LDAP realms that are on, in order: the first that accepts the password signs in. 502 when none accepted it and a realm could not be reached.', body: passwordBody, returns: '`{ token, expiresAt, user }`', errors: [502] },
  { method: 'get', path: '/ui/auth/:name/start', tag: 'Sign-in', summary: 'Begin sign-in with an OIDC, GitHub or SAML realm', query: startQuery, answers: 'redirect', returns: 'a redirect to the realm\'s identity provider' },
  { method: 'get', path: '/ui/auth/:name/callback', tag: 'Sign-in', summary: 'OIDC and GitHub return here', answers: 'html', returns: 'a page that completes the sign-in' },
  { method: 'post', path: '/ui/auth/:name/callback', tag: 'Sign-in', summary: 'SAML posts its response here', answers: 'html', returns: 'a page that completes the sign-in' },
  { method: 'post', path: '/ui/auth/complete', tag: 'Sign-in', summary: 'Trade a sign-in ticket for a session', body: completeBody, returns: '`{ token, expiresAt, user }`' },
  { method: 'get', path: '/ui/auth/:name/metadata', tag: 'Sign-in', summary: 'SAML service provider metadata', answers: 'xml', returns: 'SAML metadata', errors: [404] },
  { method: 'post', path: '/ui/api/device-link', tag: 'Sign-in', summary: 'A login link for another device, per LAN name', description: '`keep` names the code shown: while it is live the same links come back; once it is used or expired, a fresh code.', role: 'admin', body: deviceLinkBody, returns: '`{ links: string[] }`', errors: [409] },
  { method: 'post', path: '/ui/api/password', tag: 'Sign-in', summary: 'Change your own password', description: 'The password account this session signed in with takes a new password, the current one checked first; every other session of that account ends.', role: 'viewer', body: passwordChangeBody, returns: '`{ ok: true }`', errors: [400, 409] },
  { method: 'post', path: '/ui/api/logout', tag: 'Sign-in', summary: 'End this session', role: 'viewer', returns: '`{ ok: true }`' },
  { method: 'get', path: '/api/realms', tag: 'Sign-in', summary: 'The realms, in order, with their settings and password accounts', description: 'Each realm\'s settings, whether it is on, a password realm\'s accounts (username, role, the user each signs in as; never a hash), and for OIDC, GitHub and SAML the URLs to register with the identity provider; local sign-in, no sign-in, and the version of it all. Loopback, or a UI session with role **admin**.', returns: '`RealmsView`', errors: [403] },
  { method: 'post', path: '/ui/api/realms', tag: 'Sign-in', summary: 'Change sign-in: realms and password accounts', description: 'Add or replace a realm from its fields, remove, move, or turn one on or off; set local sign-in and no sign-in; add a password account (with its password, which only the daemon hashes, its role, and optionally your own user to sign in as), change its role or password, or remove it — against the `version` read. Applies at once: sign-in and the stored sessions follow it. Refused (400) when the result would not load, naming the field; (409) when the sign-in config moved, when the change would end the acting session\'s admin role, when it would turn no sign-in on while the hopper has more than one user, or when it would set a password on, add an account under the name of, or link an account to another user — an admin never gets a way into another user\'s work.', role: 'admin', body: realmsEditBody, returns: 'the new view, as GET /api/realms', errors: [404, 409] },
];

const TAGS: Record<Tag, string> = {
  State: 'What the hopper is doing: health, the queue, decisions, the router.',
  Jobs: 'Jobs and the job sources they are pulled from.',
  Questions: 'Questions a running job asks, and the gates they pass.',
  'Machines and usage': 'Where jobs run, and the usage that throttles lanes.',
  'Plugins and routing': 'Which plugin instance fills which role, and the routing rules.',
  Webhooks: 'Subscribers to the event log, kept in the database.',
  Events: 'The event log, read back or streamed.',
  'Self-update': 'The install and the update repository.',
  Users: 'The people one hopper works for, each with their own work, kept apart.',
  'Sign-in': 'UI sessions: sign-in, the session, logout.',
};

const DESCRIPTION = `The hopper daemon's HTTP API.

**Users.** Every user's work is their own. A read or a change acts for the session's user. A loopback read without a session reads the one user's work while the hopper has one user; with more, it reads no user's work (401). An admin runs the instance — the users, the plugin store, self-update and sign-in — and reads the users' work only as totals (\`GET /api/instance\`).

**Reading.** Every \`GET /api/*\` route reads. From loopback (\`127.0.0.1\` or \`localhost\` with the port) it needs nothing. From a LAN name or the public URL it needs a UI session: the token in the \`${SESSION_HEADER}\` header.

**Changing.** The only changes are \`POST /ui/api/*\`. Each needs a UI session (\`${SESSION_HEADER}\`) whose role allows it, the exact Origin of a UI page, and a JSON body; else 403. No route creates a job: jobs come from job sources.

**A session.** Sign in from the UI. The UI keeps the token in this origin's localStorage under \`jh_session\`; paste it under Authentication here to try the routes that need it.

**Host.** Every request must name this daemon in Host; another Host is 421.

**Errors.** \`{ "error": string }\` with the status: 400 a malformed request, 401 no session for a LAN or public read, 403 a refused change, 404 nothing by that id, 409 not possible in the current state, 421 a misdirected Host.`;

const ERROR_TEXT: Record<number, string> = { 400: 'malformed request', 401: 'no session for a LAN or public read, or for a user\'s work on a hopper with several users', 403: 'refused: no session, role too low, wrong Origin, or not JSON', 404: 'not found', 409: 'not possible in the current state' };

/** JSON Schema for a request part, as the route parses its input. */
const schemaOf = (s: z.ZodType): Record<string, unknown> => {
  const { $schema: _, ...rest } = z.toJSONSchema(s, { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>;
  return rest;
};

const openApiPath = (path: string): string => path.replace(/:([A-Za-z]+)/g, '{$1}');

function parameters(op: Operation): unknown[] {
  const out: unknown[] = [];
  if (op.path.includes(':id')) out.push(id(op.tag === 'Questions' ? 'question' : op.tag === 'Jobs' ? 'job' : 'decision'));
  if (op.path.includes(':name')) out.push(name);
  if (op.query) {
    const s = schemaOf(op.query) as { properties?: Record<string, Record<string, unknown>>; required?: string[] };
    for (const [n, schema] of Object.entries(s.properties ?? {})) {
      out.push({ name: n, in: 'query', required: s.required?.includes(n) ?? false, schema, ...(typeof schema.description === 'string' ? { description: schema.description } : {}) });
    }
  }
  return out;
}

const MEDIA = { html: 'text/html', sse: 'text/event-stream', xml: 'application/samlmetadata+xml' } as const;
const ERROR = { description: '', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } };

function responses(op: Operation): Record<string, unknown> {
  const statuses = [...(op.query || op.body ? [400] : []), ...(op.role ? [403] : []), ...(op.path.startsWith('/api/') ? [401] : []), ...(op.errors ?? [])];
  const ok = op.answers === 'redirect'
    ? { 302: { description: op.returns } }
    : { 200: { description: op.returns, content: { [op.answers ? MEDIA[op.answers] : 'application/json']: op.path === '/api/events' ? { schema: { type: 'object', properties: { events: { type: 'array', items: { $ref: '#/components/schemas/Event' } } } } } : {} } } };
  return { ...ok, ...Object.fromEntries([...new Set(statuses)].sort().map((s) => [s, { ...ERROR, description: ERROR_TEXT[s] ?? '' }])) };
}

function operation(op: Operation): Record<string, unknown> {
  const roleNote = op.role ? `Needs a UI session with role **${op.role}** or above.` : undefined;
  return {
    tags: [op.tag],
    summary: op.summary,
    ...(op.description || roleNote ? { description: [op.description, roleNote].filter(Boolean).join('\n\n') } : {}),
    operationId: `${op.method}${op.path.replace(/[/:-](\w)/g, (_m, c: string) => c.toUpperCase())}`,
    parameters: parameters(op),
    ...(op.body ? { requestBody: { required: true, content: { [op.form ? 'application/x-www-form-urlencoded' : 'application/json']: { schema: schemaOf(op.body) } } } } : {}),
    // A read needs nothing on loopback and a session beyond it; a mutation always needs one.
    security: op.role ? [{ uiSession: [] }] : op.path.startsWith('/api/') ? [{}, { uiSession: [] }] : [],
    responses: responses(op),
  };
}

/** The OpenAPI 3.1 document of this daemon at `version`. */
export function openApiDocument(version: string): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const op of OPERATIONS) (paths[openApiPath(op.path)] ??= {})[op.method] = operation(op);
  return {
    openapi: '3.1.1',
    info: { title: 'hopper', version, description: DESCRIPTION },
    tags: Object.entries(TAGS).map(([n, d]) => ({ name: n, description: d })),
    paths,
    components: {
      securitySchemes: { uiSession: { type: 'apiKey', in: 'header', name: SESSION_HEADER, description: 'A UI session token (localStorage `jh_session` in a signed-in UI).' } },
      schemas: {
        Error: { type: 'object', properties: { error: { type: 'string' } }, required: ['error'] },
        Event: schemaOf(ENVELOPE_SCHEMA),
      },
    },
  };
}

/** Where the reference stands apart from the served routes; empty when they agree. */
export function referenceDrift(doc: { paths: Record<string, Record<string, unknown>> }, routes: { method: string; url: string }[]): string[] {
  const isApi = (url: string) => url.startsWith('/api/') || (url.startsWith('/ui/') && !url.startsWith('/ui/assets/'));
  const served = new Set(routes.filter((r) => r.method !== 'HEAD' && isApi(r.url)).map((r) => `${r.method} ${openApiPath(r.url)}`));
  const documented = new Set(Object.entries(doc.paths).flatMap(([p, ops]) => Object.keys(ops).map((m) => `${m.toUpperCase()} ${p}`)));
  const show = (key: string) => key.replace(/\{(\w+)\}/g, ':$1');
  return [
    ...[...served].filter((k) => !documented.has(k)).map((k) => `${show(k)} is served but not in the API reference (src/http/openapi.ts)`),
    ...[...documented].filter((k) => !served.has(k)).map((k) => `${show(k)} is in the API reference (src/http/openapi.ts) but not served`),
  ];
}
