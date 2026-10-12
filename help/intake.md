# Intake: how issues become jobs

The hopper takes a GitHub issue as a job when it has the source label, is assigned to you, and comes from a trusted origin. Any other issue waits in Sources as a request card that you read and approve, and every job runs the text that was approved.

## What it is

A job comes from a GitHub issue. Nothing pushes jobs: the hopper pulls them at each sync of its job source (every 60 seconds by default).

The hopper takes an open issue when all of these are true:

| Check | What the hopper looks for |
|---|---|
| Source label | The issue has the source label, `hopper` by default. |
| Assignee | The issue is assigned to your connected GitHub account. |
| Job repository | The issue is in a repository you chose in **Sources**. |
| Trusted origin | A trusted actor wrote the issue, added the label and assigned it to you. |
| No end label | The issue has no `hopper:done`, `hopper:failed`, `hopper:rejected`, `hopper:pr-ready`, `hopper:partly-done` or `hopper:pr-closed`. |
| Not held back | The issue does not have `hopper:backburner`, and it is not addressed to another hopper (`hopper@<name>`). |
| Not claimed | No other hopper holds its claim (`hopper:claimed`). |

When the hopper takes an issue, it adds `hopper:claimed` and a holder label, `hopper:held-by:<id>`. The id is random. It names no person and no machine.

### Trusted actors and trusted origin

A **trusted actor** is a GitHub login whose acts can start your jobs. By default, the only trusted actor is your connected GitHub login. An admin can name more logins in **Settings → Intake**.

An issue has a **trusted origin** when all three acts come from trusted actors:

- who wrote the issue,
- who added the source label (the newest time it was added),
- who assigned the issue to you (the newest time it was assigned).

These never count as trusted actors:

- an app or a bot (a `name[bot]` login, or an act done through a GitHub App),
- a login that is not in your trusted actors,
- an act the hopper cannot find in the issue's events.

**Assign to me** in Sources counts as your own act, because the hopper does it for you.

An issue that a job filed is never of a trusted origin. A job cannot make work for itself.

Access decides each login. The hopper asks OpenFGA (`intake#can_start_jobs`) and tells it your list of trusted actors at each check.

### Request cards

An open, labelled issue that is assigned to you, but is not of a trusted origin, is a **request card**. The hopper does not take it. It shows the card in **Sources**, above the other issues.

The card shows:

- why it is a request (one reason per line, for example `written by octocat, not a trusted actor`),
- who wrote, labelled and assigned the issue (green when trusted),
- the title and the body, as plain text.

When you approve a card, the hopper records that title and body as the approved text. The job runs exactly that text.

### Item snapshots

The text a job runs is the item's **snapshot**: its title, its body, and the assignee's comments the job saw. The hopper records the snapshot when the first job of the issue is made, or when you approve a request card. It keeps a SHA-256 hash of the text.

Every later job of the same issue runs the snapshot, not the live issue. This includes **Run again**, a failure's retry, and an issue that you offer again by removing its end label.

## How to use it

### Give the hopper a job

1. Connect GitHub and choose your job repositories in **Sources → GitHub account**.
2. Open an issue in one of those repositories. Write the task in its title and body.
3. Add the label `hopper`.
4. Assign the issue to your connected GitHub account.
5. Look in **Sources**. The issue shows as `taken`, with its job.

If you did all of these steps yourself, the issue has a trusted origin. The job goes into the queue.

### Let other people start jobs

1. Sign in as an admin.
2. Open **Settings → Intake**.
3. Type one GitHub login per line. Leave it empty to trust only your connected login.
4. Select **Save**.

A bot login is refused. Issues from people not in the list still reach you as request cards.

### Approve a request card

1. Open **Sources**.
2. Read the reasons on the card, and read the title and body.
3. Select **Approve**.

The next sync takes the issue. The source syncs at once after an approval.

Approve works only when the text has not changed since the hopper showed it to you. If someone edited the issue after you read it, the hopper refuses: `its title or body changed since it was shown: read it again`. Reload the page and read the card again.

If the issue changes after you approved it, but before its job is made, the card shows again. It shows the approved text and the change line by line, with **Approve the new text**.

### Issues not assigned to you

An issue with the label but not assigned to you shows in Sources with `not assigned to you`.

