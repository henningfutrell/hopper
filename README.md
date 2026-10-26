<img src="site/hopper-logo.svg" alt="" width="64">

# hopper

A self-hosted job queue for coding agents. It pulls jobs from GitHub issues, runs each one as a
Claude Code session in a herdr pane on a machine it manages, answers or escalates the questions a
job asks, and keeps every machine inside its usage budget. One daemon, one Postgres database, a
web UI, and an HTTP API with its reference at `/docs/`.
Install page, step by step: https://henningfutrell.github.io/hopper/install.html (`site/install.html`).
User guide, what it does with a job once it runs and what you can do: https://henningfutrell.github.io/hopper/guide.html (`site/guide.html`).

- **Jobs are pulled, never pushed.** A job is an issue with the `hopper` label, assigned to you,
  from a trusted origin; any other is a request card you approve in Intake. No route creates a job.
- **Everything it keeps is in its database.** Config is the plugins, rules and sign-in configs and
  the webhook subscriptions, all in that database and all edited in the UI; there is no config file.
  Secrets come from its environment.
- **Every part is a plugin**: router, queue sorter, escalation levels, executors, job sources,
  machines, usage sources, notifiers (`docs/plugins.md`); the UI installs more from a plugin store.
- **Several people, kept apart.** One hopper can work for several users: each has their own jobs,
  questions, machines, plugins, webhooks and logins, and sees nobody else's. A new hopper starts with
  none: each person's first sign-in makes their user, and the first person to sign in with GitHub is the
  admin (`docs/sign-in.md` "Who signs in as which user").

![The hopper dashboard, busy: nine lanes on four machines running jobs, a lane timeline of finished and failed runs, the waiting queue with held jobs, and recent ended jobs.](docs/screenshots/queue.webp)

<p>
<img src="docs/screenshots/lanes.webp" width="520" alt="Animated: lanes finish their jobs and pick up the next ones from the waiting queue, which gets shorter.">
<img src="docs/screenshots/phone.webp" width="200" alt="The dashboard on a phone: the numbers of running, waiting and ended jobs, and the lane timeline.">
<img src="docs/screenshots/phone-question.webp" width="200" alt="The Questions view on a phone: a job's question with each escalation level's suggested answer and the answer box.">
</p>

