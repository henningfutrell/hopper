# hopper — repo law

Local job-queue daemon that pulls its jobs. Loopback plus an opt-in LAN or public URL behind a reverse proxy, sign-in through realms (GitHub through the hopper's app — the main way, and the connection jobs work through —, LDAP, OIDC, SAML, or an auth gateway in front that signed people in), a device link's login code, or no sign-in; no password accounts of its own, and a fresh hopper holds no user: the first to sign in with GitHub is admin. TypeScript run directly by Node ≥ 24.

North star (owner decision): an extendable and plugin architecture; every part must serve it. `docs/design.md` "North star".

Acknowledge before working here: you have read this file, `docs/design.md`, and
`docs/glossary.md`.

## Rules

- **The glossary is the language.** `docs/glossary.md`. New term → glossary entry in the
  same change. No synonyms in code, tests, events, API, UI.
- **Directory seams are law.** `docs/design.md` "Directories and what each must not know".
  A new directory or seam updates that table in the same change.
- **The decider stays pure.** No I/O, no clock, no randomness in `src/decider/`. The
  Decision id is passed in.
- **Test first.** Failing test committed before the code that passes it. Integration tests
  use the real database and the real HTTP server; fakes only at `ports.ts` seams. Postgres is the only
  store (issue #53): `npm test` starts a throwaway Postgres container (testcontainers; needs docker),
  each test in its own schema, unless `HOPPER_TEST_POSTGRES_URL` names one.
- **Tests are sealed off from the real machine.** `test/support/isolate.ts` (vitest setup) gives
  every worker a throwaway HOME and refuses any non-loopback `fetch`. Never point a test at
  the owner's database, env file or a real URL; a test daemon once sent real Grok Bot webhooks.
  An ad-hoc daemon (own port) gets its own database (a copy, by `pg_dump` into a fresh
  database, with the Grok Bot variables and webhook subscribers removed), and runs network-isolated (`unshare -rn`).
- **Erasable TypeScript only** (`erasableSyntaxOnly`): no enums, no namespaces, no
  parameter properties. Relative imports carry `.ts`.
- **Loopback plus the LAN names and the public URL, and the hopper pulls.** The daemon binds `127.0.0.1`, or every
  interface only when `HOPPER_LAN_PEERS` is set; a peer outside
  loopback and the LAN peers is refused, and a LAN or public request reads `/api/` only with a UI session
  (`docs/design.md` "Reaching the UI across the LAN", issue #16). No route creates or changes a job, question, webhook or setting except
  through the UI session below: jobs come only from job sources; webhook subscriptions are rows in the
  database and nothing else (issue #78), which the UI session may edit (`POST /ui/api/webhooks`, issue #18). Every request passes the Host guard
  (`127.0.0.1:<port>` / `localhost:<port>` / a LAN name with the port / the public URL's host, else 421). One exception, a
  machine's (issue #308, `docs/design.md` "Joining a machine"): `POST /client/join` adds the one client target a join
  code names — the code minted through an admin's UI session or the operator CLI, kept hashed, spent by the join — and
  a machine's dial-in (`GET /client/connect`, signed with its client token) changes nothing. Every other mutation is the UI's
  `POST /ui/api/*`, behind a UI session (`x-hopper-session`,
  exact Origin, same-origin, JSON — else 403) whose UI role allows it; a new mutation goes there and
  nowhere else, and names its least UI role. `docs/design.md` "UI session and mutations" and
  "Sign-in: realms" state the residual risk.
- **Sign-in fails closed.** An invalid sign-in config stops the daemon; an identity no role rule
  matches gets no session; sign-in is never a plugin (`docs/design.md` "Sign-in"). Every sign-in
  kind uses an established library for its protocol or hash (openid-client, jose, @node-saml/node-saml,
  ldapts, @octokit/oauth-methods for GitHub's device flow, openid-client for its web flow); no hand-rolled protocol or password code. The hopper keeps no password accounts of its own (issue #237). A realm change from the UI is loaded
  before it is stored and never ends the acting admin's own admin session. No sign-in (`none`) is only ever explicit.
- **GitHub text is neutral.** Text the hopper or a job writes to GitHub names no person and
  carries no personal or machine details. The hopper writes only labels to issues, never closes
  one (the merge of a job's pull request does), and posts no comments. One exception, the user's Run again
  (issue #354): it reopens the job's closed issue, so the new job can finish against it. The default job rules carry the rule (`src/job-rules/` `DEFAULT_JOB_RULES`); the job rules are the owner's to edit (issue #172).
- **Nothing leans on the machine** (issue #40, `docs/design.md` "Deployable"). Everything the daemon
  keeps is in the database `HOPPER_DATABASE_URL` names; config is config records in it — JSON values
  (`plugins`, `rules`, `job-rules`, `sign-in`), every setting edited in the UI, none set only in a file, no YAML
  (issue #198) — and the webhook subscriptions, rows of its own. **Every secret comes from the runtime**
  (issue #56): the variable `NAME` or the mounted file `NAME_FILE` names (`src/secrets/runtime.ts`),
  named by a command-bearing option. The hopper stores no secret — not in the database, not in a file
  of its own; a token or code it mints is only hashed (`docs/design.md` "Secrets"). One exception, by
  owner direction (issue #216): a realm's own secrets (`clientSecret`, `bindPassword`) are stored in the
  database, set in the UI or from the `HOPPER_SIGN_IN_*` environment, and never answered back by any route. A second: a **connected account**'s token (issue #214), which the
  provider grants the hopper's app and no runtime holds — kept in that user's schema, never answered
  by any route. A third (issue #293: the hopper runs in ephemeral containers with no durable `~/.ssh`): the
  **hopper's ssh key**, minted by the hopper when the runtime mounts none, kept in that user's schema,
  written to the work dir for ssh at each start, and never answered by any route but its public half. A fourth, for the
  same reason (issue #308): the hopper's **link key** for each user, the private half of the key a machine's client token is
  derived from, kept in that user's schema and never answered by any route but its public half. No default names a path on one
  machine; the work dir (`HOPPER_WORK_DIR`) is scratch only. The operator CLI (`src/cli.ts`,
  `hopper`) writes the database directly: whoever runs it holds its credentials. Its operator actions
  (`job`, `queue`, `question`, issue #374) change no job, question or setting themselves: each mints a UI session in the database for one
  `POST /ui/api/*` on the running daemon, and drops it after.
- **Never write into the Jev repo.** The shim reads it; logs go to hopper's work dir.
- **Persisted state is the user's.** A schema change ships a migration in
  `src/store/migrations.ts` (`SHARED`, in SQL both databases mean the same way); it never drops a
  queue. A change to persisted state inside a config record (its value's shape) migrates the
  records too.
- **The UI is the daemon's one built part.** `ui/` → `npm run build:ui` → `ui/dist` (gitignored), served
  by the daemon. It imports nothing of `src/` at runtime; types only, from `src/domain/types.ts`.
  The GitHub Pages site is built too (`npm run build:site` → `site/dist`, gitignored), for Pages only,
  never served by the daemon; it takes its look from `ui/src/index.css` and nothing of `src/`.
- **What's new.** A change people who use the hopper would notice adds one line at the top of
  `WHATS-NEW.md`, in the same change: plain words for a non-technical reader, what they can now do
  or what now works. No issue or PR numbers, hashes, file names or code words; never edit a
  released line (the update notice shows the lines the installed version lacks). Internal-only
  changes add none. `docs/design.md` "Self-update".
- Gates: `npm run typecheck`, `npm run lint`, `npm test`, `npm run build:ui` — all exit 0
  (`npm run check` runs all four).
