# job-hopper — repo law

Local job-queue daemon that pulls its jobs. One maintainer, loopback only, TypeScript run directly by Node ≥ 24.

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
- **Erasable TypeScript only** (`erasableSyntaxOnly`): no enums, no namespaces, no
  parameter properties. Relative imports carry `.ts`.
- **Loopback only, and the hopper pulls.** Binding anything but `127.0.0.1` is a different
  application. No route creates or changes a job, question, webhook or setting: jobs come only
  from job sources, webhooks only from `webhooks.yaml`. Every request passes the Host guard
  (`127.0.0.1:<port>` / `localhost:<port>`, else 421). The only mutations are the UI's
  `POST /ui/api/*`, behind a UI session from the one-time login code (`x-jobhopper-session`,
  exact Origin, same-origin, JSON — else 403); a new mutation goes there and nowhere else.
  `docs/design.md` "UI session and mutations" states the residual risk.
- **Never write into the Jev repo.** The shim reads it; logs go to job-hopper's data dir.
- **Persisted state is the user's.** A schema change ships a migration in
  `src/store/migrations.ts`; it never drops a queue.
- Gates: `npm run typecheck`, `npm run lint`, `npm test` — all exit 0.
