# Needs you: what waits on you

**Needs you** is the second entry in the navigation, after the **Dashboard**. It shows every decision that waits on a person, by kind, with a count for each. Each row opens the one page where you act on that kind.

## What it is

Each kind of decision has one page, its home. Needs you collects the counts. You act on the home page, not in Needs you.

| Row | Its home | What it counts |
|---|---|---|
| Intake | **Intake** | Issues from people who are not trusted actors, waiting for your approval. |
| Access requests | **Access requests** | Credentials, vault grants, AWS actions, box templates and sandbox runs that wait for your approval. Nothing else. A job's run counts once, on its card, with the template it needs, while the job waits, and stops when the job ends. A high-priority job's card marks the badge and comes first. |
| Unknown clusters | **Access requests** | Templates that name a cluster the vault cannot find, or a short name of more than one cluster. No approval makes them work, so the Access requests badge does not count them. |
| Infra plans | **Infra** | Plans of infrastructure changes that wait for a person to approve them, one line each: what the plan changes, its risk, and who approves it. A plan of a high-priority job marks the badge. A job that waits on a plan links to that plan on Infra. |
| Questions | **Questions** | Questions jobs asked you. |
| Proposals | **Proposals** | Proposals that wait for you to pick a path. |
| Research | **Research** | Research reports that wait for you to accept or steer them. |
| Logins | **Logins** | Logins a job waits on, and connections that ended. A code that ran out still counts while its job waits for a new code: by default the job gets a new code by itself. |
| Accounts | **Accounts** | Machines whose agent tool (Claude) is signed in as nobody, one line each. The row shows as soon as the machine's usage source reads the sign-out. Sign the tool in again from Accounts: no terminal on the machine is needed. |
| Machines | **Machines** | Machines that are not ready, one line each, with why: its job user holds credentials a job could use, or the machine cannot reach the hopper. Such a machine takes no new job until you fix it. Its row on Machines gives the fix. |
| Failures | **Failures** | Open problems and jobs handed off to a person. |
| Pull requests | **Pull requests** | Open pull requests with merge conflicts. Fix them, or close them. |
| Checks | **Pull requests** | Repositories whose pull request checks the hopper may not read, one line each, with the permission that is missing and the fix. The hopper merges no pull request there until you give the permissions. |
| Tagged | **Tagged** | Open issues and pull requests in your job repositories that ask for your review, mention you, or are assigned to you. |
| Pre-sort | **Queue** | Jobs that wait on the pre-sort before a lane takes them. |

The badge on **Needs you** is the sum of all rows. When a high-priority job waits, the badge has a ring and an arrow. Parked jobs are not in Needs you: they wait to be picked up, not for a decision. **Parked** keeps its own badge.

**Infra** and **Pull requests** also have their own badges in the navigation, with the same counts. The Pull requests badge adds the Checks row. The Infra badge also counts the out-of-band changes that no one marked yet: see [Infra](infra.md). A machine has no row: a join code adds a machine at once, with no approval. A box whose template waits for approval counts in Access requests.

Every row shows, also when its count is 0. The page says *Nothing waits on you* when all counts are 0.

## Critical jobs

A **critical job** is a job whose priority is at or above the critical priority (100 unless your admin changed `HOPPER_CRITICAL_PRIORITY`), or a job that a person marked critical. The **Critical jobs** widget shows each critical job under the header, on every page. It stays when you go to another page or reload.

To mark any job critical, whatever its priority, open its job page and select **Mark critical** in the **critical** row. **Clear critical flag** removes the mark. The mark changes only what the widget shows: it does not give the job a lane past the cap.

For each job, the widget shows:

- its title, its issue and its status;
- its lane and the sandboxes it runs on;
- its current step in plain words, and for how long;
- its last few actions.

When the job waits on you, the widget turns red and its dot pulses. Each wait has its action in the widget:

| Wait | Action in the widget |
|---|---|
| A question | **Answer** opens the question's card from **Questions**. |
| A sandbox run | **Approve** opens the run card from **Access requests**. |
| A vault grant | **Grant**. |
| A credential | **Give** opens the request from **Access requests**. |
| A proposal or a research report | **Pick a path** or **Decide** opens its card from **Proposals** or **Research**. |
| A hand-off | **Resolve** opens it from **Failures**. |
| A login | **Log in** opens its card from **Logins**. |
| A hold for a person | **Approve**. |
| The blast-radius gate | **Let through** (an admin). |
| Its own wait | **Continue** tells the job that what it waits for happened. |

