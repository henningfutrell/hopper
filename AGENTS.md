# job-hopper — repo law

Local job-queue daemon. One maintainer, loopback only, TypeScript run directly by Node ≥ 24.

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
- **Loopback only.** Binding anything but `127.0.0.1` makes authentication mandatory and
  is a different application.
- **Never write into the Jev repo.** The shim reads it; logs go to job-hopper's data dir.
- **Persisted state is the user's.** A schema change ships a migration in
  `src/store/migrations.ts`; it never drops a queue.
- Gates: `npm run typecheck`, `npm run lint`, `npm test` — all exit 0.