- Select **Assign to me** to assign one issue to your account.
- Select **Assign all N to me** to assign every such issue.

The next sync takes each issue that is also of a trusted origin.

### Release a claim

An issue claimed by another hopper shows `claimed by another hopper`. If you know that no hopper works on it, select **Release claim**. The hopper removes `hopper:claimed` and the holder label.

### When an issue changes after its job is made

If someone edits the issue's title or body after the snapshot, the hopper holds the job. It does not run the edited text without a decision.

The job card (in the Overview's waiting list and in the Queue) shows the title change, the body change line by line, any new assignee comments, and who edited the issue. Pick one:

| Button | What happens |
|---|---|
| **Rerun the original** | The job runs the snapshot's text. This edit does not hold it again. |
| **Accept the new text** | The new text becomes the snapshot, and the job runs it. Only the owner can do this, as Access decides. |
| **Cancel** | The job ends. |

A new comment alone does not hold a job. Only an edit of the title or the body does.

From a terminal:

```sh
hopper job keep-original <job-id>
hopper job accept-new-text <job-id>
```

A job cannot accept new text. A job's token does not reach these routes.

### Run again and Reject

- **Run again** is on a job that failed, finished or was rejected. The hopper reopens the issue if it is closed, removes the end labels, and queues a new job at once. The new job runs the snapshot. CLI: `hopper job rerun <job-id>`.
- **Reject** is on a waiting job (Queue, or the Overview's waiting list). The job ends rejected and never runs. You can give a reason. The hopper writes nothing on GitHub. It does not take the issue again until it is assigned to you again, or you select **Run again**. CLI: `hopper job reject <job-id> --reason <text>`.

### The queue gate

After intake, a new job also passes the queue gate. Set it in the **Queue** view:

- `auto-accept` (default): the hopper accepts each new job. You can set a limit per hour.
- `review`: each new job waits for you. Select **Accept** or **Reject**.

## What the hopper does for you

- It lists every open labelled issue in your job repositories in **Sources**, with `taken` or the one reason it was not taken. It drops nothing silently.
- It reads the issue's events to find who wrote, labelled and assigned it.
- It puts the issue's text into the job's prompt inside an untrusted block. The job reads it as data, not as instructions.
- Only the assignee's comments reach the job.
- It releases its own stale claims: a claim of yours with no job here.
- When you unassign a waiting job's issue, it cancels the job. A running job goes on, and the UI flags it for you to stop or let finish.
- When an issue gets `hopper:backburner`, it cancels the waiting job.
- The origin controls only whether a job runs. Yolo mode merges a ready pull request of any job. See [Pull requests](pull-requests.md).

## Limits and troubleshooting

| Symptom | Cause and fix |
|---|---|
| Every issue is a request card, even your own | OpenFGA is not set up or not reached, so nobody is trusted. The reason says `trusted actors cannot be checked`. Set up OpenFGA: see [Deploy and update](deploy-and-update.md). |
| **Approve** answers 503 | OpenFGA cannot be asked. Approve needs Access. Fix OpenFGA, then approve again. |
| **Accept the new text** answers 403 | Access refused it: only the owner can accept new text. |
| An issue is not in Sources at all | It is not open, has no source label, or is not in a chosen job repository. |
| `not assigned to you` | Assign the issue to your connected account, or select **Assign to me**. |
| `labelled by an app or a bot (…)` or `assigned by an app or a bot (…)` | An app or a bot added the label or the assignment. Do it again yourself, or approve the card. |
| `a job filed it` | A job filed the issue. Read it and approve the card if you want it done. |
| `rejected by you: not taken until assigned to you again` | Assign the issue to yourself again, or use **Run again** on the rejected job. |
| A job waits with `its item changed since the snapshot` | Pick **Rerun the original**, **Accept the new text**, or **Cancel**. |
| A job waits with `queued before trusted origins` | The job was queued before the hopper checked origins. Approve its request card in **Sources**, or cancel the job. |
| `addressed to another hopper` | The issue has a `hopper@<name>` label for another hopper. |

Not built yet: a separate intake gate that stops each new issue for review before the trust check.

See also: [Pull requests](pull-requests.md), [Questions](questions.md), [CLI and API](cli-and-api.md).