Lanes pick up and finish jobs on their own; a question nothing else can answer waits for you, on any
screen, your phone too. Every screenshot here comes from a demo hopper with made-up data
([regenerate them](#develop)).

## Getting started

Five steps, in this order. Each links to its section below.

1. **[Run it](#run-it)** — recommended: the published image with Podman, from one compose file;
   or one line installs the daemon, its database and its herdr session on this host.
2. **[Sign in](#sign-in)** — one command opens the UI, signed in.
3. **[Connect GitHub](#connect-github)** — sign in with GitHub and enter the code it shows; the first
   person to do so becomes admin, and that connection is what your jobs work through. A GitHub App an
   admin sets up is the one other path.
4. **[Give it jobs](#give-it-jobs)** — choose the job repositories in Sources, then label an issue
   `hopper`.
5. **[Add machines](#add-machines)** — optional: jobs run on this host from step 1; add other
   computers, or a sandbox container, when you want more room.

## What you need

With Podman ([recommended](#with-podman-recommended)): only Podman with a compose provider; the image
carries the rest. The table is for the install on this host. On Windows, either goes inside WSL; the
install page has the steps: https://henningfutrell.github.io/hopper/install.html#windows

| | for |
|---|---|
| Node.js ≥ 24 | the daemon (TypeScript, run directly) |
| Postgres (any; `deploy/compose.yaml` has one) | everything the daemon keeps |
| Docker | the bundled Postgres of the host install, `npm test` |
| herdr ([herdr.dev](https://herdr.dev)), at `~/.local/bin/herdr` | the panes jobs run in (`herdr-claude` executor), on each machine that runs Claude jobs |
| the `claude` CLI, signed in | jobs (on each machine that runs them), the escalation levels (here, or on the machine each designates; or none, with an API key), usage readings |
| your GitHub, signed in with in the UI (default), or a GitHub App an admin creates | reading and labelling the issues that are jobs ([Connect GitHub](#connect-github)) |

## Run it

Pick one. Recommended: the published image with Podman.

### With Podman (recommended)

The daemon, its Postgres and OpenFGA (access checks), in containers from the public image
`ghcr.io/henningfutrell/hopper` (`latest` follows `stable`; Intel/AMD and ARM): no host install, nothing to
build, nothing to set first. Needs Podman ≥ 4.7 with `podman-compose` (or Docker's compose; `docker
compose` works the same everywhere below).

```sh
mkdir hopper && cd hopper
curl -fsSLO https://henningfutrell.github.io/hopper/compose.yaml      # compose.yaml in this repository
podman run --rm ghcr.io/henningfutrell/hopper:latest hopper service script > hopper-service.sh
bash hopper-service.sh install                                       # the stack under hopper-compose.service, with linger
# open http://localhost:4790/ and sign in with GitHub: the first person to do so is the admin
# save the master key it shows once (the UI banner only, never the log) in your password manager, then:
podman run --rm ghcr.io/henningfutrell/hopper:latest hopper master-key script > master-key.sh
bash master-key.sh seal                                              # paste it; sealed to this host, never in a file
systemctl --user restart hopper-compose.service                      # each start: the key is unsealed for compose alone
podman compose exec hopper claude                                    # once: /login, then /exit
# then Sources → GitHub account: choose the repositories jobs may come from
```

The service owns the stack (issue #1320): with rootless Podman the published port belongs to whoever started the
containers, and goes away when that terminal or agent exits. Start, restart and update through the service, never
`podman compose up` by hand; it starts the stack at boot, and every minute checks the port from the host and restarts
the stack when it does not answer. Docker needs no service: `docker compose up -d`.

The container is not a machine: jobs run on attached machines ("Add machines"). No settings file: the hopper keeps its
settings and secrets itself, set in the UI; the master key and what compose needs are given at launch. Update: you do it, the hopper never updates a container (`docs/deploy.md` "Update": the channel is the image tag; every image carries its own `compose.yaml` and the update: one command, the update notice gives it: `podman run --rm --pull=always ghcr.io/henningfutrell/hopper:<channel> hopper update script | bash -s -- ghcr.io/henningfutrell/hopper:<channel>` — it asks for the master key unless it is given at launch and refuses without it, uses the compose tool that started the stack, backs up the database, puts in the image's `compose.yaml`, restarts the whole stack on the new image, never the hopper alone, and checks the image, the health and the master key; then optionally `podman image prune -f --filter label=org.opencontainers.image.title=hopper`). Never edit `compose.yaml`: give a setting it names at launch (`export HOPPER_BIND=0.0.0.0` for a LAN install), the rest in `compose.override.yaml`.
Details: `docs/deploy.md` "In containers, with Podman".

The other ways each need a Postgres URL; the bundled one is `deploy/compose.yaml`.

### On this host, with one line

The daemon and its own herdr session as user services, and Postgres in docker. Jobs run on this host.

```sh
curl -fsSL https://henningfutrell.github.io/hopper/install.sh | bash
```

It clones the source into `~/.local/share/hopper/source` and runs its `scripts/install.sh`.
Without docker, give it a database: `curl … | HOPPER_DATABASE_URL=postgres://… bash`. Run the
same line again to update. Settings: the head of `scripts/get.sh`.

### On this host (systemd --user), from a clone

The same install, step by step.

```sh
git clone <this repository> hopper && cd hopper
export POSTGRES_PASSWORD="$(openssl rand -hex 24)"
docker compose -f deploy/compose.yaml up -d postgres
HOPPER_DATABASE_URL="postgres://hopper:$POSTGRES_PASSWORD@127.0.0.1:5433/hopper" bash scripts/install.sh
```

`install.sh` writes the database URL to `~/.config/hopper/daemon.env` (mode 600); put secrets
there too. The first start makes the master key and shows it once, in the UI only (**Show the key (once)**), never in the log:
save it in your password manager and add `HOPPER_MASTER_KEY=<it>` to `daemon.env` (`docs/deploy.md` "The master key").
The host install runs OpenFGA too, as the `hopper-openfga` user service on loopback, unless `daemon.env` already names one in `HOPPER_OPENFGA_URL` (`docs/deploy.md` "Access: OpenFGA"). Run it again to update. Remove with `scripts/uninstall.sh`.

### From a checkout, in the foreground

For a try-out or development:

```sh
npm ci && npm run build:ui
docker compose -f deploy/compose.yaml up -d postgres          # POSTGRES_PASSWORD set as above
export HOPPER_DATABASE_URL="postgres://hopper:$POSTGRES_PASSWORD@127.0.0.1:5433/hopper"
node src/main.ts                                              # node src/main.ts --help: every setting
```

## Sign in

The UI is at `http://localhost:4790/` on the daemon's host: sign in with GitHub, which every hopper
offers. The first person to sign in with GitHub is the admin. With no GitHub and no identity provider,
add the first admin's local account on the host (`hopper local-account add <email>`, the password on
stdin) and sign in with its email and password. A new hopper creates no user, no password and no login
code. For other people and other devices: local accounts (an email and a password, the hopper's own) and
sign-in realms — GitHub, LDAP, OIDC, SAML or an auth gateway in front —, set up in Settings → Sign-in or from the environment at
launch (`docs/deploy.md` "Sign-in set up at launch") — and the LAN or a public URL — `docs/sign-in.md`.

<img src="docs/screenshots/sign-in.webp" width="720" alt="The hopper's sign-in page: a Sign in with GitHub button beside what the hopper does in three steps.">

## Connect GitHub

GitHub is how people sign in to the hopper and how it works for them: each user's issues come from
their GitHub, and what their jobs do there acts as them, with GitHub showing the hopper's app on it.
There is one path: each user signs in with GitHub, and the `github-account` job source reads and writes
GitHub with that sign-in. The hopper keeps no GitHub App private key and asks for none: the hopper's app
ships only its public client id, which authorizes nothing by itself.

Where you stand: the UI's **Sources** view. The sentence in the GitHub section says whether issues are
read through your sign-in, or what to do first (sign in, choose repositories, sign in again).
`GET /api/accounts` names the account it acts as. (The gh CLI source and **Log in to GitHub** were removed
by issue #359; the `github-app` source, an admin's own GitHub App and its private key, by issue #1377.)

### Sign in with GitHub

Every hopper offers it, a new one too. On the sign-in page, **Sign in with GitHub** shows a code; enter
it at `https://github.com/login/device` and approve the hopper's app. **The first person to sign in with
GitHub becomes admin** — sign in yourself before anyone else reaches the UI. Everyone after gets what the
GitHub realm's role rules grant (Settings → Sign-in: usernames, or numeric ids;
[docs/sign-in.md](docs/sign-in.md#github)).

Signing in connects your GitHub: issues labelled `hopper` and assigned to you become your jobs
when you or a trusted actor (Settings → Intake) wrote, labelled and assigned them, and nobody else edited them — others show in Intake as
requests to approve —, in the repositories you choose under **Sources → GitHub account** — and your jobs
act as you on GitHub, with the app marked on what they do. Until you choose at least one repository, no job comes in.

The hopper's app reaches only the repositories it is **installed** on. It is public: install it on your
account or any organization you administer at https://github.com/apps/hopper-qm/installations/new, and
pick *All repositories* or *Only select repositories*. It asks to read and write issues (the jobs and their
labels), pull requests (a job's pull request) and contents (a job's branch), and to read metadata —
nothing else, and no webhook. **Sources → GitHub account** says where it is installed, what it may do
there, and links to choose its repositories or add it to another account or organization; then tick the
repositories jobs may use. That account is your sign-in, so
the panel offers **Sign out**, not a disconnect; to stop taking jobs from GitHub and stay signed in,
switch off the `github-account` source in **Plugins**. Revoke the app for good at
https://github.com/settings/applications.

A job never gets your token. Its git fetch and push, and the GitHub steps it takes (file an issue, open
a pull request), go through the hopper, which acts with this same connection; a job pushes only to a new
branch of its own repository. The token renews itself before it expires. Nothing falls back to another credential: while GitHub is
not connected, or its sign-in ended, the source is paused, says why, and takes nothing. An ended sign-in
shows **sign-in expired** in **Sources → GitHub account**; press **Connect GitHub again** (or sign in
with GitHub again).

Signed in at the edge instead (SSO, SAML, an auth gateway): **Sources → GitHub account → Connect
GitHub**, the same code at the same address. That account is then linked to your user. **Stop working
through GitHub** there forgets the account and its token and keeps you signed in; the source then says
*GitHub is not connected* and takes nothing.

The app ships with the hopper as a public client id — no secret: the device flow needs none. GitHub
Enterprise, or an app of your own instead of the hopper's (an organization that wants its own, a
fork), is set in the environment: `HOPPER_GITHUB_URL`,
`HOPPER_GITHUB_CLIENT_ID`, `HOPPER_GITHUB_APP_SLUG` (how to register one: [docs/sign-in.md](docs/sign-in.md#github)).

### Not built: other ways in

Named so you know they are not missing steps. None is the path for a self-hosted hopper today:

- **A fine-grained personal access token pasted into the UI.** Signing in with GitHub (above) is the
  built way: the hopper keeps the token GitHub grants its app.
- **A GitHub App of your own, acting as its bot with its private key.** Removed by issue #1377: a
  self-hosted hopper is given no App private key.
- **A hosted relay**: one App that somebody else runs, which forwards issues to many hoppers.

## Give it jobs

1. Choose the job repositories in **Sources → GitHub account**. In them, an issue labelled `hopper` and assigned to you
   becomes a job when a trusted actor wrote, labelled and assigned it, and nobody else edited it. Any other issue is a request card in Intake.
2. Label an issue `hopper` and assign it to yourself. A job runs in the work tree of the machine that runs it
   ([Where jobs work](#where-jobs-work)).
3. Watch it in the UI, answer its questions, and review its pull request. The merge closes the issue.

<img src="docs/screenshots/sources.webp" width="720" alt="The Sources view: a connected GitHub account, with four of its five repositories ticked for jobs and the Save button.">

The help pages tell the rest. Your hopper serves them for its own version at `/help/`; the project site shows them for
the stable version:

| Help page | What it tells |
|---|---|
| [How issues become jobs](https://henningfutrell.github.io/hopper/help/intake.html) | trusted actors, request cards, an issue that changes after its job is made, Reject, the queue gate |
| [The Jobs view](https://henningfutrell.github.io/hopper/help/jobs.html) | stages, the job page, a note to a running job |
| [Questions and deciders](https://henningfutrell.github.io/hopper/help/questions.html) | the escalation levels, auto-answer, the risk check, Jev |
| [Research reports and proposals](https://henningfutrell.github.io/hopper/help/research-and-proposals.html) | `hopper:research`, `hopper:proposal`, phase shifts |
| [Pull requests](https://henningfutrell.github.io/hopper/help/pull-requests.html) | the labels a job's issue gets, tending, Merge now, yolo mode |
| [Lanes and lane tuning](https://henningfutrell.github.io/hopper/help/lanes.html) | usage limits, `hopper:high` and the other priority labels, priority lanes, `hopper:specialty` |

With the queue gate on **review** (Queue view), every new job waits in the pre-sort until you accept it into your
order or reject it:

<img src="docs/screenshots/queue-order.webp" width="720" alt="The Queue view: the queue gate set to review, three held jobs in the pre-sort with Accept and Reject, and the accepted jobs in the user's order.">

**Needs you** lists every decision that waits on you, by kind: Intake, access requests, questions, proposals,
research, logins, failures and more. Each row opens the page where you act on it:

<img src="docs/screenshots/needs-you.webp" width="720" alt="The Needs you view: each kind of decision that waits on a person with its count, two questions, one of high priority, and two failures.">

## Add machines

A **machine** runs jobs. Each has **lanes**: how many jobs it runs at once. A job goes to a machine
that is online, runs the job's executor, and has the most room left — unless a
[routing rule](#send-jobs-to-one-machine) pins it to one. Pick the kind you need:

| Kind | Use it for | The hopper reaches it by | It needs |
|---|---|---|---|
| [a computer, with one line](#a-computer-one-line) | the computer the hopper's container runs on, a laptop, a desktop: it dials in | its own connection to the hopper's URL | Node.js ≥ 24, herdr, `claude` |
| [this host](#this-host) | the start: jobs on the hopper's own machine | nothing to reach | herdr and `claude`; set up by the install |
| [ssh target](#an-ssh-target) | a computer that cannot run the client (no Node.js 24) | ssh, with its own key | sshd, and herdr with `claude` or [Cursor's agent](#cursors-agent) |
| [container target](#a-container-target) | plain shell commands, sandboxed: no network, no agent | a new sandbox box for each command | the container runtime the hopper starts sandboxes with |

Every command below runs on the hopper's host, as the user the daemon runs as, from the install
(`~/.local/lib/hopper`). Each script prints what to add next. The UI's Machines view shows each
machine online or offline; the daemon's log says why one is offline
(`journalctl --user -u hopper`).

<img src="docs/screenshots/machines.webp" width="720" alt="The Machines view: four online machines, each with its lanes and live usage of the session and the week.">

**Usage throttling.** The **Usage** view shows how much of each account's plan the machines used, and the soft and
hard limits. Below the soft limit every lane is open; from it, each machine keeps fewer lanes; at the hard limit
nothing new starts. The view names the window that throttles, for example `46% session`. Help: [Lanes and lane
tuning](https://henningfutrell.github.io/hopper/help/lanes.html#usage-limits).

<img src="docs/screenshots/usage.webp" width="720" alt="The Usage view: the usage limits panel at 46% session, every lane open, the last day's usage over the free, soft and hard bands, and each machine's lanes.">

**Machine defaults.** A machine added in the Machines view starts with the machine defaults: its
lanes and the executors it runs (one lane and `herdr-claude` until you change them). Change them
there with **Defaults**; they apply to machines added afterwards, never to ones already there.

### A computer: one line

Machines → **Add machine**, **Show the line**, run it on the computer. The machine joins, and
shows in the Machines view, online, a few seconds later. Nothing is typed into the hopper; nothing
listens on the machine (it dials in to the hopper's own URL); no ssh, no keys to copy, no restart. The
line carries a one-time join code: it works once, for 10 minutes.

- **A computer**: run the line in a terminal there. It checks Node.js ≥ 24 and herdr, installs the
  hopper's client, joins, and runs it as the user units `hopper-client` and `hopper-client-herdr`. Its
  jobs run as you there. Sign `claude` in there once, and keep it running after you log out:
  `loginctl enable-linger`. For the computer a hopper container runs on, open the UI at
  `http://localhost:4790` there first: the line names the URL the page is open at.
  The hopper keeps the client current by itself. Should Machines say a computer's client cannot be
  updated, it shows the line to run there: the same install with no join code, which reinstalls the
  client and keeps the machine.
- **A Windows computer**: the usual way is to run the machine inside WSL, with systemd on and
  `podman.socket` started (`systemctl --user enable --now podman.socket`), and run the line in the WSL
  distro, not in PowerShell. A client on Windows itself (Node.js for Windows, with Git Bash's `sh` on
  its `PATH`) joins too, for work that needs Windows; it serves no vault socket. It starts its own herdr session, with
  Git Bash as the shell of its panes. The steps:
  https://henningfutrell.github.io/hopper/install.html#windows-machine
- **No sandbox box.** A sandbox never joins as a machine: a job's step runs in a sandbox of its own, which the
  hopper makes for that step and destroys after it (`docs/deploy.md` "Sandboxes the hopper starts").
  Templates, approval and what a job's sandbox may get: the help pages "Sandbox boxes" and "The vault" (`/help/sandboxes`, `/help/vault`).

A machine is removed in the Machines view; its next dial-in is refused. A script that adds machines
mints a code with `hopper join-code` (the operator CLI) and runs the same line. Make the jobs' working
directories exist on the machine: a job whose directory is missing there fails.

### This host

Set up by [Run it](#run-it): `install.sh` starts its herdr session (`hopper-herdr`). A new hopper
does not list its own host as a machine: add it in Plugins → Machine sources (the `local`
plugin), and pick it as the machine of the escalation levels and the usage source. It runs 4
lanes. To change that: the UI's Machines view, Edit on this machine. To keep some executors off this
host, set the `executors` option of the `local` instance in Plugins → Machine sources
(for example `test` and `herdr-claude`).

With [Podman](#with-podman-recommended) the hopper's container is not a machine: it lists no `local`
machine (`HOPPER_LOCAL_MACHINE=false`), and jobs run on the machines attached below.

### An ssh target

1. **On the target**: install herdr at `~/.local/bin/herdr` and the `claude` CLI, and sign `claude`
   in (run `claude` once). Keep its services running after you log out:
   `sudo loginctl enable-linger "$USER"`.
2. **In the UI**: Machines → Add machine → **Attach a machine over ssh**. Type the ssh target as
   `you@my-desktop` (or pick a `Host` alias from `~/.ssh/config`, when the hopper's host has one).
   Nothing on the hopper's host needs a `~/.ssh`: the hopper has its own key, kept in its database, so
   it works the same when the hopper runs in a container that keeps nothing.
3. **On the target**: add the line the form shows (`restrict ssh-ed25519 … hopper`) to
   `~/.ssh/authorized_keys`.
4. **Attach machine**. When the hopper has not seen the target's host key, the form shows its
   fingerprint: check it on the target (`ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub`), then
   **Trust this key and attach**. The hopper then talks to it only while it presents that key. No restart.

   A key of your own instead (optional): mount it as the secret `HOPPER_SSH_KEY_FILE` and prepare the
   target with `bash ~/.local/lib/hopper/scripts/attach-machine.sh my-desktop 2`, which lets that key in
   and prints the options to set in Plugins → Machine sources.
5. Optional: give it a work tree (Machines → Edit → work tree). Default `~/hopper-jobs` there. The
   hopper makes it and clones each job's repository into it; nothing to set up by hand.

Within 30 s the Machines view shows it online.

### A container target

A machine with no agent that runs plain shell commands. The `command` executor runs an issue's first
fenced code block (else its whole body) with `sh -c`, and reports the exit code and output. Each
command runs in a new sandbox box of the target's image: no network, a read-only root, no
capabilities, a user other than root. The hopper removes the box when the command ends. The box
starts through the container runtime the hopper starts its sandboxes with ([docs/deploy.md
"Sandboxes the hopper starts"](docs/deploy.md)); while it has none, the target is offline.

1. Attach it in the UI:
   - Plugins → Executors: **Add** a `command` instance named `command`.
   - Plugins → Machine sources: **Add** a `container` instance named `box`, and set its
     options `lanes: 1`, `executors: command`. Its `image` is the hopper's box image by default;
     another image must run as a user other than root.
   - Keep commands off this host: on the `local` instance there, set `executors` to the others
     (`test`, `herdr-claude`).
2. Send labelled issues to the container target: a routing rule in Settings → Routing, named
   `commands to the box`, matching the label `on-box`, setting machine `box` and executor
   `command`. No restart: executors and machines follow the plugins config.

An issue labelled `hopper` and `on-box` now runs its script in a sandbox box.

### Cursor's agent

The `cursor-agent` executor runs a job in Cursor's agent (the Cursor CLI, `cursor-agent`) instead of
Claude Code: one print-mode run per turn, in the job's working directory, on this host, an ssh
target or a computer that joined with its line. A question it asks is answered in the same Cursor chat. It needs no herdr, and nothing
of it shows in a herdr pane.

1. **On each machine that runs it**: install the Cursor CLI
   (https://cursor.com/docs/cli/installation) and sign it in once: `cursor-agent login`, or set
   `CURSOR_API_KEY` in that machine's environment. The hopper holds no Cursor credential.
2. In the UI's Plugins view, under **Shipped plugins**, switch `cursor-agent` on. It runs at once; no
   restart.
3. Attach the machine in the Machines view with only `cursor-agent` ticked: a machine whose executors
   need no herdr is checked over ssh alone, so it needs no herdr. To make it the usual choice, tick
   `cursor-agent` under **Defaults**.
4. Send jobs to it with a routing rule in the Routing view: set its machine and the executor
   `cursor-agent`.

### Machines nobody watches: Claude with no key press

A job never waits on a key press at Claude's startup. On each herdr-claude instance, **unattended** (on by default,
Plugins) seeds Claude's config where the machine has none — a fresh container's empty home starts with no
first-run screen — and answers Claude's first-run screens (theme, the machine's API key, notices) with their defaults.
A screen the hopper has no default for, or Claude not signed in, comes to you as a question with the screen; your
answer picks its option. In a container, give Claude its credential as `CLAUDE_CODE_OAUTH_TOKEN`: name it in `compose.override.yaml`
(`CLAUDE_CODE_OAUTH_TOKEN: ${CLAUDE_CODE_OAUTH_TOKEN:-}`) and give it at launch (docs/deploy.md).

To run Claude with no screen at all, switch the `claude` executor on under **Shipped plugins**: Claude Code in print
mode, one run per turn, on this host or an ssh target, as `cursor-agent` runs (steps above). A question it asks is
answered in the same Claude session. It has no pane to watch and cannot pick up again after a daemon restart.

### Other agents: codex, opencode and omp

The `codex`, `opencode` and `omp` executors run a job in that agent's CLI, as `cursor-agent` runs Cursor's agent
(steps above): one print-mode run per turn, on this host, an ssh target or a computer that joined with its line.
Install the CLI on each machine that runs it and sign it in once there; opencode needs no sign-in.

The hopper publishes a box image of each agent: `ghcr.io/henningfutrell/hopper:box-<agent>`, for `claude`, `codex`,
`cursor`, `omp` and `opencode`. The sandbox playground starts a box of the agent you pick, and the Helm chart's lane
pods run the agent `lanes.agent` names.

### Send jobs to one machine

A routing rule sets a job's machine, executor, priority or work tree when the job comes in; the first
rule that matches wins. Edit them in the UI's Settings → Routing. Three examples:

| rule | matches | sets |
|---|---|---|
| app work on the desktop | repo `your-org/app-*` | machine `my-desktop` |
| by label | label `on-laptop` | machine `laptop` |
| app in its tree | repo `your-org/app` | machine `my-desktop`, work tree `~/code/app` |

<img src="docs/screenshots/settings.webp" width="720" alt="Settings → Routing: the router, the queue sorter and three routing rules.">

### Where jobs work

A job works in its **work tree**, on the machine that runs it; `~` is that machine's home, never the
hopper's. Each machine has its own (Machines → Edit → work tree; default `~/hopper-jobs`). A routing
rule can give a repository another path on the machine the rule names. A path is one machine's: it is
never used on another.

The hopper makes the work tree on each machine when it checks the machine (at attach, then every
30 s). A work tree that is a git repository you keep is used as it is: each Claude job gets its own
worktree of it. Any other work tree gets the job's repository: at the job's start the hopper fetches
`<work tree>/<repo>`, or clones it there the first time, and the job works in its own worktree of that
checkout, so a new machine or agent box needs nothing set up by hand. A machine whose work tree cannot be
made (not writable, the home itself) takes no job: its jobs wait, held with the reason, for a machine
that can take them, and the Machines view says what is wrong.

A job pinned to a machine that is offline waits for it. To keep room for pinned jobs, give a machine
`reservedLanes` (Plugins → Machine sources): jobs that could run on any machine leave that
many of its lanes free for the jobs pinned to it, and go to other machines first. How each kind works and why:
`docs/design.md` "Attached machines", "Container targets", "Client targets", "Target
authentication".

## Use it

| Where | What |
|---|---|
| UI, `/` | the board, questions, machines, usage, plugins, routing, webhooks, events, decisions |
| Help, `/help/` | how each feature works and how to use it, for the version that runs; Help in the user menu opens it. Agents read `/help/index.json` and `/help/<page>.md`; a job runs `sh "$HOPPER_SKILL" help` |
| API reference, `/docs/` | every route, with parameters and bodies; try them from the page. The book icon in the UI's top bar opens it |
| `hopper help` | the operator CLI: config records as JSON, users, join codes; and the operator's actions on the running hopper for a script — `hopper job accept\|reject\|rerun\|rework\|keep-original\|accept-new-text`, `hopper queue order\|gate`, `hopper question list\|answer\|close\|dismiss`, `hopper prs`, `hopper pr merge\|close`, `hopper repo checks`, `hopper yolo`, `hopper search` (its words, type-ahead, the index's state, Reindex); and the Failures actions with no UI sign-in — `hopper problem list\|release\|resolve`, `hopper handoff list\|continue\|fixed\|done-by-hand\|wont-do`, `hopper failure list\|retry` ([design](docs/design.md#failures-from-the-operator-cli-issue-623-2026-10-10)) |
| `node src/main.ts --help` | the daemon's settings, with defaults |

Settings holds the rest: the job rules every job's prompt carries, the plugins, the routing, the
question gates, webhooks, users and sign-in.

What each part of the UI is for, and what to do there: the [help pages](https://henningfutrell.github.io/hopper/help/) (`/help/` on your
hopper). Needs a person, parking, the blast-radius gate, failures and client updates: the [user guide](https://henningfutrell.github.io/hopper/guide.html).

<img src="docs/screenshots/job-rules.webp" width="49%" alt="Settings → Job rules: the rules text every job's prompt carries, and the fixed part after it."> <img src="docs/screenshots/plugins.webp" width="49%" alt="Plugins: the shipped plugins, each switched on or off, with what it does.">

The API: `GET /api/*` reads, free on loopback, and with a UI session (`x-hopper-session`) or an API token
(`Authorization: Bearer hopper_at_…`) from anywhere else; the only changes are `POST /ui/api/*`, behind a UI session or
an API token whose role allows them. A person mints a grant once for an agent, which then trades its refresh token for
short-lived API tokens by itself, each within the grant's scopes. A box action (start a job, run a command, merge,
update, change a machine) needs a box grant, which only a person mints.
The OpenAPI document is `/docs/openapi.json` (or `.yaml`).

## Read on

| | |
|---|---|
| [User guide](https://henningfutrell.github.io/hopper/guide.html) (`site/guide.html`) | using it: the blast-radius gate, Needs a person, parking, failures, client updates |
| Help pages, `/help/` (`help/`; [on the site](https://henningfutrell.github.io/hopper/help/)) | each feature, for the version you run: deploy and update, intake, lanes, questions, research and proposals, pull requests, infra, the vault, sandbox boxes, artifacts, API tokens, the CLI and the API |
| `docs/deploy.md` | deploy recipes, secrets, mounted secret files |
| `docs/sign-in.md` | sign-in, roles, reaching the UI across the LAN or a public URL |
| `docs/plugins.md` | writing a plugin; the plugin store |
| `docs/events.md` | the event log and webhooks |
| [`docs/agent-integration.md`](docs/agent-integration.md) | connect an outside agent: a scoped grant, webhooks and their signatures, direct queries, answering questions and approving Intake |
| `docs/design.md` | how it works, and why |
| `docs/glossary.md` | the words |

## Develop

`npm run check` runs every gate: typecheck, lint, tests (a throwaway Postgres container; needs
Docker), and the UI build. The repo's rules are `AGENTS.md`.

The screenshots in `docs/screenshots/` (this README, the install page, the Pages site's tour) are made by one
command, from a demo hopper: the real daemon over the test doubles, with made-up GitHub issues, four machines
that only pretend to be online, and the test executor standing in for agents. It never reaches the network,
a real machine or a real agent. Re-run it when the UI changes:

```sh
npm run build:ui
npx playwright install chromium   # once; or SCREENSHOTS_CHROMIUM=/usr/bin/chromium for a Chromium of the system
npm run screenshots               # about 3 minutes; SHOTS=queue,job for some
```

It needs Postgres as `npm test` does (Docker, or `HOPPER_TEST_POSTGRES_URL`). `scripts/screenshots/` holds
the demo's data (`demo.ts`) and the shots (`capture.ts`).

## License

MIT, see [LICENSE](LICENSE).
