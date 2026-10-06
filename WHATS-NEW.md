# What's new

What changed for the people who use the hopper, newest first. The update notice shows the lines
here that the installed version does not have yet.

How to write a line (AGENTS.md "What's new"): one line per change someone would notice, in plain
words, starting with `- `. Say what they can now do or what now works. No issue or pull request
numbers, no commit hashes, no file names, no code words. Never edit a line once released: the
update notice would show it again as new.

- You can now choose which version the hopper updates to, in Version and updates: dev gets every change first, beta gets changes once they have run on dev, and main gets them once they have run on beta. Switching to a steadier channel takes the hopper back to that channel's version.
- When a job's instructions were pasted into Claude but never submitted, the hopper now submits them instead of pasting them a second time.
- You can now edit the rules every job is told, in Settings → Job rules: change them, clear them, or go back to the default. Where a job works and how it reports back stay fixed.
- A job no longer sits running while Claude waits idle: when its instructions never reach Claude, the hopper sends them again, and fails the job if they still do not arrive.
- Sources no longer asks you to install the hopper's GitHub app when it may already be installed: if GitHub cannot say where the app is installed, it says why and links to where you can see its installs.
- The lane timeline now shows when a job is sitting on a question: a hatched strip on its lane from the moment it asked until it is answered.
- The old built-in user from before GitHub sign-in is gone: everything it held now belongs to you, the admin who signed in with GitHub, and Settings → Users lists only real people.
- Claude jobs no longer get stuck on Claude's "bypass permissions" warning: yolo is now a switch on each Claude runner, on by default. Turn it off for a runner that should ask before it acts; its questions come to you (or your answering levels), and answering with an option's number or words picks it.
- Picking this computer as a machine to add over ssh now adds it directly, without ssh. When the hopper runs in a container, Machines says how to attach the computer it runs on instead of offering to add the container.
- An install or update can no longer leave the hopper's pages unstyled: a version whose look did not build properly is refused, and the running one stays.
- The sign-in page has a fresh look: on a wide screen it shows what the hopper does in three steps beside the sign-in, over a backdrop of jobs moving along their lanes.
- Someone you add with a login link sets up everything of their own, but only the hopper's admins manage sign-in, users, updates and the plugin store.
- Scripts and tools can read the hopper with the same GitHub or gateway sign-in you use in the browser: send the token, and they see your work and nothing else.
- Sources now lists the repositories the hopper's GitHub app reaches on each account it is installed on, with a link to change them, and asks you to install the app only when it is not installed yet.
- Two kinds of admin: the first person to sign in with GitHub is a super admin. Any admin can make someone admin from Settings → Sign-in → Admins; only a super admin can make someone super admin or hand theirs over.
- Once you sign in with GitHub, Sources shows that one GitHub connection, with what it reads and when, instead of leftover pieces for the command-line GitHub tool and its login.
- The hopper always looks for a newer version on its own, every minute, and offers it once one is ready: a setting can no longer quietly stop it from checking.
- The Sign-in settings page now shows sign-in as it works: GitHub first, with who the admin is and who else gets in, then any other ways to sign in, device links and no sign-in, each switch saying On or Off in words.
- The sign-in page has a new look: one clear card over a calm night-sky background, with a big Sign in with GitHub button. Where the hopper is set up for it, that button takes you to GitHub and straight back signed in, with no code to type; otherwise the code it shows is large and centred, with a copy button and a button that opens GitHub. Connecting GitHub from Sources shows the code the same way.
- You can add this machine from the Machines page with no ssh target: give it a name and the herdr session its jobs run in, and the hopper starts that session for you. Adding a machine over ssh no longer stops at a missing key setting: it uses the keys your own ssh would.
- A new hopper, and each person who joins one, no longer adds the hopper's own computer as a machine on its own: you add the machines your jobs run on, this computer among them if you want it.
- Jobs of someone who signed in with GitHub run again: every job runs in the hopper's usual terminal session, instead of looking for a separate per-person session that was never started.
- A new hopper no longer makes a starting admin account, password or login code, and there is no sign-in command to run on the machine: you sign in with GitHub, the first person to do so is the admin, and each person who signs in gets a space of their own.
- Sign in with GitHub: press the button, enter the code it shows on GitHub, and you are in — on a new hopper too, where the first person to sign in with GitHub becomes admin. That same sign-in connects your GitHub: your issues labelled hopper become your jobs, and your jobs act as you there, marked as done through the hopper. The page says plainly when GitHub is not connected.
- The sign-in page no longer tells you to run a script or paste a login code: it offers only the ways to sign in, such as GitHub.
- Settings now has a Version history page: every version of the hopper you run, newest first, with the day it came out and what it brought.
- Admins see, under Settings → Users, how many jobs every user together finished, failed, cancelled or turned away in the last day, and their usage added up, without seeing any one person's work or account.
- A new hopper's first sign-in is a one-time login code, shown with its link when the hopper starts. Username-and-password accounts kept by the hopper itself are gone: people sign in with GitHub or the sign-in your organisation already uses, and Settings no longer offers password accounts.
- The first person to sign in with GitHub becomes an admin, so a new hopper can be set up by whoever signs in first.
- The router's advice now always decides which jobs wait and which go first. The shadow and active switch is gone from the top bar and from the routing settings.
- The install guide now shows, step by step, how to let a team sign in through your own single sign-on, SAML, directory or sign-in gateway, set up from the hopper's settings at launch.
- The built-in "owner" account is now the default admin account, "admin": everything it had — work, settings, sign-ins — moved over, and "owner" is gone.
- Settings now has a Version section: the version you run, when it was installed and what it brought, with or without an update waiting. The version at the top is now a clear button that opens the same.
- A sign-in provider's client secret or directory password is now typed straight into its settings, with nothing to set up on the server. A deploy can also set up sign-in, and the first admin's password, from its environment.
- When you are not signed in, the hopper shows only a page to sign in, and nothing else of it, not even for a moment while it loads.
- The gate router's settings now say what they are: where Jev is installed, the Python that runs it, the Claude model and a timeout in seconds. Two settings nobody needed are gone. Saved settings carry over.
- With several users, an admin sees only totals across everyone — jobs waiting and running, open questions, busy lanes — and no longer anyone else's work. You can now change your own password under Settings → Users, which signs out your other sessions.
- You can always sign in with a username and password: a new hopper starts with an admin account whose first password is shown once when it starts, and Settings will not let the last admin password account be removed or turned off.
- The hopper can sit behind a sign-in gateway that already signs people in: it checks the gateway's token and opens without asking anyone to sign in again.
- Escalation levels are named as levels, not after a model: the two that came with the hopper are now "level-1" and "level-2", whatever model each uses. The model a level uses is shown only as its model. A level can no longer be given a model's name.
- A machine can be edited after it is added: change its name, its ssh target, its herdr session and every other detail from its Edit button on the Machines page. A new name is refused while a job runs there or waits for it.
- The Machines page no longer shows a "plugin" line on each machine: the line that says how a machine is reached is enough.
- Sign-in is set up in Settings → Sign-in with plain form fields, and people get a username and password there: add an account, pick its role and who it signs in as, and it works at once — nothing to type in as code.
- Every setting is now edited in the app and kept in its database — there are no config files to edit any more. Settings that name a program, its arguments or a folder (such as the program an advice level runs, or the ssh client it uses) can be changed on the Plugins page like any other setting.
- The Queue menu entry now shows how many new jobs are waiting to be sorted, and the Queue page has a "Set up the sorter" button that opens the setting that chooses how new jobs are sorted.
- A new Queue page lets you decide what runs: new jobs can wait for you instead of starting by themselves. Move each into your own order, take the automatic sort as it is, or reject a job — a rejected job is kept and marked, never run. You can also cap how many jobs are let in by themselves each hour, and give an issue a label naming one hopper so only that hopper takes it.
- You can choose where a job's work stops: merged (as before), or at a pull request left open for you to review and merge — for all issues, or for one issue by a label. A job is only marked done once its work gets there.
- Set up how people sign in from Settings, under Sign-in: add sign-in through a company directory (LDAP or Active Directory), OpenID Connect, SAML, GitHub or password accounts, put them in the order they are tried, and switch each on or off. Changes work at once, without a restart.
- The lane timeline no longer keeps drawing a job as running after the hopper restarted and ran that job again; the earlier run ends where the job started again.
- A finished issue runs again when you reopen it and remove its done label, and the Sources page says when an offered issue is not run again and why.
- A lane shows as running only while a job is actually running on it; a lane whose job has ended no longer stays shown as running.
- A newer version is offered within about a minute of being published, instead of up to a quarter of an hour later.
- Each lane shows the folder its job works in, and every lane is named with its machine — on the lane board, the timeline, the decision log and the event list — so two lanes with the same number on different machines no longer look the same.
- For the levels that answer questions and for usage readings, you now pick the machine they run on from your list of machines instead of typing it, and one must always be picked. This machine is in that list like any other; settings that named no machine now name this one.
- A job from a GitHub issue now counts as done only when its change has really shipped: its own pull request was merged and closed the issue. If nothing shipped, the job shows as failed with the reason, and the issue stays open instead of being closed as done.
- The top bar always shows who you are: your name and what you may do, or "not signed in" and whose work you see. When several people use the hopper, you sign in first and see only your own work.
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
