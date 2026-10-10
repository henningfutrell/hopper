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
  a machine's dial-in (`GET /client/connect`, signed with its client token) changes nothing. A running job's (issue #563,
  `docs/design.md` "GitHub through the hopper"): `POST /job/github`, with the job's proxy token — derived, never stored,
  honoured only while the job is at work — asks the hopper to act on GitHub with its own connection; it changes no job,
  question, webhook or setting, only records what it did. A running job's git (issue #652, `docs/design.md` "Git through the
  hopper"): `GET`/`POST /job/git/<owner>/<name>.git/…`, git's smart HTTP with the job's proxy token as its password, fetches
  and pushes on GitHub with the job's own user's connection — a push only to a branch of the job's own repository, never its
  default or a release branch —; it changes no job, question, webhook or setting, only records a push. **A job holds no
  GitHub token** (issue #652): no `GH_TOKEN`, no gh config, no ssh agent. A box's vault ask (issue #558, `docs/design.md` "The vault"):
  `POST /client/vault`, signed with its client token and carrying the job's proxy token, is answered a vault secret
  sealed to that request; it records only the delivery or refusal. A running job's skill request (issue #582, `docs/design.md` "Skills: what the
  hopper can set up for a box"): `POST /job/skill`, with the job's proxy token, answers the skill catalog, a skill, or a no
  with its reason, after Access for a link; it records only the request and its answer. When the skill needs a
  credential the box's template does not give (issue #583, `docs/design.md` "The dynamic vault"), it opens a credential
  request in memory and answers that a person is asked; a person answers it through `POST /ui/api/vault`. A running job's
  stream (issue #613, `docs/design.md` "The job stream"): `GET /job/stream` and `GET /job/stream/results/:seq`, with the
  job's proxy token, serve the job its own stream events and results, kept in the database; they change nothing. A running
  job's artifacts (issue #624, `docs/design.md` "Artifacts"): `/job/artifacts`, with the job's proxy token, puts, shares, revokes
  and removes that user's artifacts, each an event on the job's timeline; it changes no job, question, webhook or setting. Their
  content is served off `/api/`, at `/artifact-content/` (a URL a read signed for one viewer, for an hour) and `/artifact-link/`
  (a public link), under a sandbox policy; they change nothing. Every other mutation is the UI's
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
  one (the merge of a job's pull request does), and posts no comments. Four exceptions, each the user's own act or setting: with
  yolo mode on for a repository (issue #637), the hopper merges a done job's ready pull request that it follows — not a draft, no
  merge conflicts, a check passed on it (issue #652: no checks is not passing) —, a merge commit, and that merge closes the issue as a person's would; Run again
  (issue #354) reopens the job's closed issue, so the new job can finish against it; Assign to me in Sources (issue #440)
  assigns a labelled issue to the user's connected account; resolving a hand-off in Needs a person (issue #551) posts one
  short comment — what was done, the person's note and link, naming no person, the resolver included — and sets the end
  label (`hopper:done`, `hopper:rejected`) in place of `hopper:failed`. A job's own request through the GitHub proxy (issue #563) is
the job's act, as when it pushes: its text is the job's, under the publishing rule; an issue filed that way ends with the
hopper's note naming the job and the request by id only, and gets no label or assignee. The default job rules carry the rule (`src/job-rules/` `DEFAULT_JOB_RULES`); the job rules are the owner's to edit (issue #172).
- **Nothing leans on the machine** (issue #40, `docs/design.md` "Deployable"). Everything the daemon
  keeps is in the database `HOPPER_DATABASE_URL` names; config is config records in it — JSON values
  (`plugins`, `rules`, `job-rules`, `sign-in`), every setting edited in the UI, none set only in a file, no YAML
  (issue #198) — and the webhook subscriptions, rows of its own. **Two kinds of secret** (issue #451, `docs/design.md`
  "Secrets"). A credential the hopper is *given* for an outside service comes from the runtime: the variable
  `NAME` or the mounted file `NAME_FILE` names (`src/secrets/runtime.ts`), named by a command-bearing
  option. A secret the hopper *owns* — one made by or for the hopper (a webhook signing secret), or one
  only it holds (a **connected account**'s token, issue #214; a **vault secret**, issue #558, set in the UI for jobs) — is kept in the database, **sealed** under
  the master key `HOPPER_MASTER_KEY` (`src/secrets/sealer.ts`: a key per value from the master key
  and a salt, AES-256-GCM, bound to its place, a key id for rotation), never logged, never
  in an event, and never answered by any route but, once, a secret the hopper made in the answer that made
  it. A value that cannot be opened is said so, never read as no secret. A token or code it mints is only
  hashed. **Every secret the hopper owns for itself is a system secret** (issues #657, #658, `docs/design.md`
  "The vault's system scope"): the GitHub connection's access and refresh tokens, each webhook signing secret and each
  user's TypeSafe API key in that user's vault, each sign-in realm's `clientSecret` or `bindPassword` (set in the UI or
  from the `HOPPER_SIGN_IN_*` environment) in the instance's vault — rows named `system/<name>`, sealed, written only
  through `SystemSecrets.keep` (src/vault/system.ts), each set, replace, rotation, removal, move and read an event with no
  value, shown with its audit trail on Settings → Vault, and never given to a job, a machine or a box: OpenFGA
  (`system_secret#can_read`) denies them, and the vault refuses them whatever it answers. None is kept in clear: without
  the master key (limited, issue #659) none is kept or opened, and a realm's secret given meanwhile stays in the `sign-in`
  record until the next start with the key moves it. The master key itself stays outside every vault (given at launch). Kept in that user's schema, never answered by any route but its public half: the
  **hopper's ssh key** (issue #293: the hopper runs in ephemeral containers with no durable `~/.ssh`), minted
  when the runtime mounts none and written to the work dir for ssh at each start; and the hopper's **link
  key** for each user (issue #308), the private half of the key a machine's client token is derived from.
  No default names a path on one
  machine; the work dir (`HOPPER_WORK_DIR`) is scratch only. The operator CLI (`src/cli.ts`,
  `hopper`) writes the database directly: whoever runs it holds its credentials. Its operator actions
  (`job`, `queue`, `question`, issue #374) change no job, question or setting themselves: each mints a UI session in the database for one
  `POST /ui/api/*` on the running daemon, and drops it after.
- **Never write into the Jev repo.** The shim reads it; logs go to hopper's work dir.
- **Persisted state is the user's.** A schema change ships a migration in
  `src/store/migrations.ts` (`SHARED`, in SQL both databases mean the same way); it never drops a
  queue. A change to persisted state inside a config record (its value's shape) migrates the
  records too. A migration leaves a store the build before it still runs on: a hopper moved to a
  steadier update channel runs that channel's older build on the migrated store (`docs/deploy.md`
  "Update channels and promotion").
- **Changes reach people dev → beta → stable.** Pull requests merge to `dev`, the default branch;
  `beta` and `stable` move only by `scripts/promote.sh`, one step at a time.
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
