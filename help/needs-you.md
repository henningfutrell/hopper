# Needs you: what waits on you

**Needs you** is the first entry in the navigation. It shows every decision that waits on a person, by kind, with a count for each. Each row opens the one page where you act on that kind.

## What it is

Each kind of decision has one page, its home. Needs you collects the counts. You act on the home page, not in Needs you.

| Row | Its home | What it counts |
|---|---|---|
| Intake | **Intake** | Issues from people who are not trusted actors, waiting for your approval. |
| Access requests | **Access requests** | Credentials, vault grants and box templates that jobs on boxes wait for. |
| Infra plans | **Infra** | Plans of infrastructure changes that wait for an admin to approve them. |
| Questions | **Questions** | Questions jobs asked you. |
| Proposals | **Proposals** | Proposals that wait for you to pick a path. |
| Research | **Research** | Research reports that wait for you to accept or steer them. |
| Logins | **Logins** | Logins a job waits on, and connections that ended. |
| Failures | **Failures** | Open problems and jobs handed off to a person. |
| Pull requests | **Pull requests** | Open pull requests with merge conflicts. Fix them, or close them. |
| Pre-sort | **Queue** | Jobs that wait on the pre-sort before a lane takes them. |

The badge on **Needs you** is the sum of all rows. When a high-priority job waits, the badge has a ring and an arrow. Parked jobs are not in Needs you: they wait to be picked up, not for a decision. **Parked** keeps its own badge.

**Infra** and **Pull requests** also have their own badges in the navigation, with the same counts. The Infra badge also counts the out-of-band changes that no one marked yet: see [Infra](infra.md). A machine has no row: a join code adds a machine at once, with no approval. A box whose template waits for approval counts in Access requests.

Every row shows, also when its count is 0. The page says *Nothing waits on you* when all counts are 0.

## Intake

**Intake** lists every open labelled issue your job sources list, per source. The issues are in groups, each with a count:

1. **Needs approval**: request cards. Select **Approve** to let the hopper take the issue.
2. **Not assigned to you**: select **Assign to me**, or **Assign all to me**.
3. **On the backburner**: select **Take off the backburner**.
4. **Pull request waits for review**, **Partly done**, **Other reasons**.
5. **Taken**: the issues the hopper took, with their jobs.

The nav badge counts the request cards. A second, dashed badge counts the issues on the backburner. When no source lists issues, the page says so.

**Sources** shows each source's sync and a link to Intake with its counts. Who is a trusted actor is set on **Settings → Intake**. See [How issues become jobs](intake.md).

## Access requests

**Access requests** shows what jobs on boxes wait on a person for. It always shows three panels. A panel with nothing in it says what will show there.

| Panel | What you do |
|---|---|
| **Asked for** | A job needs a credential the vault does not give. Give one, or decline with a reason. |
| **Vault grants** | A job on a box asked the vault with no grant. Select **Grant**. Granted items show here, with **Revoke**. |
| **Template approvals** | A template is new, or has a new image, secret or profile. Select **Approve**. A write, sync or apply profile has its own **Approve** button. |

The page also links to **Settings → API tokens**, where you mint a box token for an agent that approves or merges through the API.

**Settings → Vault** keeps the configuration: secrets, templates, the read policy, shared secrets and the hopper's own secrets. A template that waits there links to Access requests. See [The vault](vault.md) and [Sandbox boxes](sandboxes.md).

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
| Access requests | `GET /api/vault`: `requests`, `grantAsks`, and the templates with `pending` items or no `approval`. |
| Infra plans | `GET /api/infra-plans`: the plans with no `approval`, no failed check (`summary.failed`), and an `expiresAt` still to come. |
| Pull requests | `GET /api/pull-requests`: the cards with `state: "open"` and `mergeable: "conflicts"`. |
| Questions, proposals, research, logins, failures, pre-sort | `GET /api/questions`, `GET /api/proposals`, `GET /api/research`, `GET /api/logins`, `GET /api/failures`. The pre-sort: `GET /api/queue`. |

The yolo mode in the top bar is `GET /api/yolo-mode`. Each action is the same `POST /ui/api/*` route the page uses. See [The operator CLI and the API](cli-and-api.md).