These are the same entries as on their home pages. When you act in the widget, the entry clears on its home page too, and Needs you counts it no more.

Select **Notify me** to get a browser notification when a critical job needs you. **Timeline** shows every step of the job; **Job page** opens it. A job that ended stays in the widget until you select **Dismiss**. This browser remembers what you dismissed.

## Intake

**Intake** lists the open labelled issues your job sources list that wait on an intake decision, per source. The issues are in groups, each with a count:

1. **Needs approval**: request cards. Select **Approve** to let the hopper take the issue. Select **Decline** when you do not want it done: the hopper makes no job. Then pick what happens to the issue, and select **Decline** again:
   - **Close the issue**: the hopper closes it as not planned and removes its hopper labels.
   - **Leave it open**: the issue stays open, but the hopper removes the hopper label, so no hopper queues it.

   Either way the hopper posts one short comment on the issue that says what it did. The comment does not name you. To queue the issue again, add the hopper label again on GitHub (and reopen it, when it is closed). An edit to its title or body does not bring it back. An admin sets which choice shows first in **Settings → Intake**: by default, Leave it open for a request and Close the issue for a reopened issue.
2. **Not assigned to you**: the hopper takes a labelled issue only when it is assigned to you, so nothing works on these issues. Select **Assign to me**, or **Assign all to me**.
3. **On the backburner**: select **Take off the backburner**.
4. **Other reasons**.

Each row shows the repository and number of the issue (`owner/repo#number`) and its title. Select it to open the issue on GitHub. When the issues of a source come from more than one repository, select a repository above the groups to show only its issues. **Assign all to me** then assigns only the issues shown. Select **All repositories** to show all issues again.

An issue the hopper took leaves Intake. Its progress (taken, partly done, its pull request waits for review) shows on **Jobs**. Each source shows one line with how many such issues there are, with a link to Jobs. When nothing waits, the source says *Nothing waiting for intake*.

The nav badge counts the request cards. A second, dashed badge counts the issues on the backburner. When no source lists issues, the page says so.

**Sources** shows each source's sync and a link to Intake with its counts. Who is a trusted actor is set on **Settings → Intake**. See [How issues become jobs](intake.md).

## Tagged

**Tagged** lists the open issues and pull requests in your job repositories that wait on you on GitHub, per source:

- **review requested**: a pull request asks for your review.
- **mentioned**: the issue or pull request mentions you (`@` and your GitHub login).
- **assigned**: the issue or pull request is assigned to you.

Each row shows the repository and number, the title, the author, why it is listed (one or more of the three), when it was opened, and for a pull request its checks. The number links to GitHub.

The source reads them at each sync, at most once for each intake sync interval, and at once when you select **Sync now**. A new review request shows within one sync. A row leaves by itself when you handle it on GitHub: you give the review, the pull request is merged or closed, the issue is closed, or you are no longer mentioned or assigned.

Select **Dismiss** to take a row off the list. Nothing changes on GitHub. The row comes back only when it is listed for a new reason: for example, someone asks for your review again after you reviewed it. The source shows how many rows you dismissed.

To work on a row, select one of these. One select starts a job at once, with no Intake card: your select is the approval.

- **Research**: a job reads the item, its discussion, its diff, the issues it links and its checks, and writes a research report. For a review request, the report has a review summary, the risks and the comments it suggests. The report is on **Research**.
- **Propose**: a job writes a proposal for the item. You accept or decline it on **Proposals**.
- **Start work**: for an issue, a job does the work and opens a pull request that closes the issue. For a pull request, a job reviews it and writes the review as a draft in its result.
- **Fix its branch** (pull requests only): a job makes the change the pull request needs and pushes it to the branch of the pull request.

The job gets the link to the item, why it is on Tagged, and the repository. It posts nothing on GitHub in your name: a review, a comment or a reply is a draft for you to send. After you start a job, the row shows a link to it in place of the buttons, and the row is not counted in **Needs you**. A second select on the same row starts no second job.

Issues with the hopper label are not on Tagged: they are on **Intake**. Your own pull requests are not on Tagged: they are on **Pull requests**. Only a GitHub source of a connected account reads tagged items.

