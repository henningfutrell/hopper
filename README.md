<img src="site/hopper-logo.svg" alt="" width="64">

# hopper

A self-hosted job queue for coding agents. It pulls jobs from GitHub issues, runs each one as a
Claude Code session in a herdr pane on a machine it manages, answers or escalates the questions a
job asks, and keeps every machine inside its usage budget. One daemon, one Postgres database, a
web UI, and an HTTP API with its reference at `/docs/`.
Install page, step by step: https://henningfutrell.github.io/hopper/ (`site/`).

- **Jobs are pulled, never pushed.** A job is an issue with the `hopper` label, by an author you
  allow. No route creates a job.
- **Everything it keeps is in its database.** Config is three config documents in that database
  (`plugins.yaml`, `rules.md`, `auth.yaml`) and the webhook subscriptions, rows there edited from
  the UI; secrets come from its environment.
- **Every part is a plugin**: router, queue sorter, escalation levels, executors, job sources,
  machines, usage sources, notifiers (`docs/plugins.md`); the UI installs more from a plugin store.
- **Several people, kept apart.** One hopper can work for several users: each has their own jobs,
  questions, machines, plugins, webhooks and logins, and sees nobody else's. It starts with one,
  `owner`; an admin adds more in Settings → Users (`docs/sign-in.md` "Who signs in as which user").

## Getting started

Five steps, in this order. Each links to its section below.

