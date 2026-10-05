# job-hopper

A self-hosted job queue for coding agents. It pulls jobs from GitHub issues, runs each one as a
Claude Code session in a herdr pane on a machine it manages, answers or escalates the questions a
job asks, and keeps every machine inside its usage budget. One daemon, one Postgres database, a
web UI, and an HTTP API with its reference at `/docs/`.
Install page, step by step: https://henningfutrell.github.io/hopper/ (`site/`).

- **Jobs are pulled, never pushed.** A job is an issue with the `hopper` label, by an author you
  allow. No route creates a job.
- **Everything it keeps is in its database.** Config is four config documents in that database
  (`plugins.yaml`, `webhooks.yaml`, `rules.md`, `auth.yaml`); secrets come from its environment.
- **Every part is a plugin**: router, queue sorter, answerer, assessor, executors, job sources,
  machines, usage sources, notifiers (`docs/plugins.md`); the UI installs more from a plugin store.

## Getting started

Five steps, in this order. Each links to its section below.

1. **[Run it](#run-it)** — one line installs the daemon, its database and its herdr session on this
   host.
2. **[Sign in](#sign-in)** — one command opens the UI, signed in.
3. **[Connect GitHub](#connect-github)** — `gh auth login`, as you. That is the default; a GitHub App
   of your own is the other path.
4. **[Give it jobs](#give-it-jobs)** — say whose GitHub issues it takes, then label an issue
   `hopper`.
5. **[Add machines](#add-machines)** — optional: jobs run on this host from step 1; add other
   computers, or a sandbox container, when you want more room.

## What you need

On Windows, all of this goes inside WSL (Ubuntu with systemd on); the install page has the steps:
https://henningfutrell.github.io/hopper/#windows

| | for |
|---|---|
| Node.js ≥ 24 | the daemon (TypeScript, run directly) |
| Postgres (any; `deploy/compose.yaml` has one) | everything the daemon keeps |
| Docker | the container deploy, the bundled Postgres, `npm test` |
| herdr ([herdr.dev](https://herdr.dev)), at `~/.local/bin/herdr` | the panes jobs run in (`herdr-claude` executor), on each machine that runs Claude jobs |
| the `claude` CLI, signed in | jobs (on each machine that runs them), the answerer, the assessor, usage readings |
| the `gh` CLI signed in as you (default), or a GitHub App you create | reading and labelling the GitHub issues that are jobs ([Connect GitHub](#connect-github)) |

## Run it

Pick one. Each needs a Postgres URL; the bundled one is `deploy/compose.yaml`.

### On this host, with one line

The daemon and its own herdr session as user services, and Postgres in docker. Jobs run on this host.

```sh
curl -fsSL https://henningfutrell.github.io/hopper/install.sh | bash
bash ~/.local/lib/job-hopper/scripts/open-ui.sh        # signs this browser in and opens the UI
```

It clones the source into `~/.local/share/job-hopper/source` and runs its `scripts/install.sh`.
Without docker, give it a database: `curl … | JOB_HOPPER_DATABASE_URL=postgres://… bash`. Run the
same line again to upgrade. Settings: the head of `scripts/get.sh`.

### On this host (systemd --user), from a clone

The same install, step by step.

```sh
git clone <this repository> job-hopper && cd job-hopper
export POSTGRES_PASSWORD="$(openssl rand -hex 24)"
docker compose -f deploy/compose.yaml up -d postgres
JOB_HOPPER_DATABASE_URL="postgres://hopper:$POSTGRES_PASSWORD@127.0.0.1:5433/hopper" bash scripts/install.sh
bash ~/.local/lib/job-hopper/scripts/open-ui.sh        # signs this browser in and opens the UI
```

`install.sh` writes the database URL to `~/.config/job-hopper/daemon.env` (mode 600); put secrets
there too. Run it again to upgrade. Remove with `scripts/uninstall.sh`.

### In a container

The daemon in a container beside its Postgres. Jobs run on machines it reaches over ssh.

```sh
cp deploy/hopper.env.example deploy/hopper.env && chmod 600 deploy/hopper.env   # fill it in
export POSTGRES_PASSWORD="$(openssl rand -hex 24)"
docker compose -f deploy/compose.yaml --profile container up -d --build
docker compose -f deploy/compose.yaml exec hopper job-hopper login-code --link http://127.0.0.1:4790
```

Open the printed link. Behind a reverse proxy, set `JOB_HOPPER_PUBLIC_URL` and
`JOB_HOPPER_LAN_PEERS` in `deploy/hopper.env`. Details: `docs/deploy.md`.

### From a checkout, in the foreground

For a try-out or development:

```sh
npm ci && npm run build:ui
docker compose -f deploy/compose.yaml up -d postgres          # POSTGRES_PASSWORD set as above
export JOB_HOPPER_DATABASE_URL="postgres://hopper:$POSTGRES_PASSWORD@127.0.0.1:5433/hopper"
node src/main.ts                                              # node src/main.ts --help: every setting
node src/cli.ts login-code --link http://127.0.0.1:4790       # in another terminal; open the link
```

## Sign in

The UI is at `http://127.0.0.1:4790/` on the daemon's host. On that host, after the systemd
install, one command signs this browser in as admin and opens the UI:

```sh
bash ~/.local/lib/job-hopper/scripts/open-ui.sh
```

Elsewhere (a container, a checkout, a browser without the script), mint a one-time login code:
`job-hopper login-code --link http://127.0.0.1:4790`, then open the link (it works once, for 10
minutes). For other people and other devices: password sign-in, OIDC,
GitHub or SAML in `auth.yaml`, and the LAN or a public URL — `docs/sign-in.md`.

## Connect GitHub

The hopper reads issues, sets their labels and closes finished ones. It does that as one GitHub
identity. Pick the path; a new hopper is on the first one.

| Path | Use it when | The hopper acts as | Job source |
|---|---|---|---|
| [**The gh CLI**](#the-gh-cli-default) (default) | a personal hopper: your own repos, one person | you | `github` |
| [**A GitHub App of your own**](#a-github-app-of-your-own) | labels and closes must come from a bot, not from you; or an organization's repos, chosen by where you install the App | the App's bot, `<slug>[bot]` | `github-app` |

**Each hopper has its own identity. Never use a GitHub App or a private key from somebody else's
hopper**, and never give yours to anyone. A private key acts on every repository its App is installed
on; whoever holds a copy can do what the hopper can. job-hopper ships no shared App and no shared key:
if a guide or a person offers you one, do not use it.

Which path you are on: the UI's **Sources** view. The source that is not `paused` is the one taking
jobs; its badge says `gh` or `app`. `GET /api/accounts` names the GitHub account it acts as.

### The gh CLI (default)

On the hopper's host, as the user the daemon runs as:

```sh
gh auth login          # GitHub.com → HTTPS → log in with a web browser
gh auth status         # must say "Logged in to github.com account <you>"
```

That is all: the `github` source starts on its own once gh is signed in (no restart), and pauses
while a GitHub App key is set (`enabled: auto`). In a container there is no browser: put a token for
your account in `deploy/hopper.env` as `GH_TOKEN` (`gh auth token` prints one on a machine where gh
is signed in).

### A GitHub App of your own

You create the App; it lives on your GitHub account (or your organization), and its key on your
hopper only. One App, one key, one hopper.

1. Create it. On the hopper's host, with a browser:

   ```sh
   bash ~/.local/lib/job-hopper/scripts/create-github-app.sh            # --org <org> for an organization
   ```

   GitHub shows a prefilled "Create GitHub App" page; click create. The script writes the key into
   `~/.config/job-hopper/daemon.env` as `GITHUB_APP_PRIVATE_KEY` and prints the App's `appId`, `slug`
   and install link. For a container, add `--secrets-file deploy/hopper.env`.
2. Install it: open the printed install link and pick the repositories it may read. Those are the
   only repositories it takes jobs from.
3. `job-hopper config edit plugins.yaml`: set `appId` and `slug` on the `github-app` instance, with
   `authors` as in [Give it jobs](#give-it-jobs).
4. `systemctl --user restart job-hopper` (or the container), so the daemon reads the key. The
   `github` source now pauses and `github-app` takes the jobs.

### Not built: other ways in

Named so you know they are not missing steps. None is the path for a self-hosted hopper today:

- **Sign in to GitHub from the UI** (an OAuth app, or a fine-grained personal access token pasted in).
- **A hosted relay**: one App that somebody else runs, which forwards issues to many hoppers.

## Give it jobs

1. Say whose issues it takes. `job-hopper config edit plugins.yaml`, under `jobSources`, on the
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
   (`systemctl --user restart job-hopper`, or the container).
2. Label an issue `hopper`. The issue body is the job's prompt.
3. Watch it in the UI. The labels say where it is: `hopper:claimed` (running), `hopper:done` (and
   the issue closed), `hopper:failed`. Remove `hopper:failed` to run it again. `hopper:high` and
   `hopper:low` set the priority; `hopper:backburner` parks an issue.

When a job asks a question, the answerer (Claude) answers it, the assessor decides whether a
person must, and the UI's Questions view shows what waits for you.

## Add machines

A **machine** runs jobs. Each has **lanes**: how many jobs it runs at once. A job goes to a machine
that is online, runs the job's executor, and has the most room left — unless a
[routing rule](#send-jobs-to-one-machine) pins it to one. Pick the kind you need:

| Kind | Use it for | The hopper reaches it by | It needs |
|---|---|---|---|
| [this host](#this-host) | the start: jobs on the hopper's own machine | nothing to reach | herdr and `claude`; set up by the install |
| [ssh target](#an-ssh-target) | another computer the hopper can always ssh to (a desktop, a server) | ssh, with its own key | herdr, `claude`, sshd |
| [client target](#a-client-target) | a computer the hopper cannot always reach (a laptop that moves networks): it dials in | the client's tunnel to the hopper | Node.js ≥ 24, herdr, `claude`; sshd on the hopper's host |
| [container target](#a-container-target) | plain shell commands, sandboxed: no network, no agent | `docker exec`, through a socket proxy | docker on the hopper's host |

Every command below runs on the hopper's host, as the user the daemon runs as, from the install
(`~/.local/lib/job-hopper`). Each script prints what to add next. The UI's Machines view shows each
machine online or offline; the daemon's log says why one is offline
(`journalctl --user -u job-hopper`).

### This host

Set up by [Run it](#run-it): `install.sh` starts its herdr session (`job-hopper-herdr`). It runs 4
lanes. To change that: the UI's Machines view, Edit on this machine. To keep some executors off this
host, set its `executors` option (`job-hopper config edit plugins.yaml`):

```yaml
machines: { name: local, plugin: local, options: { lanes: 4, executors: [test, herdr-claude] } }
```

In the [container deploy](#in-a-container) this host has no herdr: jobs run only on the machines you
add.

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
   export JOB_HOPPER_SSH_KEY_FILE="$HOME/.config/job-hopper/ssh_key"
   bash ~/.local/lib/job-hopper/scripts/attach-machine.sh my-desktop 2     # 2 lanes
   ```

4. Give the daemon the key, once for every ssh target, and restart it:

   ```sh
   echo "JOB_HOPPER_SSH_KEY_FILE=$HOME/.config/job-hopper/ssh_key" >> ~/.config/job-hopper/daemon.env
   systemctl --user restart job-hopper
   ```

5. Attach it: in the UI, Machines → Add machine, pick `my-desktop`. Or paste the printed entry under
   `attachedMachines:` with `job-hopper config edit plugins.yaml`. No restart.
6. Make the jobs' working directories exist there, at the same paths (`repoPaths`, `defaultCwd`):
   a job whose directory is missing fails.

Within 30 s the Machines view shows it online.

### A client target

The target runs the hopper client, which dials the hopper over ssh and keeps the tunnel up; the
hopper never connects to it after setup. The hopper loads each new client release onto it by itself.

1. **On the target**: Node.js ≥ 24, herdr, the `claude` CLI signed in, and
   `sudo loginctl enable-linger "$USER"`.
2. **On the hopper's host**: sshd runs, and the target can reach it (`<user>@<hopper-host>`, port 22,
   or `JOB_HOPPER_CLIENT_HOPPER_PORT`). You can ssh to the target now, as in step 2 of the ssh target.
3. Install the client there. `laptop` is the machine's name in the hopper, `my-laptop` how you reach
   it now, `me@hopper-host` how it reaches the hopper:

   ```sh
   bash ~/.local/lib/job-hopper/scripts/attach-client.sh laptop my-laptop me@hopper-host 1
   ```

4. Add the line it prints to `~/.config/job-hopper/daemon.env` (`CLIENT_TOKEN_LAPTOP_FILE=…`), then
   `systemctl --user restart job-hopper`.
5. Paste the printed entry under `attachedMachines:` with `job-hopper config edit plugins.yaml` (the
   UI's Add machine attaches ssh targets only).
6. Make the jobs' working directories exist there, as for an ssh target.

### A container target

A container on the hopper's host with no network, a read-only root and no capabilities. No agent
runs in it: the `command` executor runs an issue's first fenced code block (else its whole body) with
`sh -c` and reports the exit code and output.

1. Start the container (`alpine:latest`; another image: `JOB_HOPPER_TARGET_IMAGE`):

   ```sh
   bash ~/.local/lib/job-hopper/scripts/container-target.sh box 1      # 1 lane
   ```

2. Start the docker socket proxy, naming every container target (run it again when you add one):

   ```sh
   bash ~/.local/lib/job-hopper/scripts/docker-proxy.sh box
   ```

3. Add the line it prints (`JOB_HOPPER_DOCKER_HOST=unix://…`) to `~/.config/job-hopper/daemon.env`.
4. `job-hopper config edit plugins.yaml`: add the `command` executor, the container, keep commands
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

5. `systemctl --user restart job-hopper` (a new executor needs a restart).

An issue labelled `hopper` and `on-box` now runs its script in the container.

### Send jobs to one machine

A routing rule sets a job's machine, executor or priority when the job comes in; the first rule that
matches wins. Edit them in the UI's Routing view, or under `routing:` in `plugins.yaml`:

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
| `job-hopper help` | the operator CLI: config documents, login codes, password hashes |
| `node src/main.ts --help` | the daemon's settings, with defaults |

The API: `GET /api/*` reads, free on loopback and with a UI session (`x-jobhopper-session`) from
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