Each new review request records the event `source.review_requested`. Your webhooks get it, as they get every event.

## Access requests

**Access requests** shows what jobs on boxes wait on a person for. It always shows six panels, and an admin also sees **Delegate approvers**. A panel with nothing in it says what will show there.

| Panel | What you do |
|---|---|
| **Asked for** | A job needs a credential the vault does not give. Give one, or decline with a reason. |
| **Vault grants** | A job on a box asked the vault with no grant. Select **Grant**, or **Deny**: then that job asks no more. Granted items show here, with who granted them and when, and **Revoke**. |
| **AWS actions** | A job's step must change AWS with an action that the role's own access does not give. The card shows the exact action, the resource it acts on, the role, the job and why. Select **Grant**: the step goes on, and its session can only read and do the granted actions on their resources. The step still needs its approved plan, and the apply shows in the Infra changes feed. The grant covers later steps of the same role, action and resource until the time limit of remembered write approvals. Or select **Decline**: the step is told no. Grants show here, with who granted them and when they end, and **Revoke**. When infra applies are off, no job asks here: the change goes through CI. |
| **Sandbox runs** | One card for each job's run that waits for you. The card shows why the job asks, the job and its link, its plan and how to undo it, each need in plain words, and the access it needs: the image, the vault secrets and the egress hosts. Select **Approve** once: the hopper approves the access and the run together, and the job's step goes on with no other approval. The approval is for this job only: another job that asks for the same access gets a card of its own. To let later jobs with the same needs run with no new card, turn on **Allow again** on the card before you approve. Then the hopper also remembers each change you approved. Or write why not and select **Decline**: the job is told why. Cards of high-priority jobs show first. Runs that were approved or declined show below. A run of a blast radius the auto-approve policy holds, or whose every change you approved before (a remembered write approval), does not wait here. Skip this step with **Skip sandbox approval** on Settings → Vault. Each card's approval is its own: you can approve several cards in a row. |
| **Template approvals** | A template you or another person saved is new, or has a new image, secret or profile. Select **Approve**. When the card lists a write, sync or apply profile, select **Approve all listed** to approve the template and each profile. A template a job asks for has no card here: you approve it on the job's card in **Sandbox runs**. |
| **Unknown assets** | A template names a cluster that the vault cannot find: no AWS source of the topology lists it, and it has no minting credential or cluster override. No approval makes it work. Select **Add a cluster override** to name the cluster, or **Edit its needs on Settings → Vault** to change it to a known cluster, or select **Remove**. The card lists the known clusters, nearest first. A short name that is the start of more than one cluster (`utility` for `utility-eks` and `utility-gke`) is ambiguous: the card lists the clusters, and **Point at** a cluster changes the template to name it. These templates are not access requests: the Access requests badge does not count them, and Needs you counts them in its **Unknown clusters** row. |

To approve several at once, select the box on each sandbox run or template card, or select **Select all waiting**. Then select **Approve selected**. Each approval goes on its own, at the same time. Each card shows **Approving…**, then **Approved**, or why it was not approved. One that fails does not stop the others.

The page also links to **Settings → API tokens**, where you mint a box token for an agent that approves or merges through the API.

### Access requests over the API

An agent with an API token reads and decides the same requests. A token of the scope `*` (no limits) can do all of this. A token with other scopes needs the scope in each step.

1. `GET /api/vault` lists what waits: `grantAsks` (vault grant asks), `requests` (credentials asked for) and `sandboxRequests` (sandbox runs). Scope: `vault:read`.
2. `POST /ui/api/jobs/<job id>/grant-vault` grants a job the vault. `POST /ui/api/jobs/<job id>/deny-vault` denies its ask. Scopes: `jobs:grant-vault`, `jobs:deny-vault`.
3. `POST /ui/api/vault` with `{ "action": "give-credential", … }` or `{ "action": "decline-credential", "request": "<id>", "reason": "<text>" }` answers a credential request. Scope: `vault:edit`.
4. `POST /ui/api/sandbox-requests` with `{ "action": "approve-run", "job": "<job id>", "template": "<name>" }` approves a job's run card. `decline-run` with a `reason` declines it. Scope: `sandbox-requests:edit`.

