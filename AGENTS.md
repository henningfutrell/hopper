# job-hopper — repo law

Local job-queue daemon that pulls its jobs. Loopback plus an opt-in LAN or public URL behind a reverse proxy, sign-in through the login code or identity providers (OIDC, GitHub, SAML). TypeScript run directly by Node ≥ 24.

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
  use the real database and the real HTTP server; fakes only at `ports.ts` seams. The suite runs on
  SQLite (`npm test`) and on Postgres (`bash scripts/test-postgres.sh`); a store change passes both.
- **Tests are sealed off from the real machine.** `test/support/isolate.ts` (vitest setup) gives
  every worker a throwaway HOME and refuses any non-loopback `fetch`. Never point a test at
  the owner's database, env file or a real URL; a test daemon once sent real Grok Bot webhooks.
  An ad-hoc daemon (own port) gets its own database (a copy, by `migrate-local`, with the Grok Bot
  variables and webhook subscribers removed), and runs network-isolated (`unshare -rn`).
- **Erasable TypeScript only** (`erasableSyntaxOnly`): no enums, no namespaces, no
  parameter properties. Relative imports carry `.ts`.
- **Loopback plus the LAN names and the public URL, and the hopper pulls.** The daemon binds `127.0.0.1`, or every
  interface only when `JOB_HOPPER_LAN_PEERS` is set; a peer outside
  loopback and the LAN peers is refused, and a LAN or public request reads `/api/` only with a UI session
  (`docs/design.md` "Reaching the UI across the LAN", issue #16). No route creates or changes a job, question, webhook or setting except
  through the UI session below: jobs come only from job sources; webhooks come only from the
  `webhooks.yaml` config document, which the UI session may edit (`POST /ui/api/webhooks`, issue #18). Every request passes the Host guard
  (`127.0.0.1:<port>` / `localhost:<port>` / a LAN name with the port / the public URL's host, else 421). The only mutations are the UI's
  `POST /ui/api/*`, behind a UI session (`x-jobhopper-session`,
  exact Origin, same-origin, JSON — else 403) whose UI role allows it; a new mutation goes there and
  nowhere else, and names its least UI role. `docs/design.md` "UI session and mutations" and
  "Sign-in: local, OIDC and SAML" state the residual risk.
- **Sign-in fails closed.** An invalid `auth.yaml` stops the daemon; an identity no role rule
  matches gets no session; sign-in is never a plugin (`docs/design.md` "Sign-in").
- **GitHub text is neutral.** Text the hopper or a job writes to GitHub names no person and
  carries no personal or machine details. The hopper writes only labels to issues, closes the
  issue of a finished job, and posts no comments. The job prompt carries the rule (`src/executors/herdr/screen.ts` `PUBLISHING_RULE`).
- **Nothing leans on the machine** (issue #40, `docs/design.md` "Deployable"). Everything the daemon
  keeps is in the database `JOB_HOPPER_DATABASE_URL` names; config is config documents in it
  (`plugins.yaml`, `webhooks.yaml`, `rules.md`, `auth.yaml`); a secret is an environment variable,
  named by a command-bearing option — never a file the daemon reads. No default names a path on one
  machine; the work dir (`JOB_HOPPER_WORK_DIR`) is scratch only. The operator CLI (`src/cli.ts`,
  `job-hopper`) writes the database directly: whoever runs it holds its credentials.
- **Never write into the Jev repo.** The shim reads it; logs go to job-hopper's work dir.
- **Persisted state is the user's.** A schema change ships a migration in
  `src/store/migrations.ts` (`SHARED`, in SQL both databases mean the same way); it never drops a
  queue. A change to persisted state outside the store's tables (a document's shape) migrates the
  documents too.
- **The UI is the one built part.** `ui/` → `npm run build:ui` → `ui/dist` (gitignored), served
  by the daemon. It imports nothing of `src/` at runtime; types only, from `src/domain/types.ts`.
- Gates: `npm run typecheck`, `npm run lint`, `npm test`, `npm run build:ui` — all exit 0
  (`npm run check` runs all four); `bash scripts/test-postgres.sh` exits 0 for any store change.
