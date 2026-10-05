# What's new

What changed for the people who use the hopper, newest first. The update notice shows the lines
here that the installed version does not have yet.

How to write a line (AGENTS.md "What's new"): one line per change someone would notice, in plain
words, starting with `- `. Say what they can now do or what now works. No issue or pull request
numbers, no commit hashes, no file names, no code words. Never edit a line once released: the
update notice would show it again as new.

- A question a job asks now climbs levels: a first model answers what it can, a stronger one takes what the first is unsure of, and only what neither should decide reaches you. You choose the levels and their order on the Questions page.
- You can run the hopper from a ready-made image with Podman: nothing to build or install on the machine but Podman, and an upgrade is one download. This is now the recommended way, and the install page leads with it.
- Jobs keep all their work, temporary files included, inside the folder they start in, instead of wandering off to other places on the machine.
- You can run the hopper with Docker alone: download one file, start it, and the hopper, its database and the place its jobs run all come up together, with nothing else to install.
- You can install the hopper on Windows. It runs in WSL, from the same one-line install, and the install page shows each step.
- The app is now called hopper. An existing install changes to the new name with its next update, and keeps its settings, secrets and data.
- When an update is ready, "What's new" now lists the changes in plain words instead of a technical change log.
- When a job needs a decision, the hopper first works out its own best answer and only asks you when the choice really is yours.
- The first-time setup guide now walks you through adding the machines your jobs run on.
- You can install the hopper with a single copy-and-paste command.
- Linking another device shows a QR code you can scan with your phone; it follows the sign-in code as it changes.
- You can dismiss notices you have read: attention items, the update notice and pop-up messages.
- You can install, update and remove plugins from a plugin store.
- You can choose which panels the overview shows, in what order and how big, from Customize.
- Long lists scroll inside their own box, so every panel stays neatly in its place.
- The hopper keeps its helper on your other machines up to date by itself.
- Jobs can run on other computers and in containers, not only on the machine the hopper runs on.
- You can sign in with a password, or with your existing account from another sign-in provider.
- The hopper tells you when an update is ready and can install it without stopping running jobs.
- You can dismiss a question you no longer need to answer, and see the questions already handled.
