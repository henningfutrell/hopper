# Deploying job-hopper

Everything the daemon keeps is in one Postgres database it is given — the only store; it keeps no
local file. Its secrets come from its runtime — environment variables or mounted secret files — and it
stores none; its config is config documents in that database
(docs/design.md "Deployable"). It runs as a self-hosted service anywhere it can reach its database:
containers from one compose file, systemd `--user` units on a host that also runs the jobs, or any
platform that runs a container and hands it a managed Postgres. **Recommended: the published image,
with Podman** ("In containers, with Podman"); the host install is the other way.

## What every deploy needs

| | where |
|---|---|
| `JOB_HOPPER_DATABASE_URL` | `postgres://user:password@host:port/database[?schema=<name>][&sslmode=require]`, or `JOB_HOPPER_DATABASE_URL_FILE` naming a mounted file holding it. Required. Put Postgres near the hopper: every store call waits one round trip. |
| Secrets | from the runtime (docs/design.md "Secrets"): each one the variable `NAME`, or the mounted file the variable `NAME_FILE` names (never both) — `GITHUB_APP_PRIVATE_KEY`, `GROKBOT_WEBHOOK_URL`, `GROKBOT_WEBHOOK_KEY`, `TYPESAFE_API_KEY`, each webhook's `secretEnv` (`WEBHOOK_SECRET_<NAME>` from the UI; `openssl rand -hex 32`, given to the subscriber too), an identity provider's `clientSecretEnv`; `GH_TOKEN` for the gh CLI, `CLAUDE_CODE_OAUTH_TOKEN` for the claude CLI where their own login is not on the machine (variables only: those CLIs read them). The hopper stores no secret. A leftover `JOB_HOPPER_SECRET_KEY` line: delete it. |
| Process settings | `JOB_HOPPER_*` variables: port, LAN names and peers, public URL, tick, limits (`src/config.ts`). |
| Plugins | Optional. `JOB_HOPPER_PLUGIN_DIR` (plugins put there by hand; a container mounts it read-only) and `JOB_HOPPER_PLUGIN_STORE` (a git repository the UI installs plugins from — this repository is one: docs/plugins.md). Store installs are kept in the database and restored into the work dir at start: they need no plugin dir and no volume. |
| Config | the documents `plugins.yaml`, `webhooks.yaml`, `rules.md`, `auth.yaml`: from the UI, or `job-hopper config edit <document>`. The first boot writes the built-in plugins.yaml. |
| GitHub | the gh CLI signed in as the owner (default; `GH_TOKEN` in a container), or a GitHub App the owner creates for this hopper with `scripts/create-github-app.sh` (its key in `GITHUB_APP_PRIVATE_KEY`). Each hopper has its own App and key; there is no shared one. Setting up either: `README.md` "Connect GitHub". |
| Where jobs run | machines: this host's herdr session (`job-hopper-herdr`), and attached machines in plugins.yaml `attachedMachines:` — ssh targets, client targets, container targets. Setting each one up, step by step: `README.md` "Add machines". |

`job-hopper` is the operator CLI (`job-hopper config …`, `job-hopper login-code`); it needs `JOB_HOPPER_DATABASE_URL` (or `_FILE`) and nothing else. `job-hopper help` lists its commands; `node src/main.ts --help` lists every daemon setting with its default.

Once it runs, the API reference is at `/docs/` (Scalar; the OpenAPI document at `/docs/openapi.json`), on every address the UI answers on. A first-time walkthrough is `README.md`.

Mounted secrets: in compose, a `secrets:` entry (added to `compose.yaml`) appears at `/run/secrets/<name>` — set
`<NAME>_FILE=/run/secrets/<name>`; in Kubernetes, a Secret volume; under systemd, `LoadCredential=` in
a drop-in with `Environment=<NAME>_FILE=%d/<name>`.

## In containers, with Podman (recommended)

