# Deploying job-hopper

Everything the daemon keeps is in one Postgres database it is given — the only store; it keeps no
local file. Its secrets come from its runtime — environment variables or mounted secret files — and it
stores none; its config is config documents in that database
(docs/design.md "Deployable"). It runs as a self-hosted service anywhere it can reach its database:
a container next to its Postgres, systemd `--user` units on a host that also runs the jobs, or any
platform that runs a container and hands it a managed Postgres.

## What every deploy needs

| | where |
|---|---|
| `JOB_HOPPER_DATABASE_URL` | `postgres://user:password@host:port/database[?schema=<name>][&sslmode=require]`, or `JOB_HOPPER_DATABASE_URL_FILE` naming a mounted file holding it. Required. Put Postgres near the hopper: every store call waits one round trip. |
| Secrets | from the runtime (docs/design.md "Secrets"): each one the variable `NAME`, or the mounted file the variable `NAME_FILE` names (never both) — `GITHUB_APP_PRIVATE_KEY`, `GROKBOT_WEBHOOK_URL`, `GROKBOT_WEBHOOK_KEY`, `TYPESAFE_API_KEY`, each webhook's `secretEnv` (`WEBHOOK_SECRET_<NAME>` from the UI; `openssl rand -hex 32`, given to the subscriber too), an identity provider's `clientSecretEnv`; `GH_TOKEN` for the gh CLI, `CLAUDE_CODE_OAUTH_TOKEN` for the claude CLI where their own login is not on the machine (variables only: those CLIs read them). The hopper stores no secret. A leftover `JOB_HOPPER_SECRET_KEY` line: delete it. |
| Process settings | `JOB_HOPPER_*` variables: port, LAN names and peers, public URL, tick, limits (`src/config.ts`). |
| Config | the documents `plugins.yaml`, `webhooks.yaml`, `rules.md`, `auth.yaml`: from the UI, or `job-hopper config edit <document>`. The first boot writes the built-in plugins.yaml. |
| Where jobs run | herdr sessions: this host's (`job-hopper-herdr`), or attached machines over ssh (plugins.yaml `attachedMachines:`). |

`job-hopper` is the operator CLI (`job-hopper config …`, `job-hopper login-code`); it needs `JOB_HOPPER_DATABASE_URL` (or `_FILE`) and nothing else. `job-hopper help` lists its commands; `node src/main.ts --help` lists every daemon setting with its default.

Once it runs, the API reference is at `/docs/` (Scalar; the OpenAPI document at `/docs/openapi.json`), on every address the UI answers on. A first-time walkthrough is `README.md`.

Mounted secrets: in compose, a `secrets:` entry appears at `/run/secrets/<name>` — set
`<NAME>_FILE=/run/secrets/<name>`; in Kubernetes, a Secret volume; under systemd, `LoadCredential=` in
a drop-in with `Environment=<NAME>_FILE=%d/<name>`.

## Container

```sh
cp deploy/hopper.env.example deploy/hopper.env && chmod 600 deploy/hopper.env   # fill it in
export POSTGRES_PASSWORD=<a long random password>
docker compose -f deploy/compose.yaml --profile container up -d --build
docker compose -f deploy/compose.yaml exec hopper job-hopper login-code --link https://<public host>
```

- The image (`Dockerfile`): node 26, git, openssh-client, python3 + PyYAML (the Jev shim), gh, the
  claude CLI (`--build-arg INSTALL_CLAUDE=false` leaves it out). No herdr: the container runs the
  hopper, and jobs run on attached machines over ssh. Mount the ssh key and config those need
  (`/home/node/.ssh`), and Jev's checkout if the router uses it (`jevSrc`).
- The UI is reached through a reverse proxy: `JOB_HOPPER_PUBLIC_URL` (its origin) and
  `JOB_HOPPER_LAN_PEERS` (the range its requests come from). Inside the container the daemon
  answers loopback only otherwise. Sign-in: a login code, or identity providers in `auth.yaml`
  (docs/sign-in.md).
- Health: the image's HEALTHCHECK reads `/api/health` on loopback inside the container.
- Self-update does not apply to a container: rebuild the image.

## This host (systemd --user)

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

The local container setup is `deploy/compose.yaml`: `up -d postgres` for a database (optional —
any Postgres will do). `npm test` starts its own throwaway Postgres container (testcontainers;
needs docker), each test in its own schema; `JOB_HOPPER_TEST_POSTGRES_URL=postgres://…` uses an
existing database instead.
