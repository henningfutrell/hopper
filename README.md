# job-hopper

A self-hosted job queue for coding agents. It pulls jobs from GitHub issues, runs each one as a
Claude Code session in a herdr pane on a machine it manages, answers or escalates the questions a
job asks, and keeps every machine inside its usage budget. One daemon, one Postgres database, a
web UI, and an HTTP API with its reference at `/docs/`.

- **Jobs are pulled, never pushed.** A job is an issue with the `hopper` label, by an author you
  allow. No route creates a job.
- **Everything it keeps is in its database.** Config is four config documents in that database
  (`plugins.yaml`, `webhooks.yaml`, `rules.md`, `auth.yaml`); secrets come from its environment.
- **Every part is a plugin**: router, queue sorter, answerer, assessor, executors, job sources,
  machines, usage sources, notifiers (`docs/plugins.md`).

## What you need

| | for |
|---|---|
| Node.js ≥ 24 | the daemon (TypeScript, run directly) |
| Postgres (any; `deploy/compose.yaml` has one) | everything the daemon keeps |
| Docker | the container deploy, the bundled Postgres, `npm test` |
| herdr, at `~/.local/bin/herdr` | the panes jobs run in (`herdr-claude` executor), on each machine that runs jobs |
| the `claude` CLI, signed in | jobs, the answerer, the assessor, usage readings |
| the `gh` CLI signed in, or a GitHub App | the GitHub job source |

## Run it

Pick one. Each needs a Postgres URL; the bundled one is `deploy/compose.yaml`.

### On this host (systemd --user)

The daemon and its own herdr session as user services. Jobs run on this host.

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

The UI is at `http://127.0.0.1:4790/` on the daemon's host. From loopback, a one-time login code
signs a browser in as admin: `job-hopper login-code --link http://127.0.0.1:4790`, then open the
link (it works once, for 10 minutes). For other people and other devices: password sign-in, OIDC,
GitHub or SAML in `auth.yaml`, and the LAN or a public URL — `docs/sign-in.md`.

## Give it jobs

1. Say whose issues it takes. `job-hopper config edit plugins.yaml`, under `jobSources`, on the
   `github` instance (the gh CLI) or `github-app` (a GitHub App, `scripts/create-github-app.sh`):

   ```yaml
   jobSources:
     - name: github
       plugin: github-gh
       options:
         enabled: true
         authors: [your-github-login]          # required: whose issues are accepted
         repos: [your-org/your-repo]           # optional allowlist
         repoPaths: { your-org/your-repo: /srv/checkouts/your-repo }   # where each repo's jobs run
   ```

   Restart the daemon (`systemctl --user restart job-hopper`, or the container).
2. Label an issue `hopper`. The issue body is the job's prompt.
3. Watch it in the UI. The labels say where it is: `hopper:claimed` (running), `hopper:done` (and
   the issue closed), `hopper:failed`. Remove `hopper:failed` to run it again. `hopper:high` and
   `hopper:low` set the priority; `hopper:backburner` parks an issue.

When a job asks a question, the answerer (Claude) answers it, the assessor decides whether a
person must, and the UI's Questions view shows what waits for you.

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
| `docs/plugins.md` | writing a plugin |
| `docs/events.md` | the event log and webhooks |
| `docs/design.md` | how it works, and why |
| `docs/glossary.md` | the words |

## Develop

`npm run check` runs every gate: typecheck, lint, tests (a throwaway Postgres container; needs
Docker), and the UI build. The repo's rules are `AGENTS.md`.
