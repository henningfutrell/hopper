# Issue assignment: the design, end to end (issue #388 — research)

Research only when written. Issue #387 has since built part of it — intake by label and assignee, reject as
a hopper-side record, assignment drift for waiting and started jobs (`docs/design.md` "Intake by label and
assignee"). Issue #440 built §8's intake reasons, part of §9's migration, and D7 (a bulk "assign to me" in
Sources; `docs/design.md` "Intake outcomes, claim holders and the intake migration"). The rest, and the other
owner decisions below, stay open. Issue #387 moves intake from an author allowlist to the source
label plus an assignee. This note assesses the whole assignment mechanic and its knock-on effects,
recommends a design, and lists what needs an owner decision. Paths are relative to the repo root;
line numbers are as of `origin/main` at `bff0b47`.

Terms this note proposes and that are not yet in `docs/glossary.md` are in *italics* the first time.
They enter the glossary with the change that builds them, not before.

## Summary

- **Intake signal: label plus assignee** (#387), **with a trust check on the issue's author**.
  Applying a label or an assignee by hand needs triage access, so the pair is a deliberate act of
  someone who can manage the repo's issues. But issue forms and templates apply `labels:` and
  `assignees:` for any filer, so on a repo with such a template a stranger's issue becomes a job.
  The author check closes that path: an issue whose author has no write access waits for review,
  whatever the queue gate says.
- **The allowlist does not vanish; it changes role.** It stops deciding *what is taken* and starts
  deciding *what runs without review* (a *trusted account* list, defaulting to the user's own
  connected login).
- **One claim per issue per hopper.** Users are separate schemas, so today two users of one hopper
  assigned the same issue would both take it. A claim table in the instance schema settles it:
  first ingest wins, the other user's source says why it did not take the issue.
- **Reject is a hopper-side record, not a shared label.** In the assignee model `hopper:rejected` is
  wrong: it is shared across every user and every hopper on the repo. Reject records the rejection
  on the user's job and, if the owner allows a non-label write, unassigns the user; reassignment is
  then the natural way back.
- **Drift: waiting jobs cancel, running jobs flag.** Unassigned (or label removed) while waiting →
  cancelled with a reason. While running or waiting on a question → flagged, the user decides.
  After failure → the locked entry is dismissed.
- **Prompt injection is the largest risk** and the allowlist was the only defence: issue text goes
  raw into a skip-permissions agent that holds the user's GitHub token (`src/sources/github/context.ts:75-77`).
  The author trust check, a comment filter by repo permission, and fencing the issue text are the
  minimum; sandboxing (#315) is the real fix.
- **Migration grandfathers in-flight jobs**: a waiting job ingested under the allowlist is not
  cancelled for having no assignee.

---

## 1. Intake signal

### Current behaviour

- Discovery lists open issues carrying the source label, repo by repo, never by search
  (`src/sources/github/app/rest.ts:226-230`: `GET /repos/{o}/{r}/issues?labels=<label>&state=open&per_page=100`).
- An issue is eligible when it is open, has the label, its author is in `authors`, it has none of
  `hopper:done`, `hopper:failed`, `hopper:backburner`, `hopper:rejected`, and it is addressed to this
  hopper or to none (`src/sources/github/discover.ts:37-52`).
- `authors` is required for `github-app` (`src/sources/config.ts:23`) and defaults to the connected
  login for `github-account` (`src/sources/compose.ts:83`). The app bot may not be in it
  (`compose.ts:47-50`, `src/sources/github/source.ts:52`).
- Assignees are never read: the issue mapping has no such field (`app/rest.ts:209-218`).

### Who can set each signal on GitHub

| signal | who can set it by hand | who can set it without triage access |
|--------|------------------------|--------------------------------------|
| label | triage, write, maintain, admin | any filer, through an issue form or template's `labels:` |
| assignee | triage and up; at most 10; the assignee must have commented, have write access, or be an org member with read access | any filer, through an issue form or template's `assignees:` |
| milestone | triage and up | nobody |
| Projects (v2) field | project writers | the form's `projects:` needs write access to the project |
| comment (mention, slash command) | anyone who can comment — on a public repo, anyone | — |
| author | — | anyone who can file |

The template row needs a check on a test repo before it is relied on: GitHub's form syntax documents
both keys as applied "automatically to issues created with this template" and names no permission
for them, unlike `projects:`.

### Options

| option | clear? | safe? | multi-user? | surprise |
|--------|--------|-------|-------------|----------|
| **label only** | yes | needs triage, except templates | no: says *a* hopper, not *whose* | every user watching the repo takes it |
| **assignee only** | yes | as label | yes | assigning someone for human work starts an agent on it |
| **label + assignee** (#387) | yes: "a hopper job, for this person" | as label, both must be forged | yes | low; both are visible on the issue |
| Projects field (`Agent: <login>`) | needs the board open | project writers only | yes | per-repo project config; org project read permission; reads already fall back silently on error (design "Priority") |
| mention or slash command | in the comment stream | anyone can comment: needs an actor check on every command | yes | the hopper would read comments as commands, which it stopped doing for answers |
| milestone | no: one per issue, already used for releases | triage only | no | high |

### Recommendation

**Label plus assignee**, as #387 asks, with two additions:

1. **Author trust gate.** At intake, the source asks the repo permission of the issue's author
   (`GET /repos/{o}/{r}/collaborators/{author}/permission`, cached per repo and login for the
   source's lifetime). An author with `write` or more, or in the user's trusted accounts, passes. Any
   other author's job is created unaccepted and **never auto-accepted**: it waits in the Queue view's
   pre-sort with the reason `filed by an account without write access`. This closes the template
   path without a per-issue timeline read: a template-applied label always comes with an outside
   author.
2. **Optional actor check, not first.** Reading who applied the label and the assignee (timeline
   `labeled` / `assigned` events, their `actor`) is stronger — it catches a triage holder in an org
   repo assigning work to someone — but costs one timeline read per new issue. Recommend it only if
   the owner wants org repos where triage is broadly granted (decision D2).

The Projects field stays what it is today: a priority input, not an intake signal.

---

## 2. Multiple users and accounts

### Current behaviour

- Each user has their own runtime, store schema, sources, queue and machines (`src/users/runtime.ts:1-5`).
- The duplicate guard is per user schema: `ingest` re-reads the newest job by `source_key` in one
  transaction (`src/engine/source-host.ts:75-77`); `jobs.source_key` is a non-unique index
  (`src/store/migrations.ts:36`, `src/store/tenant-migrations.ts:37`).
- Across users and across hoppers the only guard is `hopper:claimed`, written **after** ingest by the
  async claim report (`src/sources/sync.ts:140-141`). A source with no local job skips a claimed
  issue (`discover.ts:62-64`); before the label lands, a second user or hopper takes it too.
- One connected account per provider per user: `connected_accounts.provider` is the primary key
  (`src/store/migration-connected-accounts.ts:10`).
- `github-app` acts as `<slug>[bot]`; a bot cannot be an issue assignee.

### Cases

| case | today (allowlist) | with #387 as written | risk |
|------|-------------------|----------------------|------|
| two hopper users, same repo, issue assigned to one | the one whose `authors` holds the filer takes it; both, if both list the filer | only the assignee's source takes it | none |
| issue assigned to two hopper users on one hopper | — | **both take it**: separate schemas, no shared guard | double run, two pull requests |
| same, users on two hoppers | — | both, inside the claim-label window | as above; `hopper@<name>` settles it |
| one person, personal and work GitHub accounts | one account per hopper user; second needs a second hopper user | as today | work issues need the work account's token (SSO, org policy) |
| assigned to an account no hopper user has connected | nothing | nothing | none: not this hopper's work |
| org repo, hopper user cannot be assigned (no read access) | — | the user cannot be assigned, so nothing is taken | none; the app must also be installed on the org (#352) |
| `github-app` source | matches `authors` | **no assignee to match**: the bot cannot be assigned | the app source takes nothing |

### Options

- **Cross-user claim on one hopper:** (a) a `claims (source_key PRIMARY KEY, user_id, job_id)` table in
  the instance schema, written in the ingest transaction — first wins, released when the job ends;
  (b) refuse issues with more than one hopper-user assignee (held, reason `assigned to several
  users`); (c) first assignee in the API's order (the order is not documented as stable).
- **Several accounts per person:** (a) several connected accounts per hopper user, primary key
  `(provider, login)`, each with its own job repositories; a job records which account took it and
  gets that account's token as `GH_TOKEN`; (b) one hopper user per GitHub account, as today.
- **`github-app` source:** (a) it takes issues assigned to the GitHub identity linked to the hopper
  user at sign-in (`user_identities`); (b) an `assignees` option listing logins; (c) it keeps
  label-only intake, with the author trust gate.

### Recommendation

- Claim table (a). It is one row per live issue, it uses the transaction `ingest` already holds, and
  it turns a silent double run into a stated skip (`claimed by another user of this hopper`). It
  breaks the "users never see each other" rule only as far as a reason string; the reason names no
  user.
- Several accounts per user (a), as a separate, later issue (decision D4). Until then, a person with
  two accounts uses two hopper users, and the claim table keeps them from both taking one issue.
- `github-app` (a): the user's linked GitHub identity. No new option to configure.
- Across hoppers, keep first-claim-wins plus `hopper@<name>`, and narrow the window: a job is not
  accepted until its claim report has gone out (`sourceState.sync.claimReported`). That bounds the
  race to a poll, not to a run.

---

## 3. Rejection and handback

### Current behaviour

- `POST /ui/api/jobs/:id/reject` (operator) on a waiting job → status `rejected` (terminal), `error` the
  reason, `job.rejected { by, reason }` (`src/engine/queue-gate.ts:36-40,122-130`). The pre-sort can
  reject through `queueSorter.reject`; no built-in sorter does (`queue-gate.ts:43-55`).
- The report removes `hopper:claimed` and adds `hopper:rejected`; the issue stays open
  (`src/sources/github/report.ts:67-69`). Discovery skips the label (`discover.ts:44`). Removing it
  offers the issue again as a re-run.
- **Run again does not cover rejected jobs**: `src/sources/rerun.ts:30` takes only `failed` and
  `finished`, though `takeBack` would strip `hopper:rejected` (`report.ts:91`).
- A rejected job is not a locked entry (`src/domain/locked.ts:9`).
- The hopper writes only labels, posts no comments, never closes; the one exception is Run again
  reopening a closed issue (#354; `AGENTS.md` "GitHub text is neutral").
- A running job cannot be rejected (409): cancel is the action there.

### What reject should do on GitHub

| option | visible to the assigner | per user? | how it comes back | repo law |
|--------|------------------------|-----------|-------------------|----------|
| nothing (hopper-side record only) | no | yes | Run again, or a reassign the hopper detects | fits |
| `hopper:rejected` label (today) | yes | **no: blocks every user and every hopper on the repo** | remove the label | fits |
| **unassign the user** | yes: the issue shows it is nobody's | yes | assign again | a new write kind: needs owner sign-off |
| neutral comment with the reason | yes, and the reason | yes | — | breaks "posts no comments" |
| unassign + label | yes | no (label) | both gestures | as above |

### Recommendation

- **Reject records on the job, and unassigns the user** (if the owner allows the write, D1). No
  `hopper:rejected` in the assignee model: a shared label cannot carry one user's decision. Without
  the unassign, the source remembers rejections per issue and assignee login and skips that pair
  until a later `assigned` event for the login (one timeline read, only for rejected keys).
- **No comment.** The reason stays in the job's timeline (`job.rejected.reason`). An assigner who
  needs to know sees the unassignment.
- **Coming back:** reassignment takes the issue in again as a re-run (`rerunOf` the rejected job).
  Run again extends to rejected jobs: it assigns the user again (the same write kind) and queues now.
- **Pre-sort rejections do not unassign.** An automatic rejection is the user's filter, not a
  statement on the issue; it stays hopper-side (`by: pre-sort`), and a changed sorter or Run again
  undoes it.
- **Existing `hopper:rejected` labels** keep blocking until removed (migration, §9).
- **Never closes, never reopens** on reject. Run again's reopen (#354) is unchanged.

### Interaction with held, failed, Run again

- Held and awaiting acceptance: reject applies as today.
- Failed (locked entry, #355): reject is not offered (the job is ended); Dismiss stays the action. If
  the user is unassigned from a failed job's issue, the locked entry is dismissed automatically
  (`job.dismissed { by: "source" }`): the work is no longer theirs.
- Run again on a failed or finished job whose issue is no longer assigned to the user → 409 with
  `no longer assigned to you`, and the UI does not offer it (the #362 rule: never offer what is
  refused).

---

## 4. State drift

### Current behaviour

`check()` reads every active job's issue each poll (`getIssue`) and cancels on `issue gone`,
`issue closed` (except the job's own pull request, or a close as complete after the job started),
`label removed`, and `backburner` while waiting (`src/sources/github/check.ts:242-248`). The issue
object it already fetches carries `assignees`, so assignee drift costs no extra call.

### Matrix (recommended)

| change | awaiting acceptance / queued / held | running | waiting on a question | failed (locked) |
|--------|-----|-----|-----|-----|
| user unassigned | cancel, `unassigned` | flag, user decides (#387) | flag; the question stays open | dismiss the locked entry |
| label removed | cancel, `label removed` (today) | **today: cancel** — recommend flag, as unassigned | flag | dismiss |
| reassigned to another user of this hopper | cancel; the other user's source takes it once the claim is free | flag; the other user's source holds it, `claimed by another user of this hopper`, until this job ends or is stopped | as running | dismiss; the other user takes it |
| reassigned to someone on another hopper | cancel | flag | flag | dismiss |
| a second hopper user added as assignee | nothing: the claim holds | nothing | nothing | nothing |
| issue closed | as today | as today | as today | as today |
| issue transferred to another repo | cancel, `issue transferred`; the new repo's discovery takes it fresh if eligible | flag | flag | dismiss |
| `hopper:backburner` | cancel (today) | nothing (today) | nothing | nothing |

*Flag*: a new source signal kind beside `cancel` (`SourceSignal`, `src/domain/ports.ts:361`). The job
gets a *drift* mark and a `job.drifted { reason }` event; the UI shows it on the job with Stop and
Keep. Keep clears the mark until the issue changes again. A drifted job that ends done still has to
meet its completion.

**Label removed while running** today cancels a job mid-work. Unifying it with unassignment (flag)
is a behaviour change: decision D3.

**Transfer.** `GET` on a transferred issue answers a redirect to its new location; the adapter's
handling of it is not tested. Today it either follows the redirect and sees an issue with a
different URL, or reads 404 and cancels `issue gone`. A test against the fake should pin it before
the drift rule is built.

### Duplicate intake

Within one user's schema the same issue cannot be ingested twice: the store is synchronous Postgres
(`src/store/db.ts:1-3`), `ingest` re-reads by key inside its transaction, and syncs of a slot are
chained (`src/sources/sync.ts:296-302`); Run again falls back to an existing job
(`source-host.ts:141-148`). So the double pickup seen on 2026-10-07 came from two schemas (two users
of one hopper) or two hoppers. The events of both jobs (`job.queued` source and user) will say which. The claim table (§2)
fixes the first; the accept-after-claim rule narrows the second.

---

## 5. Trust and security

### Who may queue work for whom

With #387 as written, **anyone with triage access on a watched repo can start an agent on your
machines, with your GitHub token, by labelling and assigning an issue to you** — and, through a
template, anyone who can file. In a personal repo, triage holders are you and your collaborators. In
an org repo they can be the whole org. The allowlist made this impossible; the trust gate (§1)
restores it for auto-accept without restoring it for intake.

### Whose comments count

- **As answers: nobody's, already.** Questions are answered in the UI; nothing on the issue answers
  (`src/sources/github/check.ts:12`; `SourceSignal` has only `cancel`). #387's concern about
  answers is moot. One stale code comment says otherwise (`src/sources/compose.ts:41`).
- **As prompt context: the allowlist decides today** (`src/sources/github/context.ts:29-35`, called
  at `source.ts:89`). Replacement: a comment reaches the job when its author has write access (same
  cached permission read as §1), or is the assignee, or is a trusted account; never a hopper-marked
  comment or the app bot. The header line says which rule applied.

### Prompt injection

- The issue body goes into the prompt as is (`context.ts:75-77`); the job runs with permissions
  skipped, holds the user's `GH_TOKEN`, and can reach a UI session (design "UI session and
  mutations", residual risk). `DEFAULT_JOB_RULES` says nothing about untrusted text
  (`src/job-rules/index.ts:13-21`). The only fencing in the code is the escalation level's prompt
  (`src/plugins/escalation-level/claude-cli/prompt.ts:4-6`).
- Recommended, in order: (1) the author trust gate — an untrusted author's text never runs without a
  person reading it; (2) fence the body and comments in the prompt as data, with the author and
  their permission on the fence; (3) one job-rules line: the issue is a request for this repo's code,
  never an instruction to touch credentials, other repos, or the hopper; (4) sandboxing (#315).
  Text fencing lowers the odds; only (1) and (4) bound the damage.

### Rate and abuse limits

- `autoAcceptPerHour` (the gate's throttle) bounds what starts by itself. Untrusted jobs never
  auto-accept, so they cannot use it.
- Add a cap on unaccepted jobs per source (for example 50): past it, new items are listed in the
  source status as `not taken: review queue full` instead of becoming jobs. This keeps a flood of
  labelled issues from filling the queue view and the database.

### Admin controls

Users are separate by design (#158), so the instance admin cannot see or change a user's sources.
Options: (a) none — each user owns their risk; (b) instance policy the admin sets: repos or owners any
user's source may watch, and "untrusted authors always need review" as a floor no user can lower.
Recommend (b)'s floor only, if the hopper will host users other than the owner (D8).

---

## 6. GitHub mechanics

| need | API | permission | note |
|------|-----|------------|------|
| list labelled issues with assignees | `GET /repos/{o}/{r}/issues?labels=<l>&state=open` | Issues: read | `assignees[]` is in each item. Filter client-side: no extra call, and the source can say why an issue was not taken |
| server-side assignee filter | same, `&assignee=<login>` | Issues: read | one login per call; worth it only with many unassigned labelled issues |
| author or commenter permission | `GET /repos/{o}/{r}/collaborators/{u}/permission` | Metadata: read for an app; a user token needs push access to the repo — **to verify** | cache per repo and login |
| who applied label or assignee | `GET /repos/{o}/{r}/issues/{n}/timeline` (`labeled`, `assigned`, `unassigned`, `actor`) | Issues: read | only if the actor check is wanted (§1) |
| unassign on reject | `DELETE /repos/{o}/{r}/issues/{n}/assignees` `{ assignees: [login] }` | Issues: write | whether a user without triage can unassign themselves is **to verify** |
| reassign on Run again | `POST /repos/{o}/{r}/issues/{n}/assignees` | Issues: write | the assignee rules above apply |

- **Permissions.** The shipped app already has Issues read and write (`docs/sign-in.md:783-786`); the
  admin's own app manifest has Issues write and Metadata read (`scripts/create-github-app.ts:59-60`).
  Nothing new is needed. The device flow has no scopes: a GitHub App user token is the app's
  permissions intersected with the user's access (`src/connected-accounts/device-flow.ts:81`).
- **Webhooks.** The hopper pulls (`AGENTS.md`); `issues` events (`assigned`, `unassigned`,
  `labeled`) would need a public receiver. Not recommended: polling at `pollSeconds` already sees
  every change, and drift needs no faster reaction than a poll.
- **Rate limits.** A user token has 5 000 requests per hour. Per poll: one list per job repository,
  one `getIssue` per active job, GraphQL for closers and projects. Twenty repositories at 60 s are
  1 200 an hour before jobs. The code sends no conditional requests and reads no `x-ratelimit`
  headers (`src/sources/github/api.ts:97-99` only classifies). ETag requests (a `304` does not count
  against the limit) and backoff on `x-ratelimit-remaining` are a cheap, separate follow-up. The
  permission and timeline reads added here are per new issue and cached.
- **Public repos.** Outsiders can file and comment, not label or assign, except through templates.
  Their comments must not reach the prompt (§5).
- **Forks.** A fork's issues are its own (off by default), and pull requests from forks are not
  intake. A fork is a separate repo to choose as a job repository; nothing special is needed.

---

## 7. Routing and capacity

- **Routing rules** match source, repo, label, author and title (`src/domain/routing.ts:1-35`),
  applied once at intake (`source-host.ts:22-49`). An `assignee` match adds nothing while a user has
  one account; with several accounts per user (D4), an `account` match (work or personal) is the
  useful one — for example work issues to the machine signed in to the work org. Keep `author`: it is
  still meaningful for trust and routing.
- **Machine pins and lane reservation (#372), usage pacing (#373), priority.** An untrusted job,
  once accepted by a person, is an ordinary job. Before acceptance it takes no lane (the decider holds
  `awaiting acceptance` first, `src/decider/index.ts:46-49`). Priority labels (`hopper:high`) need the
  same triage access as assignment, so they need no extra check.
- **Per-machine workspaces (#361).** With several accounts per user, a machine's workspace needs the
  credentials of the account the job came from; the job's `GH_TOKEN` (#359) already comes from the
  hopper, so this is a matter of passing the right account's token.
- **Intake-time snapshot (#375).** A drift cancel followed by a fresh intake re-applies current
  routing, which is the behaviour #375 wants. The claim table must release on cancel so the fresh
  intake is not blocked by its own predecessor.
- **Per-job work trees (#379)** are unaffected.

---

## 8. UI and notifications

- **Intake reasons.** Discovery filters silently today (`discover.ts:37-52`; only claimed-without-job
  and not-run-again reach status, `sync.ts:210-218`). Add to the source status, per labelled issue not
  taken: `not assigned to you`, `rejected by you`, `addressed to another hopper`, `claimed by another
  user of this hopper`, `claimed elsewhere`, `review queue full`. Shown on the Sources view.
- **On the job.** The job's timeline starts with why it was taken: assignee login, author, the
  author's permission, trusted or not. The pre-sort column marks untrusted jobs.
- **Rejection.** The timeline shows `job.rejected` with its reason and whether the user was unassigned.
- **Drift.** A drift mark on the job card and the Overview, with Stop and Keep.
- **Events.** New: `job.drifted { reason }` and `job.cancelled` reasons `unassigned`, `issue
  transferred`; `job.rejected` gains `unassigned: boolean`; `job.dismissed` gains `by: "source"`.
- **Grok Bot notifier and webhooks (#357, #378).** Today the notifier sends `source.stalled`,
  `connected_account.expired` and `question.escalated_to_human` (issue #481;
  `src/plugins/notifier/grokbot-routine/notifier.ts` `wanted`). It should also send the two things that
  wait on a person: an untrusted job awaiting review, and a drifted running job. As #357 did for
  questions, one distinct event — `job.needs_decision { reason }` — lets a subscriber take only those.
  Rejections and cancels are the user's own acts: not notified.

---

## 9. Migration

- **`authors` option.** As #387: configs with it load, the field is ignored, a tenant migration drops
  it; the trusted-accounts list is seeded from it, so authors the user trusted keep auto-accepting.
- **Waiting jobs ingested under the allowlist.** Their issues are mostly unassigned; the drift rule
  would cancel them all on the first poll after the update. Grandfather them: the migration marks
  waiting jobs `intake: author` in `sourceState`, and the unassignment rule skips that mark until the
  job ends. The Sources view lists them once (`N waiting jobs were taken before assignment: assign
  or reject`).
- **Running and failed jobs.** Same mark; a grandfathered locked entry is not auto-dismissed.
- **Labelled, unassigned issues** in watched repos are no longer taken. The intake-reason list (§8)
  shows them as `not assigned to you`. A bulk "assign to me" button would be a user-initiated
  GitHub write: decision D7.
- **`hopper:rejected` labels.** Keep honouring them as a block (they may be another hopper's
  decision); removing the label still offers the issue again. New rejections do not write it.
- **`github-app` sources** switch to the user's linked GitHub identity as the assignee to match; a
  user with no linked identity gets a paused source with that message, not silence.
- **Docs.** `docs/design.md` "GitHub source" ("Authors outside the allowlist are never acted on",
  the eligibility line, the comments header), `docs/glossary.md` (assignee intake, trusted account,
  claim, drift), and the stale comment at `src/sources/compose.ts:41`.

---

## Follow-up issues, in priority order

1. **Author trust gate at intake** (§1, §5): permission read, never auto-accept untrusted authors,
   trusted accounts seeded from `authors`. Ships with or right after #387: without it #387 widens who
   can run code on the user's machines.
2. **Comment context by permission, not allowlist** (§5): replaces `contextComments`'s allowlist;
   removes the stale `compose.ts:41` comment. Same release as #387, which removes `authors`.
3. **Grandfather in-flight jobs** (§9): part of #387's migration.
4. **One claim per issue per hopper** (§2): instance claim table in the ingest transaction; status
   reason; release on end or cancel.
5. **Assignee drift signals** (§4): cancel waiting, flag running and questioned, dismiss locked;
   `job.drifted`; Stop and Keep in the UI.
6. **Reject in the assignee model** (§3): hopper-side record, unassign (if D1), no new
   `hopper:rejected`; Run again for rejected jobs; Run again refused when no longer assigned.
7. **Intake reasons in source status** (§8).
8. **Fence issue text in the prompt, plus a job-rules line** (§5).
9. **`job.needs_decision` event and notifier support** (§8; with #378).
10. **Accept only after the claim is reported** (§2): narrows the cross-hopper race.
11. **Transferred issues**: pin the adapter's behaviour with a test, then cancel `issue transferred` (§4).
12. **Conditional requests and rate-limit backoff** (§6).
13. **Several connected accounts per user**, with an `account` routing match (§2, §7) — if D4 says so.
14. **Review-queue cap per source** (§5).
15. **Instance policy floor** (§5) — if D8 says so.

## Decisions for the owner

- **D1. A second non-label write.** May reject unassign the user, and Run again assign them back?
  This widens "the hopper writes only labels". Recommended: yes. Without it, rejections are
  remembered per login and a reassign is detected from the timeline.
- **D2. Trust rule.** Auto-accept only when the author has write access or is a trusted account
  (recommended), or also check who applied the label and the assignee (stronger, one timeline read
  per new issue)?
- **D3. Label removed while running.** Keep cancelling (today), or flag as unassignment does
  (recommended: one rule for both)?
- **D4. Several GitHub accounts per person.** Several connected accounts per hopper user, or one
  hopper user per account (today)?
- **D5. Issue assigned to two users of one hopper.** First claim wins (recommended), or refuse with a
  reason?
- **D6. `github-app` source.** Match the user's linked GitHub identity (recommended), or an
  `assignees` option?
- **D7. Bulk "assign to me"** for labelled, unassigned issues after the migration: offer it, or
  leave assignment to GitHub's own UI?
- **D8. Instance policy.** An admin-set floor ("untrusted authors always need review", allowed
  owners), or none because users are separate?
- **D9. Comment on reject.** Confirm no comment (recommended; keeps "posts no comments"), or a
  neutral one with the reason.

## What to verify before building

- Issue forms and templates apply `labels:` and `assignees:` for a filer without triage access
  (test repo).
- The permission endpoint answers for a user token without push access, and for the app's token.
- A user without triage access can remove themselves as assignee.
- The REST adapter's behaviour on a transferred issue (redirect followed or not).
- The source of the 2026-10-07 duplicate intake: two schemas or two hoppers (the two jobs' events).
