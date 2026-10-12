# Pull requests

A job is done when its pull request is open, ready for review and free of merge conflicts. After that, the hopper follows the pull request, tends it when it gets conflicts or failing checks, and merges it for you only when you turn on yolo mode.

## What it is

### When a job is done

A job that works on an issue is done when one of these is true:

- Its pull request closes the issue (`Closes #N` in its body), and it is open, not a draft, has no merge conflicts and no failing checks.
- That pull request was merged after the job began.
- The issue was closed as completed (for example, the issue needed no code change).

A merge is never needed for done. A local commit, a pushed branch with no pull request, or a draft is not done.

If the job ends done but its own pull request has merge conflicts, failing checks, or is a draft, the hopper tells the job the fixed step to take: rebase, fix the checks, or mark it ready. The job goes on in the same session. It gets at most three such steps in one run. After that, the job fails.

If the hopper cannot find the pull request, the job ends failed and says what it looked at.

### Parts of an issue

A job can ship only part of an issue. It opens its pull request with `Part of #N` in place of `Closes #N` and lists what is left.

- The job ends finished, as partly done. The issue gets `hopper:partly-done`.
- When that pull request merges, the hopper runs the next part.
- The last part uses `Closes #N`. Its merge marks the issue done.

An issue can list its parts as a checklist under a heading named `Parts`. The job card then shows `x/y` parts done. A ticked box, or a merged `Part of #N` pull request, counts as one part done.

### PR waiting and the Pull requests list

A finished job whose pull request is open is **PR waiting**. It holds no lane and is not a failure. The issue gets `hopper:pr-ready`.

The **Pull requests** view lists these pull requests, grouped by job repository. Each card shows:

- the pull request and the issue it closes (or is part of),
- its state, its checks and its merge state,
- its age,
- why it is not merged yet, in plain words.

| Card says | Meaning |
|---|---|
| `waiting for a person to merge` | Yolo mode is off for this repository. |
| `waiting for checks` | Checks run now. |
| `waiting for checks to start` | No checks yet, inside the grace window. |
| `conflicts with <base>` | The pull request has merge conflicts. |
| `checks failed` | A check failed. |
| `a job works on it now` | The hopper tends it (see below). |
| `the job that worked on it failed: waiting for a person` | The tend job failed. |
| `merge refused` | GitHub refused the merge. The card shows what GitHub said. |
| `ready, merging` | Yolo mode merges it at the next sync. |

The header says how many repositories have yolo mode on, and where merging waits.

## How to use it

### Review and merge yourself

1. Open **Pull requests**.
2. Select the pull request number to open it on GitHub. Review it there.
3. Merge it on GitHub, or select **Merge now** on the card.

When the pull request merges, the issue gets `hopper:done` and the card drops off.

### Merge now and Close PR

An open card has three buttons for an operator:

| Button | What happens |
|---|---|
| **Merge now** | The hopper merges the pull request now, with a merge commit, whatever yolo mode and the checks say. GitHub still refuses a draft, merge conflicts or a required check. |
| **Close PR** | The pull request closes without a merge. The issue gets `hopper:pr-closed`. The hopper does not take it again until a person removes that label. |
| **Send back for rework** | Type notes and select **Send back**. The pull request becomes a draft. A new job works on the same pull request, told your notes. It is done when it pushes to the pull request and marks it ready. |

Each of **Merge now** and **Close PR** asks you to confirm once.

From a terminal:

```sh
hopper prs                                    # the Pull requests list
hopper pr merge <n> [--repo <owner/repo>]     # Merge now
hopper pr close <n> [--repo <owner/repo>]     # Close PR
hopper job rework <job-id> --notes <text>     # Send back for rework
```

Use `--repo` when two repositories have a pull request with the same number.

### Turn on yolo mode

Yolo mode lets the hopper merge a ready pull request itself. It is off by default.

1. Sign in as an admin.
2. Open **Settings → Yolo mode**, read the warning, and set it for every repository or per repository. Or use the switch on a repository's group in **Pull requests**.
3. Or, from a terminal: `hopper yolo <owner/repo> on|off|default`.

A per-repository setting wins over the setting for every repository. `default` follows the setting for every repository.

### Add checks to a repository

A repository has **no checks** when its default branch requires no status check, no workflow runs on pull requests, and none of its five newest pull requests had checks. There, yolo mode merges code that nothing tested.

The Pull requests view warns about such a repository and recommends the job **Add PR checks to <repo>**:

- **Queue job** files that issue for you, with the `hopper` label, assigned to your connected account. It then runs as any other job.
- **Dismiss** hides the recommendation for that repository. The warning stays.

From a terminal: `hopper repo checks <owner/repo>`.

## What the hopper does for you

### It follows each pull request

At each sync, the hopper looks at every waiting pull request:

- Merged: the issue is done (`hopper:done`). For a part, the next part runs.
- Closed without a merge: the issue gets `hopper:pr-closed` and waits for a person.
- Still open: the hopper keeps what it saw (checks, conflicts, draft) for the card.

It also finds pull requests that a job opened before the hopper followed them, and follows those too.

### It tends a waiting pull request

When a waiting pull request gets merge conflicts with its base branch, or failing checks, the hopper does not leave it for you. It runs the issue again with a fixed brief:

- Merge conflicts: rebase onto the base branch, resolve the conflicts, push.
- Failing checks: read the failing checks, fix the cause, push.

The new job works on the same pull request and opens no new one. If it cannot fix it, it fails and says which files or checks, and why. The card then waits for a person.

The hopper tends one pull request at most three times in a row. A draft is never tended. The hopper does not act on review comments by itself: to ask for changes, use **Send back for rework**.

### Yolo mode merges when ready

With yolo mode on, the hopper merges a waiting pull request when all of these are true:

- It is not a draft.
- It has no merge conflicts.
- Its checks passed. Or it has no checks, and no check started within two minutes after its last push.

The origin of the job's issue does not change this. The hopper checked the issue before the job ran. See [Intake](intake.md).

A job never merges. The job holds no GitHub token. The hopper makes the merge.

### It closes the issue after its own merge

When the hopper merges a pull request (yolo mode or **Merge now**) that did not close its issue, and the pull request is not a part, the hopper closes the issue as completed. It posts one comment that links the pull request. A merge that a person made on GitHub does not get this.

## Limits and troubleshooting

| Symptom | Cause and fix |
|---|---|
| `merge refused` | GitHub refused: often a required check or a branch rule. Read the reason on the card. |
| A card says `pull request not found yet` | The hopper looks for it again at each sync: one that closes the issue, then one that mentions it, then one on a branch named for the issue. |
| A job failed with `not complete:` | It ended done with no ready pull request. Open the job to read what the hopper looked at. |
| The issue stays open after a merge | The pull request was a part, or a person merged a pull request with no `Closes #N`. Close the issue, or let the next part run. |
| A repository shows `no checks` | Select **Queue job** to add checks, or add a workflow yourself. |

**Merge now**, **Close PR** and **Send back for rework** need the operator role. Yolo mode needs an admin.

See also: [Intake](intake.md), [Questions](questions.md), [CLI and API](cli-and-api.md).
