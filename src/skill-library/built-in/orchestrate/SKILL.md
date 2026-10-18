---
name: orchestrate
description: How a hopper job plans many steps as a task list, runs the tasks, fans out the ones that are deliverables of their own, waits on them, and finishes.
---

# Orchestrate

Use this skill when the job has more than one step. The hopper ships it and gives it to every job, with any agent CLI:
nothing is installed from another repository. The rules of the repository you work in win over this skill.

## The repository's own copy

Some repositories have their own copy of this skill (for example `.agents/skills/workflow-orchestrate/` or
`.claude/skills/<name>/`). When the repository you work in has one, follow it where it differs: its rules win. Tell the
hopper which copy you follow, so the job record says so:

```sh
sh "$HOPPER_SKILL" orchestrate --repo-copy <the folder of its SKILL.md>
```

The hopper records the folder, its git tree and commit, and whether it has changes. Do the same again when you change
the copy. Keep the state as the next section says, also when the copy tells you to keep it in other places.

## Where the state is

Keep no state only on this machine. A job can stop, and start again on another machine. What stays is:

- the job's branch, as you pushed it;
- its pull request;
- its sub-tasks: the required child issues it filed, each with its fan-out key (below);
- your `HOPPER_TASKS` lines, which the hopper keeps on the job.

Commit and push work as each task is done. Do not write a task list file into the repository unless its rules ask for one.

## The loop

1. **Intake.** Read the job's issue and its comments through the hopper (`sh "$HOPPER_GH" issue view N --repo OWNER/NAME`
   and `issue comments`). Write the goal, and how you will know that it is done, in one or two lines.
2. **Task list.** Break the work into tasks. Each task has one acceptance test and is small enough to finish in one go.
   A task with no acceptance test is not a task. Give each task a short id that does not change: letters, digits and
   `-`, for example `t3-schema`. Write `HOPPER_TASKS 0/<total>`.
3. **Order.** Use real dependencies only. Put tasks that do not depend on each other side by side.
4. **Choose where each task runs.**
   - **In this job.** Most tasks. When your agent CLI has sub-agents, give each independent task to one, all at the same
     time; each works in a git worktree of its own under `$TMPDIR`. Else do the tasks one at a time.
   - **As a sub-task.** A task that is a deliverable of its own — a change in another repository, or a part that needs
     its own pull request — is a required child issue. File it with a **fan-out key**, and put the task id in its title:

     ```sh
     sh "$HOPPER_GH" issue create --repo OWNER/NAME --title TITLE --body-file FILE --required --key fanout-<task id>
     ```

     The hopper files it, labels it, assigns it to your user and links it as a sub-issue of the job's issue. A person
     approves it in Intake, and a job of its own does it. The key is the issue's (8 to 64 letters, digits, `_` or `-`):
     the same key again, from this job or a later job of the same issue, is answered with the issue it filed first
     (`"replayed": true`), and nothing is filed twice.
5. **Verify.** Check each task against its acceptance test, not against a claim that it worked. Then write the new
   `HOPPER_TASKS <done>/<total>`. A task that failed goes back on the list, or you write it in the pull request body.
6. **Wait.** When only sub-tasks are left, end your message with `HOPPER_WAITING`, `for:` the sub-task, and
   `on: issue OWNER/NAME#N` for one open child. The hopper wakes you when it closes. Then look at the next one. Never
   poll in a loop.
7. **Resume.** After a stop, a move to another machine or a cold start, make the task list again from the state that
   stays, never from memory: the branch, the pull request, and the sub-tasks. To learn a sub-task's issue, file it again
   with the same `--key`: the hopper answers the issue it filed, and files nothing.
8. **Finish.** Follow the job's done line. The hopper owns the issue's completion: never close the job's issue yourself;
   the merge of the pull request closes it. When a sub-task is still open and the rest is ready, open the pull request
   with "Part of #N" and write what is left.

## Rules

- Say what went wrong; do not hide it. A blocked task, a failed sub-agent, or a task you dropped goes in the pull
  request body.
- A sub-task gets its own text: what to change, why, and its acceptance test. Never a secret or a personal detail.
- One writer for each work tree: two sub-agents never edit the same worktree.
