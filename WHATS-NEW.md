# What's new

What changed for the people who use the hopper, newest first. The update notice shows the lines
here that the installed version does not have yet.

How to write a line (AGENTS.md "What's new"): one line per change someone would notice, in plain
words, starting with `- `. Say what they can now do or what now works. No issue or pull request
numbers, no commit hashes, no file names, no code words. Never edit a line once released: the
update notice would show it again as new.

- See which version you run, and what it brought, at any time and on a phone too: tap the version at the top. Before, it showed only when an update was waiting.
- A job that only reports how it is getting on no longer asks you a question or sends a question alert: it is told to carry on, and only real questions reach you.
- Several people can now use one hopper, each with their own jobs, questions and settings, kept apart from everyone else's.
- The Sources page now shows GitHub as one section: it says whether issues are read through gh or through your GitHub App, puts that one first, and says why the other is not in use. Logging in to GitHub is shown beside them as what jobs push with.
- The container image you pull is now always built from the newest version. Before, changes made close together could leave it hours behind, so a container could lack features such as logging in to GitHub from the Sources view.
- One assistant's usage limit no longer stops jobs that run on another: a machine can run several kinds of coding assistant, and each one's budget holds back only its own jobs. Usage and the account of any assistant can now be read by a command you choose.
- Questions can be answered on a machine you choose, or through the Claude API with your own key, so a hopper in a container no longer sends every question to you.
- The hopper's container no longer shows itself as a machine jobs can run on. It never had what a job needs; jobs run on the machines you add.
- Settings has its own page: the question gates, the question history, routing, plugins and webhooks, each a section of it. The Questions page shows only the questions waiting for an answer.
- The model of an escalation level or of the gate router is now picked from the models your Claude offers, not typed.
- Turn a plugin that ships with the hopper on or off with one switch on the Plugins page. A new way to run jobs, such as Cursor's agent, works the moment you switch it on, with no restart.
- Jobs can now run in Cursor's agent instead of Claude, on this computer or on another one you reach over ssh; that computer no longer needs herdr. What a newly added machine starts with — how many jobs it runs at once and what it runs — is now yours to set in Machines, under Defaults.
- You can connect the hopper to GitHub from its own pages: press Log in to GitHub, then enter the code it shows on GitHub's site. Nothing to type in a terminal, which makes this the easy way when the hopper runs with Podman.
- An attached machine can show the Claude usage and account it runs on: add a Claude usage reading for that machine, and its usage caps that machine's jobs, not every machine's.
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
