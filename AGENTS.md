# hopper — repo law

Local job-queue daemon that pulls its jobs. Loopback plus an opt-in LAN or public URL behind a reverse proxy, sign-in through the login code, no sign-in, or realms (LDAP, OIDC, GitHub, SAML, or an auth gateway in front that signed people in); no password accounts of its own, and a fresh hopper bootstraps with the login code. TypeScript run directly by Node ≥ 24.

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
  (`127.0.0.1:<port>` / `localhost:<port>` / a LAN name with the port / the public URL's host, else 421). The only mutations are the UI's
  `POST /ui/api/*`, behind a UI session (`x-hopper-session`,
  exact Origin, same-origin, JSON — else 403) whose UI role allows it; a new mutation goes there and
  nowhere else, and names its least UI role. `docs/design.md` "UI session and mutations" and
  "Sign-in: realms" state the residual risk.
- **Sign-in fails closed.** An invalid sign-in config stops the daemon; an identity no role rule
  matches gets no session; sign-in is never a plugin (`docs/design.md` "Sign-in"). Every sign-in
  kind uses an established library for its protocol or hash (openid-client, jose, @node-saml/node-saml,
  ldapts); no hand-rolled protocol or password code. The hopper keeps no password accounts of its own (issue #237). A realm change from the UI is loaded
  before it is stored and never ends the acting admin's own admin session. No sign-in (`none`) is only ever explicit.
- **GitHub text is neutral.** Text the hopper or a job writes to GitHub names no person and
  carries no personal or machine details. The hopper writes only labels to issues, never closes
  one (the merge of a job's pull request does), and posts no comments. The job prompt carries the rule (`src/executors/herdr/screen.ts` `PUBLISHING_RULE`).
- **Nothing leans on the machine** (issue #40, `docs/design.md` "Deployable"). Everything the daemon
  keeps is in the database `HOPPER_DATABASE_URL` names; config is config records in it — JSON values
  (`plugins`, `rules`, `sign-in`), every setting edited in the UI, none set only in a file, no YAML
  (issue #198) — and the webhook subscriptions, rows of its own. **Every secret comes from the runtime**
  (issue #56): the variable `NAME` or the mounted file `NAME_FILE` names (`src/secrets/runtime.ts`),
  named by a command-bearing option. The hopper stores no secret — not in the database, not in a file
  of its own; a token or code it mints is only hashed (`docs/design.md` "Secrets"). One exception, by
  owner direction (issue #216): a realm's own secrets (`clientSecret`, `bindPassword`) are stored in the
  database, set in the UI or from the `HOPPER_SIGN_IN_*` environment, and never answered back by any route. No default names a path on one
  machine; the work dir (`HOPPER_WORK_DIR`) is scratch only. The operator CLI (`src/cli.ts`,
  `hopper`) writes the database directly: whoever runs it holds its credentials.
- **Never write into the Jev repo.** The shim reads it; logs go to hopper's work dir.
- **Persisted state is the user's.** A schema change ships a migration in
  `src/store/migrations.ts` (`SHARED`, in SQL both databases mean the same way); it never drops a
  queue. A change to persisted state inside a config record (its value's shape) migrates the
  records too.
- **The UI is the one built part.** `ui/` → `npm run build:ui` → `ui/dist` (gitignored), served
  by the daemon. It imports nothing of `src/` at runtime; types only, from `src/domain/types.ts`.
- **What's new.** A change people who use the hopper would notice adds one line at the top of
  `WHATS-NEW.md`, in the same change: plain words for a non-technical reader, what they can now do
  or what now works. No issue or PR numbers, hashes, file names or code words; never edit a
  released line (the update notice shows the lines the installed version lacks). Internal-only
  changes add none. `docs/design.md` "Self-update".
- Gates: `npm run typecheck`, `npm run lint`, `npm test`, `npm run build:ui` — all exit 0
  (`npm run check` runs all four).
