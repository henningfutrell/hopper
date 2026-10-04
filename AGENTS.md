# job-hopper — repo law

Local job-queue daemon that pulls its jobs. One maintainer, loopback plus an opt-in LAN, TypeScript run directly by Node ≥ 24.

North star (the owner): an extendable and plugin architecture; every part must serve it. `docs/design.md` "North star".

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
  use the real SQLite file and the real HTTP server; fakes only at `ports.ts` seams.
- **Tests are sealed off from the real machine.** `test/support/isolate.ts` (vitest setup) gives
  every worker a throwaway HOME and refuses any non-loopback `fetch`. Never point a test at
  `~/.config/job-hopper` or a real URL; a test daemon once sent real Grok Bot webhooks.
  An ad-hoc daemon (own port) gets a copy of the config with `grokbot-webhook.env` and webhook
  subscribers removed, and runs network-isolated (`unshare -rn`).
- **Erasable TypeScript only** (`erasableSyntaxOnly`): no enums, no namespaces, no
  parameter properties. Relative imports carry `.ts`.
- **Loopback plus the LAN names, and the hopper pulls.** The daemon binds `127.0.0.1`, or every
  interface only when `JOB_HOPPER_LAN_NAMES` and `JOB_HOPPER_LAN_PEERS` are set; a peer outside
  loopback and the LAN peers is refused, and a LAN request reads `/api/` only with a UI session
  (`docs/design.md` "Reaching the UI across the LAN", issue #16). No route creates or changes a job, question, webhook or setting: jobs come only
  from job sources, webhooks only from `webhooks.yaml`. Every request passes the Host guard
  (`127.0.0.1:<port>` / `localhost:<port>` / a LAN name with the port, else 421). The only mutations are the UI's
  `POST /ui/api/*`, behind a UI session from the one-time login code (`x-jobhopper-session`,
  exact Origin, same-origin, JSON — else 403); a new mutation goes there and nowhere else.
  `docs/design.md` "UI session and mutations" states the residual risk.
- **Never write into the Jev repo.** The shim reads it; logs go to job-hopper's data dir.
- **Persisted state is the user's.** A schema change ships a migration in
  `src/store/migrations.ts`; it never drops a queue.
- **The UI is the one built part.** `ui/` → `npm run build:ui` → `ui/dist` (gitignored), served
  by the daemon. It imports nothing of `src/` at runtime; types only, from `src/domain/types.ts`.
- Gates: `npm run typecheck`, `npm run lint`, `npm test`, `npm run build:ui` — all exit 0
  (`npm run check` runs all four).