`compose.yaml` (issues #119, #125): the whole hopper in containers, from that one file — no clone, no
host install, no build, nothing to set before the first start. The hopper is the public image
`ghcr.io/henningfutrell/hopper` (`latest` follows `main`; `sha-<commit>` pins one build; Intel/AMD and
ARM), built and pushed by `.github/workflows/image.yml` on every change to `main`. The install page
serves the compose file.

Needs Podman 4.7 or later with a compose provider: `podman compose` runs `docker-compose` or
`podman-compose`, whichever is installed (Debian/Ubuntu: `sudo apt install podman podman-compose`;
Fedora: `sudo dnf install podman podman-compose`). Rootless: run it as your own user, no sudo. Docker
works the same — `docker compose` in place of `podman compose` everywhere below.

```sh
curl -fsSLO https://henningfutrell.github.io/hopper/compose.yaml
podman compose up -d
podman compose exec hopper job-hopper login-code --link http://127.0.0.1:4790
```

| service | |
|---|---|
| `secrets` | runs once per start: makes a random database password on the first one, in the `secrets` volume, and writes the database URL from it. Each file is readable only by the one service that uses it. Nobody types or keeps the password. |
| `postgres` | the database (`POSTGRES_PASSWORD_FILE`), on no host port; data in the `postgres` volume. |
| `hopper` | the image `HOPPER_IMAGE` names (default `ghcr.io/henningfutrell/hopper:latest`). `JOB_HOPPER_DATABASE_URL_FILE` from `secrets`. Its home, `/home/node`, is the `home` volume: the herdr session, the gh and claude sign-ins, git's identity, and the repositories jobs work in. |

- **Jobs run in the hopper's container.** The image carries herdr; its entrypoint
  (`scripts/container-start.sh`) starts job-hopper's herdr session and keeps it running, as
  `job-hopper-herdr.service` does on a host. That is the `local` machine. Attached machines work as
  anywhere else.
- **Sign-ins.** `podman compose exec -it hopper gh auth login` and `podman compose exec -it hopper claude`
  (`/login`), once: both are kept in the home volume. Or the tokens in `.env`: `GH_TOKEN`,
  `CLAUDE_CODE_OAUTH_TOKEN`. Jobs reach GitHub over HTTPS through gh (git's credential helper is
  `gh auth git-credential`). Who jobs commit as: `git config --global` in the container, or the
  `GIT_AUTHOR_*`/`GIT_COMMITTER_*` variables in `.env`.
- **Settings and secrets: `.env` beside `compose.yaml`**, optional (`.env.example`, mode 600). Compose
  reads it for the file's own variables and passes all of it to the hopper.
- **The UI** is published on this computer's loopback, `127.0.0.1:${JOB_HOPPER_PORT:-4790}`, the same port
  inside and out. Those requests reach the daemon from the compose network, so they are LAN requests:
  `/api/` needs a UI session (docs/design.md "Reaching the UI across the LAN"). `JOB_HOPPER_LAN_PEERS`
  defaults to the private ranges and `JOB_HOPPER_LAN_NAMES` to `hopper`, the name a reverse proxy on the
  compose network reaches it by; set `JOB_HOPPER_PUBLIC_URL` for one.
- **Health:** the image's HEALTHCHECK reads `/api/health` on loopback inside the container.
- **Keep it running.** Every container restarts unless stopped. Rootless Podman has no daemon, so
  nothing starts them after a reboot by itself: `systemctl --user enable podman-restart.service` (it
  starts every container whose restart policy is `always` or `unless-stopped`) and
  `sudo loginctl enable-linger "$USER"`, once.
- **Upgrade:** `podman compose pull && podman compose up -d` (self-update does not apply to a
  container). It recreates the hopper's container, so it ends the running jobs' panes: upgrade when none
  runs. A pinned build: `HOPPER_IMAGE=ghcr.io/henningfutrell/hopper:sha-<commit>` in `.env`.
- **Remove:** `podman compose down` keeps the volumes; `down -v` deletes the database and the sign-ins.
- **An image from a checkout:** `podman build -t localhost/hopper .`, then `HOPPER_IMAGE=localhost/hopper`
  in `.env`. Without the claude CLI: `--build-arg INSTALL_CLAUDE=false` (then jobs and the answerer need
  attached machines).

**From the build-from-source compose file** (before issue #125): the volumes are the same, so the new
file, downloaded into the same folder, starts on the old data with `docker compose up -d`. Docker and
Podman keep separate volumes: moving such a stack from Docker to Podman moves the database once, with
`pg_dump` from one and `psql` into the other, before the hopper's first start under Podman.

**From the earlier container deploy** (`deploy/compose.yaml --profile container`, removed): its database
is the `job-hopper_postgres` volume, which `deploy/compose.yaml` still serves. Move it into the new stack
once, before the hopper's first start, with `pg_dump` from one and `psql` into the other.

## This host (systemd --user)

One line, the curl install (`scripts/get.sh`, issue #87): it checks what the install needs, clones
the source into `~/.local/share/job-hopper/source` (or updates it), starts the bundled Postgres with
a fresh password unless `daemon.env` or `JOB_HOPPER_DATABASE_URL` already names a database, and runs
`scripts/install.sh`:

```sh
curl -fsSL https://henningfutrell.github.io/hopper/install.sh | bash
```

`JOB_HOPPER_REF` installs and tracks another branch; `JOB_HOPPER_REPO` another repository. By hand,
from a clone:

```sh
export POSTGRES_PASSWORD=<a long random password>
docker compose -f deploy/compose.yaml up -d postgres          # published on 127.0.0.1:${POSTGRES_PORT:-5433}
JOB_HOPPER_DATABASE_URL="postgres://hopper:$POSTGRES_PASSWORD@127.0.0.1:5433/hopper" bash scripts/install.sh
```

`install.sh` copies the install to `~/.local/lib/job-hopper`, links `~/.local/bin/job-hopper`,
installs `job-hopper.service` and `job-hopper-herdr.service`, writes `JOB_HOPPER_DATABASE_URL` into
`~/.config/job-hopper/daemon.env` (mode 600, the unit's EnvironmentFile) when it is not there yet,
and writes the starter `rules.md` when the database has none. Secrets go in the same `daemon.env`.
Open the UI: `bash ~/.local/lib/job-hopper/scripts/open-ui.sh`.

A managed Postgres works the same: put its URL (with `sslmode=require`) in `daemon.env`.

## Local development and tests

`deploy/compose.yaml` is the bundled Postgres alone: `up -d postgres` for a database (optional —
any Postgres will do). `npm test` starts its own throwaway Postgres container (testcontainers;
needs docker), each test in its own schema; `JOB_HOPPER_TEST_POSTGRES_URL=postgres://…` uses an
existing database instead.
