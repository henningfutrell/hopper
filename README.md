<img src="site/hopper-logo.svg" alt="" width="64">

# hopper

A self-hosted job queue for coding agents. It pulls jobs from GitHub issues, runs each one as a
Claude Code session in a herdr pane on a machine it manages, answers or escalates the questions a
job asks, and keeps every machine inside its usage budget. One daemon, one Postgres database, a
web UI, and an HTTP API with its reference at `/docs/`.
Install page, step by step: https://henningfutrell.github.io/hopper/install.html (`site/install.html`).

- **Jobs are pulled, never pushed.** A job is an issue with the `hopper` label, by an author you
  allow. No route creates a job.
- **Everything it keeps is in its database.** Config is the plugins, rules and sign-in configs and
  the webhook subscriptions, all in that database and all edited in the UI; there is no config file.
  Secrets come from its environment.
- **Every part is a plugin**: router, queue sorter, escalation levels, executors, job sources,
  machines, usage sources, notifiers (`docs/plugins.md`); the UI installs more from a plugin store.
- **Several people, kept apart.** One hopper can work for several users: each has their own jobs,
  questions, machines, plugins, webhooks and logins, and sees nobody else's. A new hopper starts with
  none: each person's first sign-in makes their user, and the first person to sign in with GitHub is the
  admin (`docs/sign-in.md` "Who signs in as which user").

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

