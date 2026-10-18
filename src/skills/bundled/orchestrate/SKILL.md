# orchestrate

Plan a job of many steps as a task list, fan out the sub-tasks that are deliverables of their own, wait on them, and
finish. The hopper ships this skill and gives it to every job: it needs nothing installed from another repository, and
it works with any agent CLI.

The rules of the repository you work in win over this skill. Read its AGENTS.md (or CLAUDE.md, CONTRIBUTING.md) first.

## Where the state is

Keep no state only on this machine. A job can stop, and resume on another machine. What survives is:

- the job's branch, as pushed;
- its pull request;
- its sub-tasks: the child issues it filed, each with its fan-out key (below);
- your HOPPER_TASKS lines, which the hopper keeps on the job.

Commit and push work as each task lands. Do not write a task list file into the repository unless its rules ask for one.

## The loop

1. **Intake.** Read the job's issue and its comments: `sh "$HOPPER_GH" issue view N --repo OWNER/NAME` and
   `sh "$HOPPER_GH" issue comments N --repo OWNER/NAME`. Write the goal and how you will know it is done, in one or two
   lines.
2. **Task list.** Break the work into tasks. Each task has one acceptance test and is small enough to finish in one go.
   A task with no acceptance test is not a task. Give each task a short id that does not change: letters, digits and
   `-`, for example `t3-schema`. Write `HOPPER_TASKS 0/<total>`.
3. **Order.** Use real dependencies only. Put tasks that do not depend on each other side by side.
4. **Choose where each task runs.**
   - **In this job.** Most tasks. When your agent CLI has sub-agents, give each independent task to one, all at once;
     each works in a git worktree of its own under `$TMPDIR`. Else do them one at a time.
   - **As a sub-task.** A task that is a deliverable of its own — a change in another repository, or a part that needs
     its own pull request — is a required child issue. File it with a **fan-out key**:

     ```sh
     sh "$HOPPER_GH" issue create --repo OWNER/NAME --title TITLE --body-file FILE --required --key fanout-<task id>
     ```

     The hopper files it, labels it and assigns it to your user, and links it as a sub-issue of the job's issue. Intake
     lists it; a person approves it; a job of its own does it. The key is the job's own (8 to 64 letters, digits, `_` or
     `-`): the same key again is answered with the issue it filed first (`"replayed": true`), and nothing is filed twice.
5. **Verify.** Check each task against its acceptance test, not against a claim that it worked. Then write the new
   `HOPPER_TASKS <done>/<total>`. A task that failed goes back on the list, or is said in the pull request body.
6. **Wait.** When only sub-tasks are left, end your message with `HOPPER_WAITING`, `for:` the sub-task, and
   `on: issue OWNER/NAME#N` for one open child. The hopper wakes you when it closes. Then look at the next one. Never poll
   in a loop.
7. **Resume.** After a stop, a move to another machine or a cold start, build the task list again from the durable
   state, never from memory: the branch, the pull request, and the sub-tasks. To learn a sub-task's issue, file it again
   with the same `--key`: the hopper answers the issue it filed, and files nothing.
8. **Finish.** Follow the job's done line. The hopper owns the issue's completion: never close the job's issue yourself;
   the merge of the pull request closes it. When a sub-task is still open and the rest is ready, open the pull request
   with "Part of #N" and list what is left.

## Rules

- Surface, do not hide: a blocked task, a failed sub-agent, a task you dropped — each goes in the pull request body.
- A sub-task gets its own text: what to change, why, and its acceptance test. Never a secret or a personal detail.
- One writer per file: two sub-agents never edit the same worktree.
