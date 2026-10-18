---
name: orchestrate
description: How a hopper job plans many steps as a task list, runs the tasks, fans out the ones that are deliverables of their own, waits on them, and finishes.
---

# Orchestrate

Use this skill when the job has more than one step. The rules of the repository you work in win over this skill.

## Where the state is

Keep no state only on this machine. A job can stop, and start again on another machine. What stays is:

- the job's branch, as you pushed it;
- its pull request;
- its sub-tasks: the required child issues it filed, which the hopper links to the job's issue;
- your `HOPPER_TASKS` lines, which the hopper keeps on the job.

Commit and push work as each task is done. Do not write a task list file into the repository unless its rules ask for one.

## The loop

1. **Intake.** Read the job's issue and its comments through the hopper (`sh "$HOPPER_GH" issue view N --repo OWNER/NAME`
   and `issue comments`). Write the goal, and how you will know that it is done, in one or two lines.
2. **Task list.** Break the work into tasks. Each task has one acceptance test and is small enough to finish in one go.
   A task with no acceptance test is not a task. Give each task a short id that does not change, for example
   `t3-schema`. Write `HOPPER_TASKS 0/<total>`.
3. **Order.** Use real dependencies only. Put tasks that do not depend on each other side by side.
4. **Choose where each task runs.**
   - **In this job.** Most tasks. When your agent CLI has sub-agents, give each independent task to one, all at the same
     time; each works in a git worktree of its own under `$TMPDIR`. Else do the tasks one at a time.
   - **As a sub-task.** A task that is a deliverable of its own — a change in another repository, or a part that needs
     its own pull request — is a required child issue:
     `sh "$HOPPER_GH" issue create --repo OWNER/NAME --title TITLE --body-file FILE --required`. Put the task id in its
     title. A person approves it in Intake, and a job of its own does it.
5. **Verify.** Check each task against its acceptance test, not against a claim that it worked. Then write the new
   `HOPPER_TASKS <done>/<total>`. A task that failed goes back on the list, or you write it in the pull request body.
6. **Wait.** When only sub-tasks are left, end your message with `HOPPER_WAITING`, `for:` the sub-task, and
   `on: issue OWNER/NAME#N` for one open child. The hopper wakes you when it closes. Never poll in a loop.
7. **Resume.** After a stop, a move to another machine or a cold start, make the task list again from the state that
   stays, never from memory: the branch, the pull request, and the child issues of the job's issue (find a sub-task by
   the task id in its title before you file it again).
8. **Finish.** Follow the job's done line. Never close the job's issue yourself: the merge of the pull request closes
   it. When a sub-task is still open and the rest is ready, open the pull request with "Part of #N" and write what is
   left.

## Rules

- Say what went wrong; do not hide it. A blocked task, a failed sub-agent, or a task you dropped goes in the pull
  request body.
- A sub-task gets its own text: what to change, why, and its acceptance test. Never a secret or a personal detail.
- One writer for each work tree: two sub-agents never edit the same worktree.