Each decision is recorded as a decision in the UI is: the same event, and the card shows who decided. A decision through an API token shows the token's name and yours, for example "granted by cos-key (API token of you)". A path that is no route gets `404` and "no such route". A route that the token's scopes do not cover gets `403`, and the answer names the scope it needs. See [API tokens](api-tokens.md).

### Delegate approvers

A **delegate approver** lets an agent approve for you what waits on this page: vault grants, templates and sandbox runs. It can also deny a grant ask and decline a sandbox run. It cannot change settings, secrets or the master key.

1. On **Delegate approvers**, select **Mint delegate**.
2. Give it a name. Under **Never approves what names**, write what stays yours, for example `prod`. An approval that touches a template, secret, asset or machine whose name holds one of these is refused; you approve it yourself.
3. Copy the refresh token. It is shown once. Put it in a file the agent alone can read.
4. The agent runs `HOPPER_REFRESH_TOKEN_FILE=<that file> HOPPER_URL=<the hopper's URL> hopper grant approve <job>`. Also `hopper grant list`, `hopper grant deny <job>`, `hopper sandbox requests`, `hopper sandbox approve <id>`, `hopper sandbox decline <id> --reason <text>` and `hopper template approve <name>`. Each use writes a new refresh token to the file.

Each approval it makes shows its name and yours, for example "granted by cos (delegate of you)". Select **Revoke** on its row to stop it at once.

**Settings → Vault** keeps the configuration: secrets, templates, the sandbox approvals, the read policy, shared secrets and the hopper's own secrets. A template that waits there links to Access requests. See [The vault](vault.md) and [Sandbox boxes](sandboxes.md).

## Settings keeps configuration only

Each page where you act is outside **Settings**. Settings keeps only how the hopper works:

| What | Its home | What you do there |
|---|---|---|
| Decider picks | **Decisions**, panel **Decider picks** | Read what Jev picked. Select **Override** to say what it should have been. |
| Question history | **Questions**, tab **History** | Read each handled question. Select **Correct** to correct an auto-answer. |
| Your reports | **Your reports** | Read the bug reports you and your jobs filed. Select **Refresh**. |

**Settings → Decider** keeps the decision points and the TypeSafe API key, and links to Decisions. An old link to Settings → Question history or Settings → Your reports opens the new page.

## Through the API

Every count comes from the same reads the UI makes, with the same scopes:

| Count | Read |
|---|---|
| Intake | `GET /api/sources`: the intake items with `action: "approve"`. |
| Access requests | `GET /api/vault`: `requests`, `grantAsks`, `actionAsks` and `actionGrants` (AWS actions: `POST /ui/api/sandbox-requests` `grant-action` or `decline-action`, with `job` and `grant`: `role`, `action`, `resource`; revoke with `POST /ui/api/sandbox-approvals` `revokeAction`), `runs` (the run cards), and the templates with `pending` items or no `approval` that no job asked for (no `askedBy`) and no run card names. A run card is decided with `POST /ui/api/sandbox-requests` `approve-run` or `decline-run` (`job`, `template`), or `hopper sandbox approve-run <job> <template>`. Add `allowAgain: true` (`--allow-again`) to approve the access for later jobs too. |
| Unknown clusters | `GET /api/vault`: the templates with `unknownAssets`. |
| Infra plans | `GET /api/infra-plans`: the plans with no `approval`, no failed check (`summary.failed`), and an `expiresAt` still to come. |
| Pull requests | `GET /api/pull-requests`: the cards with `state: "open"` and `mergeable: "conflicts"`. |
| Tagged | `GET /api/sources`: `detail.tagged` of each source. **Dismiss** is `POST /ui/api/sources/<name>/intake` with `kind: "dismiss"`. **Research**, **Propose**, **Start work** and **Fix its branch** are `POST /ui/api/sources/<name>/tagged-start` with `key` and `start` (`research`, `propose` or `work`), and `work: "fix"` for **Fix its branch**. |
| Questions, proposals, research, logins, failures, pre-sort | `GET /api/questions`, `GET /api/proposals`, `GET /api/research`, `GET /api/logins`, `GET /api/failures`. The pre-sort: `GET /api/queue`. |

The yolo mode in the top bar is `GET /api/yolo-mode`. Each action is the same `POST /ui/api/*` route the page uses. See [The operator CLI and the API](cli-and-api.md).
