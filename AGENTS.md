# hopper — repo law

Local job-queue daemon that pulls its jobs. Loopback plus an opt-in LAN or public URL behind a reverse proxy, sign-in through realms (GitHub through the hopper's app — the main way, and the connection jobs work through —, LDAP, OIDC, SAML, or an auth gateway in front that signed people in), the hopper's own local accounts (an email and a password or a passkey, issue #1380), a device link's login code, or no sign-in; a fresh hopper holds no user: the first to sign in with GitHub is admin, or the operator CLI adds the first admin's local account. TypeScript run directly by Node ≥ 24.

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
  every worker a throwaway HOME and refuses any connection or DNS lookup off loopback, from any client and in every
  node process a test starts (`test/support/network-guard.ts`, issue #1955; the `HOPPER_TEST_*` services excepted). Never point a test at
  the owner's database, env file or a real URL; a test daemon once sent real Grok Bot webhooks.
  An ad-hoc daemon (own port) gets its own database (a copy, by `pg_dump` into a fresh
  database, with the Grok Bot variables and webhook subscribers removed), and runs network-isolated (`unshare -rn`).
- **Erasable TypeScript only** (`erasableSyntaxOnly`): no enums, no namespaces, no
  parameter properties. Relative imports carry `.ts`.
- **Loopback plus the LAN names and the public URL, and the hopper pulls.** The daemon binds `127.0.0.1`, or every
  interface only when `HOPPER_LAN_PEERS` is set; a peer outside
  loopback and the LAN peers is refused, and a LAN or public request reads `/api/` only with a UI session
  (`docs/design.md` "Reaching the UI across the LAN", issue #16) — one exception, a LAN `GET /api/health`, which answers
  without a session the instance's health only, `{ ok, version, uptimeS }` (issue #712). The **health port** (issue #1383, `HOPPER_HEALTH_PORT`): the held-loop thread answers `GET /api/health` on `127.0.0.1` at that port only, a loopback Host only, the same instance health and how long the event loop is held (503 while it is); it serves nothing else, and changes and records nothing. No route creates or changes a job, question, webhook or setting except
  through the UI session below: jobs come only from job sources; webhook subscriptions are rows in the
  database and nothing else (issue #78), which the UI session may edit (`POST /ui/api/webhooks`, issue #18). Every request passes the Host guard
  (`127.0.0.1:<port>` / `localhost:<port>` / a LAN name with the port — this host's tailnet names and addresses and the admin's allowed hosts count as LAN names, and while it is on a tailnet a peer in Tailscale's ranges as a LAN peer (issue #1024) — / the public URL's host / the remote access domain while remote access is on (issue #880), else 421). One exception, a
  machine's (issue #308, `docs/design.md` "Joining a machine"): `POST /client/join` adds the one client target a join
  code names — the code minted through an admin's UI session or the operator CLI, kept hashed, spent by the join — and
  a machine's dial-in (`GET /client/connect`, signed with its client token) changes nothing. A running job's (issue #563,
  `docs/design.md` "GitHub through the hopper"): `POST /job/github`, with the job's proxy token — derived, never stored,
  honoured only while the job is at work, and after a lost-machine move only the new run's (issue #1569) — asks the hopper to act on GitHub with the job's own user's connection (issue #1380) — the connected account of the repository it names, else of the job's own (issue #1448) —; it changes no job,
  question, webhook or setting, only records what it did. A running job's git (issue #652, `docs/design.md` "Git through the
  hopper"): `GET`/`POST /job/git/<owner>/<name>.git/…`, git's smart HTTP with the job's proxy token as its password, fetches
  and pushes on GitHub with the job's own user's connection (the account of the repository, issue #1448) — a push only to a branch of a repository its user can push to, as GitHub says (issue #1806: its own, another job repository,
  the user's fork, or a repository the hopper does not work on; a fork's pull request only with the user's **Contribution** on, issue #429,
  `docs/design.md` "The contribution flow"), never its
  default or a release branch — but, with the user's **direct push** on for the repository (issue #1806, `docs/design.md` "Direct push", off unless a person names it), its target branch (the landing branch, else the default branch), only as a fast-forward the hopper checked —, and never a push that brings in its base branch (its pull request's, else the landing branch) and empties or shrinks a file the branch's own change
  did not, or empties a file it only shrank (the shrink guard, issues #1096, #1218; the hopper's own base merge is judged so too, `docs/design.md` "The shrink guard") —; it changes no job, question, webhook or setting, only records a push. A running
  GitLab job's git (issue #1448, `docs/design.md` "Jobs through GitLab"): `GET`/`POST /job/gitlab-git/<project>.git/…`, the same
  with the job's proxy token, fetches and pushes on GitLab with the token of its own user's GitLab account — a push only to a
  branch of the job's own project, never its default or a release branch, its push options (the merge request) as git sent them —;
  it changes no job, question, webhook or setting, only records a push. **A job holds no
  GitHub or GitLab token** (issues #652, #1448): no `GH_TOKEN`, no gh config, no ssh agent. A **direct query**'s job (issue #2184,
  `docs/design.md` "Direct queries") only reads: the GitHub proxy refuses its every write and the git proxy its every push. A box's vault ask (issue #558, `docs/design.md` "The vault"):
  `POST /client/vault`, signed with its client token and carrying the job's proxy token, is answered a vault secret
  sealed to that request; it records only the delivery or refusal. **The vault gives only to a job a person granted it**
  (issue #652, `docs/design.md` "Vault grants"): a box job's item with no **vault grant** is refused and becomes a grant
  ask; Grant and Revoke are a person's acts through the UI session, after Access (`vault_grant#can_grant`); a job asks,
  never grants. One exception, the user's own setting: the **standing read grant** (issue #1472, off by default), an admin's
  toggle with the sandbox approvals, grants a job on a box of a template whose needs the read policy holds entirely as reads,
  with no vault secret, and records it as `vault.granted` by the setting; a template with a write, sync or apply, a read
  outside the policy or a secret still waits for a person's grant, and turned off it grants no job that has not asked yet. A **step schedule**'s runs (issue #2716, `docs/design.md` "Step schedules") have no job: they get the
  vault secrets their template gives only after a person's **schedule grant**, after Access (`vault_grant#can_grant`), never by a
  delegate approver; a save that changes what the schedule runs takes it back; a scheduled run gets no minted credential. Only a box's jobs get the vault's helper (`HOPPER_SECRET`). A running job's skill request (issue #582, `docs/design.md` "Skills: what the
  hopper can set up for a box"): `POST /job/skill`, with the job's proxy token, answers the skill catalog, a skill, or a no
  with its reason, after Access for a link; it records only the request and its answer. When the skill needs a
  credential the box's template does not give (issue #583, `docs/design.md` "The dynamic vault"), it opens a credential
  request in memory and answers that a person is asked; a person answers it through `POST /ui/api/vault`. A **template
  request** (issue #716, `docs/design.md` "Templates on request"), `sandbox-template` with the job's needs, saves the
  template those needs name through the vault's own save, never widening one a person changed, and approves it only when
  it makes it now and the user's **read policy** holds every need as a read, or, with the user's **skip template approval**
  on (issue #991), as it is with its profiles, `by` that toggle — never one with a database need (issue #2231) —; it never approves anything else. A template of
  read needs only takes no box until its read-only check passed (issue #716, `docs/design.md` "The read-only check"). A
  **sandbox request** (issue #991, `docs/design.md` "Sandboxes jobs start"), `sandbox` with the job's needs, asks for that
  template as above, then for a box of it: kept in memory, it waits for a person (`POST /ui/api/sandbox-requests`, a box
  action) unless the user's **skip sandbox approval** is on, and the box starts through the sandbox module only once
  approved. A **bastion** (issue #2146, `docs/design.md` "Bastions"), `bastion` with a template and its targets, starts only once the job's sandbox runs of that template are approved and it is ready: one need box that holds `kubectl port-forward` to each target inside it, its kube tokens minted for the template's **observe** profiles and renewed by the hopper as files in the box, never given to the job; it ends with its TTL, its job or the job's stop. A running job's relay (issue #2146 part 2): `GET /job/relay`, an HTTP/1.1 upgrade with the job's proxy token, only while it is at work, joins the job's connection to one target of its own bastion through a command the hopper starts in the bastion's box; only to a **bastion target** a person approved with its template, after Access (`bastion#can_relay`, issue #2146 part 3) for each connection, which is recorded; it changes no job, question, webhook or setting. A **bastion read** (issue #2146 part 6) is such a connection whose command the hopper starts: curl in the box, a GET or a POST to Grafana's `/api/ds/query` only, with the header of a vault secret the job named for its bastion — one its template gives, read for the box after the job's vault grant, a file in the box, never in its environment and never to the job —; the job gets the answer, and the read is recorded. A **database read** (issue #2231, `docs/design.md` "Database reads"), `database read` with a template, a database and one SELECT, runs only after a person approved the template's read on that database (no policy or toggle approves it) and Access allows it: the vault mints a database read role in the database from its minting credential — SELECT only on the schemas and tables the credential names, read-only, `VALID UNTIL` its TTL (on SQL Server a login and its user, checked to change nothing, the sweep its TTL) —, the hopper runs the statement with it in a read-only transaction (on SQL Server one rolled back) and drops the role; the job gets the rows as CSV, never a credential, and the read is recorded with its SQL. The toggles (`POST /ui/api/sandbox-approvals`, a box action; both is sandbox YOLO) are an admin's; a job never
  sets one, approves its own request, or names an image, a flag or a launch parameter. A running job's
  stream (issue #613, `docs/design.md` "The job stream"): `GET /job/stream` and `GET /job/stream/results/:seq`, with the
  job's proxy token, serve the job its own stream events and results, kept in the database; they change nothing. A running job's
  login outcome (issue #1110, `docs/design.md` "Logins"): `POST /job/login`, with the job's proxy token, says one of the job's own
  logins went through or did not, which completes, fails or reopens it; it changes no job, question, webhook or setting. A job resuming
  elsewhere (issue #921, `docs/design.md` "Checkpoints and resume elsewhere"): `GET /job/checkpoint/patch|session`, with the
  job's proxy token, serves that job its own checkpoint, scrubbed, only while it runs resuming elsewhere; it changes nothing. A running job's
  topology read (issue #1905, `docs/design.md` "The infrastructure topology"): `GET /job/topology`, with the job's proxy token, only while
  it is at work, serves its user's topology graph as `GET /api/topology` does; it changes and records nothing. A running job's push requirements
  (issue #2555, `docs/design.md` "Push requirements"): `POST /job/requirements`, with the job's proxy token, only while it is at
  work, answers its branch's base, which of the requirements of its commit apply, and judges and records the job's own
  evaluation of them (`push_requirements.evaluated`, never a check's output); the checks run on the job's machine, never on the
  hopper's. The git proxy takes a push of a commit that holds a requirements file only after a passing evaluation of it; it
  changes no job, question, webhook or setting. A running job's heavy steps (issue #2622,
  `docs/design.md` "The heavy-step gate"): `POST /job/heavy`, with the job's proxy token, only while it is at work, takes,
  renews and lets go a slot of its host's memory for a heavy step, kept in memory; it changes and records nothing. A running job's
  park (issue #2167, `docs/design.md` "Parking a proposal or a research report"): `GET`/`POST /job/park`, with the job's proxy token, only
  while it is at work, lists its user's open proposals and research reports, and parks one whose job waits on it or picks up one a job
  parked — never a running job, never itself, never an item a person parked —, kept as `job <its id>`, `via` `job`; it decides no item and
  changes no other job, question, webhook or setting. A running job's egress (issue #2849,
  `docs/design.md` "A job's egress allowlist"): `GET /job/egress?to=<host>:<port>`, an HTTP/1.1 upgrade with the job's proxy token, only while it is at work,
  is joined by the hopper to that host only when its user's **job egress allowlist** holds it for the job's repository — never a listed name that
  resolves to a loopback or link-local address —; a refusal is recorded once on the job (`job.egress_denied`); it changes no job, question, webhook or setting. A machine's address check (issue #698,
  `docs/design.md` "GitHub through the hopper"): `GET /job/address` answers 204 to anyone the Host guard lets in, so an ssh
  target's probe learns which of the hopper's addresses its jobs reach; it changes and records nothing. A GitHub delivery (issue #1079,
  `docs/design.md` "GitHub deliveries"): `POST /github/webhook`, signed with the GitHub webhook secret (HMAC-SHA256, a system
  secret the hopper's admin makes through the UI session), only GitHub's `issues` events, makes the repository it names due
  at the sources whose job repository it is, so they list it again at a sync soon after; it changes no job, question,
  webhook or setting, only records the delivery and, for an issue closed or reopened that is a work item, that close or
  reopen (issue #1067), which moves the item in the work-item ledger. The hopper still pulls: a delivery never carries a job. The tunnel
  services' ask (issues #880, #968, `docs/design.md` "Remote access"): `GET /tunnel/agent`, with the preshared key the
  compose stack makes in memory (`HOPPER_TUNNEL_KEY`), never as a public request, answers the tunnel token the hopper
  minted (and for ngrok the remote access URL) to the service of the tunnel provider that is on; it changes no job,
  question, webhook or setting, only records in memory when each service asked and what it said of its agent. Remote
  access itself — the provider, its one credential, on or off, which mints or releases the tunnel at the provider — is
  set only through the UI session, by the hopper's admin. A running
  job's artifacts (issue #624, `docs/design.md` "Artifacts"): `/job/artifacts`, with the job's proxy token, puts, shares, revokes
  and removes that user's artifacts, each an event on the job's timeline; it changes no job, question, webhook or setting. Their
  content is served off `/api/`, at `/artifact-content/` (a URL a read signed for one viewer, for an hour) and `/artifact-link/`
  (a public link), under a sandbox policy; they change nothing. A running job's Windows sandbox step (issue #731,
  `docs/design.md` "Windows sandbox steps"): `GET`/`POST /job/step` and `GET /job/step/:id`, with the job's proxy token,
  run one step on a Windows host the user set up, over ssh with the hopper's own key and the host's pinned key, and answer
  its output, exit code and outputs; it changes no job, question, webhook or setting, only records the step. A step's vault
  secret goes only to the step, on its ssh connection's stdin, never to the job: one its host's `secrets` names, after the job's
  vault grant. A Windows host is a config record (`windows-hosts`), set through the UI session or the operator CLI. A running job's
  box step (issue #1004, `docs/design.md` "Box steps"): the same routes with `box=`, run one command in a sandbox box the job's own
  sandbox request started, through that box's container runtime beside the hopper, and answer its output, exit code and outputs; it
  changes no job, question, webhook or setting, only records the step. While it runs, the box's vault helper asks for that job, as for
  a job on the box, after the same checks and the job's vault grant; a box step takes no `--secret`. The vault secrets its template
  gives go into its need box beside the hopper, after the job's vault grant, by a copy, never in its environment and never to the job (issue #1875). A Windows, need or box step is kept
  (issues #1568, #1611, `docs/design.md` "Need steps kept as sagas", "Windows steps kept as sagas"): its ask carries the job's key and is answered 202, its saga runs it on
  any host, and the job reads `GET /job/step/:id/log` and stops it with `DELETE /job/step/:id`, its own step only. Every other mutation is the UI's
  `POST /ui/api/*`, behind a UI session (`x-hopper-session`,
  exact Origin, same-origin, JSON — else 403) or an **API token** (issue #718, `docs/design.md` "API tokens":
  `Authorization: Bearer hopper_at_…`, JSON; a session of kind `api`, kept hashed, the admin's API-token lifetime at most
  (5–15 minutes), its role no higher than its minter's, refreshed from a **grant** a person minted from a UI session (issue
  #881, `docs/design.md` "Grants and refresh tokens": `POST /ui/auth/token/refresh` with a one-time refresh token, only
  its hash kept; a spent one sent again ends the grant; or one an agent asked for at `POST /ui/auth/device-grant`, which a
  person approved by its user code through the UI session, never an API token, and the agent takes once at its poll, issue
  #892, `docs/design.md` "Grants by device approval"; a **bound grant**'s refresh and each use of its tokens, `Authorization: DPoP`,
  need a DPoP proof of its agent's key, `docs/design.md` "Sender binding"; a **limited grant**'s mutations act only on the
  repositories and job sources it names, `docs/design.md` "Grant limits") or exchanged at `POST /ui/auth/api-token` for a sign-in the API door
  accepts, never by another API token; a grant's token uses only the routes its scopes name, deny by default; Access decides
  each use, `api_token#can_view|can_operate|can_administer`) whose UI role allows it. A
  **box action** (issue #795: starts a job, runs a command, approves or merges, updates, changes the work on a machine) also
  needs a **box token**, a box grant's: list a new such route in `BOX_ACTIONS` (`src/http/ui/box-actions.ts`) in the same change. A
  new mutation goes there and nowhere else, and names its least UI role, so every action a person has in the UI an agent has
  over the API. A job's own proxy token is no API token: a job asks the hopper, never acts on the vault or a box itself. `docs/design.md` "UI session and mutations" and
  "Sign-in: realms" state the residual risk.
- **Sign-in fails closed.** An invalid sign-in config stops the daemon; an identity no role rule
  matches gets no session; sign-in is never a plugin (`docs/design.md` "Sign-in"). Every sign-in
  kind uses an established library for its protocol or hash (openid-client, jose, @node-saml/node-saml,
  ldapts, @octokit/oauth-methods for GitHub's device flow, openid-client for its web flow, @simplewebauthn/server for a local account's passkey); no hand-rolled protocol or password code. The hopper's own **local accounts** (issue #1380, `docs/design.md` "Local accounts") keep only a salted scrypt hash, made by Node's crypto; an admin never sets the password of one that signs in as another user. A realm change from the UI is loaded
  before it is stored and never ends the acting admin's own admin session. No sign-in (`none`) is only ever explicit.
- **Jobs come only from a trusted origin** (issue #652, `docs/design.md` "Trusted origin and request cards"): an issue
  becomes a job only when the user's trusted actors — Access decides (OpenFGA `intake#can_start_jobs`) — wrote, labelled
  and assigned it — or, in place of the assignment, the user's connected account nominated it by a **comment command** (`/hopper run|research|propose`,
  its newest one, not edited since; issue #655 part 21, `docs/design.md` "Trust stamps") —, not through an app or as a bot, nobody but them edited its title or body (issue #655 part 17), and no job filed it;
  a job writes no comment command (the GitHub proxy refuses it); any other is a request card a person approves, and
  its job runs the approved text. A GitLab issue (issue #1448, `docs/design.md` "Jobs through GitLab") becomes a job only when
  the user's GitLab account — Access decides (`intake#can_start_jobs`, a `gitlab_account` by its GitLab and user id) — wrote,
  labelled and assigned it, and nobody else edited its title or description; any other is a request card a person approves, as on GitHub, and its job runs the approved text (issue #1642). Approve is a person's act through the UI session, never a job's. One exception, the
  user's own setting: **auto-approval** (issue #1268, `docs/design.md` "Auto-approval", on by default) approves a card a
  trusted actor reopened, wrote or labelled `hopper:high`, or a listed app wrote, and records it as an approval; a card a
  job filed, that someone else edited, or that a person took into Intake still waits; a GitLab card only when a trusted actor wrote it or labelled it `hopper:high` (issue #1642). The origin gates the job,
  not its merge: yolo mode merges a job's ready pull request whatever its origin (issue #805). No OpenFGA trusts nobody.
- **GitHub text is neutral.** Text the hopper or a job writes to GitHub names no person and
  carries no personal or machine details. The hopper writes only labels to issues, never closes
  one (the merge of a job's pull request does), and posts no comments. On GitLab (issue #1448) it writes only its labels to an
  issue, with no exception, and a GitLab job's merge request text is under the publishing rule; with yolo mode on (issue #1642), the hopper merges a done GitLab job's ready merge request it follows — not a draft, no merge conflicts, its pipeline passed, or none started within two minutes of its last change, and its job's done criteria met with none that says a person merges it (issue #1924) —, at the head it read. Eleven exceptions, each the user's own act or setting: with
  yolo mode on for a repository (issue #637; on a repository the hopper does not work on, only one a person named on, issue #1806), the hopper merges a done job's ready pull request that it follows — not a draft, no
  merge conflicts, its checks passed — or it has none, and none started within two minutes of its last push (issue #677; issue #652 had none wait), and its job's done criteria met with none that says a person merges it (issue #1924) —, a merge commit, and that merge closes the issue as a person's would; Merge now and Close PR on a Pull requests card or `hopper pr merge|close`
  (issue #677) merge, on the same path whatever yolo mode and the checks say, or close without a merge, a job's open pull request, as a person's act; after either merge — yolo mode or Merge now — of a pull request that did not close its issue and is no part ("Part of #N"), the hopper closes the issue as completed and posts one comment that links the pull request (issue #677), so the merge finishes the issue as the user's setting or act asked; Run again
  (issue #354) reopens the job's closed issue, so the new job can finish against it, and assigns it to the user's connected account when it is no longer (issue #1010) — so does tending, which runs it again; Assign to me in Sources (issue #440)
  assigns a labelled issue to the user's connected account; Take into Intake on a Not tracked pull request (issue #1176) gives the issue it closes, which is no work item, the hopper label and assigns it so, and Intake lists it as a request card; Decline on a request card (issue #1710, `docs/design.md` "Decline") takes the source's label off the issue — with the person's choice Close, also its priority labels and `hopper:done`, and closes it as not planned — and posts one fixed comment that says what the hopper did and how to queue it again, naming no person and never quoting the issue; resolving a hand-off in Needs a person (issue #551) posts one
  short comment — what was done, the person's note and link, naming no person, the resolver included — and sets the end
  label (`hopper:done`, `hopper:rejected`) in place of `hopper:failed`; Report a bug (issue #694) files the person's own bug report on the hopper's repository through their own connection — an issue labelled `user-report`, no assignee, or a comment on a similar open one —, only while the user's **public bug reports** are on (issue #2818, off until an admin turns them on), its text the fixed template (a short title and description, the OS and the hopper's version), scrubbed of identifiers and masked, as they read it before sending; a running job's report on itself (`hopper-gh report bug`) goes the same way through its user's connection, its private work and identifiers removed, its text masked whole, marked as the job's, and only once a person approved it; File an issue (issue #471, `docs/design.md` "File an issue") files the person's own issue, drafted by their own signed-in Claude and read, edited and confirmed by them, on one of their job repositories through their own connection (the account of the repository), with no label and no assignee, its text scanned first as Promote to GitHub's (never a secret; personal data only on a private repository they allow it for; a public repository only when they confirm it) and ending with a fixed note that names no person; Queue job for a job repository with no checks (issue #677) files "Add PR checks to <repo>" on that repository through the person's own connection — an issue with the hopper label, assigned to their connected account, its text fixed —, once: an open one of that title is answered instead. Promote to GitHub (issue #946, `docs/design.md` "Promote to GitHub") posts a finished direct job as an issue, or a comment on an issue the person picks, on a repository they choose, through their own connection, never a job's — the text they read, edited and confirmed in a preview, scanned first: never a secret, personal data only on a private repository they allow it for, a public repository only when they confirm it; it names who promoted it, and the requester only when they ask; its links need a hopper sign-in, but a small text artifact the person ticks, scanned the same way, is committed to the promotion's own branch `hopper-promotion/<direct job>` (never the default branch) and linked there; promoted again it edits what it posted and updates what it committed. With the user's **drift issues** setting on (issue #1077,
`docs/design.md` "Component watchers"), a **component watcher** files one issue per kind of drift on the hopper's own repository through
the user's own connection — labelled `user-report`, no assignee, each item only a short hash of its key — and edits that issue's body
while the drift lasts, never filing a second. With **landing batches** on for a repository (issue #1073, `docs/design.md`
"Landing batches"), a red batch's **culprit** — the first change a bisect within the batch finds failing — is reverted from the
landing branch through GitHub's own revert of its pull request, which the hopper merges, and one **fix issue** is filed through
the user's own connection — the hopper label, assigned to their connected account, so Intake takes it —, its text fixed but for
the failing checks' output, masked; a `landing_batch.fix_filed` event keeps it from being filed twice. When a batch run promoted a job's pull request that did the whole item and its issue is still open — the batch run's text did not close it — the hopper closes that issue as completed, once, with no comment, and records the close (issue #1232, `docs/design.md` "A promoted item is done"). A batch run with merge
conflicts with the tested branch gets a **back-merge** (issue #1073 part 4): the tested branch merged into a branch at the
landing tip by GitHub's own merge, and a pull request of it into the landing branch, its text fixed, which the hopper merges;
a conflict GitHub cannot merge files one issue the same way as a fix issue, its text fixed, and no second while it stands
(`landing_batch.back_merge_issue_filed`). A done item's **companion rebase issue** (issue #1143, `docs/design.md` "A done item's companion pull request"): when the base merge cannot resolve the merge conflicts of a companion pull request of an item that is done or whose issue is closed, one issue is filed through the user's own connection on the item's repository — the hopper label, assigned to their connected account, so Intake takes it —, its text fixed but for the pull request, its branches and the item; once for each head commit of the companion, at most three times (`job.companion_rebase_filed`). **Pull request housekeeping** (issue #1143, `docs/design.md` "Pull request housekeeping") is the hopper's
care of a job's open pull request it follows, or a **stray** one (a job named it, no job follows it, no job of its item
works on it; part 4), or an **untracked** one of an item the ledger holds, on a branch named for its issue (issue #1176,
`docs/design.md` "Untracked pull requests"; only the move, and the close of a **second pull request** on a branch named for its issue with merge conflicts, issue #1208): it moves one based off the landing branch to it, closes one with nothing
left to land, and posts on the pull request one fixed comment for each such act and for each tend job it starts,
naming no person; the batch runner's move of a job's pull request from the tested branch, followed or not, posts the same
comment. A job's own request through the GitHub proxy (issue #563) is
the job's act, as when it pushes: its text is the job's, under the publishing rule; so are, with the user's Contribution on
(issue #429), the fork of a repository its user cannot push to and the pull request it opens there from that fork; an issue filed that way ends with the
hopper's note naming the job and the request by id only, and gets no label or assignee — but a **routed child** (issue #1510, `docs/design.md` "Routed children"): a required child, which the hopper labels with the job sources' label and assigns to the job's user's connected account, so Intake lists it as a request card; a job filed it, so it is never of a trusted origin, and a person approves it. The **push requirements summary** (issue #2555 part 4, `docs/design.md` "Push requirements") is the job's act too: the hopper adds it to a job's `pr create`, and after each push of the job's that GitHub took, puts it in the body of the pushed branch's open pull request the job may edit, with the job's own user's connection — the job's evaluation of the commit pushed only (requirement ids, levels, statuses, commands, thresholds and measured values, masked), between its two hidden lines; the rest of the body stays as it was. The default job rules carry the rule (`src/job-rules/` `DEFAULT_JOB_RULES`); the job rules are the owner's to edit (issue #172).
- **Nothing leans on the machine** (issue #40, `docs/design.md` "Deployable"). Everything the daemon
  keeps is in the database `HOPPER_DATABASE_URL` names; config is config records in it — JSON values
  (`plugins`, `rules`, `job-rules`, `sign-in`), every setting edited in the UI, none set only in a file, no YAML
  (issue #198) — and the webhook subscriptions, rows of its own. **Two kinds of secret** (issue #451, `docs/design.md`
  "Secrets"). A credential the hopper is *given* for an outside service comes from the runtime: the variable
  `NAME` or the mounted file `NAME_FILE` names (`src/secrets/runtime.ts`), named by a command-bearing
  option. A secret the hopper *owns* — one made by or for the hopper (a webhook signing secret), or one
  only it holds (a **connected account**'s token, issue #214; a **vault secret**, issue #558, set in the UI for jobs; a **shared secret**, issue #718, one the instance admin shares with every user's agents or the readers named, `shared/<name>` in the instance's vault, read by a job only through its approved template and OpenFGA `shared_secret#can_read`) — is kept in the database, **sealed** under
  the master key `HOPPER_MASTER_KEY` (`src/secrets/sealer.ts`: a key per value from the master key
  and a salt, AES-256-GCM, bound to its place, a key id for rotation), never logged, never
  in an event, and never answered by any route but, once, a secret the hopper made in the answer that made
  it. A value that cannot be opened is said so, never read as no secret. A token or code it mints is only
  hashed. **Every secret the hopper owns for itself is a system secret** (issues #657, #658, `docs/design.md`
  "The vault's system scope"): the GitHub connection's access and refresh tokens, the GitLab account's personal access token (issue #1448), each webhook signing secret, each
  user's TypeSafe API key in that user's vault, each sign-in realm's `clientSecret` or `bindPassword` (set in the UI or
  from the `HOPPER_SIGN_IN_*` environment) and remote access's — each tunnel provider's credential and the tunnel token the hopper
  minted with it (issues #880, #968, set in Settings → Remote access, never in `.env`) — and the GitHub webhook secret (issue #1079, made in Settings → GitHub webhook) in the instance's vault — rows named `system/<name>`, sealed, written only
  through `SystemSecrets.keep` (src/vault/system.ts), each set, replace, rotation, removal, move and read an event with no
  value, shown with its audit trail on Vault, and never given to a job, a machine or a box: OpenFGA
  (`system_secret#can_read`) denies them, and the vault refuses them whatever it answers. One kind is answered by a route: the
  tunnel token, to its provider's tunnel service alone (`GET /tunnel/agent` above), which holds it in its agent's environment
  only, never in a file. None is kept in clear: without
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
- **hopper.io runs nothing on an instance** (issue #468, `docs/hopper-io-security.md`). The **cloud link** is outbound
  from the instance, off until its admin links it, and carries allow-listed state out only (a closed, versioned schema in
  the instance's code). The instance acts on nothing that comes in on it but a remote action its admin turned on for that
  instance, one kind at a time, taken as one `POST /ui/api/*` under the role of the user the hopper.io account maps to, and
  recorded; no remote action changes sign-in, plugins, command-bearing options, the vault, remote access or the cloud link.
  No credential goes on it: no GitHub token, database URL, master key, sealed secret, client token, machine link key,
  proxy token, API token or session; only the public half of the **cloud link key**. At hopper.io every record and query
  is scoped to one **hopper.io account**, with tests. A hopper.io change cites the rules (R1–R8) it touches; one that
  cannot obey a rule changes that document first, with the owner's decision.
- **A job's containers are its own** (issue #1295, `docs/design.md` "Each job its own container runtime"): a job's shell
  gets a podman runtime of its own (`src/client/job-runtime.ts`) — its runtime dir, storage and socket —, never the user's
  runtime dir or a host docker or podman socket; with no podman there, none. The reap resets only that runtime. Claude, and a print-mode agent's turn,
  runs in the **job's sandbox** (`src/client/job-sandbox.ts`, bubblewrap): the kernel hides the user's runtime dir but for the
  job's own, the user's bus and container storage, the host's container sockets, herdr's sockets and the host's processes;
  with no bubblewrap that runs there, none.
- **Never write into the Jev repo.** The shim reads it; logs go to hopper's work dir.
- **Persisted state is the user's.** A schema change ships a migration, appended to
  `src/store/migrations-recent.ts` or `src/store/tenant-migrations-recent.ts` (additions files, issue #967; `SHARED`, in SQL both databases mean the same way); it never drops a
  queue. A change to persisted state inside a config record (its value's shape) migrates the
  records too. A migration leaves a store the build before it still runs on: a hopper moved to a
  steadier update channel runs that channel's older build on the migrated store (`docs/deploy.md`
  "Update channels and promotion").
- **Changes reach people main → dev → beta → canary → stable** (issue #1073, `docs/design.md` "Landing batches").
  Pull requests merge to `main`, the landing branch and the default branch, after the fast checks (the
  gates and the affected tests); `dev` moves only when a green batch run of `main`'s tip merges into it, and that merge closes the issues of the batch's job pull requests (its text
  names them with closing keywords, issue #1175); a red batch's culprit is reverted from `main`, and the rest of the batch moves on;
  `beta` and `canary` move only by `scripts/promote.sh`, one step at a time; `stable` moves to the canary's candidate
  when its canary window passes with no bug report that names it (the batch runner, part 5), or by `scripts/promote.sh stable`.
- **The UI is the daemon's one built part; `cloud/` is the second part, and not the daemon's.** `ui/` → `npm run build:ui`
  → `ui/dist` (gitignored), served by the daemon. It imports nothing of `src/` at runtime; types only, from `src/domain/types.ts`.
  `cloud/` is **hopper.io** (issue #463, `docs/cloud-hosting-identity.md`), its own service with its own database, run by Node
  as the daemon is (`npm run cloud`): the daemon never serves it, its image does not carry it, and nothing in `src/` imports
  it. It imports of `src/` only the GitHub sign-in it shares with an instance (`src/connected-accounts/hopper-app.ts`,
  `web-flow.ts`, `identity.ts`) and `src/secrets/runtime.ts`; `test/cloud/config.test.ts` checks both ways. It signs in
  through a GitHub App of its own, never the shipped one, and keeps no GitHub token.
  The GitHub Pages site is built too (`npm run build:site` → `site/dist`, gitignored), for Pages only,
  never served by the daemon; it takes its look from `ui/src/index.css` and nothing of `src/`.
- **What's new.** A change people who use the hopper would notice adds one line in a new file
  `whats-new/<issue number>.md` (a fragment), in the same change. **Never edit `WHATS-NEW.md`
  directly**: every open pull request would conflict on its top line (issue #824). The line: `- `,
  then plain words for a non-technical reader, what they can now do or what now works. No issue or
  PR numbers, hashes, file names or code words; never edit a released line (the update notice shows
  the lines the installed version lacks). Internal-only changes add none. The pull request check
  (`node scripts/whats-new.ts check HEAD^1`) refuses a direct edit; `node scripts/whats-new.ts
  assemble` moves the fragments into `WHATS-NEW.md` before a promotion to beta (`whats-new/README.md`,
  `docs/design.md` "Self-update").
- Gates: `npm run typecheck`, `npm run lint`, `npm test`, `npm run build:ui` — all exit 0
  (`npm run check` runs all four). Locally, run typecheck, lint, the UI build and the **affected** test files
  (`npx vitest run <files>`); the PR check (`pr / test`) runs the affected tests on a pull request into
  `main`, and the full suite on a batch run into `dev` and on a promotion. Do not run the full suite to compare it
  with `dev`: a seat fails it for machine reasons (issue #1038). In the pull request, list environment skips (no
  container runtime, a service that stopped, a timeout under load) apart from real failures.
