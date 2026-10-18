---
name: work
description: How a hopper job does the work of an issue, from the first read to a pull request that is ready for review.
requires: orchestrate
---

# Work

Use this skill when the job must change code or text in a repository.

## Before you change anything

1. Read the repository's rules: `AGENTS.md`, `CLAUDE.md`, `CONTRIBUTING.md` and the design documents they name.
2. Read the issue and its discussion. Find what it asks, and what it does not ask.
3. Look for work that already exists: an open pull request for the issue, an earlier part, or the same fix on the default
   branch under another issue.
4. Make a task list. Each task is one step that takes the job to done. When the work has more than a few steps, follow
   the `orchestrate` skill, which comes with this one.

## While you work

- Make the smallest change that does what the issue asks. Do not change what the issue does not touch.
- When the repository asks for tests first, write the failing test before the code that passes it.
- Use the words of the repository's glossary in code, tests and text.
- Commit in small steps, each with a message that says what changed and why.
- Run the repository's checks on what you changed. When a check fails for a reason of the machine, not of the change,
  write it down as an environment skip.

## Before you end

- Push the branch and open the pull request as the job rules say. Its body says what changed, how you checked it, and
  each decision you made yourself.
- Read your own diff once more. Remove debug output and files you did not mean to add.
