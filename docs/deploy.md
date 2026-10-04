# Deploying job-hopper

Everything the daemon keeps is in one database; its secrets are environment variables; its
config is config documents in that database (docs/design.md "Deployable"). Two recipes: a
container next to its Postgres, or systemd `--user` units on a host that also runs the jobs.

## What every deploy needs

| | where |
|---|---|
| `JOB_HOPPER_DATABASE_URL` | `postgres://user:password@host:port/database[?schema=<name>]`, or `sqlite:<path>` for local use. Required. Put Postgres near the hopper: every store call waits one round trip. |
| Secrets | environment variables (docs/design.md "Secrets"): `GITHUB_APP_PRIVATE_KEY`, `GROKBOT_WEBHOOK_URL`, `GROKBOT_WEBHOOK_KEY`, `TYPESAFE_API_KEY`, a webhook's `secretEnv`, an identity provider's `clientSecretEnv`; `GH_TOKEN` for the gh CLI, `CLAUDE_CODE_OAUTH_TOKEN` for the claude CLI where their own login is not on the machine. |
| Process settings | `JOB_HOPPER_*` variables: port, LAN names and peers, public URL, tick, limits (`src/config.ts`). |
| Config | the documents `plugins.yaml`, `webhooks.yaml`, `rules.md`, `auth.yaml`: from the UI, or `job-hopper config edit <document>`. The first boot writes the built-in plugins.yaml. |
| Where jobs run | herdr sessions: this host's (`job-hopper-herdr`), or attached machines over ssh (plugins.yaml `attachedMachines:`). |

`job-hopper` is the operator CLI (`job-hopper config …`, `job-hopper login-code`,
`job-hopper migrate-local …`); it needs `JOB_HOPPER_DATABASE_URL` and nothing else.

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

SQLite instead of Postgres, for local use only:
`JOB_HOPPER_DATABASE_URL=sqlite:$HOME/.local/share/job-hopper/job-hopper.db bash scripts/install.sh`.

## Moving an existing install

An install from before the database (SQLite in `~/.local/share/job-hopper/job-hopper.db`, config
in `~/.config/job-hopper/`) moves with `migrate-local`, into an empty database, before the daemon
first starts on it:

```sh
systemctl --user stop job-hopper                  # never job-hopper-herdr: that kills every pane
JOB_HOPPER_DATABASE_URL=postgres://… job-hopper migrate-local \
  --from-sqlite ~/.local/share/job-hopper/job-hopper.db \
  --config-dir ~/.config/job-hopper \
  --secrets-out ~/.config/job-hopper/secrets.env
cat ~/.config/job-hopper/secrets.env >> ~/.config/job-hopper/daemon.env && rm ~/.config/job-hopper/secrets.env
# set JOB_HOPPER_DATABASE_URL in daemon.env, then:
bash scripts/install.sh
```

It copies every row with its seq, turns plugins.yaml, webhooks.yaml, rules.md and auth.yaml into
documents with their file-path options rewritten (github-app.json's id and slug become options),
and writes the secrets those files pointed at to `--secrets-out` (mode 600, never over a file).
The SQLite file and the config dir are left as they were: keep them until the new install has run
for a while, then remove them. Running jobs are reattached when the daemon starts again.

## Testing against Postgres

`bash scripts/test-postgres.sh` runs the whole suite against a throwaway Postgres container (each
test in its own schema); `npm test` uses SQLite.