1. **[Run it](#run-it)** — recommended: the published image with Podman, from one compose file;
   or one line installs the daemon, its database and its herdr session on this host.
2. **[Sign in](#sign-in)** — one command opens the UI, signed in.
3. **[Connect GitHub](#connect-github)** — log gh in as you: **Log in to GitHub** in the UI's Sources
   view (or `gh auth login` on a host). That is the default; a GitHub App
   of your own is the other path.
4. **[Give it jobs](#give-it-jobs)** — say whose GitHub issues it takes, then label an issue
   `hopper`.
5. **[Add machines](#add-machines)** — optional: jobs run on this host from step 1; add other
   computers, or a sandbox container, when you want more room.

## What you need

With Podman ([recommended](#with-podman-recommended)): only Podman with a compose provider; the image
carries the rest. The table is for the install on this host. On Windows, either goes inside WSL; the
install page has the steps: https://henningfutrell.github.io/hopper/#windows

| | for |
|---|---|
| Node.js ≥ 24 | the daemon (TypeScript, run directly) |
| Postgres (any; `deploy/compose.yaml` has one) | everything the daemon keeps |
| Docker | the bundled Postgres of the host install, `npm test` |
| herdr ([herdr.dev](https://herdr.dev)), at `~/.local/bin/herdr` | the panes jobs run in (`herdr-claude` executor), on each machine that runs Claude jobs |
| the `claude` CLI, signed in | jobs (on each machine that runs them), the escalation levels (here, or on the machine each designates; or none, with an API key), usage readings |
| the `gh` CLI signed in as you (default), or a GitHub App you create | reading and labelling the GitHub issues that are jobs ([Connect GitHub](#connect-github)) |

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
podman compose exec hopper hopper login-code --link http://127.0.0.1:4790   # open the printed link
podman compose exec hopper claude                                    # once: /login, then /exit
# GitHub: the UI's Sources view → Log in to GitHub (once; kept in the home volume)
systemctl --user enable podman-restart.service                        # once: start it again after a reboot
```

The container is not a machine: jobs run on attached machines ("Add machines"). Settings and secrets: a
`.env` beside `compose.yaml` (`.env.example`). Upgrade: `podman compose pull && podman compose up -d`.
Details: `docs/deploy.md` "In containers, with Podman".

The other ways each need a Postgres URL; the bundled one is `deploy/compose.yaml`.

### On this host, with one line

The daemon and its own herdr session as user services, and Postgres in docker. Jobs run on this host.

```sh
curl -fsSL https://henningfutrell.github.io/hopper/install.sh | bash
bash ~/.local/lib/hopper/scripts/open-ui.sh        # signs this browser in and opens the UI
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
bash ~/.local/lib/hopper/scripts/open-ui.sh        # signs this browser in and opens the UI
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
node src/cli.ts login-code --link http://127.0.0.1:4790       # in another terminal; open the link
```

## Sign in

The UI is at `http://127.0.0.1:4790/` on the daemon's host. On that host, after the systemd
install, one command signs this browser in as admin and opens the UI:

```sh
bash ~/.local/lib/hopper/scripts/open-ui.sh
```

Elsewhere (a container, a checkout, a browser without the script), mint a one-time login code:
`hopper login-code --link http://127.0.0.1:4790`, then open the link (it works once, for 10
minutes). For other people and other devices: sign-in realms — password accounts, LDAP, OIDC,
GitHub or SAML, set up in Settings → Sign-in — and the LAN or a public URL — `docs/sign-in.md`.

## Connect GitHub

The hopper reads issues, sets their labels and closes finished ones. It does that as one GitHub
identity. Pick the path; a new hopper is on the first one.

| Path | Use it when | The hopper acts as | Job source |
|---|---|---|---|
| [**The gh CLI**](#the-gh-cli-default) (default) | a personal hopper: your own repos, one person | you | `github` |
| [**A GitHub App of your own**](#a-github-app-of-your-own) | labels and closes must come from a bot, not from you; or an organization's repos, chosen by where you install the App | the App's bot, `<slug>[bot]` | `github-app` |

**Each hopper has its own identity. Never use a GitHub App or a private key from somebody else's
hopper**, and never give yours to anyone. A private key acts on every repository its App is installed
on; whoever holds a copy can do what the hopper can. hopper ships no shared App and no shared key:
if a guide or a person offers you one, do not use it.

Which path you are on: the UI's **Sources** view. The source that is not `paused` is the one taking
jobs; its badge says `gh` or `app`. `GET /api/accounts` names the GitHub account it acts as.

### The gh CLI (default)

On the hopper's host, as the user the daemon runs as:

```sh
gh auth login          # GitHub.com → HTTPS → log in with a web browser
gh auth status         # must say "Logged in to github.com account <you>"
```

Or, on any install, from the UI: **Sources** → **Log in to GitHub** (an admin). The hopper runs gh's
own device flow and shows its code and `https://github.com/login/device`; enter the code there as the
GitHub user the hopper should act as. gh keeps the login in its own config — with Podman, in the
container's home volume, so it outlives restarts and upgrades. This is the way in a container: no
terminal, no token in `.env`. A `GH_TOKEN` in the environment overrides gh's login; the panel says
so, and asks you to remove it.

That is all: the `github` source starts on its own once gh is logged in (no restart), and pauses
while a GitHub App key is set (`enabled: auto`).

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
3. `hopper config edit plugins.yaml`: set `appId` and `slug` on the `github-app` instance, with
   `authors` as in [Give it jobs](#give-it-jobs).
4. `systemctl --user restart hopper` (or the container), so the daemon reads the key. The
   `github` source now pauses and `github-app` takes the jobs.

### Not built: other ways in

Named so you know they are not missing steps. None is the path for a self-hosted hopper today:

- **A GitHub token kept by the hopper** (an OAuth app of the hopper's, or a fine-grained personal
  access token pasted into the UI). Logging gh in from the UI is built (above), and the login stays gh's.
- **A hosted relay**: one App that somebody else runs, which forwards issues to many hoppers.

## Give it jobs

1. Say whose issues it takes. `hopper config edit plugins.yaml`, under `jobSources`, on the
   instance of your [path](#connect-github): `github` (the gh CLI) or `github-app` (your App):

   ```yaml
   jobSources:
     - name: github
       plugin: github-gh
       options:
         enabled: auto                         # on until a GitHub App key is set
         authors: [your-github-login]          # required: whose issues are accepted
         repos: [your-org/your-repo]           # optional allowlist
         repoPaths: { your-org/your-repo: /srv/checkouts/your-repo }   # where each repo's jobs run
   ```

   A job runs in `repoPaths[<repo>]` (a checkout of that repo), else in `defaultCwd` (default: the
   home directory). That path must exist on whichever machine runs the job ([Add machines](#add-machines)). Restart the daemon
   (`systemctl --user restart hopper`, or the container).
2. Label an issue `hopper`. The issue body is the job's prompt.
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
| [this host](#this-host) | the start: jobs on the hopper's own machine | nothing to reach | herdr and `claude`; set up by the install |
| [ssh target](#an-ssh-target) | another computer the hopper can always ssh to (a desktop, a server, WSL) | ssh, with its own key | sshd, and herdr with `claude` or [Cursor's agent](#cursors-agent) |
| [client target](#a-client-target) | a computer the hopper cannot always reach (a laptop that moves networks): it dials in | the client's tunnel to the hopper | Node.js ≥ 24, herdr, `claude`; sshd on the hopper's host |
| [container target](#a-container-target) | plain shell commands, sandboxed: no network, no agent | `docker exec`, through a socket proxy | docker on the hopper's host |

Every command below runs on the hopper's host, as the user the daemon runs as, from the install
(`~/.local/lib/hopper`). Each script prints what to add next. The UI's Machines view shows each
machine online or offline; the daemon's log says why one is offline
(`journalctl --user -u hopper`).

**Machine defaults.** A machine added in the Machines view starts with the machine defaults: its
lanes and the executors it runs (one lane and `herdr-claude` until you change them). Change them
there with **Defaults**; they apply to machines added afterwards, never to ones already there.

### This host

Set up by [Run it](#run-it): `install.sh` starts its herdr session (`hopper-herdr`). It runs 4
lanes. To change that: the UI's Machines view, Edit on this machine. To keep some executors off this
host, set its `executors` option (`hopper config edit plugins.yaml`):

```yaml
machines: { name: local, plugin: local, options: { lanes: 4, executors: [test, herdr-claude] } }
```

With [Podman](#with-podman-recommended) the hopper's container is not a machine: it lists no `local`
machine (`HOPPER_LOCAL_MACHINE=false`), and jobs run on the machines attached below.

### An ssh target

1. **On the target**: install herdr at `~/.local/bin/herdr` and the `claude` CLI, and sign `claude`
   in (run `claude` once). Keep its services running after you log out:
   `sudo loginctl enable-linger "$USER"`.
2. **On the hopper's host**: give the target a `Host` alias in `~/.ssh/config`, then connect once by
   hand and check the host key it shows. The hopper trusts only the host key that
   `~/.ssh/known_hosts` holds for it; it never learns one from a connection.

   ```sh
   ssh my-desktop true        # must work without a password prompt
   ```

3. Prepare the target. This makes the hopper's own ssh key when it is missing, lets that key in on
   the target (restricted: no forwarding, no pty), installs and starts the target's herdr
   session, and prints the `plugins.yaml` entry:

   ```sh
   export HOPPER_SSH_KEY_FILE="$HOME/.config/hopper/ssh_key"
   bash ~/.local/lib/hopper/scripts/attach-machine.sh my-desktop 2     # 2 lanes
   ```

4. Give the daemon the key, once for every ssh target, and restart it:

   ```sh
   echo "HOPPER_SSH_KEY_FILE=$HOME/.config/hopper/ssh_key" >> ~/.config/hopper/daemon.env
   systemctl --user restart hopper
   ```

5. Attach it: in the UI, Machines → Add machine, pick `my-desktop`. Or paste the printed entry under
   `attachedMachines:` with `hopper config edit plugins.yaml`. No restart.
6. Make the jobs' working directories exist there, at the same paths (`repoPaths`, `defaultCwd`):
   a job whose directory is missing fails.

Within 30 s the Machines view shows it online.

### A client target

The target runs the hopper client, which dials the hopper over ssh and keeps the tunnel up; the
hopper never connects to it after setup. The hopper loads each new client release onto it by itself.

1. **On the target**: Node.js ≥ 24, herdr, the `claude` CLI signed in, and
   `sudo loginctl enable-linger "$USER"`.
2. **On the hopper's host**: sshd runs, and the target can reach it (`<user>@<hopper-host>`, port 22,
   or `HOPPER_CLIENT_HOPPER_PORT`). You can ssh to the target now, as in step 2 of the ssh target.
3. Install the client there. `laptop` is the machine's name in the hopper, `my-laptop` how you reach
   it now, `me@hopper-host` how it reaches the hopper:

   ```sh
   bash ~/.local/lib/hopper/scripts/attach-client.sh laptop my-laptop me@hopper-host 1
   ```

4. Add the line it prints to `~/.config/hopper/daemon.env` (`CLIENT_TOKEN_LAPTOP_FILE=…`), then
   `systemctl --user restart hopper`.
5. Paste the printed entry under `attachedMachines:` with `hopper config edit plugins.yaml` (the
   UI's Add machine attaches ssh targets only).
6. Make the jobs' working directories exist there, as for an ssh target.

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
4. `hopper config edit plugins.yaml`: add the `command` executor, the container, keep commands
   off this host, and send labelled issues to the container:

   ```yaml
   executors:
     - { name: test, plugin: test }
     - { name: herdr-claude, plugin: herdr-claude }
     - { name: command, plugin: command }
   machines: { name: local, plugin: local, options: { lanes: 4, executors: [test, herdr-claude] } }
   attachedMachines:
     - { name: box, docker: box, lanes: 1, executors: [command] }
   routing:
     - { name: commands to the box, match: { label: on-box }, set: { machine: box, executor: command } }
   ```

5. `systemctl --user restart hopper` (a new executor needs a restart).

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

### Send jobs to one machine

A routing rule sets a job's machine, executor or priority when the job comes in; the first rule that
matches wins. Edit them in the UI's Settings → Routing, or under `routing:` in `plugins.yaml`:

```yaml
routing:
  - { name: app work on the desktop, match: { repo: "your-org/app-*" }, set: { machine: my-desktop } }
  - { name: by label, match: { label: on-laptop }, set: { machine: laptop } }
```

A job pinned to a machine that is offline waits for it. How each kind works and why:
`docs/design.md` "Attached machines", "Container targets", "Client targets", "Target
authentication".

## Use it

| Where | What |
|---|---|
| UI, `/` | the board, questions, machines, usage, plugins, routing, webhooks, events, decisions |
| API reference, `/docs/` | every route, with parameters and bodies; try them from the page. The book icon in the UI's top bar opens it |
| `hopper help` | the operator CLI: config documents, login codes, password hashes |
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