The daemon and its Postgres, in containers from the public image
`ghcr.io/henningfutrell/hopper` (`latest` follows `main`; Intel/AMD and ARM): no host install, nothing to
build, nothing to set first. Needs Podman ≥ 4.7 with `podman-compose` (or Docker's compose; `docker
compose` works the same everywhere below).

```sh
mkdir hopper && cd hopper
curl -fsSLO https://henningfutrell.github.io/hopper/compose.yaml      # compose.yaml in this repository
podman compose up -d
# open http://localhost:4790/ and sign in with GitHub: the first person to do so is the admin
podman compose exec hopper claude                                    # once: /login, then /exit
# then Sources → GitHub account: choose the repositories jobs may come from
systemctl --user enable podman-restart.service                        # once: start it again after a reboot
```

The container is not a machine: jobs run on attached machines ("Add machines"). Settings and secrets: a
`.env` beside `compose.yaml` (`.env.example`). Upgrade: `podman compose pull && podman compose up -d && podman image prune -f --filter label=org.opencontainers.image.title=hopper`.
Details: `docs/deploy.md` "In containers, with Podman".

The other ways each need a Postgres URL; the bundled one is `deploy/compose.yaml`.

### On this host, with one line

The daemon and its own herdr session as user services, and Postgres in docker. Jobs run on this host.

```sh
curl -fsSL https://henningfutrell.github.io/hopper/install.sh | bash
```

It clones the source into `~/.local/share/hopper/source` and runs its `scripts/install.sh`.
Without docker, give it a database: `curl … | HOPPER_DATABASE_URL=postgres://… bash`. Run the
same line again to upgrade. Settings: the head of `scripts/get.sh`.

### On this host (systemd --user), from a clone

The same install, step by step.

```sh
git clone <this repository> hopper && cd hopper
export POSTGRES_PASSWORD="$(openssl rand -hex 24)"
docker compose -f deploy/compose.yaml up -d postgres
HOPPER_DATABASE_URL="postgres://hopper:$POSTGRES_PASSWORD@127.0.0.1:5433/hopper" bash scripts/install.sh
```

`install.sh` writes the database URL to `~/.config/hopper/daemon.env` (mode 600); put secrets
there too. Run it again to upgrade. Remove with `scripts/uninstall.sh`.

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
offers. The first person to sign in with GitHub is the admin. There is no bootstrap login: a new hopper
creates no user, no password and no login code, and no command on the host signs anyone in. For other
people and other devices: sign-in realms — GitHub, LDAP, OIDC, SAML or an auth gateway in front (the hopper
keeps no password accounts of its own), set up in Settings → Sign-in or from the environment at
launch (`docs/deploy.md` "Sign-in set up at launch") — and the LAN or a public URL — `docs/sign-in.md`.

## Connect GitHub

GitHub is how people sign in to the hopper and how it works for them: each user's issues come from
their GitHub, and what their jobs do there acts as them, with GitHub showing the hopper's app on it.
There are two paths; a new hopper is on the first one.

| Path | Use it when | The hopper acts as | Job source |
|---|---|---|---|
| [**Sign in with GitHub**](#sign-in-with-github-default) (default) | each user works from their own GitHub | that user, through the hopper's app | `github-account` |
| [**A GitHub App of your own**](#a-github-app-of-your-own) | an admin's choice for particular environments: labels from a bot, repos chosen by where the App is installed. Not for local deployments in general | the App's bot, `<slug>[bot]` | `github-app` (added in Plugins) |

**Never use a GitHub App private key from somebody else's hopper**, and never give yours to anyone. A
private key acts on every repository its App is installed on. The hopper's app is different: it ships
only its public client id, which authorizes nothing by itself.

Which path you are on: the UI's **Sources** view. The source that is not `paused` is the one taking
jobs, and the sentence in the GitHub section says which. `GET /api/accounts` names the account it acts as.
(The gh CLI source and **Log in to GitHub** were removed by issue #359: the hopper reads GitHub as a
user only through that user's GitHub sign-in.)

### Sign in with GitHub (default)

Every hopper offers it, a new one too. On the sign-in page, **Sign in with GitHub** shows a code; enter
it at `https://github.com/login/device` and approve the hopper's app. **The first person to sign in with
GitHub becomes admin** — sign in yourself before anyone else reaches the UI. Everyone after gets what the
GitHub realm's role rules grant (Settings → Sign-in: usernames, or numeric ids;
[docs/sign-in.md](docs/sign-in.md#github)).

Signing in connects your GitHub: issues labelled `hopper` and assigned to you become your jobs —
whoever opened them, in the repositories you choose under **Sources → GitHub account** — and your jobs
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

A job that needs GitHub for its own git or `gh` gets your token from this same connection (`GH_TOKEN`).
The token renews itself before it expires. Nothing falls back to another credential: while GitHub is
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

### A GitHub App of your own

You create the App; it lives on your GitHub account (or your organization), and its key on your
hopper only. One App, one key, one hopper.

1. Create it. On the hopper's host, with a browser:

   ```sh
   bash ~/.local/lib/hopper/scripts/create-github-app.sh            # --org <org> for an organization
   ```

   GitHub shows a prefilled "Create GitHub App" page; click create. The script writes the key into
   `~/.config/hopper/daemon.env` as `GITHUB_APP_PRIVATE_KEY` and prints the App's `appId`, `slug`
   and install link. In containers, add `--secrets-file .env` (in the folder of `compose.yaml`).
2. Install it: open the printed install link and pick the repositories it may read. Those are the
   only repositories it takes jobs from.
3. In the UI, Settings → Plugins → Job sources, open the `github-app` instance and set `appId` and
   `slug` (marked "runs a command"; an admin edits them). It takes the issues assigned to your connected
   GitHub account, as in [Give it jobs](#give-it-jobs).
4. `systemctl --user restart hopper` (or the container), so the daemon reads the key. The
   `github-app` source then takes the jobs of the repositories the App is installed on.

### Not built: other ways in

Named so you know they are not missing steps. None is the path for a self-hosted hopper today:

- **A fine-grained personal access token pasted into the UI.** Signing in with GitHub (above) is the
  built way: the hopper keeps the token GitHub grants its app.
- **A hosted relay**: one App that somebody else runs, which forwards issues to many hoppers.

## Give it jobs

1. Sign in with GitHub (or **Sources → GitHub account → Connect GitHub**), then choose the job
   repositories in **Sources → GitHub account**: the issues in them that are labelled `hopper` and
   assigned to you are taken, whoever opened them. To tune a source, or to use
   [your own App](#a-github-app-of-your-own), open the instance in Settings → Plugins → Job sources —
   `github-account` or `github-app` (your App) — and set its options:

   | option | |
   |---|---|
   | `repos` | on `github-app`, an optional allowlist inside the App's installations (`your-org/your-repo`); `github-account` takes the job repositories chosen in Sources |
   | `repoPaths` | where each repo's jobs run (`your-org/your-repo` → `/srv/checkouts/your-repo`) |

   A job runs in `repoPaths[<repo>]` (a checkout of that repo), else in `defaultCwd` (default: the
   home directory). That path must exist on whichever machine runs the job ([Add machines](#add-machines)). Restart the daemon
   (`systemctl --user restart hopper`, or the container).
2. Label an issue `hopper` and assign it to yourself. The issue body is the job's prompt. Unassign it
   and a waiting job leaves the queue; a running one is flagged in the UI for you to stop or let finish.
   **Reject** a waiting job (Queue, or the Overview's Waiting list), with a reason if you like: the issue is
   left alone and not taken again until it is assigned to you again, or you run it again.
3. Watch it in the UI. The labels say where it is: `hopper:claimed` (running), `hopper:done`,
   `hopper:failed`. Remove `hopper:failed` to run it again. `hopper:high` and
   `hopper:low` set the priority; `hopper:backburner` parks an issue.
   A job is done when its pull request is merged — the merge closes the issue. To have jobs stop at
   an open pull request for you to review and merge, set the source's `completion` to
   `pull-request` in the Plugins view; `hopper:complete-at-pr` or `hopper:complete-at-merge` on an
   issue sets it for that issue alone.

When a job asks a question, it climbs the escalation levels: Opus answers what it can settle,
Fable takes what Opus escalates, and what neither should decide waits for you in the UI's
Questions view. The levels, their order and each one's model (picked from the models your `claude`
offers) are yours to change in Settings → Question gates, and so is where each one runs: on this
machine, on an attached machine you designate (`machine`), or through the Claude API with a key the
runtime gives (`anthropic-api`, `ANTHROPIC_API_KEY`) — the way a hopper in a container answers.

## Add machines

A **machine** runs jobs. Each has **lanes**: how many jobs it runs at once. A job goes to a machine
that is online, runs the job's executor, and has the most room left — unless a
[routing rule](#send-jobs-to-one-machine) pins it to one. Pick the kind you need:

| Kind | Use it for | The hopper reaches it by | It needs |
|---|---|---|---|
| [a computer, with one line](#a-computer-or-a-sandbox-box-one-line) | the computer the hopper's container runs on, a laptop, a desktop: it dials in | its own connection to the hopper's URL | Node.js ≥ 24, herdr, `claude` |
| [a sandbox box, with one line](#a-computer-or-a-sandbox-box-one-line) | jobs that must reach nothing of your computer | its own connection to the hopper's URL | Podman or Docker beside the hopper |
| [this host](#this-host) | the start: jobs on the hopper's own machine | nothing to reach | herdr and `claude`; set up by the install |
| [ssh target](#an-ssh-target) | a computer that cannot run the client (no Node.js 24) | ssh, with its own key | sshd, and herdr with `claude` or [Cursor's agent](#cursors-agent) |
| [container target](#a-container-target) | plain shell commands, sandboxed: no network, no agent | `docker exec`, through a socket proxy | docker on the hopper's host |

Every command below runs on the hopper's host, as the user the daemon runs as, from the install
(`~/.local/lib/hopper`). Each script prints what to add next. The UI's Machines view shows each
machine online or offline; the daemon's log says why one is offline
(`journalctl --user -u hopper`).

**Machine defaults.** A machine added in the Machines view starts with the machine defaults: its
lanes and the executors it runs (one lane and `herdr-claude` until you change them). Change them
there with **Defaults**; they apply to machines added afterwards, never to ones already there.

### A computer or a sandbox box: one line

Machines → **Add machine**, pick one, **Show the line**, run it where it says. The machine joins, and
shows in the Machines view, online, a few seconds later. Nothing is typed into the hopper; nothing
listens on the machine (it dials in to the hopper's own URL); no ssh, no keys to copy, no restart. The
line carries a one-time join code: it works once, for 10 minutes.

- **A computer**: run the line in a terminal there. It checks Node.js ≥ 24 and herdr, installs the
  hopper's client, joins, and runs it as the user units `hopper-client` and `hopper-client-herdr`. Its
  jobs run as you there. Sign `claude` in there once, and keep it running after you log out:
  `loginctl enable-linger`. For the computer a hopper container runs on, open the UI at
  `http://localhost:4790` there first: the line names the URL the page is open at.
- **A sandbox box** (Podman or Docker): run the line on the computer the hopper runs on. It starts the
  container `hopper-sandbox-claude` from `ghcr.io/henningfutrell/hopper:box-claude` on the hopper's network,
  locked down — every capability dropped, no new privileges, a read-only root, its own home volume,
  nothing of the computer mounted. Sign its agent in once:
  `podman exec -it hopper-sandbox-claude claude`; the sign-in stays in its home volume, as does its identity,
  so a recreated box is the same machine.
- **Windows, without WSL** (no systemd): once the client is installed and joined there, start herdr
  (`herdr --session hopper-client server`) and the client from your home directory, never from the
  client's own directory (Windows cannot replace a directory a process is in, which breaks a release
  load), and start the client again when it exits 75 — it does so after each new client release:
  ```powershell
  Set-Location $HOME
  do { node "$HOME\.local\lib\hopper-client\main.ts"; $code = $LASTEXITCODE } while ($code -eq 75)
  ```
  `claude` must be on its PATH as `claude.exe` (the native installer's); the client runs it with no shell.

A machine is removed in the Machines view; its next dial-in is refused. A script that adds machines
mints a code with `hopper join-code` (the operator CLI) and runs the same line. Make the jobs' working
directories exist on the machine: a job whose directory is missing there fails.

### This host

Set up by [Run it](#run-it): `install.sh` starts its herdr session (`hopper-herdr`). A new hopper
does not list its own host as a machine: add it in Settings → Plugins → Machine sources (the `local`
plugin), and pick it as the machine of the escalation levels and the usage source. It runs 4
lanes. To change that: the UI's Machines view, Edit on this machine. To keep some executors off this
host, set the `executors` option of the `local` instance in Settings → Plugins → Machine sources
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
   and prints the options to set in Settings → Plugins → Machine sources.
5. Make the jobs' working directories exist there, at the same paths (`repoPaths`, `defaultCwd`):
   a job whose directory is missing fails.

Within 30 s the Machines view shows it online.

### A container target

A container on the hopper's host with no network, a read-only root and no capabilities. No agent
runs in it: the `command` executor runs an issue's first fenced code block (else its whole body) with
`sh -c` and reports the exit code and output.

1. Start the container (`alpine:latest`; another image: `HOPPER_TARGET_IMAGE`):

   ```sh
   bash ~/.local/lib/hopper/scripts/container-target.sh box 1      # 1 lane
   ```

2. Start the docker socket proxy, naming every container target (run it again when you add one):

   ```sh
   bash ~/.local/lib/hopper/scripts/docker-proxy.sh box
   ```

3. Add the line it prints (`HOPPER_DOCKER_HOST=unix://…`) to `~/.config/hopper/daemon.env`.
4. Attach it in the UI, as the script prints:
   - Settings → Plugins → Executors: **Add** a `command` instance named `command`.
   - Settings → Plugins → Machine sources: **Add** a `docker` instance named `box`, and set its
     options `docker: box`, `lanes: 1`, `executors: command`.
   - Keep commands off this host: on the `local` instance there, set `executors` to the others
     (`test`, `herdr-claude`).
5. Send labelled issues to the container: a routing rule in Settings → Routing, named
   `commands to the box`, matching the label `on-box`, setting machine `box` and executor
   `command`. No restart: executors and machines follow the plugins config.

An issue labelled `hopper` and `on-box` now runs its script in the container.

### Cursor's agent

The `cursor-agent` executor runs a job in Cursor's agent (the Cursor CLI, `cursor-agent`) instead of
Claude Code: one print-mode run per turn, in the job's working directory, on this host or an ssh
target. A question it asks is answered in the same Cursor chat. It needs no herdr, and nothing
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

### Agent boxes: claude, codex, cursor, omp and opencode

On a computer with docker, `bash scripts/agent-boxes.sh` (from a checkout) starts one container per agent
CLI, each a machine of its own that runs its agent's jobs: claude in Claude Code, cursor in Cursor's agent,
codex, opencode and omp each in its own CLI. It finds the hopper in its container by itself and attaches
them all; running it again puts every box back as it should be.

1. `bash scripts/agent-boxes.sh`
2. `bash scripts/agent-boxes.sh --sign-in`: each agent not signed in yet opens its own sign-in here (a link
   or a code to enter on any device). Once per box: its home keeps it. opencode needs none.
3. Send jobs to a box with a routing rule in the Routing view: set its machine (`hopper-box-<agent>`).

### Send jobs to one machine

A routing rule sets a job's machine, executor, priority or work tree when the job comes in; the first
rule that matches wins. Edit them in the UI's Settings → Routing. Three examples:

| rule | matches | sets |
|---|---|---|
| app work on the desktop | repo `your-org/app-*` | machine `my-desktop` |
| by label | label `on-laptop` | machine `laptop` |
| app in its tree | repo `your-org/app` | machine `my-desktop`, work tree `~/code/app` |

### Where jobs work

A job works in its **work tree**, on the machine that runs it; `~` is that machine's home, never the
hopper's. The first that is set applies: a routing rule's work tree, the repository's path in its
source's `repoPaths`, the machine's own `workTree` (Settings → Plugins → Machine sources, on that
machine), the source's `defaultCwd`, the executor's `cwd`. The default is `~/hopper-jobs`, made when
missing. A work tree that is the machine's home, above it, or missing there fails the job at once.

A job pinned to a machine that is offline waits for it. To keep room for pinned jobs, give a machine
`reservedLanes` (Settings → Plugins → Machine sources): jobs that could run on any machine leave that
many of its lanes free for the jobs pinned to it, and go to other machines first. How each kind works and why:
`docs/design.md` "Attached machines", "Container targets", "Client targets", "Target
authentication".

## Use it

| Where | What |
|---|---|
| UI, `/` | the board, questions, machines, usage, plugins, routing, webhooks, events, decisions |
| API reference, `/docs/` | every route, with parameters and bodies; try them from the page. The book icon in the UI's top bar opens it |
| `hopper help` | the operator CLI: config records as JSON, users, join codes; and the operator's actions on the running hopper for a script — `hopper job accept\|reject\|rerun`, `hopper queue order\|gate`, `hopper question answer\|close\|dismiss` |
| `node src/main.ts --help` | the daemon's settings, with defaults |

The API: `GET /api/*` reads, free on loopback and with a UI session (`x-hopper-session`) from
anywhere else; the only changes are `POST /ui/api/*`, behind a UI session whose role allows them.
The OpenAPI document is `/docs/openapi.json` (or `.yaml`).

## Read on

| | |
|---|---|
| `docs/deploy.md` | deploy recipes, secrets, mounted secret files |
| `docs/sign-in.md` | sign-in, roles, reaching the UI across the LAN or a public URL |
| `docs/plugins.md` | writing a plugin; the plugin store |
| `docs/events.md` | the event log and webhooks |
| `docs/design.md` | how it works, and why |
| `docs/glossary.md` | the words |

## Develop

`npm run check` runs every gate: typecheck, lint, tests (a throwaway Postgres container; needs
Docker), and the UI build. The repo's rules are `AGENTS.md`.
