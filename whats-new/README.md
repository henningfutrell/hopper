# What's new fragments

A change that people who use the hopper would notice adds its What's new line here, in a new file.
It never edits `WHATS-NEW.md`: two open pull requests that edit the same lines of one file conflict.

- Name the file `<issue number>.md`, for example `824.md`. When one issue has more than one change, use
  `<issue number>-<word>.md`, for example `824-promote.md`.
- Write one line per change, starting with `- `. The rules of AGENTS.md "What's new" apply: plain words,
  no issue or pull request numbers, no file names, no code words.
- Never edit a line once it is merged.

Before a promotion to beta, `node scripts/whats-new.ts assemble` moves every fragment into the top of
`WHATS-NEW.md`, newest first, and deletes the fragments. Merge that as a pull request to `dev`, then run
`scripts/promote.sh beta`. Until then, the update notice reads the fragments too.

The pull request check runs `node scripts/whats-new.ts check HEAD^1`. It fails when a pull request adds a
line to `WHATS-NEW.md` directly, adds a line that is not in plain words, changes or removes a released line
(except to write one that is not in plain words again), or names a fragment wrongly.
