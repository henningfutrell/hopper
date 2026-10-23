# Deploying hopper

Everything the daemon keeps is in one Postgres database it is given — the only store; it keeps no
local file. Its secrets come from its runtime — environment variables or mounted secret files — and it
stores none; its config is config records in that database, edited in the UI, with no config file
(docs/design.md "Deployable"). It runs as a self-hosted service anywhere it can reach its database:
containers from one compose file, systemd `--user` units on a host that also runs the jobs, a Helm chart
on Kubernetes ("On Kubernetes, with Helm"), or any platform that runs a container and hands it a managed
Postgres. **Recommended: the published image,
with Podman** ("In containers, with Podman"); the host install is the other way.

## What every deploy needs

| | where |
|---|---|
| `HOPPER_DATABASE_URL` | `postgres://user:password@host:port/database[?schema=<name>][&sslmode=require]`, or `HOPPER_DATABASE_URL_FILE` naming a mounted file holding it. Required. Put Postgres near the hopper: every store call waits one round trip. |
| Credentials the hopper is given | for outside services, from the runtime (docs/design.md "Secrets"): each one the variable `NAME`, or the mounted file the variable `NAME_FILE` names (never both) — `GROKBOT_WEBHOOK_URL`, `GROKBOT_WEBHOOK_KEY` (with the user's secret prefix, `HOPPER_USER_<ID>_`, as Plugins names them; as `_FILE` they can change without a restart), a realm's secrets only when the realm is set up from the environment (`HOPPER_SIGN_IN_REALM_<NAME>_CLIENT_SECRET`, docs/sign-in.md "Sign-in from the environment"; typed in Settings otherwise, and stored); `CLAUDE_CODE_OAUTH_TOKEN` for the claude CLI where its own login is not on the machine (a variable only: the CLI reads it). A job holds no GitHub token: its `git` and GitHub steps go through the hopper, which uses the connected account's token (docs/design.md "Git through the hopper"). A leftover `HOPPER_SECRET_KEY` line: delete it. |
| Secrets the hopper owns, and the master key | kept in the database, encrypted under the **master key** `HOPPER_MASTER_KEY` (32 bytes, `openssl rand -hex 32`): the vault secrets, and the hopper's own secrets in the vault's system scope — each webhook's signing secret, the connected account's tokens, each sign-in realm's client secret or bind password, each user's TypeSafe API key —, listed with an audit trail on Vault and never given to a job. Given at launch as a variable, or as a mounted Secret file (`HOPPER_MASTER_KEY_FILE`), never from a volume of the hopper's own: "The master key" below. |
| Process settings | `HOPPER_*` variables: port, LAN names and peers, public URL, tick, limits (`src/config.ts`). |
| Plugins | Optional. `HOPPER_PLUGIN_DIR` (plugins put there by hand; a container mounts it read-only) and `HOPPER_PLUGIN_STORE` (seeds the plugin store setting on a hopper that never had one set; the plugin store is set in the UI, Plugins → Plugin store, and defaults to the one the Pages site publishes: docs/plugins.md). Store installs are kept in the database and restored into the work dir at start: they need no plugin dir and no volume. |
| Config | the plugins, rules and sign-in configs and the webhook subscriptions, all in the database, all edited in the UI (Plugins, Settings → Question gates, Settings → Sign-in, Settings → Webhooks); no config file. The first boot writes the built-in plugins config. |
| GitHub | each user's GitHub sign-in, the **connected account** (sign in with GitHub, or Sources → Connect GitHub, then choose the job repositories in Sources): the one way the hopper reads and writes GitHub. No GitHub App private key is given to a hopper (issue #1377); no gh CLI source and no gh login since issue #359. Setting it up: `README.md` "Connect GitHub". |
| Where jobs run | machines: this host's herdr session (`hopper-herdr`; not in a container, issue #141), and attached machines, instances in the plugins config's machine sources (Plugins → Machine sources, or the Machines view) — `client` targets (a computer or a sandbox box, joined with one line), `ssh` targets, `docker` container targets. Setting each one up, step by step: `README.md` "Add machines". |

`hopper` is the operator CLI (`hopper config …`, `hopper users`, `hopper user add`, `hopper user transfer`); it needs `HOPPER_DATABASE_URL` (or `_FILE`) and nothing else. `hopper help` lists its commands; `node src/main.ts --help` lists every daemon setting with its default.

### Unblock the queue from the host

The Failures actions need no UI sign-in: the operator CLI does them on the running hopper (issue #623). In the
compose install, run each in the container: `podman compose exec hopper hopper <command>`. Each prints JSON.

1. See what holds jobs: `hopper problem list` (each problem's `held` jobs), `hopper handoff list` (Needs a
   person), `hopper failure list`.
2. Let a problem's held jobs run now: `hopper problem release <id>`. The problem stays open.
3. Resolve a problem that is gone or was false: `hopper problem resolve <id> --note "<what you found>"`. Its held
   jobs run again, and new jobs are no longer held for it.
4. Resolve a hand-off, as its card in Needs a person does:
   - `hopper handoff done-by-hand <id> --note "<what you did>" --link <pull request URL>`: its job ends finished;
   - `hopper handoff continue <id> --note "<what to do next>"`: the job goes on, told the note;
   - `hopper handoff fixed <id> --note "<what you fixed>"`: a new job of its item runs, told the note;
   - `hopper handoff wont-do <id> --note "<why>"`: no more work on it.
   Its issue gets the same comment and end label as from the UI.
5. Run a failure's job again: `hopper failure retry <id>`.

Each event names who acted: `person` `operator CLI` and `via` `cli`. `--user <id>` names the user when there are
several; `--url` names the hopper when it is not on this machine's port.

Once it runs, the API reference is at `/docs/` (Scalar; the OpenAPI document at `/docs/openapi.json`), on every address the UI answers on. A first-time walkthrough is `README.md`.

### Webhook secrets from before

A webhook subscription added before its signing secret was kept in the hopper names a runtime variable
(`WEBHOOK_SECRET_<NAME>`, also `_FILE`), and keeps reading it: nothing stops signing on upgrade. Its card
in Settings → Webhooks says "secret from runtime variable X". To move it into the hopper: **Replace
secret** with the value the receiver already has (nothing changes for the receiver), or **Rotate secret**
and give the receiver the new one. From then on the variable is not read: delete it from the runtime.

### The master key

Every secret the hopper keeps is sealed under one key, the **master key**. The database keeps only its
fingerprint (an HMAC of a fixed label under the key), never the key. The key comes from the launch, as the
variable `HOPPER_MASTER_KEY`, or as the file `HOPPER_MASTER_KEY_FILE` names: a Secret the orchestrator mounts (in
Kubernetes, "On Kubernetes, with Helm"). A key file named but not there stops the start. Never keep the key in a volume
beside the container: a container is ephemeral, and a key kept beside it is lost with it. No KMS gives the master key:
`HOPPER_KMS_URL` and `HOPPER_KMS_REGION` change only the key of the vault's own secrets (`docs/design.md` "A KMS as the
master key's source: not built").

**Keep the master key in a password manager.** Without it, a new container on the same database opens none
of the secrets. Keep it apart from the database's backups: a backup with its key beside it holds every secret.

- **First start.** With no key and a database that keeps no secret, the hopper makes a key. It shows the key
  once in the UI, to the hopper's admin (**Show the key (once)**). The key never goes to the log: the start log
  says only where the key came from and its fingerprint (`master key: made for this new hopper (generated),
  fingerprint <16 hex digits>`). The banner stays until the admin clicks **I saved it**. Then give the key at each launch:
  - compose: seal it to the host, so no start needs it from you again ("The master key sealed to the host" below);
    or give it in the environment compose starts with, never in a file (issue #894):
    `read -rs HOPPER_MASTER_KEY && export HOPPER_MASTER_KEY` (paste the key; nothing is shown), then
    `podman compose up -d --force-recreate --no-deps hopper`. A container keeps the key it was started with: give it
    again at each `up` that recreates the hopper;
  - host install: add `HOPPER_MASTER_KEY=<the 64 hex digits>` to `~/.config/hopper/daemon.env`, then
    `systemctl --user restart hopper`;
  - Kubernetes (the Helm chart): put the key in the Secret `hopper-master-key`, key `master-key`, and restart the
    hopper ("On Kubernetes, with Helm" below). The pod reads the variable from the Secret by reference;
  - any other runtime: set the variable `HOPPER_MASTER_KEY` in the container's or service's environment.
- **A wrong key.** The hopper does not start: `the master key does not match this database`. Nothing in the
  database changes. Give the right key.
- **No key, while the database keeps secrets.** The hopper does not start (issue #1296; it never starts limited).
  The error names the key it needs by its fingerprint: `the master key is missing: this database was set up with
  the key of fingerprint <16 hex digits>`. Nothing in the database changes. Do not connect GitHub again: give the
  key, or unseal it (`bash master-key.sh run …`), and start again.
- **Moving from the old token key.** An install from before kept its key in the compose `secrets` volume
  (`token_key`) or as `HOPPER_TOKEN_KEY` in `daemon.env`. While `HOPPER_MASTER_KEY` is unset, a host install reads
  `HOPPER_TOKEN_KEY`, checks it against the secrets it keeps, and shows it once in the UI to be saved. Give it as
  `HOPPER_MASTER_KEY`, and restart. The log then says the old key is not read and can be removed: delete the
  `HOPPER_TOKEN_KEY` line. The compose file no longer mounts the `secrets` volume or reads its `token_key`: save the key
  from the UI and give it at launch as `HOPPER_MASTER_KEY` **before** you update (the update refuses until then).
  A compose install that updated without it does not start, and nothing is lost: the key is still in the old volume.
  Read it once, give it at launch as `HOPPER_MASTER_KEY`, and recreate the hopper:
  `podman run --rm -v hopper_secrets:/s:ro docker.io/library/alpine:3 cat /s/token_key`. Once the hopper starts with
  the key, remove the old volume: `podman volume rm hopper_secrets` (with the stack stopped, or after
  `podman compose up -d --remove-orphans`).

### The master key sealed to the host

Issue #1296. The host keeps the key sealed, and each launch unseals it: a restart, an update or a recreate needs no
key from you. No file holds the key in plaintext, and no log line holds it (the fingerprint only).
`master-key.sh` is in every image. Save it beside `compose.yaml`, and run it in that folder:

```sh
podman run --rm ghcr.io/henningfutrell/hopper:latest hopper master-key script > master-key.sh
bash master-key.sh seal                    # paste the key from your password manager; nothing is shown
bash master-key.sh status                  # sealed with systemd-creds (or kek), and it unseals on this host
systemctl --user restart hopper-compose.service                 # each start: the key goes to compose only
```

- **How it seals.** With `systemd-creds --user` (systemd 256 and later; as root, `systemd-creds`): under the host's
  TPM2 when it has one, else under the host's own credential key, in `hopper-master-key.cred`. Else with a
  key-encryption key of this host, made once, mode 600, at `~/.config/hopper/master-key.kek` (never in the compose
  folder or a volume), and openssl, in `hopper-master-key.enc`. `HOPPER_KEY_SEAL=systemd-creds` or `kek` picks one.
  Neither file opens on another host.
- **At launch.** The user service ("The user service" below) unseals it at each start. Without the service,
  `bash master-key.sh run <command>` unseals the key and gives it to the command as
  `HOPPER_MASTER_KEY`, for that process only. A sealed key that does not unseal stops it before the command runs. With
  `HOPPER_MASTER_KEY` given and no key sealed here yet, it seals that key first: the first start with the key seals it.
- **Update.** The update unseals it by itself when you give no key (`hopper update script | bash -s -- <image>`, in the
  same folder), and puts in the new image's `master-key.sh`.
- **A wrong or missing key.** The hopper does not start, and names the key it needs by its fingerprint. Seal the right
  key again from your password manager: `bash master-key.sh seal`.
- **Rotation.** `bash master-key.sh rotate` rotates the key of the running hopper and seals the new one in the same
  step. Then restart the stack with it: `systemctl --user restart hopper-compose.service` (without the service:
  `bash master-key.sh run podman compose up -d --force-recreate --no-deps hopper`). While the key is sealed to the host, the UI's **Rotate the master key** is refused: it cannot seal the new key.
- **Keep the key in a password manager too.** A new host, a new TPM or a lost key-encryption key opens nothing
  sealed. Whoever runs as your user on this host can unseal the key, as the launch does.
- **Host install** (systemd --user): seal it with `systemd-creds --user encrypt --name=hopper-master-key - <file>`, and
  give it to the unit in a drop-in: `LoadCredentialEncrypted=hopper-master-key:<file>` and
  `Environment=HOPPER_MASTER_KEY_FILE=%d/hopper-master-key`. Remove `HOPPER_MASTER_KEY` from `daemon.env`.
- **Kubernetes.** The master key Secret: the chart's own, made at the first install and kept, or one you give, or one the
  External Secrets Operator fills from an outside store ("On Kubernetes, with Helm"). A Helm upgrade needs no key from
  you; a missing Secret stops the pod.

**The master key never goes to a log.** The hopper logs only where the key came from and its fingerprint, and
every log line goes through a mask that removes the key in any form. To see the key's status without the key:
`hopper master-key status` (JSON: `source`, `fingerprint`, and `previous`, whether `HOPPER_MASTER_KEY_PREVIOUS` is
set). In compose: `podman compose exec hopper hopper master-key status`.

**If the key was ever logged, rotate it.** Hoppers from before issue #685 wrote a key they made, or read from the old
token key, to the start log (`SAVE THIS NOW`). A container's log goes to the host's journal and stays there, and
anyone who can read that journal or a copy of it has the key. Search for the line:
`podman compose logs hopper | grep -c 'SAVE THIS NOW'` (and the host's journal: `journalctl --user | grep -c 'SAVE THIS NOW'`).
If either count is not 0, rotate the key now (below). Deleting the log lines is not enough: rotate.

### Rotating the master key

**A key sealed to the host** (issue #1296): `bash master-key.sh rotate` in the compose folder, then
`bash master-key.sh run podman compose up -d --force-recreate --no-deps hopper` ("The master key sealed to the host").

**With one command** (issue #659): the hopper's admin rotates the key from Vault → Master key → **Rotate the
master key**, or from the operator CLI: `hopper master-key rotate` (in compose:
`podman compose exec hopper hopper master-key rotate`). The hopper makes a new key and seals every secret it keeps
again under it, in one transaction: if anything fails, nothing changes. The running hopper goes on under the new key,
with no restart. The new key is shown once — in the UI banner, or in the command's answer (`key`) —, never in the log.

1. Save the new key in your password manager now.
2. Put it in place of the old one at launch, before the next start: in compose, give the new key as
   `HOPPER_MASTER_KEY` in the environment of the next `up` that recreates the hopper; on a host install, in
   `~/.config/hopper/daemon.env`. A start with the old key is refused: `the master key
   does not match this database: it was rotated …`. Nothing changes then: give the new key.
3. Click **I saved it** in the banner. Delete the old key from your password manager and from every place it was
   written.

The answer also says how many secrets were sealed again (`resealed`), and how many the old key sealed that do not open
(`unreadable`, left as they were; they did not open before either). With the vault in a container of its own
(`HOPPER_VAULT_URL`), the command is refused: that container keeps the key it started with. Rotate at launch instead:

**At launch** (the vault in a container of its own, or a key you made yourself):

1. Make a new key: `openssl rand -hex 32`. Save it in your password manager.
2. Give it as `HOPPER_MASTER_KEY`, and the old one as `HOPPER_MASTER_KEY_PREVIOUS`. In compose: both at launch, in
   the environment compose starts with.
3. Restart the hopper. Every secret the hopper keeps for itself is sealed again under the new key; the log says how
   many (`system secret(s) sealed again under the current HOPPER_MASTER_KEY`, and the same for the sign-in realms').
4. Remove `HOPPER_MASTER_KEY_PREVIOUS` and restart again.

With compose (`podman compose`, or `podman-compose` directly: the commands are the same), in the directory of
`compose.yaml`:

```sh
# 1. The current key's fingerprint, to compare at the end.
podman-compose exec hopper hopper master-key status
# 2. The new key, with the old one as the previous key. Keep the new key in your password manager first.
#    Give both at launch (paste each key; nothing is shown):
read -rs HOPPER_MASTER_KEY_PREVIOUS && export HOPPER_MASTER_KEY_PREVIOUS   # the old key
read -rs HOPPER_MASTER_KEY && export HOPPER_MASTER_KEY                     # the new 64 hex digits
# 3. Recreate the hopper (and the vault container, when the hopper-vault profile is on) with the new keys.
podman-compose up -d --force-recreate --no-deps hopper
podman-compose up -d --force-recreate --no-deps hopper-vault   # only with COMPOSE_PROFILES=hopper-vault
podman-compose logs hopper | grep 'sealed again'
podman-compose exec hopper hopper master-key status            # the new fingerprint, "previous": true
# 4. Drop the previous key, then recreate again.
unset HOPPER_MASTER_KEY_PREVIOUS
podman-compose up -d --force-recreate --no-deps hopper
podman-compose exec hopper hopper master-key status            # "previous": false
```

Then delete the old key from your password manager, and from every place it was written (an old backup file that
an earlier update made too). A key given at launch does not reach a running container: `--force-recreate` does. A plain `restart` keeps the
old environment.

The connected account's tokens are among them: no new GitHub sign-in. A secret that neither key opens is named at
start (`start check: system secret <name> cannot be opened: …`) and on Vault.
Keep using the same key with this database: a hopper on the database with neither key reads the connection as
*cannot be read* and asks for the key back. Connecting again instead makes another GitHub grant (docs/design.md
"One grant per connection").

Mounted secrets: in compose, a `secrets:` entry (in `compose.override.yaml`; never edit `compose.yaml`) appears at `/run/secrets/<name>` — set
`<NAME>_FILE=/run/secrets/<name>`; in Kubernetes, a Secret volume; under systemd, `LoadCredential=` in
a drop-in with `Environment=<NAME>_FILE=%d/<name>`.

## In containers, with Podman (recommended)

`compose.yaml` (issues #119, #125): the whole hopper in containers, from that one file — no clone, no
host install, no build, nothing to set before the first start. The hopper is the public image
`ghcr.io/henningfutrell/hopper` (`latest` follows `stable`; `dev`, `beta` and `stable` follow the branch of
that name; `sha-<commit>` pins one build; Intel/AMD and ARM), built and pushed by `.github/workflows/image.yml`
on every change to those three branches ("Update channels and promotion" below). The install page serves the
compose file. The update channel is the image tag: to run another channel, run the update with that channel's image
(`ghcr.io/henningfutrell/hopper:dev`, `:beta` or `:stable`); it writes the image into `compose.yaml` ("Update" below).

Needs Podman 4.7 or later with a compose provider: `podman compose` runs `docker-compose` or
`podman-compose`, whichever is installed (Debian/Ubuntu: `sudo apt install podman podman-compose`;
Fedora: `sudo dnf install podman podman-compose`). Rootless: run it as your own user, no sudo. Docker
works the same — `docker compose` in place of `podman compose` everywhere below.

```sh
curl -fsSLO https://henningfutrell.github.io/hopper/compose.yaml
podman run --rm ghcr.io/henningfutrell/hopper:latest hopper service script > hopper-service.sh
bash hopper-service.sh install            # the stack under hopper-compose.service ("The user service" below)
```

With Docker, `docker compose up -d` in place of the last two lines: Docker's daemon keeps the port.

Then open `http://localhost:4790/` and sign in with GitHub: the first person to do so is the admin.
There is no bootstrap login: a new hopper creates no user, no password and no login code (issue #238).

**Save the master key now.** The first start makes the master key and shows it once, in the UI banner, to the admin
(**Show the key (once)**). It is never in `podman compose logs hopper`: the log has only its fingerprint. Put it in
your password manager. Then seal it to this host (never in a file, issue #894) and restart the stack through the
service, which unseals it for compose at each start ("The master key sealed to the host" above):

```sh
podman run --rm ghcr.io/henningfutrell/hopper:latest hopper master-key script > master-key.sh
bash master-key.sh seal                            # paste the 64 hex digits; nothing is shown
systemctl --user restart hopper-compose.service
```

Without the service (Docker): `read -rs HOPPER_MASTER_KEY && export HOPPER_MASTER_KEY`, then `docker compose up -d
--force-recreate --no-deps hopper`. Without it, a new container on the same database does not start ("The master key"
above). No volume or file holds it in plaintext. A container keeps the key it was started with: give it again at each
`up` that recreates the hopper.

| service | |
|---|---|
| `postgres` | the database (`POSTGRES_PASSWORD_FILE`), on no host port; data in the `postgres` volume. Before it starts, it makes a random database password and the database URL from it, and OpenFGA's and the vault container's preshared keys, in `runtime-secrets`, and sets the password again once it takes connections. Each file is readable only by the one service that uses it. Nobody types or keeps the password. |
| `hopper` | the image `HOPPER_IMAGE` names (default `ghcr.io/henningfutrell/hopper:latest`). `HOPPER_DATABASE_URL_FILE` from `runtime-secrets`. Its home, `/home/node`, is the `home` volume: the claude sign-in and git's identity. |
| `openfga-migrate` | brings OpenFGA's tables in the `openfga` schema up to its version, then exits; retries until postgres has made the schema. The update removes its container once it exited 0 (issue #1247). Nothing depends on it ("Access: OpenFGA" below). |
| `openfga` | OpenFGA, which access asks before every credential a job is given; on no host port, behind a preshared key `postgres` makes. |

No secret is in a persistent volume (issue #659). `runtime-secrets` is in memory (tmpfs): the services share it while
any of them runs, it is gone after a full stop, and `postgres` makes its files again at the next start. The master key
is only in the hopper's environment, given at launch.

- **The container is not a machine** (issue #141). The image sets `HOPPER_LOCAL_MACHINE=false`: no
  `local` machine, and the boot removes one an earlier version wrote into the plugins config. Jobs run on
  attached machines (`README.md` "Add machines"); the image carries herdr's CLI for them. The Machines
  view offers no **Add this machine** here. To run jobs on the computer the container runs on, use
  **Add machine**, and run the line it shows there (issue #308, `README.md` "A computer: one line"):
  the computer dials in to the published port, so nothing is set up inside the container and nothing
  leans on a `~/.ssh` (issue #293). A sandbox never joins as a machine (issue #1349): a job's step
  runs in a sandbox of its own on the compose network `hopper_default`, burned after the step. The box keeps no copy of the join code (issue #606): its entrypoint moves `HOPPER_JOIN` into a
  file only the box's user can read and starts itself again without the variable; the client reads that
  file once and removes it, joined or not. So the box's processes, herdr and the jobs do not get the code,
  and a restart dials in with the box's link, not the spent code. The container's own config still holds the
  line it was created with: `podman inspect` shows it, and a `podman exec` into the box gets it. The code in
  it is spent. Attaching over ssh (`you@host.containers.internal`, Docker `you@host.docker.internal`) stays
  for a computer that cannot run the client. A reverse proxy in front of a public hopper must pass the
  dial-in's HTTP upgrade (`Upgrade: hopper-client/1`) to `/client/connect`.
- **Sign-ins.** GitHub: sign in with GitHub in the UI (or Sources → Connect GitHub); the hopper keeps
  that connection, and nothing in the container signs in to GitHub (the image has no gh since issue
  #359). Claude Code: `podman compose exec hopper claude` (`/login`), once, kept in the home volume. No
  `-it`: `podman compose exec` is interactive with a terminal by default, and podman-compose refuses the
  flag. Or, for Claude Code, `CLAUDE_CODE_OAUTH_TOKEN`, named in `compose.override.yaml`
  (`CLAUDE_CODE_OAUTH_TOKEN: ${CLAUDE_CODE_OAUTH_TOKEN:-}` under `services.hopper.environment`) and given at launch:
  every job's Claude gets it, and the hopper seeds
  Claude's config in an empty home, so a job starts with no first-run screen. A job gets no GitHub token: its git
  and GitHub steps go through the hopper, with the connected account (docs/design.md "Git through the hopper"). Who jobs commit as: `git config --global` in the container, or the
  `GIT_AUTHOR_*`/`GIT_COMMITTER_*` variables in `compose.override.yaml`.
- **No settings file** (issue #894). Compose reads no file of settings, and nothing goes in one. The hopper keeps its settings and secrets
  itself: set them in the UI; it keeps them in the database and the vault. What compose itself needs — a variable
  `compose.yaml` names, `${NAME:-default}` (`HOPPER_PORT`, `HOPPER_BIND`, `HOPPER_IMAGE`, `HOPPER_LAN_NAMES`,
  `HOPPER_LAN_PEERS`, `HOPPER_PUBLIC_URL`, `COMPOSE_PROFILES`, …) — is given at launch (`export HOPPER_BIND=0.0.0.0`,
  then `podman compose up -d`), at each `up` that recreates the hopper. A default an earlier update wrote into
  `compose.yaml` stays: the update keeps it. A setting `compose.yaml` does not name goes in `compose.override.yaml` (`services.hopper.environment`); a
  secret there only by reference, `NAME: ${NAME:-}`, given at launch.
- **The UI** is published on this computer's loopback, `127.0.0.1:${HOPPER_PORT:-4790}`, the same port
  inside and out. `HOPPER_BIND`, given at launch, names another address: `HOPPER_BIND=0.0.0.0` publishes it on every
  interface, for a LAN install (issue #697). Those requests reach the daemon from the compose network, so they are LAN requests:
  `/api/` needs a UI session (docs/design.md "Reaching the UI across the LAN"). `HOPPER_LAN_PEERS`
  defaults to the private ranges and `HOPPER_LAN_NAMES` to `hopper`, the name a reverse proxy on the
  compose network reaches it by; set `HOPPER_PUBLIC_URL` for one.
- **Over Tailscale** (issue #1024, docs/design.md "Reaching the UI across a tailnet"). With `HOPPER_BIND=0.0.0.0`, a
  device on the host's tailnet reaches the UI at the host's MagicDNS name or tailnet address with the port, after sign-in.
  The hopper finds those names itself from tailscaled, which a container sees only when the host's socket directory is
  mounted: in `compose.override.yaml`, `services.hopper.volumes: ["/var/run/tailscale:/var/run/tailscale:ro"]`. Without
  it, add the names in Settings → Allowed hosts. A tailnet peer whose address the container sees as `100.64.0.0/10` needs
  that mount too, or that range in `HOPPER_LAN_PEERS`.
- **Health:** the image's HEALTHCHECK reads `/api/health` on loopback inside the container. While the event loop is held, that read times out; the **health port** still answers inside the container (`curl 127.0.0.1:4791/api/health`: 503 and `eventLoopHeldMs`, issue #1383, docs/design.md "Reading the held event loop"). It is not published. `HOPPER_HEALTH_PORT` moves it; a host install has none unless it is set. An admin reads the process's memory and event-loop delay at `GET /api/process`.
- **Keep it running.** Every container restarts unless stopped. Rootless Podman has no daemon, so
  nothing starts them after a reboot by itself: the user service does, with linger on ("The user service" below).
- **Update: you update a container install, never the hopper** (issues #51, #409, #494). Self-update and
  Auto-update do not apply to a container: the UI offers neither Update now nor the Auto-update switch, and the
  server ignores an auto-update setting for it. When the update check finds a newer build, the update notice
  and Settings → Version give the command below with the selected channel's tag.
  - **The channel is the image tag.** `ghcr.io/henningfutrell/hopper:<channel>`, the default of `HOPPER_IMAGE` in
    `compose.yaml` (the update writes it there), where `<channel>` is the channel picked in Settings → Version:
    `dev`, `beta` or `stable`. Unset, it is `:latest`, the same image as `:stable`. A container on `:latest` with the channel set to `dev`
    never reaches `dev`'s head by pulling, so the notice says "this container runs the `stable` image; the
    selected channel is `dev`: switch the image tag". **Switch channels** by running the update below with the
    channel's image (it sets `HOPPER_IMAGE`); pick the same channel in Settings → Version.
  - **One command updates the install** (issue #1104). Every image carries the `compose.yaml` of its commit and the
    update itself, `scripts/update.sh`. In the folder that holds `compose.yaml`, run (the update notice gives it with the
    channel's image; Docker: `docker run`):

    ```sh
    podman run --rm --pull=always ghcr.io/henningfutrell/hopper:<channel> hopper update script | bash -s -- ghcr.io/henningfutrell/hopper:<channel>
    ```

    In order, it:
    1. **Takes the master key** from `HOPPER_MASTER_KEY` in its environment, else unseals the key sealed to this host
       (`master-key.sh` and its sealed key beside `compose.yaml`, issue #1296), else asks for it on the terminal (paste
       it; nothing is shown). Without it, or with a value that is no master key, it stops before it changes anything,
       so the hopper never fails to start for want of it. It reads the key from nowhere else: not from a plaintext
       file, and not from the running container (issue #970). An update with no person (an agent, a scheduled task; issue #1013) gives the key
       from a secret manager: `export HOPPER_MASTER_KEY="$(pass show hopper/master-key)"`. The KMS (`kms` profile)
       wraps only the vault's data key: the master key is required with it too.
    2. **Finds the compose tool that started the stack** and uses it with the project `hopper` (`-p hopper`): podman-compose
       when its containers carry podman-compose's label, else `podman compose` (docker-compose, or the provider
       `PODMAN_COMPOSE_PROVIDER` names), and `docker compose` on Docker. When that tool does not see the stack that runs,
       it stops before it changes anything (issue #1063, below).
    3. **Backs up the database** to `hopper-backup.dump` (`pg_dump -Fc`), while Postgres runs.
    4. **Puts in the new `compose.yaml`**: `hopper update carry` from the new image (below); it shows the change and
       keeps the old file as `compose.yaml.bak`. With Podman it first looks for your rootless Podman socket
       (`$XDG_RUNTIME_DIR/podman/podman.sock`, issue #1157): when `podman.socket` is on, the new file gives it to the
       hopper; when it is off, the update goes on without it and says the line that turns it on (`systemctl --user
       enable --now podman.socket`). A `compose.override.yaml` that is the old `compose.sandboxes.yaml` goes to
       `compose.override.yaml.bak` ("Sandboxes the hopper starts" below).
       **First it checks the new `compose.yaml` with your `compose.override.yaml`** as compose merges them (issue #1246,
       `hopper update check`): a target mounted twice or a host port published twice makes `up -d` fail, so the update
       stops before it changes anything, and says the file, the service, the key and the fix
       (`conflict: compose.override.yaml: services.hopper.volumes: /run/podman/podman.sock: …`). When the override entry
       only repeats what `compose.yaml` gives now, the update asks to remove it (a backup stays as
       `compose.override.yaml.bak`); an update with no person removes it only with `HOPPER_UPDATE_FIX_OVERRIDE=1`. An
       override setting that gives another value than one `compose.yaml` fixes is a warning: the override's value wins.
    5. **Pulls, stops the stack and starts it on the new image**: `compose pull`, `compose down` (the volumes and the
       data stay), `compose up -d`, with `HOPPER_IMAGE` set to the image; when `hopper-compose.service` owns the stack
       ("The user service" above), `systemctl --user restart hopper-compose.service` in place of the last two. Before that restart, it takes the
       quotes out of a `WorkingDirectory="…"` that an older `hopper-service.sh` wrote in the units, which systemd refuses,
       and runs `systemctl --user daemon-reload` (issue #1453). Every container is made again on the new
       image: podman-compose's plain `up -d` keeps a container whose image changed under the same tag, and it cannot
       `--force-recreate` a service that has no container yet (issue #894). When the new stack does not start, it puts
       the old `compose.yaml` and `compose.override.yaml` back, points the image tag the old file names at the image
       the hopper ran before (the pull moved it), and starts the old stack again. When the pull fails, the old files go
       back and the stack that runs is not touched.
    6. **Checks the result**: the hopper's container runs the image pulled (the image ids match), answers `/api/health`
       (it waits up to `HOPPER_UPDATE_WAIT` seconds, 180 by default, and shows the last log lines when the container
       stops: a wrong master key stops it), answers on its published port from the host (issue #1320), has its master key (`hopper master-key status` is not `missing`), and the
       stack has no drift (`hopper update drift` exits 0). Then it says `hopper update: done: …` with the image and the
       key's fingerprint, and exits 0. When a check fails, it says which and exits 1.
    7. **Removes the older hopper images** (issue #1120), once every check passed: each image labelled
       `org.opencontainers.image.title=hopper` but the one the hopper runs and the one it ran before the update (to go
       back to). An image a container still uses, or with more than one name, stays. It says how many it removed.

    **Use the compose tool that started the stack** (issue #1063). docker-compose does not see a stack podman-compose
    started, and podman-compose does not see one docker-compose started: each finds containers by its own labels. Both
    resolve the same project name, `hopper`, and the same named volumes, so the other tool's `up` starts a second stack
    on them, with a second Postgres on the live data directory. The update picks the tool by the labels on the stack's
    containers, and stops when that tool sees none of the containers of the `hopper` project. Never go around the stop.

    **One Postgres per data volume** (issue #1063). The update guards only itself: a plain `podman compose up -d`
    with the wrong tool still makes the second stack's containers. Its Postgres stops at once: before anything else,
    Postgres locks its data volume (`flock`, held for the database's whole life), and a second Postgres on the same
    volume exits 75 with `postgres: another container runs on this data volume` before it writes anything, the start
    files in `runtime-secrets` included. The hopper of that stack waits for a healthy Postgres, so it does not start.
    Remove the second stack's containers with the tool that made them (`docker-compose down` or `podman-compose down`,
    never with `-v`: that removes the volumes the first stack uses). Postgres's own `postmaster.pid` check does not
    work across containers, because in each one the database is PID 1. A stack started from an older compose.yaml
    holds no lock: the lock is in place once the update recreates Postgres.

    `hopper update carry --image <ref>` reads the old `compose.yaml` on stdin and prints the new one: the image's own,
    stamped `# hopper version: <branch> <commit>`, with this install's settings written into the old `compose.yaml` as
    the defaults of its variables (`${HOPPER_BIND:-0.0.0.0}`, `${HOPPER_IMAGE:-<the image>}`, …). A `COMPOSE_PROFILES`
    default turns its services on in the file itself (their `profiles:` line is removed). A secret goes in no file. It
    writes no file itself. When the old file has what the new one cannot name — a setting it does not name, a service of
    the install's own with the volumes it names, a host folder mounted into a service, a key of a service the hopper
    never sets, the install's own project name — it prints that part on stderr, to add to `compose.override.yaml`. A
    service the hopper once shipped and no longer does is dropped, and said so. With `--with-override`, stdin is
    `compose.yaml`, a line `#--- hopper update: compose.override.yaml`, then the override: carry prints nothing and
    exits 4 while the two conflict. `hopper update check` answers the conflicts alone, as JSON (`{ok, conflicts: [{kind,
    file, service, key, value, detail, resolution, refuse, fixable}]}`), exit 4 when one stops the update; `hopper update
    fix-override` prints the override without the entries `compose.yaml` gives itself.

    **To go back:** run the update with the image you ran before (`ghcr.io/henningfutrell/hopper:sha-<commit>`;
    `compose.yaml.bak` names it). A migration leaves a store the build before still runs on. To restore the database
    itself: `podman compose -p hopper exec -T postgres pg_restore -U hopper -d hopper --clean < hopper-backup.dump`.
  - **The removed update script** (issue #1013). `hopper update podman`, `hopper update podman-compose`,
    `hopper update docker` and `hopper update override` are removed (issue #970). Run, each says so on stderr, gives the
    update command above (with `--image <ref>`, for that image) and exits 2, so `… > hopper-update.sh` writes an empty
    script.
  - **Never update the hopper's container alone** (`pull hopper`, `up -d --no-deps hopper`). It keeps the old
    compose file: a version that adds a required service (OpenFGA, issue #559) or a setting never gets it, and
    features fail. **Never edit `compose.yaml`**: each update replaces it whole. Give a setting it names at launch
    (`HOPPER_BIND`, `HOPPER_PORT`, `HOPPER_LAN_NAMES`, `HOPPER_PUBLIC_URL`, …), and the master key at launch always. Put the rest in `compose.override.yaml`, which compose reads beside
    it.
  - **The hopper checks its stack** (issue #697). At start, and each minute while the UI is open, a container hopper
    compares the stack it runs in with the compose file of its own version: each service that must run (no profile,
    or one the hopper's `COMPOSE_PROFILES` turns on), by its name on the compose network; the settings that file gives the
    hopper's container; and the version `hopper-vault` runs. A gap is logged at start and shown in a banner over every
    view: what is missing, what is off until then, and the fix — the update command with the image the hopper runs.
    `GET /api/update/drift` answers the same (`StackDrift`). It sees only from inside its container: a service of the
    install's own, and the versions of OpenFGA and Postgres, are not compared. A headless update reads it with no
    sign-in in a browser (issue #1017): `podman compose exec hopper hopper update drift` prints the `StackDrift` as JSON,
    and exits 3 while a gap is open, else 0.
  - **An agent that updates a hopper** follows the update skill: `GET /api/update/skill` on the running hopper, or
    `podman run --rm <image> hopper update skill`. `GET /api/update/compose` answers the compose file the running
    build ships with, and its version.
  - **From a beta install on an old compose file** (one without `openfga`): run the update above once. It keeps
    a LAN install's `0.0.0.0` as `${HOPPER_BIND:-0.0.0.0}` in `compose.yaml`, prints its own services and mounts (a
    container socket for boxes, say) to add to `compose.override.yaml`, adds OpenFGA, and keeps the old file as
    `compose.yaml.bak`. Until then the stack banner names the gaps.
  - **The `openfga-migrate` one-shot** (issue #1247): its container stays after it exits, and podman-compose's `down`
    can leave it, so a plain `up -d` exits 125 (the container name is in use). The update removes a leftover one before
    it starts the stack (a failed one shows its last log lines first), waits until the new run exits 0, then removes its
    container. A run that still exits non-zero when the health wait ends fails the update, with its last log lines.
  - **Older images go with the update** (issue #1120, step 7 above): repeated upgrades do not pile up images. By hand,
    `podman image prune -f --filter label=org.opencontainers.image.title=hopper` removes the untagged ones.
  - **When.** Recreating the container is a restart. A job whose machine reattaches (a herdr pane on an
    attached machine) keeps running through restart recovery (issue #368); a job a restart would lose (a
    restart blocker) ends. The notice shows how many there are, the same count the host updater waits on:
    wait until it is zero.
  - A pinned build: run the update with the image `ghcr.io/henningfutrell/hopper:sha-<commit>`.
- **Remove:** `podman compose down` keeps the volumes; `down -v` deletes the database and the sign-ins.
- **An image from a checkout:** `bash scripts/build-image.sh` (Docker, else Podman; `HOPPER_BUILDER` picks one),
  then `export HOPPER_IMAGE=localhost/hopper` and `podman compose up -d` (the update with the image
  `localhost/hopper` writes it into `compose.yaml`; `--pull=always` then fails: leave it out). It builds `localhost/hopper` with the checkout's repository,
  branch and commit written into the image, so Settings → Version history and the update check work as for an
  install; a bare `docker build .` cannot see the commit and the hopper then says it lacks it. Without the claude
  CLI: `bash scripts/build-image.sh --build-arg INSTALL_CLAUDE=false` (then jobs need attached machines, and
  the escalation levels a designated machine or an API key). An image is updated by pulling or rebuilding it:
  the update check says when one is newer, and self-update never replaces an image in place.
- **Who answers questions:** the container has no Claude sign-in of its own, so its escalation levels
  escalate every question to you until one can run. In Settings → Question gates: set a level's
  `machine` (picked from the machines) to a machine signed in to claude — one joined with Add machine (its client runs claude) or an attached ssh machine —, or add an `anthropic-api` level and give the
  container `ANTHROPIC_API_KEY` (or `ANTHROPIC_API_KEY_FILE`, a mounted secret): named in `compose.override.yaml` as
  `ANTHROPIC_API_KEY: ${ANTHROPIC_API_KEY:-}` and given at launch.

**From the build-from-source compose file** (before issue #125): the volumes are the same, so the new
file, downloaded into the same folder, starts on the old data with `docker compose up -d`. Docker and
Podman keep separate volumes: moving such a stack from Docker to Podman moves the database once, with
`pg_dump` from one and `psql` into the other, before the hopper's first start under Podman.

**From the earlier container deploy** (`deploy/compose.yaml --profile container`, removed): its database
is the `job-hopper_postgres` volume, which `deploy/compose.yaml` still serves. Move it into the new stack
once, before the hopper's first start, with `pg_dump` from one and `psql` into the other.

### The user service

Issue #1320. With rootless Podman, the published port is served by a `rootlessport` process that belongs to whoever
started the hopper's container. Started from a terminal, or by an agent that recreates the hopper, that process lives
under the caller: when the caller exits, the port goes away while the container still shows `Up`. So the stack runs
under a user service of its own. `hopper-service.sh` is in every image. Save it beside `compose.yaml` and
`master-key.sh`, and run it in that folder:

```sh
podman run --rm ghcr.io/henningfutrell/hopper:latest hopper service script > hopper-service.sh
bash hopper-service.sh install       # write the units, turn on linger, start the stack through the service
bash hopper-service.sh uninstall     # stop the stack and remove the units; the data stays
```

- **`hopper-compose.service`** (in `~/.config/systemd/user`, `Type=oneshot`, `RemainAfterExit=yes`) owns the stack: the
  containers' `conmon` and `rootlessport` processes are in its cgroup. Its start takes the stack down and starts it
  again with the master key, for compose only: never a file of this folder or a volume. Its stop takes the
  stack down; the volumes and the data stay. It uses the compose tool that started the stack (issue #1063), found at
  the install.
- **The key as a file in memory** (issue #1487). The start never gives compose the key as a variable, so no container's
  config holds it (`podman inspect` shows only the file's path). It writes the key to
  `$XDG_RUNTIME_DIR/hopper-service/master-key`: in memory, in a folder only your user opens (mode 700). Compose mounts
  that file read-only at `/run/hopper-master-key` in the hopper's container and hopper-vault's
  (`HOPPER_MASTER_KEY_HOST_FILE`), and `HOPPER_MASTER_KEY_FILE` names it. The file stays while the service runs, so
  `restart: unless-stopped` can start a container again. The service's stop removes it, and a restart of the host
  clears it, so a `podman start` of an old container does not start without the service. Whoever can act as your user
  can read the file while the stack runs, as they could read the containers' environment before.
- **`master-key.sh` comes with the install** (issue #1487). With none beside `hopper-service.sh`, the install puts in
  the image's. With `HOPPER_MASTER_KEY` given to the install and no key sealed here, it seals that key: then a restart
  of the host (a reboot, `wsl --shutdown`) brings the stack back with no person. With data, no key given and none
  sealed, it says the line that seals it: `bash master-key.sh seal`.
- **The master key at launch** (issue #1372). Sealing is optional. The start takes the key from the first of these:
  1. The systemd credential `hopper-master-key`. The unit imports it (`ImportCredential=hopper-master-key`, systemd 254
     and later) from the user's credential stores. Or give it in a drop-in
     (`systemctl --user edit hopper-compose.service`): `LoadCredentialEncrypted=hopper-master-key:<file>` with a file
     from `systemd-creds --user encrypt --name=hopper-master-key - <file>` (under the TPM2 when the host has one), or
     `SetCredentialEncrypted=`. Only encrypted forms: never `SetCredential=` with the key in clear in the unit.
  2. `HOPPER_MASTER_KEY` given at launch: `bash hopper-service.sh start-with-key` reads it from `HOPPER_MASTER_KEY`, or
     reads one line on stdin when stdin is no terminal (`… | bash hopper-service.sh start-with-key`, issue #1497), or
     asks for it on the terminal (nothing is shown). It puts the key in the user manager's environment from its own
     environment (`systemctl --user import-environment`, never as an argument), restarts the service, and removes it
     from the manager's environment after the start. The key is not kept: the next start (a reboot, the port check's
     restart) needs it again, or a sealed key. While the start runs, other units of your user that start get it too.
  3. The key sealed to this host (`bash master-key.sh run …`, "The master key sealed to the host").

  With none of them, the start goes on with no key only when the hopper has no data yet (no volume `hopper_postgres`):
  a new hopper makes its key and shows it once. With data and no key, the start fails before it touches the stack, says
  how to give the key, and no new key is made (`journalctl --user -u hopper-compose.service`). The hopper itself also
  refuses to start without the key when its database keeps secrets, and names the key it needs by its fingerprint.
- **`hopper-compose-alert.service`** (issue #1487) runs when a start of `hopper-compose.service` fails
  (`OnFailure=`). The hopper is down then and cannot say so itself. The alert takes the last line the start wrote in its
  journal, shows it in a desktop notice (`notify-send`, when there is one), and runs `hopper-alert.sh` beside
  `hopper-service.sh`, when there is one, with that line as its one argument. Write there what reaches you, for example
  a webhook:

  ```sh
  # hopper-alert.sh: keep a webhook URL with a token in a file only you read (chmod 600)
  curl -fsS -m 10 -H 'Content-Type: application/json' \
    --data "$(jq -n --arg text "$1" '{text: $text}')" "$(cat ~/.config/hopper/alert-url)"
  ```
- **Joined containers come back with the stack** (issue #1497). A container you joined to the hopper's network
  (`podman network connect hopper_default <container>`, "The hopper's network"), an ssh target's machine for example,
  stops with its host, and nothing else starts it. So after the stack is up, the service's start starts each such
  container that is stopped, and says each one in its journal. A container of the hopper's compose project, and a sandbox (a label `io.hopper.*`), is
  never one; the master key never goes to one. To keep one stopped, take it off the network: `podman network
  disconnect hopper_default <container>`. A machine that still does not come back is told, after two minutes offline, as
  `machine.offline` (`docs/design.md` "The offline watch"), where webhooks and notifiers take it.
- **`hopper-compose-check.timer`** runs `hopper-compose-check.service` every minute. It reads the port the hopper's
  container publishes (`podman port`) and connects to it from the host (loopback for `0.0.0.0`). When the container runs
  and the port does not answer, twice, 10 seconds apart (`HOPPER_SERVICE_RETRY`), it restarts `hopper-compose.service`.
  It does nothing while the service is stopped or the container does not run: `restart: unless-stopped` and the
  service's own start cover those.
- **Linger.** The install turns it on (`loginctl enable-linger`), so the user's manager, and the stack with it, starts
  at boot and stays after the last logout. When the user may not, it says the line: `sudo loginctl enable-linger
  "$USER"`. `podman-restart.service` is not needed: the service's start makes every container again.
- **Settings.** The settings `compose.yaml` names (`HOPPER_PORT`, `HOPPER_BIND`, `COMPOSE_PROFILES`, …) that are set
  where the install runs go into the unit as `Environment=` lines, and `HOPPER_PODMAN_SOCKET_HOST` when `podman.socket`
  is on. Never a secret (a name with `KEY`, `TOKEN`, `SECRET` or `PASSWORD`), and never `HOPPER_IMAGE`: the update
  writes the image into `compose.yaml`. Run the install again to change them.
- **Restarts and updates go through it.** Restart: `systemctl --user restart hopper-compose.service`, never `podman
  compose up` by hand. The update ("Update" below) restarts the stack through the service when it owns the stack, and
  then checks the port from the host too. It starts the stack with the key sealed here; with none sealed, with the key
  given to the update, as `start-with-key` does. It stops before it changes anything when the key given is not the one
  sealed here. It puts in the new image's `hopper-service.sh` and `master-key.sh`, also when no `master-key.sh` was
  here (issue #1487), and with no key sealed it says the line that seals it. On Podman with no service, it says the
  line that installs one.
- **Logs.** `journalctl --user -u hopper-compose.service -u hopper-compose-check.service -u hopper-compose-alert.service`.
- **Docker and Kubernetes.** Not needed and not used: Docker's daemon serves the port, and on Kubernetes ("On
  Kubernetes, with Helm") the cluster does.

### Keep a hopper in WSL running

WSL stops a distro soon after no Windows program uses it, and every container in it stops too. Rootless Podman has no
daemon to start them again. So a hopper in WSL with Podman needs three things, done once. `hopper autostart on` from
Windows does 2 and 3 and checks 1, and `hopper autostart status` checks them all ("Keep it running on Windows" below).
By hand, `site/install.html` "On Windows" has the lines to copy. `hopper doctor` checks them from Windows ("Check it
from Windows" below).

1. **systemd on in the distro.** `[boot]` `systemd=true` in `/etc/wsl.conf`, then `wsl --shutdown` in PowerShell.
2. **The containers start with the distro.** In the distro: `sudo loginctl enable-linger "$USER"` and
   `systemctl --user enable podman-restart.service` (it starts every container whose restart policy is `always` or
   `unless-stopped`, as "Keep it running" above says).
3. **The distro keeps running.** A shortcut `hopper-wsl.lnk` in the Windows user's Startup folder
   (`shell:startup`) runs, in a hidden window, `powershell.exe -NoProfile -WindowStyle Hidden -Command "while ($true)
   { wsl.exe -d <distro> -e sleep infinity; Start-Sleep -Seconds 5 }"`. The `sleep` keeps the distro in use; when
   `wsl.exe` exits, the loop starts it again 5 seconds later.

The keep-alive runs as the signed-in Windows user: it needs no administrator rights and no secret, and nothing new
listens. It starts only when that user signs in to Windows. To stop it, run `hopper autostart off`, or delete the
shortcut and sign out.

### Open it at localhost from Windows

Windows tries `::1` first for `localhost`. WSL passes a Windows `::1` through only to a port the distro publishes on
`::1` (issue #712). `compose.yaml` publishes the UI on `127.0.0.1` alone, so `http://localhost:<port>` can fail on
Windows where `http://127.0.0.1:<port>` opens. On Windows, publish the UI on `[::1]` too, with a
`compose.override.yaml` that adds the port:

```yaml
services:
  hopper:
    ports:
      - "[::1]:${HOPPER_PORT:-4790}:${HOPPER_PORT:-4790}"
```

Compose adds it to the port in `compose.yaml`; an update keeps `compose.override.yaml`. `site/install.html` "On
Windows" writes it before the first start, only when the distro has IPv6 loopback
(`grep -q '^0\{31\}1 ' /proc/net/if_inet6`): a distro with IPv6 off cannot bind `::1`, and the start fails. An install
that has a `compose.override.yaml` already adds the `ports` lines to it by hand, then recreates the hopper with the master
key given at launch (`podman compose up -d --force-recreate --no-deps hopper`).

- **Security:** still loopback only. Nothing listens on a LAN interface. A request on `::1` reaches the daemon from the
  compose network, as one on `127.0.0.1` does, and the Host guard lets `localhost:<port>` in.
- **Not checked here:** there is no Windows runner. A person checks it once on Windows, in NAT mode with
  `localhostForwarding` and in mirrored mode: `Invoke-WebRequest http://localhost:4790/job/address` answers 204 after a
  fresh install and after `wsl --shutdown`, and `hopper doctor` says `ok` for `localhost`.

### The hopper CLI from Windows

For a hopper in WSL with Podman (issue #712), `scripts/hopper.cmd` and `scripts/hopper.ps1` run the operator CLI from
Windows: `hopper <command>` in PowerShell or the Command Prompt runs `hopper <command>` in the hopper's container,
through `wsl.exe -e podman exec`. The CLI uses the credentials it already has in the container; Windows keeps no token,
and nothing new listens. Anyone who can run `wsl.exe` as that Windows user could already do this.

- **Install:** copy one file to a folder on PATH. The site serves both, at
  `https://henningfutrell.github.io/hopper/hopper.cmd` and `.../hopper.ps1` (`site/install.html` "The hopper CLI
  from Windows" has the PowerShell lines). `hopper.cmd` works in both shells with no execution policy; `hopper.ps1`
  gives the CLI a terminal when PowerShell has one.
- **The container:** found by its compose labels (`com.docker.compose.project`, `com.docker.compose.service=hopper`),
  never by its name, which changes with the compose project. `wsl.exe -e` runs no shell, so it reads no shell profile:
  in a WSL terminal a profile can set `XDG_RUNTIME_DIR` to `/run/user/<uid>`, the runtime dir of the systemd user
  session (`podman-restart.service` uses it too), while `wsl.exe -e` gives podman another one (WSLg sets
  `/mnt/wslg/runtime-dir`). There podman sees no container run (issue #1512). So the wrapper runs `podman ps` as
  `wsl.exe -e` starts it first, then as `env XDG_RUNTIME_DIR=/run/user/<uid> podman`, and runs the CLI with the one
  that saw the container.
- **`HOPPER_WSL_DISTRO`:** the WSL distro the hopper runs in; unset, WSL's default distro.
- **`HOPPER_COMPOSE_PROJECT`:** the compose project; unset, `hopper`, the `name:` in `compose.yaml`.
- **No hopper running:** the wrapper says so, with what podman said (`hopper.ps1`), and exits 1. `hopper doctor`
  checks more.

### Keep it running on Windows

WSL stops a distro soon after its last Windows process ends, and rootless Podman has no daemon, so the hopper in WSL
stops with the last Ubuntu window and starts again with nothing. `hopper autostart on|off|status` (issue #712), in
`scripts/hopper.ps1`, keeps it running: after a Windows sign-in and after `wsl --shutdown`. `hopper.cmd` runs
`hopper.ps1` from its own folder for it (`powershell.exe -ExecutionPolicy Bypass`, this process only), so put both in
that folder. It works on the distro `HOPPER_WSL_DISTRO` names; unset, WSL's default distro.

- **`hopper autostart on`:**
  - checks through `wsl.exe` that systemd runs in the distro (`/proc/1/comm`); if not, it stops and gives the fix
    (`systemd=true` under `[boot]` in `/etc/wsl.conf`, then `wsl --shutdown`);
  - runs `sudo loginctl enable-linger <user>` when linger is off (sudo can ask for the distro user's password once) and
    `systemctl --user enable podman-restart.service`, as the Linux path does ("Keep it running" above);
  - writes `%LOCALAPPDATA%\hopper\hopper-keepalive.ps1`, a loop: `wsl.exe -e sleep infinity`, wait 5 s, again. The
    process in the distro keeps WSL from stopping it. After `wsl --shutdown` the `wsl.exe` ends, the loop starts it
    again, the distro boots, and systemd starts the containers through `podman-restart.service`;
  - the loop also reports the Windows link: at most every 5 minutes, while the hopper's container runs, it opens
    the address check, `http://localhost:<port>/job/address`, else `http://127.0.0.1:<port>/job/address` (`HOPPER_PORT`;
    unset, `4790`), 10 s at most each, reads the networking mode
    (`wsl.exe -e wslinfo --networking-mode`), and runs `hopper windows-link report` in the container with the result:
    the HTTP status (any status means the hopper answered) or why there was no answer. The hopper keeps the report in
    memory for 15 minutes, and a broken link shows the banner with the fix and tells `machine.windows_link_broken`
    (machine `windows`), as a WSL machine's client does (`docs/design.md` "The Windows link");
  - writes the shortcut `hopper-wsl.lnk` in this Windows user's Startup folder, which runs the loop in a hidden
    PowerShell at each sign-in, and starts the loop now. A loop that runs is stopped first, so a new loop takes its
    place: run `hopper autostart on` again after an update of `hopper.ps1`. The shortcut has the name of the one made by
    hand ("Keep a hopper in WSL running" above), so it replaces that one, and a loop started by hand is stopped too:
    the distro never gets two.
- **`hopper autostart off`:** stops the loop (its own or the one made by hand) and its `wsl.exe`, and removes the shortcut and the loop's script. It
  changes nothing in the distro: linger and `podman-restart.service` stay on, and WSL stops the distro when it is idle.
- **`hopper autostart status`:** says whether the shortcut exists, the loop runs, linger is on and
  `podman-restart.service` is enabled. It exits 1 when one of them is not.
- **Security:** nothing new listens; the hopper's bind stays `127.0.0.1`. It needs no admin rights and no secret: the
  Startup folder is this user's, not the common one, and no scheduled task is made. The report adds no trust: the CLI in
  the container uses its own credentials, as for every operator action, and the signed-in Windows user could already
  run them through `wsl.exe`. The loop keeps no token, and the report carries no secret.
- **Not checked here:** there is no Windows runner, so `test/scripts/windows-cli.test.ts` reads the scripts. A person
  checks it once on Windows: `hopper autostart on`, `wsl --shutdown`, wait 30 s, then
  `Invoke-WebRequest http://localhost:4790/job/address` (it answers 204). If the hidden loop is not reliable on a WSL release, a scheduled
  task with restart on failure is the fallback.

### Check it from Windows

`hopper doctor` (issue #712), in `scripts/hopper.ps1`, checks from Windows what a hopper in WSL with Podman needs.
`hopper.cmd` runs `hopper.ps1` from its own folder for it (`powershell.exe -ExecutionPolicy Bypass`, this process only),
so put both in that folder. It runs on Windows, so it needs no interop from the hopper's container. The checks, in order:

1. **The Windows link.** `Invoke-WebRequest` on the address check (`/job/address`: 204 to anyone the Host guard lets
   in, with no session) at `http://localhost:<port>`, 10 s at most. Any HTTP answer means the hopper answered. When
   `localhost` gets no answer, it tries `http://127.0.0.1:<port>`: Windows tries `::1` first for `localhost`. Only
   `127.0.0.1` answering is a `warn`, not a `FAIL`: open `http://127.0.0.1:<port>` in place of `localhost`, or publish
   the UI on `::1` too ("Open it at localhost from Windows" above). Neither
   answering is a `FAIL`, with the fix for the networking mode. The port is `HOPPER_PORT`; unset, `4790`.
2. **The networking mode.** `wsl.exe -e wslinfo --networking-mode`, and `localhostForwarding` and `networkingMode` under
   `[wsl2]` in `%UserProfile%\.wslconfig`. It fails in NAT mode with `localhostForwarding=false`, and when `.wslconfig`
   names another mode than the one WSL runs (it needs `wsl --shutdown`).
3. **The keep-alive shortcut.** `hopper-wsl.lnk` in this Windows user's Startup folder (`shell:startup`): the one
   `hopper autostart on` makes, or the one made by hand ("Keep a hopper in WSL running" above). The fix names both.
4. **In the distro, through `wsl.exe -e`:** `systemd=true` under `[boot]` in `/etc/wsl.conf`; linger on for the distro
   user (`loginctl show-user`); `podman-restart.service` enabled (`systemctl --user is-enabled`); a hopper container of
   the compose project runs, found as `hopper <command>` finds it ("The hopper CLI from Windows" above), with what
   podman said when it finds none.

Each check prints `ok`, `warn` and the hint, or `FAIL` and the fix. A broken link gets the same fix as the Machines banner
(`ui/src/model/windows-link.ts`), by the mode it read. It exits 1 when a check fails. The distro is the one
`HOPPER_WSL_DISTRO` names; unset, WSL's default distro.

- **Security:** it only reads. It sends no token, changes nothing, and adds no listener or route. It runs as the
  signed-in Windows user, who could already run `wsl.exe`.
- **Not checked here:** there is no Windows runner, so `test/scripts/windows-cli.test.ts` reads the script. A person
  checks it once on Windows: `hopper doctor` after a fresh install and after `wsl --shutdown`. By hand, in PowerShell:
  `Invoke-WebRequest http://127.0.0.1:4790/job/address` and `Invoke-WebRequest http://localhost:4790/job/address` each
  answer 204.

### The Windows link, checked by default

On Windows the install page has the person add the distro the hopper runs in as a machine (issue #712, "Add this
Ubuntu as a machine"): **Machines** → **Add machine** → **A computer**, with the UI open at `http://localhost:<port>`
in the Windows browser. The join line carries the URL the page is open at, so the client dials the hopper on loopback.
A client in WSL that dials loopback tests the Windows link (`docs/design.md` "The Windows link"): every 5 minutes it
runs `Invoke-WebRequest` on the address check, `http://localhost:<port>/job/address`, else
`http://127.0.0.1:<port>/job/address`, through interop. When the link breaks, the Machines
card and a banner over every view say so, with the fix for the networking mode. Jobs need a machine anyway, so the
check costs no extra step.

- **Security:** nothing new. It is the usual join flow; the bind stays `127.0.0.1`, and the test carries no token.
- **When it does not run:** a line copied from a page open at another address (`127.0.0.1`, a LAN name, the public
  URL) dials that address. Only a loopback address starts the test, so copy the line from the page at `localhost`.
  With no client in the distro, `hopper doctor` ("Check it from Windows") is the check.

### The hopper's network

`compose.yaml` makes its own network, `hopper_default`, on every `up` (issue #711). The name is fixed in the file, so it
is the same whatever the compose project is called, and it is never a network you make first. Every service is on it:
the hopper, Postgres, OpenFGA and the optional services. Each sandbox box the hopper starts joins it too
(`HOPPER_SANDBOX_NETWORK`, default `hopper_default`). On it, `http://hopper:4790` reaches the hopper, with no
`HOPPER_PUBLIC_URL`.

A container you start yourself, a seat for an ssh target for example, joins it with one command:

```sh
podman network connect hopper_default <container>
```

**Off-network machines.** Every 30 s the hopper asks each ssh target which of its addresses the machine reaches. When
the machine reaches none, the Machines view shows it as **off-network**, with why. When the ssh target names a container,
it also shows the command above for that container, with a Copy button. The machine takes no new job until it reaches
the hopper. Its jobs wait with the reason (`… is off-network: … Fix: podman network connect …`); they do not fail. The
other fix is a link base that the machine reaches: give `HOPPER_PUBLIC_URL` at launch, then recreate the hopper.

**Fallback: a seat in another Podman engine** (a rootful Podman, or another user's rootless one). Such a container
cannot join `hopper_default`. It can reach the hopper through `host.containers.internal`, but only on an address the
port is published on. The hopper publishes its port on `127.0.0.1` only, which the gateway does not reach. To use the
fallback:

1. In that engine, find the address `host.containers.internal` names:
   `podman run --rm docker.io/library/alpine:3 getent hosts host.containers.internal`.
2. Publish the port on that address too, in a `compose.override.yaml` beside `compose.yaml` (compose adds it to the
   loopback port; with a `compose.override.yaml` already there, add the lines to that file):

   ```yaml
   services:
     hopper:
       ports:
         - "<that address>:4790:4790"
   ```

3. Add the name to the hopper's LAN names at launch: `export HOPPER_LAN_NAMES=hopper,host.containers.internal`. The seat's
   address must be in `HOPPER_LAN_PEERS` (by default, the private ranges).
4. `podman compose up -d`. The next probe finds `http://host.containers.internal:4790`, and the seat's jobs use it.

Publish on that address only, never on every interface: the port then stays off the LAN.

## On Kubernetes, with Helm

The chart `deploy/helm/hopper` (issue #1281) brings up in a cluster what `compose.yaml` brings up with Podman: the hopper,
its Postgres, OpenFGA and Solr. It needs no container runtime socket, no host path and no settings. Every object runs as
a non-root user, with no privilege and no capability.

```sh
helm install hopper deploy/helm/hopper --namespace hopper --create-namespace
kubectl --namespace hopper port-forward svc/hopper 4790      # then open http://localhost:4790/
```

Sign in with GitHub: the first person to do so is the admin. With no GitHub (issue #1380), add the first admin's local
account with the operator CLI in the hopper's pod, its password on stdin, then sign in with its email and password. An
OIDC realm set up at launch ("Sign-in set up at launch") works the same way in a cluster.

```sh
kubectl --namespace hopper exec -i deploy/hopper -c hopper -- hopper local-account add admin@example.com < password-file
```

An agent then acts for a person through a **grant** the person mints in Users & access → API tokens (`docs/design.md` "Grants
and refresh tokens"), whatever realm they signed in through: the agent trades its refresh token for API tokens at
`POST /ui/auth/token/refresh`. GitHub is a source a person attaches after the sign-in (Sources → Connect GitHub), not a
requirement of the install.

**The master key** ("The master key", issue #1406). The install makes it: a new random key (32 bytes, as 64 hex digits)
in the Secret `hopper-master-key` (`<release>-master-key`), under `master-key`. The hopper reads it from that Secret's
file, so a new pod (a restart, an upgrade, a moved node) starts on the same key. Each upgrade reads the key back from the
Secret and keeps it, and an uninstall keeps the Secret (`helm.sh/resource-policy: keep`). Keep a copy in a password
manager: without it, a lost namespace or cluster opens none of the hopper's secrets.

```sh
kubectl --namespace hopper get secret hopper-master-key -o jsonpath='{.data.master-key}' | base64 -d
```

- **Bring your own key**: `--set masterKey.value=<64 hex digits>` (`openssl rand -hex 32`, or base64 of 32 bytes). The
  chart puts it in the same Secret. Helm keeps values in its release record in the namespace, so the key is there too:
  prefer `masterKey.existingSecret` (below) when that matters.
- **A Secret made before the install.** A `hopper-master-key` Secret made with `kubectl` before `helm install` is used as
  it is: the chart does not change or take it over.
- **Rotate**: put the old key under `previous` in the Secret and the new key under `master-key`, then
  `kubectl --namespace hopper rollout restart deployment/hopper`. The chart keeps both at the next upgrade (unless
  `masterKey.value` names another key). Once the log says every secret is sealed again, remove `previous`.
- **An install made before this.** Its hopper made its key at its first start, and holds it only in memory. An upgrade
  that finds no Secret `hopper-master-key` stops before any pod does: a new key would lose the old one. Save the key
  from the UI (**Show the key (once)**), then give it: `--set masterKey.value=<the key>`, or make the Secret with
  `kubectl` as above.
- **A tool that renders the chart with no cluster** (`helm template`, Argo CD): it cannot read the Secret back, and makes
  a new key at each render. Give the key with `masterKey.existingSecret` there.

**Move a compose install here** (issue #1373): `docs/kubernetes.md`. `hopper-cluster.sh bootstrap` makes a small
cluster on this host (k3s, rootless, beside Podman), and `hopper-cluster.sh migrate` moves the database, the master key
and the hopper's own settings into the chart's release, then stops the compose stack (not removed). `hopper-cluster.sh
rollback` starts compose again.

**The master key from a Secret you manage** (issue #1288). Set `masterKey.existingSecret` to a Secret with the key
under `master-key`. The chart mounts it as files, and the hopper reads `HOPPER_MASTER_KEY_FILE`. A start with no
`master-key` file there is refused: the pod restarts and its log says the file is missing.

- **From an outside store**, with the External Secrets Operator (https://external-secrets.io) already in the cluster:
  set `masterKey.externalSecret.enabled=true`, `masterKey.externalSecret.secretStoreRef.name` (and `.kind`, default
  `ClusterSecretStore`) and `masterKey.externalSecret.masterKey.key` (and `.property` for a map). The chart makes an
  `ExternalSecret` that fills the Secret (`masterKey.existingSecret`, else `hopper-master-key`) and mounts it as above.
- **Rotate** in the Secret, or in the outside store: put the new key under `master-key` and the old one under
  `previous` (`masterKey.externalSecret.previous.key`), then `kubectl --namespace hopper rollout restart
  deployment/hopper`. At start every secret the old key sealed is sealed again under the new one, and still opens. Once
  the log says so, remove `previous`. The hopper reads the files only at start: a Secret change needs the restart.

**AWS KMS for the vault** (issue #1288, "The local KMS"). On EKS, the vault's data key can be wrapped by AWS KMS. Then the
vault's secrets open with no master key. Make the KMS key and an IAM role with `kms:GenerateDataKey` and `kms:Decrypt`
on it, and let the hopper's service account take the role (IRSA or EKS Pod Identity):

```sh
helm upgrade hopper deploy/helm/hopper --namespace hopper --reuse-values \
  --set kms.aws.region=eu-west-1 --set kms.aws.key=alias/hopper-vault \
  --set serviceAccount.create=true \
  --set 'serviceAccount.annotations.eks\.amazonaws\.com/role-arn=arn:aws:iam::<account>:role/<role>'
```

The hopper never makes a key in AWS: `kms.aws.key` is required. `kms.aws.endpoint` names a VPC endpoint. The hopper's
own secrets (webhook secrets, the GitHub connection, sign-in realms' secrets) stay under the master key.

**The optional services** (compose's profiles `hopper-vault` and `kms`, "Optional services"). Both are off by default: the
vault then runs in the hopper, under the master key.

- `hopperVault.enabled=true` runs the hopper's vault in a pod of its own (`hopper-vault`), from the hopper's image. It
  takes the master key the same way the hopper does. The hopper asks it with the preshared key `vault_key` of the Secret
  `hopper-runtime`; only the hopper reaches it.
- `kms.local.enabled=true` runs a local KMS (`hopper-kms`, local-kms) that wraps the vault's data key, on a volume of its
  own (`kms.local.size`, default `1Gi`). Only the pod the vault runs in reaches it, and only that pod is given
  `HOPPER_KMS_URL`. Lose its volume and every value sealed under a data key is lost. It checks no credentials: on a
  cluster in the cloud, use AWS KMS instead. The chart refuses both at once.

| value | |
|---|---|
| `image.tag` | the update channel: `latest` (the default, the same image as `stable`), `stable`, `beta`, `canary` or `dev` |
| `ingress.enabled`, `ingress.host`, `ingress.className`, `ingress.tlsSecretName`, `ingress.annotations` | publish the UI on a host name through the cluster's ingress controller. That host is the public URL (`HOPPER_PUBLIC_URL`, `https://<host>` unless `ingress.publicUrl`): a request through it is a public request |
| `lanPeers` | the pod network the hopper takes LAN requests from (the ingress controller, the kubelet). Default: the private ranges, as compose |
| `solr.enabled` | `false`: no Solr, and no search |
| `networkPolicy.enabled` | NetworkPolicies: only the hopper, OpenFGA, its migration and the vault pod reach Postgres; only the hopper reaches OpenFGA, Solr, the vault pod and the tunnel services; only the pod the vault runs in reaches the local KMS. Default on; they take effect where the network plugin enforces them |
| `tunnel.ngrok.enabled`, `tunnel.cloudflared.enabled`, `postgres.bundled`, `postgres.external.existingSecret` | the other optional parts (below) |
| `masterKey.value` | the master key for the Secret the chart makes; empty: the Secret's own key, else a new one (above) |
| `masterKey.existingSecret`, `masterKey.externalSecret.*` | the master key from a mounted Secret, or one the External Secrets Operator fills (above); the chart then makes no Secret of it |
| `kms.aws.region`, `kms.aws.key`, `kms.aws.endpoint` | AWS KMS wraps the vault's data key (above) |
| `hopperVault.enabled`, `kms.local.enabled`, `kms.local.size` | the vault in a pod of its own, and a local KMS (above). Default off |
| `serviceAccount.create`, `serviceAccount.name`, `serviceAccount.annotations` | the hopper's service account; its annotations give it an AWS role |
| `extraEnv` | more environment for the hopper ("What every deploy needs") |
| `sandbox.enabled` | sandbox boxes the hopper starts as pods in the release's namespace ("Sandbox boxes on Kubernetes"). Default off |
| `sandbox.maxConcurrent`, `sandbox.maxPerUser`, `sandbox.defaults.*`, `sandbox.max.*`, `sandbox.quota.*` | the sandbox playground's limits, and an optional quota on the sandbox pods ("The sandbox playground") |
| `sandbox.limits.cpus`, `sandbox.limits.memoryMb` | the most CPU and memory (MiB) each sandbox box gets ("Sandbox boxes on Kubernetes"). Default `0`: what the box asks for |
| `lanes.replicas` and the other `lanes.*` | lane pods: machines in the cluster that dial out to the hopper ("Lane pods on Kubernetes"). Default `0`: none |
| `replicas` | `1`, or `0` while nothing may write the database (`hopper-cluster.sh migrate` moves data in so). Never more |
| `service.type` | `ClusterIP` (the default), `LoadBalancer` or `NodePort`: the hopper's Service, at `port` |
| `service.nodePort` | the Service's node port, with `service.type` `NodePort` or `LoadBalancer`. Empty (the default): Kubernetes picks one ("On kind, at a host port") |
| `allowedHosts` | more names and addresses the hopper answers to (LAN names), a list, after its Service's names: the names machines outside the cluster reach it by, through a port-forward, a node port or a load balancer (`--set allowedHosts={box.lan,192.0.2.7}`). Another Host gets 421. The ingress host needs no entry: it is the public URL. The value `lanNames` it replaces is refused |
| `service.loadBalancerIP` | the address the Service asks the load balancer for, with `service.type` `LoadBalancer`; the hopper answers to it too. Empty (the default): the load balancer picks one, and you put it in `allowedHosts` |
| `home.size`, `postgres.size`, `solr.size` and each `storageClass` | the volumes: the hopper's home (the claude sign-in), the database, the search index |

The chart makes the database password and the preshared keys of OpenFGA and the vault pod at the first install, in the
Secret `hopper-runtime`, the master key in the Secret `hopper-master-key`, and the lane pool key in the Secret
`hopper-lane-pool`, and keeps them at each upgrade. An
uninstall keeps those Secrets and the home volume (`helm.sh/resource-policy: keep`), and
the StatefulSets' volumes stay too: the database keeps the password it was made with. Remove them by hand only together.

Update: `helm upgrade hopper deploy/helm/hopper --namespace hopper --reuse-values` with the chart of the new version.
The hopper stops before the new one starts (one writer of its database).

In the cluster the hopper updates by `helm upgrade` and checks drift on its image, not on a compose stack (issue #1285):
its update notice gives the command. Not in the chart: HashiCorp Vault (the compose profile `vault`): add a
`hashicorp-vault` vault backend whose `address` names a Vault you run, and give its token in `extraEnv`, from a Secret.

**The other optional parts** (issue #1282), as compose's profiles and services:

- **Remote access**: `tunnel.ngrok.enabled` and `tunnel.cloudflared.enabled` (both on) run compose's `tunnel` and
  `cloudflared` services, with compose's own scripts (`deploy/helm/hopper/files/`, checked equal by a test). They run no
  agent until remote access is turned on in the UI ("Remote access"). Only the hopper reaches them. Their key is in
  `hopper-runtime`.
- **An external Postgres**: `postgres.bundled=false` and `postgres.external.existingSecret=<name>`, a Secret with the
  keys `database_url` (`postgres://user:password@host:port/database`) and `openfga_datastore_uri` (the same database
  with `?sslmode=…&search_path=openfga`). The chart then runs no Postgres. The hopper, the vault pod and OpenFGA read
  their URLs from that Secret.
- **The OpenFGA migration** is a Job whose name carries a hash of its spec. It makes the `openfga` schema, then runs
  `openfga migrate`, which only adds the migrations the schema lacks. An upgrade that changes nothing in it leaves the
  finished Job and runs nothing; a new OpenFGA version is a new Job. OpenFGA is not ready until the Job has run.

### On kind, at a host port

kind maps a fixed port of its node to a port of this host (`extraPortMappings`), so the hopper's Service needs a fixed node
port (issue #1407). The Host guard takes only the port the hopper answers on, so `port` is the host port too. Make the
cluster with this config, for host port 4791 and node port 30791:

```yaml
# kind.yaml
kind: Cluster
apiVersion: kind.x-k8s.io/v1alpha4
nodes:
  - role: control-plane
    extraPortMappings:
      - containerPort: 30791
        hostPort: 4791
```

```sh
kind create cluster --name hopper --config kind.yaml
helm install hopper deploy/helm/hopper --namespace hopper --create-namespace \
  --set service.type=NodePort --set service.nodePort=30791 --set port=4791
curl http://localhost:4791/api/health    # 200, once the hopper is ready
```

To reach it from other machines at this host's name or address, add them to `allowedHosts`, else the hopper answers 421
(issue #1421): `--set allowedHosts={myhost,192.0.2.7}`. Then `curl http://myhost:4791/api/health` answers 200.

The node port must be in the cluster's node port range (30000–32767 by default). A request through the mapping comes from
the node's network, which the default `lanPeers` holds: the browser reads the API only with a UI session.

### Check the sandboxes on a real cloud

To prove the sandbox module with real `aws`, `kubectl`, `helm` and `terraform` against your own AWS account and
cluster, follow `docs/cloud-acceptance.md`: one command runs the check and writes a report you can file.

### Check the chart on kind

`scripts/kind-check.ts` (issue #1281) checks the cluster install end to end on a fresh kind cluster: `helm install`
alone brings up the hopper; its health answers ok in its pod; and no pod anywhere in the cluster
has a Podman or Docker socket (a host path, a mount or a socket variable) or runs Podman, Docker or compose; and
`helm upgrade` with the same values runs the OpenFGA migration Job no second time (issue #1282). Then it deletes the
hopper's pod: the new pod must be healthy and run on the master key of the same fingerprint, given at launch (its start
log line), the key the chart made (issue #1406). Then `kubectl rollout restart deployment/hopper`: the hopper must come
back healthy on the same key (issue #1422). Then a person signs in with no GitHub (issue #1380): the operator CLI in the
hopper's pod adds the first admin's local account; in the pod, on its loopback, that account signs in with its email
and password, is admin through `local-accounts`, and mints a read-only grant; the grant's refresh token is traded for a
new API token, which must read that person's grants and only them. Then the machines come up as pods, by an upgrade of
the same release with sandbox boxes on (`sandbox.enabled=true`, with `sandbox.limits.cpus=0.25` and
`sandbox.limits.memoryMb=128`, the hopper's health and key asked again). An upgrade then scales the lane pods to one (`lanes.replicas=1`, with no wait: a lane pod joins
only once a person signed in).
The lane pod must exist, and again no pod may have a container runtime socket. Then it deletes the cluster. It needs `kind`, `helm` and `kubectl` on PATH, and Docker or Podman for kind itself (rootless
Podman: `KIND_EXPERIMENTAL_PROVIDER=podman`).

```sh
node scripts/kind-check.ts --tag dev          # --cluster NAME, --set key=value, --keep
```

Then `scripts/kind-sandbox-check.ts` (issue #1371) runs on the cluster `--keep` kept. It needs this checkout's
dependencies (`npm ci`). As the hopper's own service account, it runs need boxes through this checkout's Kubernetes
runtime. Each box succeeds, fails, times out or is cancelled. After each, no pod, claim or secret with its labels may
stay. A later box must not see an earlier one's files, and two boxes at once must not see each other's. Then (issue
#1422):

- **Limits.** A box's cgroup holds the chart's `sandbox.limits` (`memory.max`, `cpu.max`). A box that goes over its
  memory ends with exit 137, and its log says `OOMKilled`.
- **Isolation.** A box reaches the hopper on its port, and not another box, any other Service of the release (its
  Postgres, OpenFGA, …). It holds no service account token, and the credential its step was given only in its file,
  never in its environment. It does not reach its node or the Kubernetes API either: kind's network plugin holds a pod
  off its own node. On a cluster whose plugin does not (see "Egress" in "Sandbox boxes on Kubernetes"),
  `--node-reach` says what a box reaches there instead of failing on it.
- **Many at once.** Dozens of need steps start together through the sandbox module (`src/sandbox/service.ts`), more
  than the nodes have room for: the ones with no room wait for the scheduler, and none fails. Each gives back its own
  output. After them nothing with their labels stays, the module's ledger holds no open run and no problem, no box
  is a lane pod or carries a client's link, and the lane pods are as they were. The hopper's memory before and after
  is printed, not checked: load numbers run locally.

The runtime must refuse to remove the hopper's pod and the release's claims. Last, the check kills the hopper's pod (scaled to 0,
deleted with no grace), runs a need box of the hopper's instance while the hopper is down, and starts the hopper again:
the hopper's first sweep must remove that box and its home claim.

```sh
node scripts/kind-sandbox-check.ts --context kind-hopper-check   # --namespace NAME, --image IMAGE (sh, tar, base64)
kind delete cluster --name hopper-check
```

A pull request that changes the chart, either check or the sandbox module (`src/sandbox/`) runs both (`.github/workflows/kind.yml`), with the `dev` channel's image. A job that
runs to a merged pull request needs a GitHub source (a connected account), which no check has: with `--keep`, port-forward the hopper
(`kubectl --context kind-hopper-check --namespace hopper port-forward svc/hopper 4790`), sign in (with GitHub, or as the
check's local account after `hopper local-account password admin@example.com`) and connect GitHub in Sources, add a
`kubernetes-cluster` machine for the kubernetes executor (`docs/design.md` "Job pods on Kubernetes"), and queue a job on an issue of a test repository.

## Access: OpenFGA

Access (OpenFGA) decides each mint and each renewal, each shared-secret read and each vault grant (issue #559,
docs/design.md "Access: OpenFGA decides each mint"). With no OpenFGA, or one the hopper cannot reach, the vault mints
nothing, gives no shared secret, and nobody can grant a job the vault; Users & access → Access says why. Intake asks it too (`intake#can_start_jobs`): without
OpenFGA no login is a trusted actor, every issue is a request card, and Approve and Accept the new text are refused.

- **In containers** it is set up: `compose.yaml` runs `docker.io/openfga/openfga` as `openfga-migrate` and `openfga`,
  with its tables in the `openfga` schema of the hopper's Postgres. The `postgres` service writes OpenFGA's config
  (`/run/hopper-secrets/openfga/config.yaml`: the database URL, the preshared key; uid 65532 only) and the key the
  hopper sends (`openfga_key`, uid 1000 only) at each start, and makes the schema once it takes connections. The
  hopper gets `HOPPER_OPENFGA_URL=http://openfga:8080` and `HOPPER_OPENFGA_KEY_FILE`. A stack from before picks
  it up with the new `compose.yaml` and `podman compose up -d`: the `postgres` service is recreated (a restart of
  the database) and writes the new files.
- **On a host install** (issue #791) it is set up too: `scripts/install.sh` runs `scripts/host-openfga.ts`, which puts
  the release binary of the version `compose.yaml` runs in `~/.local/lib/hopper/openfga` (its SHA-256 checked against
  the release's `checksums.txt`), writes its config (`~/.config/hopper/openfga/config.yaml`, mode 600: the database
  URL with `search_path=openfga`, the preshared key, every address on loopback — the API on `127.0.0.1:4793`, gRPC on
  `127.0.0.1:4794`, metrics on `127.0.0.1:2112`) and its key (`~/.config/hopper/openfga/key`), makes the `openfga`
  schema, and adds `HOPPER_OPENFGA_URL=http://127.0.0.1:4793` and `HOPPER_OPENFGA_KEY_FILE` to `daemon.env`.
  `systemd/hopper-openfga.service` runs `openfga migrate`, then `openfga run`. A `daemon.env` that names another
  OpenFGA is kept, and none is set up. Each run of the install follows the version `compose.yaml` names; a self-update
  does not, so run the install line again after an update that moves it. `scripts/uninstall.sh` removes the unit and
  the binary, and keeps the config, the key and the schema.
- **Elsewhere**: run OpenFGA (`openfga migrate`, then `openfga run`, its datastore any it supports), and set
  `HOPPER_OPENFGA_URL` and, with `--authn-method preshared`, `HOPPER_OPENFGA_KEY` (or `HOPPER_OPENFGA_KEY_FILE`).
  The key is read at each call: rotate it in OpenFGA and the runtime together.
- **Update OpenFGA** with the hopper: the `compose.yaml` each hopper image ships with names the OpenFGA version it
  runs, and the update puts it in (issue #697). Do not change the tag in `compose.yaml` by hand.
- **What the hopper keeps**: the approvals and the model are in its own database, so an emptied or new OpenFGA is
  filled again from it within 30 seconds; OpenFGA holds nothing only it knows.
- **Without OpenFGA** (issue #696): every page shows a banner that says why access checks are off, with this fix, and
  How to update says it too. A change that needs Access — the TypeSafe API key on Settings → Decider — is off with
  the same reason, and a save tried anyway answers 503 `access checks are unavailable: OpenFGA is not reachable`.
  Intake trusts nobody, so no issue becomes a job until OpenFGA is back. Your other secrets, your GitHub connection
  and your session stay as they were.
  `GET /api/access/status` answers the state to any reader.
- **Update from an older `compose.yaml`** (a beta install from before issue #559 has no `openfga` service): do not
  copy services into it. Run the update ("In containers, with Podman" → Update, issue #697): it puts in the
  `compose.yaml` the image ships with, which has OpenFGA, keeps your own settings as its defaults, and starts the whole
  stack. The banner goes within a minute of OpenFGA answering.

### Minting short-lived credentials

The vault mints short-lived credentials for a box's job from a **minting credential** (issue #580, docs/design.md
"Minting: short-lived credentials"), and asks access before each one. It needs nothing beyond the stack above: the
hopper calls the AWS STS or the Kubernetes API that the minting credential names.

- **Kubernetes.** In the cluster, make a service account `hopper-<operation>` (`hopper-read`, `hopper-write`) in
  each namespace a template may reach, and in the namespace `hopper` for a whole cluster; bind each to the role you
  want for that operation (for `hopper-read`, the `view` cluster role). Make an identity whose token may only
  `create` on `serviceaccounts/token` for those service accounts, and `create` and `delete` on `secrets` in the same
  namespaces (issue #1371): each token a sandbox gets is bound to an empty Secret the hopper makes, labelled
  `io.hopper.mint`, and deleting that Secret when the sandbox ends stops the token at once. Without these rights, a
  sandbox gets no Kubernetes token. In Vault, set a secret with *Mints for*
  `cluster/<name>` and the value `{"server": "https://…:6443", "token": "…", "certificateAuthorityData": "<base64 PEM>"}`.
  Each token the hopper mints lives 10 minutes at most, and a sandbox's token ends with its sandbox. For read on a whole cluster, this sets up both service accounts in the
  namespace `hopper` (for a namespace, put `hopper-read` and its binding in that namespace, and let the role below
  reach it there):

  ```yaml
  apiVersion: v1
  kind: Namespace
  metadata: { name: hopper }
  ---
  apiVersion: v1
  kind: ServiceAccount
  metadata: { name: hopper-read, namespace: hopper }
  ---
  apiVersion: rbac.authorization.k8s.io/v1
  kind: ClusterRoleBinding
  metadata: { name: hopper-read-view }
  roleRef: { apiGroup: rbac.authorization.k8s.io, kind: ClusterRole, name: view }
  subjects: [{ kind: ServiceAccount, name: hopper-read, namespace: hopper }]
  ---
  apiVersion: v1
  kind: ServiceAccount
  metadata: { name: hopper-minter, namespace: hopper }
  ---
  apiVersion: rbac.authorization.k8s.io/v1
  kind: Role
  metadata: { name: hopper-minter, namespace: hopper }
  rules:
    - { apiGroups: [""], resources: [serviceaccounts/token], resourceNames: [hopper-read], verbs: [create] }
    - { apiGroups: [""], resources: [secrets], verbs: [create, delete] }
  ---
  apiVersion: rbac.authorization.k8s.io/v1
  kind: RoleBinding
  metadata: { name: hopper-minter, namespace: hopper }
  roleRef: { apiGroup: rbac.authorization.k8s.io, kind: Role, name: hopper-minter }
  subjects: [{ kind: ServiceAccount, name: hopper-minter, namespace: hopper }]
  ```

  Then `kubectl -n hopper create token hopper-minter --duration=8760h` gives the minting credential's `token`; renew it
  before it expires.
- **Kubernetes on EKS: sign in through EKS** (issue #854). No service account, no cluster change by the hopper, and no
  long-lived token: the hopper signs an EKS token with a 15-minute read session of an IAM role. You need:
  1. An IAM role that can see the cluster read-only, for example `eks-view`. Map it to view-only access in the cluster
     with an access entry (`aws eks create-access-entry --cluster-name <name> --principal-arn <role ARN>` and
     `aws eks associate-access-policy … --policy-arn arn:aws:eks::aws:cluster-access-policy/AmazonEKSViewPolicy --access-scope type=cluster`),
     or an aws-auth mapping to a group bound to `view`. Its trust policy lets the AWS minting identity assume it, as
     for any read role below.
  2. The AWS minting credential for the role's account (*Mints for* `aws-account/<id>`, below).
  3. In Vault, a secret with *Mints for* `cluster/<name>` and the value
     `{"type": "eks", "roleArn": "arn:aws:iam::<id>:role/eks-view", "cluster": "<EKS name>", "region": "<region>", "server": "https://….eks.amazonaws.com", "certificateAuthorityData": "<base64 PEM>"}`.
     When the vault already holds a kubeconfig that signs in with `aws eks get-token`, name it in place of the cluster:
     `{"type": "eks", "roleArn": "…", "kubeconfig": "<its vault name>"}` (and `"context": "<name>"` when it is not the
     current context). The hopper takes the cluster, region, server and CA from it; it never runs its exec command.
  Then check it: `hopper vault mint-test cluster/<name>` mints a read token and shows who the cluster says it is and the
  namespaces it lists, as `kubectl auth whoami` and `kubectl get ns` would. When the cluster or STS refuses, it shows why.
  A token lives 14 minutes; kubectl on the box asks for a new one before then.
- **AWS.** Make an IAM user (or role) that may only `sts:AssumeRole` the roles templates may reach. In Settings →
  Vault, set a secret with *Mints for* `aws-account/<id>` and the value `{"AccessKeyId": "…", "SecretAccessKey": "…"}`
  (optional `Region`, and `Endpoint` for an STS other than AWS's). Each session lives 15 minutes; a `read` session
  carries the `ReadOnlyAccess` session policy. The hopper names each session `hopper-<job id>`. When the role's trust
  policy allows only one session name (a condition on `sts:RoleSessionName`), add `"SessionName": "<that name>"` to
  the value; when it allows a prefix (`StringLike`, `ci-*`), add `"SessionNamePrefix": "ci-"`, and the hopper names
  each session `ci-<job id>`. Then the IAM role needs no change. To check it before a job needs it, run
  `hopper vault mint-test aws-role/<id>/<role>` (or `cluster/<name>` for a cluster): the hopper mints a read session (named `hopper-mint-test`,
  `<prefix>mint-test`, or the fixed name) and shows the role STS says it assumed, as `aws sts get-caller-identity` would.
  When STS refuses, it shows why.
- **A read-only AWS setup, step by step** (issue #715). Two IAM identities: the **minting identity** whose keys the
  hopper holds, and the **read role** it assumes. Tag each new IAM resource as your organization's rules say (for
  example its MAP tag, `map-migrated`, when the account is in a migration program): add `--tags Key=map-migrated,Value=<id>`
  to each `create-user`, `create-role` and `create-policy` below.
  1. The read role, `hopper-read`, with AWS's `ReadOnlyAccess` (or `ViewOnlyAccess`, which reads no data) and a trust
     policy that lets only the minting identity assume it:

     ```sh
     aws iam create-role --role-name hopper-read --max-session-duration 3600 \
       --permissions-boundary arn:aws:iam::aws:policy/ReadOnlyAccess \
       --assume-role-policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"AWS":"arn:aws:iam::<id>:user/hopper-minter"},"Action":"sts:AssumeRole"}]}'
     aws iam attach-role-policy --role-name hopper-read --policy-arn arn:aws:iam::aws:policy/ReadOnlyAccess
     ```

     The permissions boundary keeps the role at read, even when someone attaches a wider policy to it later.
  2. The minting identity, `hopper-minter`, that may only assume that role:

     ```sh
     aws iam create-user --user-name hopper-minter
     aws iam put-user-policy --user-name hopper-minter --policy-name hopper-mint \
       --policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":"sts:AssumeRole","Resource":"arn:aws:iam::<id>:role/hopper-read"}]}'
     aws iam create-access-key --user-name hopper-minter
     ```

  3. In Vault, set a secret with *Mints for* `aws-account/<id>` and the access key as its value, as above.
  4. Check it: `hopper vault mint-test aws-role/<id>/hopper-read`.

  The hopper's topology discovery (issue #1781, docs/design.md "The infrastructure topology") reads each account set up so
  every 6 hours, as `hopper-read`, with list and describe calls only: EKS, EC2 VPCs, load balancers, RDS and SQS in every
  region the account has enabled (EC2 `DescribeRegions`), and IAM roles and S3 buckets (`ListBuckets`) once (issue #1864).
  `ViewOnlyAccess` is enough for it. A region an organization policy denies is no topology source. The clusters EKS lists there are read as `hopper-read` too (cluster discovery).
  Cluster discovery looks for a cluster in every region the account has enabled (EC2 `DescribeRegions`, in both
  `ReadOnlyAccess` and `ViewOnlyAccess`). An organization policy that denies a region makes only that region's
  `DescribeCluster` fail: the hopper passes it over and says so in `hopper vault mint-test cluster/<name>`.

  Every read session the hopper mints carries two session policies: `ReadOnlyAccess`, and an inline policy that denies
  every `Create`, `Delete`, `Put`, `Update` and `Modify` action, IAM's other writes, and `sts:AssumeRole` on any role
  but `hopper-read` (docs/design.md "A read-only infra box"). So a read session cannot write, even when the role can. A
  template that asks for read on `aws-role/<id>/hopper-read` gets these sessions, and its read-only check proves the writes
  fail. The check runs again once a day.

  **A Terraform workspace** (issue #715, part 2). A template reads one with two needs: `read/terraform-workspace/<name>`
  and `read/aws-role/<id>/hopper-read`, the role its AWS provider and its S3 state backend are read with. The workspace
  gets no credential of its own: its probes run with that role's read session, and the template must have exactly one
  `aws-role` read need. The state backend needs no policy of its own: the deny policy refuses `s3:PutObject`,
  `s3:DeleteObject` and the DynamoDB lock table's `PutItem`, `DeleteItem` and `UpdateItem`, and `ReadOnlyAccess` reads the
  state. Use `ReadOnlyAccess` for such a role, not `ViewOnlyAccess`: `ViewOnlyAccess` does not read S3 objects, so
  `terraform plan` cannot read the state. Run `plan` with `-lock=false` (the read-only wrapper adds it), as a lock is a write.
  The box installs providers only from its image (issue #715, part 3): the AWS provider, at the version pinned in
  `src/sandbox/tools.ts`, and no other. A workspace that needs another provider, or pins another AWS provider version in
  its `.terraform.lock.hcl` or its version constraint, cannot `init` there.

  **The workspace's state backend** (issue #715, part 6). Set it on the workspace's profile: Vault, **Edit**
  the template, **State backend** (bucket, region, key prefix); or
  `hopper template save <name> --image <image> --backend <workspace>=<bucket>[/<key prefix>]@<region>`. The read-only check
  then runs `terraform.state-push-direct`: past the wrapper, `init` with that S3 backend at the key
  `<key prefix>/hopper-read-only-check/terraform.tfstate` and `state push` of a state of its own, which `s3:PutObject` must
  refuse. It never names the workspace's own state key. `init` only reads the bucket (`ListBucket`, `HeadObject`). If the
  push goes through, the check deletes that key (`aws s3api delete-object`, with the `aws` tool a workspace need adds) and
  fails. With no backend, the probe is *not run* and the check fails: a state write is not proven refused. No new IAM
  resource is needed: the read role, the deny policy and the bucket are the ones above. A bucket policy that lets the
  role write under the key prefix fails the check, as it should.
- **The action role** (issue #2206, docs/design.md "Action grants"). When a job's change needs an AWS action that no
  role it may use allows, it asks a person for exactly that action, and the hopper mints a session of the account's
  **action role**, `hopper-action`, narrowed to `ReadOnlyAccess` and the granted actions on their resources. A session
  policy only narrows: the role itself must allow the action. So make the role wide enough for the changes a person may
  grant (for example `PowerUserAccess`, or your own policy), with a trust policy that lets only the minting identity
  assume it, and let the minting identity assume it too:

  ```sh
  aws iam create-role --role-name hopper-action --max-session-duration 3600 \
    --assume-role-policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"AWS":"arn:aws:iam::<id>:user/hopper-minter"},"Action":"sts:AssumeRole"}]}'
  aws iam attach-role-policy --role-name hopper-action --policy-arn arn:aws:iam::aws:policy/PowerUserAccess
  ```

  Or, to keep the role in your infrastructure code, the same in Terraform:

  ```hcl
  resource "aws_iam_role" "hopper_action" {
    name                 = "hopper-action"
    max_session_duration = 3600
    assume_role_policy = jsonencode({
      Version   = "2012-10-17"
      Statement = [{ Effect = "Allow", Principal = { AWS = "arn:aws:iam::<id>:user/hopper-minter" }, Action = "sts:AssumeRole" }]
    })
  }

  resource "aws_iam_role_policy_attachment" "hopper_action" {
    role       = aws_iam_role.hopper_action.name
    policy_arn = "arn:aws:iam::aws:policy/PowerUserAccess"
  }
  ```

  The minting identity needs `sts:AssumeRole` on `arn:aws:iam::<id>:role/hopper-action` in its own policy too, as it has
  on `hopper-read`.

  The hopper never mints a change on `hopper-action` that is not narrowed to granted actions, and each change still needs
  its approved plan. For an EKS action on a cluster's API (not the AWS API), the cluster's access entry decides, as for
  any role. With infra applies off, no action is asked and the role is not used for changes.
  Before a template is made for a change, the hopper asks IAM's policy simulation whether the role allows each action the
  job names (the **action check**). It asks with a read session of the account's read role `hopper-read`, so that role
  needs `iam:SimulatePrincipalPolicy` (`ReadOnlyAccess` holds it as `iam:Simulate*`). Without it, the check says "not
  checked" and refuses nothing.
  It reads the role first (`iam:GetRole`, which `ReadOnlyAccess` holds): when the account has no role of that name, the
  check refuses the template request at once and names the role, so make `hopper-action` in each account a job may
  change before a job asks for it.
- **The template** declares the operation profiles (`read` on `namespace/<cluster>/<ns>`, on `cluster/<name>` or on
  `aws-role/<id>/<role>`), and a person approves them on Vault. A minting credential is never given to a box,
  and no template lists it in its scope.
- **A vault grant** is needed too: a job gets a minted credential only after a person grants it the vault
  (Vault, Vault grants).
- **The read-only check** (issue #797) uses the same minting credentials: before a check box of a template of read
  needs starts, the hopper mints a read session for each `aws-role` and a `hopper-read` token for each cluster or
  namespace, and the box's probes run with them. A need with no minting credential fails the check and says which one
  to add. The AWS session is named `hopper-read-only-check` (or `<prefix>read-only-check`, or the fixed `SessionName`).
  Set `Region` in an AWS minting credential when the account's services are not in `us-east-1`.
- **`helm list` reads Secrets** (issues #869, #1736). helm keeps each release in a Secret, and the built-in `view` role
  (EKS `AmazonEKSViewPolicy`) cannot read Secrets. On a view role the `helm.list` probe is Forbidden on secrets: that is
  right for a read credential, and the probe passes. The check report names it and says why. A refusal of anything else
  still fails the probe. The `helm.install` probe asks the cluster to create each object of a chart in a server dry run:
  each one must be refused.
- **Where the check runs** (issue #708): beside the hopper when it is given a container runtime socket
  ("Sandboxes the hopper starts" below). With none, it runs on a machine of the template's user that joined with Add machine, is
  dialled in, and has rootless Podman or Docker. The minted read credentials then go down that machine's link into
  the check box there. With neither, the template waits for its check. A client older than this release refuses the
  check box, and the check fails with that reason; run it again once the machine has the new client.

### Argo CD syncs through the plan gate

A gated Argo CD application syncs only for a recorded, approved, current GitOps plan (issue #959, `docs/design.md` "Infra
plans: Argo CD syncs through the plan gate"). A job asks `$HOPPER_SECRET kube sync argocd-app/<cluster>/<app> --plan <id>`
and gets a 10-minute token of the service account `hopper-sync` in the namespace `argocd`; with it, the job starts the
sync (`argocd app sync --core`, or a patch of the Application's `operation`). To gate an application:

1. **Turn off its automated sync.** Remove `spec.syncPolicy.automated` from the Application. Argo CD then syncs it only
   when someone asks.
2. **Label it** `io.hopper.plan-gate=true`. The out-of-band collector's `--argo` then reports it on Infra if its
   automated sync is turned on again.
3. **Make `hopper-sync`** in the namespace `argocd`, with a Role that may `get` and `patch` only the gated Applications
   (`resourceNames`), and let the minting credential's identity `create` on `serviceaccounts/token` for it and on
   `secrets` in `argocd`, as above:

   ```yaml
   apiVersion: v1
   kind: ServiceAccount
   metadata: { name: hopper-sync, namespace: argocd }
   ---
   apiVersion: rbac.authorization.k8s.io/v1
   kind: Role
   metadata: { name: hopper-sync, namespace: argocd }
   rules:
     - { apiGroups: [argoproj.io], resources: [applications], resourceNames: [web], verbs: [get, patch] }
   ---
   apiVersion: rbac.authorization.k8s.io/v1
   kind: RoleBinding
   metadata: { name: hopper-sync, namespace: argocd }
   roleRef: { apiGroup: rbac.authorization.k8s.io, kind: Role, name: hopper-sync }
   subjects: [{ kind: ServiceAccount, name: hopper-sync, namespace: argocd }]
   ```

4. **Take sync away from people and other tools** in Argo CD's own RBAC (`argocd-rbac-cm`): no role but an admin's for
   break-glass may `sync` a gated application. The hopper cannot see a sync it did not mint for, other than as drift.
5. **The template** declares `sync` on `argocd-app/<cluster>/<app>`, and a person approves it on Vault.
## Search

Search (issue #945, docs/design.md "Search") finds your jobs, artifacts, infra plans, and the issues and pull requests your job sources see by their words, filters and facets: `GET /api/search`,
type-ahead at `GET /api/search/suggest`, the index's state at `GET /api/search/status`. In the UI, the command palette
(Cmd-K or Ctrl-K) and the Search view use them; from a shell, `hopper search`; an agent, with an API token. It reads a Solr core the hopper keeps from its
events.

- **In containers** it is set up: `compose.yaml` runs `docker.io/library/solr` as the service `solr`, one core (`hopper`)
  in standalone mode on the volume `solr`, on no host port and on the network `hopper_search` that it shares with the
  hopper alone. The hopper gets `HOPPER_SOLR_URL=http://solr:8983/solr/hopper`. Solr has no credential: nothing else
  reaches it. A stack from before gets it with the update, which puts in the new `compose.yaml`.
- **Elsewhere**: run Solr in standalone mode with one core made from its default config (`solr-precreate hopper`), and
  set `HOPPER_SOLR_URL` to the core's URL. Keep the core off every network a job or a person reaches: it holds your jobs'
  words. The hopper puts its schema into the core itself at each start.
- **Unset** `HOPPER_SOLR_URL`: search answers `not-configured`; nothing else changes.
- **What the hopper keeps**: Postgres is the source of truth. A lost `solr` volume loses nothing: at the next start the
  hopper finds the core empty and writes every job, artifact, plan, issue and pull request again. **Reindex** (`POST /ui/api/search/reindex`) does that when you
  ask. No secret, vault value or credential is ever written to the index.
- **Solr down**: search answers `degraded` and why, and the rest of the hopper goes on. Changes wait in the database and
  are written when Solr is back. The stack check names a missing `solr` service.

## Telemetry

The hopper exports OpenTelemetry traces, metrics and logs (issue #1486, docs/design.md "Telemetry"). It is off until the
launch names an exporter, with the usual `OTEL_*` variables, or the hopper's admin turns it on in Settings → Telemetry.
Nothing else is needed, and nothing is set in a file.

**In Settings** (docs/design.md "Telemetry settings"): turn on the export, give the collector's OTLP endpoint (for example
`http://collector:4318`; each signal goes to its `/v1/traces`, `/v1/metrics` or `/v1/logs`) and pick the signals. It
applies at once, with no restart, over OTLP HTTP and protobuf. A header the collector needs, such as its API key, is still
given at launch as `OTEL_EXPORTER_OTLP_HEADERS`. When the launch names an exporter, the launch wins, and Settings says so.

**At launch:**

- `OTEL_EXPORTER_OTLP_ENDPOINT` — your collector, for example `http://collector:4318`. Setting it turns telemetry on.
- `OTEL_EXPORTER_OTLP_PROTOCOL` — `http/protobuf` (the compose default), `http/json` or `grpc`.
- `OTEL_EXPORTER_OTLP_HEADERS` — headers for the collector, such as its API key.
- `OTEL_TRACES_EXPORTER`, `OTEL_METRICS_EXPORTER`, `OTEL_LOGS_EXPORTER` — `otlp` (the default), `console` or `none`, per
  signal.
- `OTEL_SERVICE_NAME` (default `hopper`), `OTEL_RESOURCE_ATTRIBUTES`, `OTEL_TRACES_SAMPLER` — as everywhere else.
- `OTEL_SDK_DISABLED=true` turns it off whatever else is set.

`compose.yaml` passes these through to the hopper. To see the data on this computer, start the optional viewer, Grafana's
all-in-one OpenTelemetry image (a collector, Tempo, Prometheus, Loki and Grafana):

```sh
COMPOSE_PROFILES=telemetry OTEL_EXPORTER_OTLP_ENDPOINT=http://telemetry:4318 podman compose up -d
```

Then open Grafana at http://127.0.0.1:3000 (`TELEMETRY_UI_PORT` moves it). Explore → Tempo shows a job's trace
(`hopper.job`, and its job spans) and each request's; Explore → Prometheus shows the metrics, for example
`http_server_request_duration_seconds` by `http_route` for the slowest actions, `hopper_job_span_duration_seconds` by kind,
and `hopper_github_calls_total` by route.

Other metrics show how work goes (docs/design.md "Telemetry: how work goes"): `hopper_job_assessed_total` (failures by
class, and the assessor's decision), `hopper_job_retries_total`, `hopper_question_escalations_total` by level,
`hopper_handoffs_total`, `hopper_sandbox_requests_total` and `hopper_sandbox_spin_up_duration_seconds`, and
`hopper_landing_batch_ended_total` by outcome.

Each sync of a job source, and each batch of GitHub changes the outbox sends, is a trace of its own (docs/design.md
"Telemetry: the outbox and the sync"): `hopper.source.sync` and `hopper.outbox.flush` in Tempo, with their GitHub calls,
and a link to the request that asked for them. The metrics are `hopper_source_sync_duration_seconds` by source and
outcome, `hopper_outbox_batch_size`, `hopper_outbox_calls_total` by result, and `hopper_outbox_rows_coalesced_total`. `hopper_work_items_label_drift_total` counts issues whose end labels
differ from their work item's state, by source, state and whether the outbox corrects them (issue #1891, the label mirror),
and `hopper_work_items_label_corrections_total` counts the corrections the label mirror queued, by source and state (issue #1933).

Two gauges show what runs now (docs/design.md "Telemetry: what runs now"): `hopper_sandboxes`, the sandboxes that run at
the same time, by kind (`need`, `playground`), place (`local`, `machine`) and state, and `hopper_db_connections`, the
store's open connections. Two more show the machines' disks (docs/design.md "Hopper's own disk use" → "Part 12"):
`hopper_disk_bytes`, what the machines online take on disk by kind (`hopper` for the hopper's own places, each cache kind,
`images`, `containers`, `volumes`, `build-cache`), and `hopper_machines_disk`, the machines online by their disk's state
(`ok`, `low`, `critical`). Neither names a machine: Machines and `GET /api/machines` show each machine's.

The steps the hopper does for a job are spans of the job's trace (docs/design.md "Telemetry: job steps"):
`hopper.job.worktree` (the job's worktree on its machine), `hopper.job.follow` (a follow of its pull request: the hopper's
merge, Merge now, Close PR), `hopper.job.base_merge` and `hopper.job.tend`. Each has its outcome, and a link to the sync
or request that ran it. A job that a tend starts links to that tend. The metric is `hopper_job_step_duration_seconds` by
step and outcome, and the Telemetry panel lists the steps with the job spans.

A need box's run is the step `hopper.job.need_box`, and the box runs with its `TRACEPARENT`: a tool in the box that
exports on its own joins the job's trace (docs/design.md "Telemetry: a box's own processes and deploys"). Each landing
batch run is a trace of its own, `hopper.landing_batch`, and each job in the batch gets a `hopper.job.deploy` span that
links to it. The metric is `hopper_landing_batch_duration_seconds` by outcome.

On Kubernetes, the Helm chart takes the same variables under `telemetry.env`, and only `OTEL_*` names there:

```sh
helm upgrade hopper deploy/helm/hopper --reuse-values --set telemetry.env.OTEL_EXPORTER_OTLP_ENDPOINT=http://collector:4318
```

Keep a header with a credential in a Secret, and name it in `telemetry.envFromSecret`:

```sh
kubectl create secret generic hopper-otel --from-literal=OTEL_EXPORTER_OTLP_HEADERS='api-key=…'
helm upgrade hopper deploy/helm/hopper --reuse-values --set telemetry.envFromSecret=hopper-otel
```

`--set telemetry.viewer.enabled=true` adds the same viewer in the release; the hopper then exports to it. Only the hopper
reaches its OTLP port. Open Grafana with `kubectl port-forward svc/hopper-telemetry 3000`, then http://127.0.0.1:3000.

While telemetry is on, a job runs with `TRACEPARENT`: its run span (docs/design.md "Telemetry: a job's trace on its
machine"). A tool in the job that reads it, and is set to export, puts its spans in the job's trace. The job's requests
to the hopper through `hopper-gh`, `hopper-skill`, `hopper-login`, `hopper-artifact` and `hopper-step`, and its git fetches
and pushes through the hopper, are spans of that trace too. The
job is given no `OTEL_*` variable: to export from inside a job, give the variables to its machine yourself.

## Optional services

`compose.yaml` has required services and optional ones (issue #586). Nothing outside the stack is required.

- **Required**: `postgres`, `hopper`, `openfga` (and `openfga-migrate`, which runs once), and `tunnel` and
  `cloudflared`, which run no tunnel agent until remote access is turned on in the UI with their provider ("Remote
  access" below). A plain `podman compose up -d` starts only
  these, and the vault works: it runs in the hopper, under the master key.
- **Optional**: `hopper-vault`, `kms` and `vault`, each behind a compose profile of the same name. The hopper
  starts and works without them. No required service depends on them, and none is on a host port. `vault` is HashiCorp
  Vault, a vault backend ("Vault backends" below); the others are here.

Turn them on with these settings at launch (`export …`), then run `podman compose up -d`. The next update writes them
into `compose.yaml` (issue #894):

| You want | settings at launch |
|---|---|
| The vault in a container of its own | `COMPOSE_PROFILES=hopper-vault` and `HOPPER_VAULT_URL=http://hopper-vault:4791` |
| That, with a local KMS | `COMPOSE_PROFILES=hopper-vault,kms`, `HOPPER_VAULT_URL=http://hopper-vault:4791` and `HOPPER_KMS_URL=http://kms:8080` |
| A local KMS, with the vault in the hopper | `COMPOSE_PROFILES=kms` and `HOPPER_KMS_URL=http://kms:8080` |

Check: Vault (http://127.0.0.1:4790/#vault) shows no problem. `podman compose ps` lists
`hopper-vault` and `kms` as running. To turn a service off, give the settings without it at launch (after an update,
they override the defaults written into `compose.yaml`) and run `podman compose up -d --remove-orphans`.

### The vault container (`hopper-vault`)

The hopper's vault runs in its own container, from the hopper's image (`node src/vault/main.ts`). It holds the vault's
key and the secret values, in the hopper's Postgres. Templates and their approvals, and secrets kept in a vault backend,
stay in the hopper. The hopper holds none of the vault's keys: it asks the vault at `HOPPER_VAULT_URL` with the
preshared key `HOPPER_VAULT_KEY`. The `postgres` service makes that key on its first start
(`vault_key` in `runtime-secrets`). A stack from before gets it with the new `compose.yaml`: `podman compose up -d`
recreates `postgres` once.

- The vault keeps its write-only rule and every check of a delivery (docs/design.md "The vault in a container of its own").
- When the vault container is not running, the hopper still works. Vault says the vault is not reachable,
  a change answers 503, and a box's ask is refused.
- Its key: the master key, or the KMS's data key when `HOPPER_KMS_URL` or `HOPPER_KMS_REGION` is set. `HOPPER_MASTER_KEY_PREVIOUS` given at launch
  reaches it too (key rotation, "Rotating the master key").
- **Elsewhere** (not compose): run `node src/vault/main.ts` with `HOPPER_DATABASE_URL`, `HOPPER_MASTER_KEY` and
  `HOPPER_VAULT_KEY` (each also `_FILE`), and optionally `HOPPER_KMS_URL` or `HOPPER_KMS_REGION`; `HOPPER_VAULT_PORT` moves its port (4791).
  Give the hopper `HOPPER_VAULT_URL` and the same `HOPPER_VAULT_KEY`. Keep the port off every network but the hopper's.

### The local KMS (`kms`)

A local KMS (local-kms, AWS KMS's API) wraps a data key per user: envelope encryption. The vault asks it for the data
key once, keeps only the wrapped form in the user's store, and asks the KMS to open it at each start. Every vault secret
is then sealed under the data key. The KMS's key is `alias/hopper-vault` (`HOPPER_KMS_KEY` names another), made at the
first ask. Its keys are in the `kms` volume.

- **Turn it on** with secrets in the vault: they still open, and are sealed again under the data key at the vault's
  first use.
- **Turn it off**: a value sealed under the data key does not open without the KMS. Set each vault secret again.
- **Keep the `kms` volume.** Removing it (`podman compose down -v`) loses every value sealed under a data key. Back it
  up with the database.
- When the KMS is down, the vault stores and delivers nothing and Vault says why. The vault container asks
  the KMS again at the next request; a vault in the hopper asks again at the next restart.
- local-kms checks no credentials. For AWS KMS itself, set `HOPPER_KMS_REGION` (and `HOPPER_KMS_KEY`, a key you made:
  the hopper makes none in AWS); the vault uses AWS's own credential chain. In a cluster: "On Kubernetes, with Helm".

### Remote access (the `tunnel` and `cloudflared` services)

Remote access is optional and off by default: the hopper works fully without it (issues #795, #880, #968). When it is
on, a tunnel forwards a public host name to the hopper's API. An agent that acts for you (Grok Bot) then reaches the
hopper from anywhere, with an API token ("API tokens" in docs/design.md). This machine needs no inbound port and no
public address: the tunnel dials out. You pick the provider: **Cloudflare Tunnel** or **ngrok**. They are equal
alternatives; neither is a fallback for the other. You give the hopper that provider's one credential, and the hopper
makes the rest itself. You edit no file on the host, so you can do it from a phone.

1. Make the credential:
   - **Cloudflare Tunnel**: an API token at https://dash.cloudflare.com/profile/api-tokens, a custom token with
     Account → Cloudflare Tunnel → Edit, and Zone → DNS → Edit on the zone the hopper's host name is in.
   - **ngrok**: an API key at https://dashboard.ngrok.com/api-keys.
2. Open Settings → Remote access (http://127.0.0.1:4790/#settings/remote-access) as the hopper's admin. Select the
   provider and paste the credential. Optional: type a host name (Cloudflare: one in the token's zone; ngrok: a domain of
   the account, or one to reserve). Empty: the hopper picks `hopper.<zone>` at Cloudflare, or the ngrok account's domain.
3. Turn Remote access on.

The hopper then makes the tunnel:

- **Cloudflare Tunnel**: a named tunnel the Cloudflare dashboard manages, its ingress (only the API paths reach the
  hopper), its token, and a proxied DNS record (`CNAME` to `<tunnel id>.cfargotunnel.com`). The `cloudflared` service
  runs it.
- **ngrok**: a tunnel credential (the authtoken ngrok runs with) and a domain: the one you typed, else the account's
  first reserved domain, else one it reserves. The `tunnel` service runs it.

Both services of the compose stack ask the hopper for their settings every 10 s, so the tunnel starts within 10 s. The
one that is not picked runs no agent. Check: the copy-out panel on the page shows the public URL, the API's URL, the
API-token exchange and the refresh URL, each with a copy button, and the status says `Up: agents reach the hopper's API
at https://<host name>`. `curl -s -o /dev/null -w '%{http_code}\n' https://<host name>/api/jobs` answers `401` (the API,
with no token) and `https://<host name>/` answers `404` (the UI is not on the tunnel). An admin's API token does the
same at `POST /ui/api/remote-access` (the API reference at `/docs/`, tag Remote access).

**Turn it off, or switch the provider**: the hopper removes what it made. At Cloudflare it deletes the DNS record, the
tunnel's connections and the tunnel. At ngrok it revokes the authtoken and removes a domain it reserved; a domain the
account had stays. The credential stays kept, so you can turn it on again; **Remove the API token** (or **API key**)
removes it while remote access is off. What the hopper could not remove (the provider did not answer, or the credential
was revoked) is listed on the page: remove it at the provider by hand.

When it is not up, the page says why:

- **No tunnel service**: the picked provider's service (`tunnel` or `cloudflared`) does not ask for its settings. Run
  `podman compose up -d` beside `compose.yaml`. An install from before issue #968 needs its new `compose.yaml` (the update
  does it).
- **Down**: the agent stopped (ngrok with its error code and its page), or it has no connection yet.
  `podman compose logs tunnel` or `podman compose logs cloudflared` shows the agent's log.
- **502 when you turn it on**: the provider refused (a token without the two permissions, a host name in no zone of the
  token's, an ngrok account that cannot reserve a domain). Nothing is left made, and remote access stays off.

What it does, and what it keeps out:

- **No secret on the host.** The credential and the tunnel's token are kept sealed in the hopper's vault (Settings →
  Vault lists them, never a value). The services hold nothing: each asks the hopper with a key that `postgres` makes in
  memory at each start of the stack (the `tunnel-key` volume), and gives the token to its agent in its environment only.
- **Its own network.** The tunnel forwards to `http://hopper:<port>` over the `hopper_tunnel` network, which only the
  hopper and the two services share. It never forwards to the hopper's loopback: an internet request is a **public
  request**, which reads the API only with a session or an API token. No box the hopper starts is on that network, so none
  reaches an agent's local API.
- **Only the API.** Every path but `/api/`, `/ui/api/`, `/ui/auth/api-token`, `/ui/auth/token/refresh`, and
  `/ui/auth/device-grant` with its poll (issue #892) is `404`, and so
  is the event stream (`/api/events/stream`, whose session is in the query). ngrok's edge says so in its traffic policy;
  Cloudflare's tunnel in the ingress the hopper sets; the hopper holds the same edge for every request through a tunnel.
  The UI, its sign-in pages, the installer and the services' own ask stay off the internet.
- **A limit per caller.** 120 requests a minute per address, and 5 API-token exchanges, refreshes or device grant
  requests a minute: at ngrok's
  edge, and in the hopper for both providers. Each edge names the caller's address to the hopper (ngrok in
  `x-hopper-caller`, after it drops one the caller sent; Cloudflare in `cf-connecting-ip`), which the hopper reads only
  from that provider's agent. The sign-in limit (20 a minute) counts each caller too. A stranger cannot use up your
  agent's exchanges.
- **The URL is fixed.** The Host guard takes the host name from what the hopper made, while remote access is on.
- **Grok Bot is told.** While the tunnel is up, the Grok Bot routine gets `hopper.reachable` with the URL: at start,
  when the tunnel comes back, and every 5 minutes (docs/design.md "Grok Bot routine webhook").
- **No box action without a box grant.** The token an agent gets for its own sign-in reads, holds and cancels. To let it
  start jobs, answer questions, merge, update or change a machine, mint a grant for it in Users & access → API tokens (tick
  Box grant), with only the scopes it needs. It refreshes its own API tokens through the tunnel, at
  `/ui/auth/token/refresh` (docs/design.md "Grants and refresh tokens").

**An install from before** issue #968, with an ngrok authtoken and domain pasted by hand: it goes on running as before.
Turning it off keeps that authtoken and domain (the hopper made neither). To let the hopper make and remove them, paste an
ngrok API key and save: the hopper then mints a new authtoken in place of the old one. **An install from before** issue
#880 (`COMPOSE_PROFILES=tunnel`, `NGROK_AUTHTOKEN` and `HOPPER_PUBLIC_URL`, in the launch environment):
at its first start, the hopper moves the authtoken into its vault, takes the domain from `HOPPER_PUBLIC_URL` and turns
remote access on, once (the log says so). Then remove `NGROK_AUTHTOKEN`, `HOPPER_TUNNEL_API` and `tunnel` from
`COMPOSE_PROFILES` in the launch environment. Keep `HOPPER_PUBLIC_URL` only if a reverse proxy also
serves the UI at it.

Residual risk, stated: callers behind one address (a NAT, a shared egress) share one count of each limit. The running
service holds the tunnel's token in memory while its agent runs. The hopper holds a credential that can make tunnels and,
at Cloudflare, change DNS records in the zone: give the token that zone alone.

## The out-of-band collector

Infra changes tracks infrastructure changes that did not come through IaC or GitOps (`docs/design.md` "Out-of-band
changes"). Something must look for them on a schedule: `scripts/out-of-band-collector.ts` is a ready-made read-only check
for that. It runs outside the hopper, on any machine with Node 24 or later, a checkout of this repository, and the read
credentials of what it checks. It needs no `npm install`.

1. Mint a grant for it: Users & access → API tokens (http://127.0.0.1:4790/#users-access/api-tokens), label `drift collector`, role
   operator, scope `out-of-band:signals`. Or on the hopper's host: `hopper token mint --label "drift collector" --holder
   cron --role operator --scope out-of-band:signals`. Copy the refresh token (`hopper_rt_…`). It is shown once.
2. Run it once by hand, with the sources you have, to keep the refresh token in its state file:

   ```sh
   HOPPER_REFRESH_TOKEN=hopper_rt_… node scripts/out-of-band-collector.ts \
     --hopper https://hopper.example.org --state /var/lib/drift-collector/state.json \
     --argo --terraform infra/network --cloudtrail eu-west-1 --kube-audit /var/log/kube-audit.log
   ```

   It prints `<n> signal(s): <n> recorded, <n> in band, <n> reported before`. Use `--dry-run` first to see the signals
   and send nothing.
3. Schedule the same command without `HOPPER_REFRESH_TOKEN`, for example every 15 minutes with cron:
   `*/15 * * * * cd /srv/hopper && git pull -q && node scripts/out-of-band-collector.ts --hopper … --state … --argo …`.
   In Kubernetes, use a CronJob with the state file on a persistent volume.

Keep in mind:

- **Keep the state file.** It holds the grant's refresh token: each run spends it and writes the new one there (mode
  600). A run with an old copy ends the whole grant (reuse detection). Then mint a new grant. A grant ends 30 days after
  its last refresh, so run at least that often.
- **Give it read credentials only.** It runs `kubectl get`, `terraform init` and `terraform plan -lock=false`, and
  `aws cloudtrail lookup-events`. Point `--terraform` at a checkout of the default branch: a plan of unchanged code that
  is not empty is drift.
- **The audit log** is read from a file of JSON lines. On a managed control plane, export it to that file first (EKS: the
  `kube-apiserver-audit` stream in CloudWatch Logs).
- **Set the controller identities** in Infra → Out-of-band changes (http://127.0.0.1:4790/#infra) first, so the writes of Argo CD or Flux
  are not reported as out of band.
- A source that fails (no credentials, a failed plan) is said on stderr, the run exits 1, and the next run reads it again.
  The other sources still report.
- In a hopper job, the same command reports as the job, with the job's own token: leave out `--hopper`, `--state` and
  the refresh token.

## Sandboxes the hopper starts

On by default in `compose.yaml` (issues #603, #708, #1157, #1349). Give the hopper your rootless Podman socket, and it
runs each job's need step and box step in a sandbox of its own, and the read-only check of a template, beside it. Each
sandbox does one step and is burned after it. A sandbox never joins as a machine and has no lane. Without the socket,
a step runs in the runtime of one of your machines that is dialled in (see "Sandboxes on another machine"), else it
fails with what to do.

**Requirement: a rootless runtime.** Podman is the default whenever it is reachable. Rootless Docker works too, through
the Docker Engine API (never the docker CLI): `HOPPER_DOCKER_SOCKET` names its socket, used when no Podman socket is
given or Podman is not reached, or always with `HOPPER_SANDBOX_RUNTIME=docker`. The hopper refuses a rootful socket of
either (root on the computer), and an image that runs as root.

`compose.yaml` mounts the file `HOPPER_PODMAN_SOCKET_HOST` names into the hopper at `/run/podman/podman.sock`, sets
`HOPPER_PODMAN_SOCKET` to that path, adds group 0 to the hopper's user (in a rootless container, group 0 is your own
group, which may open the socket: `podman.socket` makes it mode 0660), and sets `label=disable` (SELinux does not let a
container open the socket; without SELinux this changes nothing). Unset, `HOPPER_PODMAN_SOCKET_HOST` is `/dev/null`:
compose cannot mount a file that is not there, so the stack starts with no socket, and the hopper says it has none.

The update ("One command updates the install" above) gives the hopper the socket. It looks for `$XDG_RUNTIME_DIR/podman/podman.sock`: when
`podman.socket` is on, it writes that path into `compose.yaml` as the default of `HOPPER_PODMAN_SOCKET_HOST`; when it is
off, it goes on without it and says the line that turns it on. So turn the socket on, then run the update:

```sh
systemctl --user enable --now podman.socket
```

On a fresh install, before the first update, give it at launch (the update then keeps it in `compose.yaml`):

```sh
export HOPPER_PODMAN_SOCKET_HOST="$XDG_RUNTIME_DIR/podman/podman.sock"
podman compose up -d
```

An install that saved the old `compose.sandboxes.yaml` (issue #603) as `compose.override.yaml` needs nothing: the update
moves that file to `compose.override.yaml.bak`, as `compose.yaml` gives the socket now. An override of your own that also
mounts the socket stops the update before it changes anything: remove those lines from it. A hopper on this host (not in a
container) needs only `HOPPER_PODMAN_SOCKET=$XDG_RUNTIME_DIR/podman/podman.sock` in its environment.

The same socket lets the hopper read what each container of its stack and each box uses, for the Resources page (issue #947):
CPU, memory against its limit, network, disk, volumes, restarts and uptime. It only reads: it starts, stops or changes no
container of the stack. Without the socket, Resources shows only Postgres.

What the hopper then does:

| When | The hopper |
|---|---|
| A job runs a need step or a box step | starts a new sandbox of the template (`hopper-need-<name>`) with the sandbox flags, the template's CPU and memory defaults (4 CPUs and 8 GiB for a template that sets none), and a fresh home volume. The step runs, its output comes back, and the sandbox is removed with its home volume. Machines → *Sandbox runs* lists each run: its job, step, template, start and end, outcome, and when it was destroyed. |
| A template has tools | first builds the image with them added through the same runtime, once per base image and set of tools, as `localhost/hopper-box-tools:<hash>`. The build fetches each tool from its own release and checks its SHA-256, so the runtime needs network access to awscli.amazonaws.com, get.helm.sh, dl.k8s.io, releases.hashicorp.com, Docker Hub and Debian's mirrors. Old tools images stay in the runtime's storage: `podman image prune` or `podman rmi` removes them. |
| Every 10 seconds, and at start | burns each sandbox that outlives its step. It also burns each sandbox box an older version started that joined as a machine (label `io.hopper.box` = its instance id), with its home volume, and removes its record. A box another hopper started is left alone. |
| It cannot remove a box | shows the box and the reason on Machines, under *Sandbox boxes not removed*, and tries again every 10 seconds. |

The sandbox network is `hopper_default` for the hopper in its container and `host` for a hopper on the host;
`HOPPER_SANDBOX_NETWORK` names another (a compose project of another name: `<project>_default`).

**Residual risk.** The socket is your account: whoever controls the hopper's process can start any container as you.
The hopper itself only starts locked-down sandboxes — every capability dropped, no new privileges, a read-only root,
the image's own non-root user, CPU and memory limits, nothing of the computer mounted — from the published box image
or an approved template's image. A job names only a template and its command, never an image, a mount or a flag.

Turn it off: `export HOPPER_PODMAN_SOCKET_HOST=/dev/null` and run `podman compose up -d`, or turn `podman.socket` off
and run the update.

### A read-only box's egress

On by default in `compose.yaml` (issue #849). A need box of a read-only template, and the read-only check box, beside
the hopper join the internal network `hopper_egress` (`internal: true`: no route out). The only way out is the compose
service `egress`: tinyproxy, from the hopper's image, on that network and on `hopper_default`. It lets a box CONNECT only
to:

- `*.amazonaws.com` (STS, S3, SSM and the other AWS APIs the read session reads),
- the API server of each cluster the vault minted a credential for a read-only box (its `server`), and an STS endpoint a
  minting credential names that is not AWS's,
- nothing else: any other host is refused (403). The box reaches the hopper past the proxy: the hopper is on
  `hopper_egress` too.

The box gets `HTTPS_PROXY` (and `NO_PROXY=hopper`); `aws`, `kubectl`, `helm` and `terraform` obey it. A process in the box
that unsets it has no route at all. The hopper writes the allowlist into the `egress` volume (`/run/hopper-egress`) before
each read-only box starts and waits until the proxy loaded it; the allowlist only grows while the hopper runs. A proxy
that does not load it in 30 seconds fails the box, with that reason: a read-only box never starts with open egress.

The variables, all three together: `HOPPER_SANDBOX_EGRESS_NETWORK` (`hopper_egress`), `HOPPER_SANDBOX_EGRESS_PROXY`
(`http://egress:3128`) and `HOPPER_SANDBOX_EGRESS_DIR` (`/run/hopper-egress`). They apply to the runtime beside the hopper
(Podman or Docker) only.

**The check proves it.** The read-only check's egress probes (`egress.aws`, `egress.kube`) send one request to
`https://example.com`, with no credential, past the proxy and through it; each must fail to connect. Where the egress is
open — a hopper on the host with no egress variables, or a check that runs on one of your machines ("Sandboxes on
another machine") — the probes reach it, the check fails, and the template takes no box. A probe of a write takes no
mark ("The read-only check" in docs/design.md), so the fix is to run the check where the egress is limited: in the
compose stack.

Check it by hand: `podman logs hopper-egress-1` shows `egress: the allowlist <version> is loaded`, and each refused host
as `Proxying refused on filtered domain`.

### Sandboxes on another machine

A machine that joined with Add machine can run sandboxes too (issue #708). The hopper starts them in that machine's
own rootless Podman (or rootless Docker when Podman is not there), through the machine's client: no socket of that
machine is given to the hopper, and nothing listens on the machine. On the machine, once:

```sh
systemctl --user enable --now podman.socket
loginctl enable-linger "$USER"
```

The second line keeps your user's services, the socket included, running after you sign out. Under WSL, also keep
the distro running: WSL stops an idle distro, and its containers with it ("Keep a hopper in WSL running" above).

A step runs there when the hopper has no runtime beside it: on the first of your machines that is dialled in and has a
runtime. The machine's client checks each call again: it creates only a check box or a need box, with the sandbox
flags and no mount of the machine, and stops or removes only the boxes the hopper made. It makes no sandbox box that
joins as a machine (issue #1349). A box with tools on a machine runs a tools image the hopper builds in that machine's
runtime, through its client, once per base image and set of tools; the client builds only a tools image, from the
hopper's one Containerfile. A client of an older release refuses the build: the hopper loads its own release there
once no job runs on it.

### Sandboxes on a Podman host

A Podman host is a computer that runs only sandboxes (issue #2272): a VM with rootless Podman and no hopper client. The
hopper reaches it over ssh with its own key, and runs each call through `podman system dial-stdio`. Once the sandbox host
names it, every sandbox starts there and nowhere else. A box step with vault secrets runs there too: the secrets are copied
into the box, never put in its environment.

On the host, once, as the account the sandboxes run as:

1. Install Podman 4 or later. Check that it is rootless: `podman info --format '{{.Host.Security.Rootless}}'` prints `true`.
2. Keep the account's services running after you sign out: `loginctl enable-linger "$USER"`.
3. Add one line to `~/.ssh/authorized_keys`: the forced command, then the hopper's public key. Settings → Podman hosts
   shows the whole line:

   ```
   command="podman system dial-stdio",no-pty,no-port-forwarding,no-agent-forwarding,no-X11-forwarding ssh-ed25519 AAAA… hopper
   ```

   The key can then run dial-stdio only: no shell, no forwarding.

Then add the host and use it:

1. Settings → Podman hosts → Add a Podman host: a name, `user@host`, and optionally the most CPUs and memory a box gets.
   Read its host key, compare the fingerprint with the host's own (`ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` on the
   host), then Pin this key and save. From the CLI: `hopper machine podman-host add <name> <user@host>` prints the key and its
   fingerprint; run it again with `--host-key '<key>'` (and `--cpus N`, `--memory-mb N`) to add it.
2. Use as sandbox host on its row, or `hopper machine sandbox-host <name>` (a list sets the order).

While the host does not answer (ssh fails, or Podman does not), steps wait and say `sandbox host <name> is offline`; they never
start on another machine.

### Sandbox boxes on Kubernetes

A hopper in a cluster starts sandbox boxes as pods, with no container socket anywhere (issue #1286). Set
`HOPPER_SANDBOX_RUNTIME=kubernetes`. The hopper uses the Kubernetes API with its pod's service account (outside a
cluster: the kubeconfig).

| Setting | What it does |
|---|---|
| `HOPPER_KUBERNETES_NAMESPACE` | The namespace the boxes start in. Unset: the hopper's own namespace. |
| `HOPPER_KUBERNETES_HOPPER_LABELS` | The labels of the hopper's pods, `key=value`, comma-separated. Default `app.kubernetes.io/name=hopper`. A box may reach only pods with these labels in the hopper's namespace, on the hopper's port. |
| `HOPPER_KUBERNETES_PRIORITY_CLASS` | The PriorityClass every sandbox pod gets, so a ResourceQuota scoped to it holds the sandbox pods alone ("The sandbox playground"). Unset: none. |
| `HOPPER_KUBERNETES_BOX_CPUS`, `HOPPER_KUBERNETES_BOX_MEMORY_MB` | The most CPUs and memory (MiB) a box gets. Unset: what the box asks for (a need box: 4 CPUs, 8192 MiB). |
| `HOPPER_LAN_NAMES` | Its first name is the address a box dials: the name of the hopper's Service in that namespace (for example `hopper`). The box's start check proves it from inside the box. |

**With the Helm chart**, set `sandbox.enabled=true`. The chart sets these settings, makes the Role below in the
release's namespace and binds it to the hopper's service account (one it makes, `hopper`, unless `serviceAccount.name`
names one). Only the hopper's pod gets the account's token. The boxes start in the release's namespace, and a box may
reach the hopper's pod alone, by its three labels (`app.kubernetes.io/name`, `instance` and `component`), not Postgres,
OpenFGA or Solr:

```sh
helm upgrade hopper deploy/helm/hopper --namespace hopper --reuse-values --set sandbox.enabled=true
```

The service account needs this Role in the boxes' namespace (and nothing in any other):

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata: { name: hopper-sandbox }
rules:
  - { apiGroups: [""], resources: [pods], verbs: [get, list, create, delete] }
  - { apiGroups: [""], resources: [pods/log], verbs: [get] }
  - { apiGroups: [""], resources: [pods/exec], verbs: [create, get] }
  - { apiGroups: [""], resources: [persistentvolumeclaims], verbs: [create, delete, get, list] }
  - { apiGroups: [networking.k8s.io], resources: [networkpolicies], verbs: [create, update] }
```

What is different from Podman:

- **A box is a pod** with the sandbox flags as its security context: every capability dropped, no privilege
  escalation, a read-only root, `/tmp` an empty dir, no service account token, no service links, nothing of the node.
  It runs as uid and gid 1000 (the box image's `agent` user), whatever user its image names, and the kubelet refuses
  root. Its home is a PersistentVolumeClaim `<name>-home` of 5 GiB, of the cluster's default storage class.
- **Egress.** Before each pod, the hopper applies one NetworkPolicy, `hopper-sandbox`, to every pod it starts: no
  ingress, and egress only to DNS (port 53), the hopper's pods on its port, and public addresses. A box cannot reach
  any other pod, Service or private address of the cluster or your network (`10.0.0.0/8`, `172.16.0.0/12`,
  `192.168.0.0/16`, `100.64.0.0/10`, link-local and loopback). Your cluster's network plugin must enforce
  NetworkPolicy, or the policy does nothing. A box still reaches any public host, as a box on Podman does: an
  allowlist of hosts per template is #849, for Podman and Kubernetes together. Kubernetes always lets a pod reach the
  node it runs on: where that node also runs the cluster's API server (kind, a one-node cluster), a box reaches the
  API server. It holds no token there. Run boxes on worker nodes where you can.
- **Limits.** A box's CPU and memory limits are its requests too, so the scheduler starts a box only on a node with
  room for it; a box with no room waits, pending, and starts when room comes (a step waits at most 15 minutes for its
  box to start). `sandbox.limits.cpus` and `sandbox.limits.memoryMb` set the most each box gets (issue #1422). A box
  that goes over its memory is killed by Kubernetes: its step ends with exit 137, and the last line of its log says
  `hopper: Kubernetes killed the box: it went over its memory limit (…, OOMKilled)`.
- **No image is built.** A box with tools runs the tools image CI publishes for its box image, with every tool:
  `ghcr.io/henningfutrell/hopper:box-<agent>-tools`, or `…-tools-read-only` for a read-only template's boxes. A
  template with its own image and tools cannot start a box here; one with no tools can. The node pulls each image.
- **Steps and copies** go through the API's exec: the box image needs `tar` for a copy (the published one has it).

Leftover box builds are not removed here: the hopper builds none.

### The sandbox playground

The sandbox playground (Machines → **Sandbox playground**, issue #1410) starts many sandboxes at once, on Podman, Docker
or Kubernetes, beside the hopper. A playground sandbox runs its image idle, with a fresh home, no secret and no join
code: it is not a machine and takes no lane. It is destroyed with its home (on Kubernetes its pod and its claim) when a
person destroys it, when its time limit passes, and at the hopper's next start (after a restart or a crash). These
settings limit it; with the Helm chart set the values (they need `sandbox.enabled=true`), with compose the variables:

| Helm value | Variable | Default | What it does |
|---|---|---|---|
| `sandbox.maxConcurrent` | `HOPPER_SANDBOX_MAX_CONCURRENT` | `20` | How many run at once, all users together. Over it a create is refused with 429, naming the limit. `0`: none start |
| `sandbox.maxPerUser` | `HOPPER_SANDBOX_MAX_PER_USER` | `10` | How many one user runs at once. Over it: 429, naming the limit |
| `sandbox.defaults.cpus` | `HOPPER_SANDBOX_DEFAULT_CPUS` | `1` | The CPUs of a sandbox when the create and its template name none |
| `sandbox.defaults.memoryMb` | `HOPPER_SANDBOX_DEFAULT_MEMORY_MB` | `2048` | Its memory, in MiB |
| `sandbox.defaults.ttlMinutes` | `HOPPER_SANDBOX_DEFAULT_TTL_MINUTES` | `60` | Its time limit, in minutes |
| `sandbox.max.cpus` | `HOPPER_SANDBOX_MAX_CPUS` | `4` | The most CPUs a create may ask for. More: 400 |
| `sandbox.max.memoryMb` | `HOPPER_SANDBOX_MAX_MEMORY_MB` | `8192` | The most memory, in MiB |
| `sandbox.max.ttlMinutes` | `HOPPER_SANDBOX_MAX_TTL_MINUTES` | `1440` | The longest time limit, in minutes |
| `sandbox.quota.enabled` | `HOPPER_KUBERNETES_PRIORITY_CLASS` | off | A ResourceQuota on the sandbox pods alone (below) |
| `sandbox.quota.pods`, `.cpu`, `.memory` | | `30`, `"40"`, `80Gi` | The quota's `pods`, `limits.cpu` and `limits.memory` |

A default above its max stops the hopper at start, with the setting named. A template's own limits also hold: a create
over them is refused with 400.

**The quota** counts every sandbox pod the hopper starts (need boxes, check boxes and playground sandboxes), and nothing else of the
namespace. A ResourceQuota holds a whole namespace, so the chart makes a PriorityClass, `<release>-sandbox` (value 0, it
never preempts a pod), the hopper gives it to every sandbox pod, and the quota counts only pods of that class. To make the
PriorityClass, the account that runs `helm install` needs the right to make one (it is cluster-wide). There is no
LimitRange: it would also set limits on the hopper, Postgres, OpenFGA and Solr. The hopper sets CPU and memory limits on
every sandbox pod itself.

```sh
helm upgrade hopper deploy/helm/hopper --namespace hopper --reuse-values \
  --set sandbox.enabled=true --set sandbox.maxConcurrent=50 --set sandbox.maxPerUser=50 \
  --set sandbox.quota.enabled=true --set sandbox.quota.pods=60
```

The runtime's NetworkPolicy, `hopper-sandbox`, is one for every sandbox pod, so it stays when the last sandbox goes.

## Lane pods on Kubernetes

Lane pods are machines that run as a StatefulSet and dial out to the hopper (design.md "Lane pods", issue #1284). Each
pod is one machine under its pod's name, a machine of the first person who signed in. No sshd, no inbound port, no
Service for the pods. The Helm chart ("On Kubernetes, with Helm") carries them: the StatefulSet `hopper-lanes`, and the
lane pool key, which the chart makes at the first install in the Secret `hopper-lane-pool` and gives to the hopper and
to the pods' join step only.

1. Sign in to the hopper once. Until then, a pod's join is refused, and the pod tries again every 10 seconds.
2. Set how many: `helm upgrade hopper deploy/helm/hopper --namespace hopper --reuse-values --set lanes.replicas=3`.
3. Keep the agent's sign-in in your vault once: on Logins, under **Claude sign-in for pods**, type the Claude account and
   select **Sign in**. Open the URL on its card, sign in as that account, and paste the code the page shows into the card.
   The hopper runs `claude setup-token` itself and keeps the token as the vault secret `CLAUDE_TOKEN`. (Or run
   `claude setup-token` on any machine and set what it prints, `sk-ant-oat…`, as `CLAUDE_TOKEN` in Vault.)
   Each job on a lane pod starts signed in with
   it, also after a pod starts again with a new volume. A `claude-plan` usage source that names a lane pod reads it with
   the token too. The token is not kept in a pod's volume, its spec or a ConfigMap.
   Without it, sign each pod in once (`kubectl --namespace hopper exec -it hopper-lanes-0 -c lane -- claude`): that
   sign-in stays in the pod's volume only.

| value | |
|---|---|
| `lanes.replicas` | how many lane pods: one machine each. Default `0`: none |
| `lanes.drainSeconds` | how long a pod told to stop waits for the jobs on it to end (`terminationGracePeriodSeconds`). Default `3600` |
| `lanes.size`, `lanes.storageClass` | each pod's volume: its link key and the jobs' work trees (the agent's sign-in only without `CLAUDE_TOKEN`). Default `20Gi` |
| `lanes.agent`, `lanes.imageTag` | the box image: `box-<agent>` for the `latest` and `stable` channels, `box-<agent>-<channel>` for the others, unless `lanes.imageTag` names another tag |
| `lanes.resources`, `lanes.nodeSelector`, `lanes.tolerations`, `lanes.affinity` | where the pods run, and with what |

What to expect:

- Scale 1 → 3: Machines shows `hopper-lanes-0`, `-1` and `-2`, online, each taking jobs.
- Scale down: each pod that goes is *leaving* on Machines — no new job, its jobs run to their end — then retired, gone
  from Machines. Its volume goes with it. A job still on it at the end of `lanes.drainSeconds` is a job on a machine
  that went away.
- A pod restarted (a rollout, a node drained) leaves the same way, then joins again as the same machine.
- Machines shows each pod's CPU and memory as its limits (`lanes.resources`). With no limit set, a pod may use the whole
  node, and Machines shows the node's. The chart passes the limits as `HOPPER_POD_CPU_LIMIT` and
  `HOPPER_POD_MEMORY_LIMIT` (design.md "Host-only parts in a cluster").
- No view asks for a Podman or Docker socket, systemd or WSL in a pod: a cluster install has none of them.

Without the chart, give the same: a Secret with the key (`openssl rand -hex 32`), mounted into the hopper's pod with
`HOPPER_LANE_POOL_KEY_FILE` naming its file, and a StatefulSet like `deploy/helm/hopper/templates/lanes.yaml`.

### Lane pods of another release

Lane pods can join a hopper that is not in their release (issue #1454, design.md "Lane pods of another release"): a
compose hopper, or a hopper on another cluster. A **runner-only release** of the chart is the lane pods alone, with no
hopper, Postgres, OpenFGA or Solr. Its pods join with a lane pool key that the hopper issues. The hopper does not start
again. Each pod is a machine of the person who made the key. It holds no credential of the hopper's host and mounts no
host path, so it is ready where a host machine that holds user credentials is not (issue #1248).

1. In the hopper, open Machines → **Add machine** → **Pods on Kubernetes** and select **Make a key**. Set the URL that the
   pods reach the hopper at. It must be a name the hopper answers to: a LAN name (`HOPPER_LAN_NAMES`, an allowed host),
   or the public URL. A pod reaches a LAN name only from a LAN peer (`HOPPER_LAN_PEERS`): add the cluster's node or pod
   network there. Or run `hopper pool-key` (the operator CLI) to print a key.
2. Copy the two commands the page shows and run them where `kubectl` reaches the cluster, from a checkout of the hopper's
   repository:

   ```sh
   kubectl create namespace hopper-runner && \
     kubectl -n hopper-runner create secret generic runner-pool-key --from-literal=key='<key>'
   helm install runner deploy/helm/hopper -n hopper-runner --set hopper.enabled=false --set lanes.replicas=1 \
     --set lanes.hopperUrl='https://hopper.example.com' --set lanes.existingSecret=runner-pool-key
   ```

3. The pod `runner-hopper-lanes-0` shows on Machines, online. Set more pods with `--set lanes.replicas=3` on a
   `helm upgrade runner deploy/helm/hopper -n hopper-runner --reuse-values`.

| value | |
|---|---|
| `hopper.enabled` | `false`: a runner-only release. Default `true` |
| `lanes.hopperUrl` | the URL the pods join and dial in at: `http://` or `https://`, a host and a port, no path. Needed with `hopper.enabled=false`. Empty: the release's own hopper |
| `lanes.existingSecret` | a Secret with the lane pool key under `key`. Needed with `hopper.enabled=false`. With the hopper on, the hopper reads it too, and the chart makes no `hopper-lane-pool` |

- The page shows the key once: the hopper keeps only its hash. **Make a new key** replaces it. **Revoke the key** (or
  `hopper pool-key --revoke`) stops new joins. Pods that joined stay machines, until you remove them on Machines.
- A pod joins again at each start with the key. After a new key, put it in the Secret, then restart the pods
  (`kubectl -n hopper-runner rollout restart statefulset/runner-hopper-lanes`).
- The agent's sign-in comes from the vault with each job, as for the chart's own lane pods (step 3 above).
- **Manual check** (no CI runner has a compose hopper and a cluster together): start a compose hopper with its port
  reachable from the cluster, do steps 1 to 3, and see the machine online and ready on Machines. Then label an issue
  so the hopper takes it, and see a job start on `runner-hopper-lanes-0`. `kubectl -n hopper-runner get pod
  runner-hopper-lanes-0 -o yaml` shows no `hostPath` volume.

## Vault backends (optional)

The vault keeps its secrets itself. It can also keep a secret in HashiCorp Vault, 1Password or Bitwarden (issue #585,
docs/design.md "Vault backends"): the hopper then reads the value there each time a box's job asks, and keeps no copy.
None is needed: without one the hopper starts and its own vault works.

- **HashiCorp Vault in the compose stack**: `podman compose --profile vault up -d` starts the `vault` service beside the
  hopper. Its first start sets Vault up and makes a read-only token for the hopper, which the hopper reads as
  `VAULT_TOKEN_FILE`. Then:
  1. Plugins → Vault backends → add `hashicorp-vault`. Its defaults reach the service.
  2. Write a secret: `podman compose exec vault sh -c 'VAULT_TOKEN=$(cat /vault/keys/root_token) vault kv put secret/apps/db password=...'`.
  3. Vault → Add secret → Kept in: the backend, reference `apps/db#password`. Add it to a template and approve it.

  The unseal key and the root token are in the `vault-keys` volume, beside Vault's data: whoever can read that volume
  can open it. Keep a copy of `root_token` elsewhere if you need it. To stop using it: remove the backend in Settings →
  Plugins, then `podman compose --profile vault down` (add `-v` only to delete its secrets).
- **An outside HashiCorp Vault**: add `hashicorp-vault` with its `address` (and `mount`, `namespace`). Give a token that
  may read the secrets as `VAULT_TOKEN_FILE` in `compose.override.yaml` (a file you mount there), or name another variable in the instance's
  `tokenEnv` and set that.
- **1Password**: add `1password`; set `OP_SERVICE_ACCOUNT_TOKEN` to a service account token that may read the vaults
  (https://developer.1password.com/docs/service-accounts/). A reference is `op://vault/item/field`, as Copy Secret
  Reference gives it.
- **Bitwarden Secrets Manager**: add `bitwarden`; set `BWS_ACCESS_TOKEN` to a machine account's access token
  (https://bitwarden.com/help/access-tokens/). For the EU cloud or your own server, set `apiUrl` and `identityUrl`. A
  reference is the secret's id.

Each token is read at each use: change it in the runtime and the next read uses it. A backend that cannot read a
secret refuses the box's ask, saying why, on the box and in the event log.

## This host (systemd --user)

One line, the curl install (`scripts/get.sh`, issue #87): it checks what the install needs, clones
the source into `~/.local/share/hopper/source` (or updates it), starts the bundled Postgres with
a fresh password unless `daemon.env` or `HOPPER_DATABASE_URL` already names a database, and runs
`scripts/install.sh`:

```sh
curl -fsSL https://henningfutrell.github.io/hopper/install.sh | bash
```

`HOPPER_SOURCE_REF` installs and tracks another branch; `HOPPER_SOURCE_REPO` another repository. By hand,
from a clone:

```sh
export POSTGRES_PASSWORD=<a long random password>
docker compose -f deploy/compose.yaml up -d postgres          # published on 127.0.0.1:${POSTGRES_PORT:-5433}
HOPPER_DATABASE_URL="postgres://hopper:$POSTGRES_PASSWORD@127.0.0.1:5433/hopper" bash scripts/install.sh
```

`install.sh` copies the install to `~/.local/lib/hopper`, links `~/.local/bin/hopper`,
installs `hopper.service` and `hopper-herdr.service`, writes `HOPPER_DATABASE_URL` into
`~/.config/hopper/daemon.env` (mode 600, the unit's EnvironmentFile) when it is not there yet,
and writes the starter rules when the database has none (edit them in Settings → Question gates).
Secrets go in the same `daemon.env`. The first start makes the master key and shows it once in the UI: save it, add
`HOPPER_MASTER_KEY=<it>` to `daemon.env`, and run `systemctl --user restart hopper` ("The master key"). No OpenFGA is
installed: set `HOPPER_OPENFGA_URL` ("Access: OpenFGA"), or every credential is denied.
Open the UI at `http://localhost:4790/` and sign in with GitHub: the first person to do so is the admin.

A managed Postgres works the same: put its URL (with `sslmode=require`) in `daemon.env`.

**Updates.** This install updates itself (`docs/design.md` "Self-update"). It checks its update channel every minute.
When a newer version is there, the UI shows a notice with What's new and **Update now**; Settings → Version has the
same button, the channel and the **Auto-update** switch. With Auto-update on, the hopper applies an update as soon as a
check finds it. An update builds the next install in `~/.local/lib/hopper.next` while jobs keep running, and checks that
it loads. Then it waits while there is a **restart blocker**: a running job that cannot reattach after a restart. The
UI shows which jobs it waits for. Then it moves the old install to `~/.local/lib/hopper.prev` (the previous `.prev`
goes), puts the new one in its place, and exits 75: systemd starts it again (`SuccessExitStatus=75`,
`RestartForceExitStatus=75`). `hopper-herdr` does not restart, so herdr panes and their jobs stay. A build that fails
leaves the install as it was. To go back by hand, stop the service, move `~/.local/lib/hopper.prev` back to
`~/.local/lib/hopper`, and start it: the next start records the update as failed.

## Sign-in set up at launch

Who may use the UI is set by sign-in: the realms (an auth gateway in front, OIDC or SAML single
sign-on, a directory, GitHub), the login code and no sign-in (docs/sign-in.md). Every
part of it can be set by the daemon's environment, with no click and no file: the `HOPPER_SIGN_IN_*`
variables (the **sign-in environment**, docs/sign-in.md "Sign-in from the environment" lists every one).
They are read at **every start** and written to the database: the environment wins over a change made
in Settings → Sign-in. A variable the hopper cannot use stops the start and names the variable; nothing
is written. A secret (a client secret, a bind password) may be the value itself or a mounted file:
`<variable>_FILE` names it.

Sign-in decides who uses the hopper. It does not connect GitHub: inside the hopper, each user connects
their own GitHub from the UI (issue #214, `README.md` "Connect GitHub"), whichever realm signed them in.

**Where the variables go**

| deploy | variables | secret files | apply |
|---|---|---|---|
| containers (`compose.yaml`) | given at launch (`export …`) for a variable `compose.yaml` names; else in `compose.override.yaml` (`services.hopper.environment`). No settings file (issue #894) | a `secrets:` entry in `compose.override.yaml`, then `<variable>_FILE=/run/secrets/<name>` there; or `<variable>: ${<variable>:-}` there and the value given at launch | `podman compose up -d` |
| this host (systemd `--user`) | `~/.config/hopper/daemon.env` (mode 600) | `LoadCredential=<name>:<path>` in a drop-in (`systemctl --user edit hopper`), with `Environment=<variable>_FILE=%d/<name>` | `systemctl --user restart hopper` |
| Kubernetes, or another platform | the container's environment (a ConfigMap) | a Secret volume, and `<variable>_FILE` naming the file in it | roll out the change |

**Steps, for every way in**

1. Give the hopper its public address: `HOPPER_PUBLIC_URL=https://hopper.example.com`, behind a
   reverse proxy with TLS (docs/sign-in.md "The sign-in origin and a public URL"). The identity
   provider sends people back to it.
2. Pick one way in below. Register the hopper at the identity provider as it says, and set its
   variables. `<NAME>` in a variable is the realm's name in upper case, `-` as `_`: the variables
   `HOPPER_SIGN_IN_REALM_CORP_*` set up the realm `corp`.
3. Give the realm a role rule that makes you admin (`ROLES_ADMIN_GROUPS`, `ROLES_ADMIN_EMAILS`, …) and
   a default role for everyone else it lets in (`ROLES_DEFAULT_ROLE`; without it, a person no rule
   matches gets no session). Rules and their matches: docs/sign-in.md "UI roles and role rules".
4. Start or restart the hopper. Its start lines say
   `hopper: sign-in from the environment: realms <name>`, and Settings → Sign-in marks the realm *set
   from the environment*. A line `invalid sign-in environment: <variable>: …` names what to fix.
5. Sign in through the new realm, and check that you are admin (Settings is there).
6. Turn the login code off: `HOPPER_SIGN_IN_LOCAL_ENABLED=false`, and start again.

To remove a realm the environment set up: delete its variables, start again, and remove the realm in
Settings → Sign-in (with the variables gone, it stays as last set).

### Behind an auth gateway

An auth gateway in front of the hopper (Envoy Gateway with OIDC, oauth2-proxy, an ingress with OIDC)
signs people in and forwards their token; the hopper only checks the token, and nobody sees a sign-in
form. Set the gateway up to forward the access token (Envoy Gateway: `forwardAccessToken: true`;
oauth2-proxy: `--pass-access-token`, header `x-forwarded-access-token`), then:

```sh
HOPPER_PUBLIC_URL=https://hopper.example.com
HOPPER_SIGN_IN_REALM_GATEWAY_TYPE=gateway
HOPPER_SIGN_IN_REALM_GATEWAY_ISSUER=https://idp.example.com/realms/corp
HOPPER_SIGN_IN_REALM_GATEWAY_AUDIENCE=hopper
HOPPER_SIGN_IN_REALM_GATEWAY_ROLES_ADMIN_GROUPS=hopper-admins
HOPPER_SIGN_IN_REALM_GATEWAY_ROLES_DEFAULT_ROLE=viewer
HOPPER_SIGN_IN_LOCAL_ENABLED=false
```

- `ISSUER` is the issuer of the tokens; `AUDIENCE` the `aud` they carry for this gateway (required).
- oauth2-proxy: add `HOPPER_SIGN_IN_REALM_GATEWAY_HEADER=x-forwarded-access-token`.
- Opaque tokens: `HOPPER_SIGN_IN_REALM_GATEWAY_CHECK=introspection`, with the hopper's own client at
  the issuer: `HOPPER_SIGN_IN_REALM_GATEWAY_CLIENT_ID` and `HOPPER_SIGN_IN_REALM_GATEWAY_CLIENT_SECRET_FILE`.
- **Reach the hopper only through the gateway**: the token is the credential. Keep the hopper's port on
  a network only the gateway reaches, with `HOPPER_LAN_PEERS` naming the gateway's address.

Envoy Gateway's `SecurityPolicy`, and how the token is checked: docs/sign-in.md "Behind an auth gateway".

### OIDC single sign-on

Google, Microsoft Entra ID, Okta, Auth0, Keycloak, or any OpenID Connect provider. At the provider, make
a web application with the redirect URI `https://hopper.example.com/ui/auth/corp/callback` (`corp` is
the realm's name), and take its client id and secret. What to click at each provider, and its issuer
URL: docs/sign-in.md "Identity providers".

```sh
HOPPER_PUBLIC_URL=https://hopper.example.com
HOPPER_SIGN_IN_REALM_CORP_TYPE=oidc
HOPPER_SIGN_IN_REALM_CORP_LABEL=Corp SSO
HOPPER_SIGN_IN_REALM_CORP_ISSUER=https://idp.example.com/realms/corp
HOPPER_SIGN_IN_REALM_CORP_CLIENT_ID=hopper
HOPPER_SIGN_IN_REALM_CORP_CLIENT_SECRET_FILE=/run/secrets/corp_client_secret
HOPPER_SIGN_IN_REALM_CORP_ROLES_ADMIN_GROUPS=hopper-admins
HOPPER_SIGN_IN_REALM_CORP_ROLES_DEFAULT_ROLE=viewer
HOPPER_SIGN_IN_LOCAL_ENABLED=false
```

- Groups need the provider to send a groups claim; `SCOPES` adds a scope it asks for
  (`openid email profile groups` at Okta), `CLAIMS_GROUPS` names another claim (`roles` for Entra app roles).
- A provider that sends no groups (Google): match on emails, `ROLES_ADMIN_EMAILS=ada@example.com`.

### SAML

Microsoft Entra ID, Okta, Keycloak, ADFS, or any SAML identity provider. At the provider, make a SAML
application with:

- entity id (Identifier, Audience URI): `https://hopper.example.com/ui/auth/corp-saml/metadata`
- assertion consumer service, HTTP-POST (Reply URL, Single sign-on URL): `https://hopper.example.com/ui/auth/corp-saml/callback`
- signed assertions, a persistent NameID, and `email`, `displayName` and `groups` attributes.

Take its single sign-on URL, its entity id and its signing certificate (Base64). The certificate is not
a secret: the bare base64 on one line, or a file.

```sh
HOPPER_PUBLIC_URL=https://hopper.example.com
HOPPER_SIGN_IN_REALM_CORP_SAML_TYPE=saml
HOPPER_SIGN_IN_REALM_CORP_SAML_LABEL=Corp SSO
HOPPER_SIGN_IN_REALM_CORP_SAML_ENTRY_POINT=https://idp.example.com/sso/saml
HOPPER_SIGN_IN_REALM_CORP_SAML_IDP_ISSUER=https://idp.example.com/metadata
HOPPER_SIGN_IN_REALM_CORP_SAML_IDP_CERT_FILE=/run/secrets/corp_saml_cert.pem
HOPPER_SIGN_IN_REALM_CORP_SAML_ROLES_ADMIN_GROUPS=hopper-admins
HOPPER_SIGN_IN_REALM_CORP_SAML_ROLES_DEFAULT_ROLE=viewer
HOPPER_SIGN_IN_LOCAL_ENABLED=false
```

- Other attribute names (Entra sends URIs): `ATTRIBUTES_EMAIL`, `ATTRIBUTES_NAME`, `ATTRIBUTES_GROUPS`.
  Entra, Okta and Keycloak: docs/sign-in.md "Identity providers".
- The hopper's metadata, for a provider that imports it: `https://hopper.example.com/ui/auth/corp-saml/metadata`.

### A directory (LDAP, Active Directory)

People sign in on the username and password form with their directory account.

```sh
HOPPER_SIGN_IN_REALM_DIRECTORY_TYPE=ldap
HOPPER_SIGN_IN_REALM_DIRECTORY_LABEL=Directory
HOPPER_SIGN_IN_REALM_DIRECTORY_URL=ldaps://ldap.example.com
HOPPER_SIGN_IN_REALM_DIRECTORY_BIND_DN=cn=hopper,ou=services,dc=example,dc=com
HOPPER_SIGN_IN_REALM_DIRECTORY_BIND_PASSWORD_FILE=/run/secrets/directory_bind_password
HOPPER_SIGN_IN_REALM_DIRECTORY_USER_BASE=ou=people,dc=example,dc=com
HOPPER_SIGN_IN_REALM_DIRECTORY_ATTRIBUTES_SUBJECT=entryUUID
HOPPER_SIGN_IN_REALM_DIRECTORY_ROLES_ADMIN_GROUPS=["cn=hopper-admins,ou=groups,dc=example,dc=com"]
HOPPER_SIGN_IN_REALM_DIRECTORY_ROLES_DEFAULT_ROLE=viewer
HOPPER_SIGN_IN_LOCAL_ENABLED=false
```

A group DN holds commas: give the groups as a JSON array. Active Directory adds
`USER_FILTER=(sAMAccountName={username})`; more: docs/sign-in.md "LDAP realm".

### GitHub sign-in

Every hopper offers GitHub sign-in: a device code through the hopper's GitHub App, nothing to register,
no secret. The first person to sign in with it becomes admin; these variables set the rules for everyone
after. The same sign-in connects their GitHub, which their jobs work through (`docs/sign-in.md` "GitHub").

```sh
HOPPER_SIGN_IN_REALM_GITHUB_TYPE=github
HOPPER_SIGN_IN_REALM_GITHUB_ROLES_ADMIN_SUBJECTS=583231
HOPPER_SIGN_IN_REALM_GITHUB_ROLES_OPERATOR_USERNAMES=octocat
HOPPER_SIGN_IN_LOCAL_ENABLED=false
```

A subject is the numeric user id (`id` in `https://api.github.com/users/<login>`). Another GitHub App or
GitHub Enterprise: `HOPPER_GITHUB_URL`, `HOPPER_GITHUB_CLIENT_ID`, `HOPPER_GITHUB_APP_SLUG`.

**GitHub keeps ten sign-ins per person and app.** Each hopper connected as one GitHub user holds one; an
eleventh made anywhere — another hopper, a test container, a connect in a browser — revokes the oldest
unused one, which may be a running hopper's, and that hopper then reads *sign-in expired*. Disconnecting,
and connecting again, revoke the sign-in they replace, so they add none. Keep hoppers plus short-lived
instances connected as one user on one app at most ten. A test, verify or CI container does not connect as
a person whose hoppers matter on the shared app: give it its own app (`HOPPER_GITHUB_CLIENT_ID`) or its own
GitHub user, or no connection at all; one that connected anyway uses Sources → *Stop working through
GitHub* before it is removed (docs/design.md "One grant per connection").

## Update channels and promotion

The repository has three long-lived branches that are the update channels (issue #423), and below them the landing
branch `main` (issue #1073, docs/design.md "Landing batches"), least stable first:

| Branch | What is on it | Who moves it, and when |
|---|---|---|
| `main` | the landing branch (a setting in Settings → Landing batches, whatever the default branch on GitHub, issue #1142): every pull request, a job's included, merges here after the fast checks (the gates and the affected tests). No update channel: no hopper follows it | each merge |
| `dev` | what passed the full test suite on `main` as one batch run | the hopper merges a green batch run (Settings → Landing batches) |
| `beta` | changes that ran on `dev` | a maintainer promotes, once a `dev` hopper has run the change without trouble |
| `canary` | the stable candidate: changes that ran on `beta`. No update channel: the stable installs that take stable releases early follow it | a maintainer promotes, once a `beta` hopper has run the change without trouble |
| `stable` | changes that ran on `canary` for its canary window | the hopper, when the canary window passes with no bug report that names the candidate (Settings → Landing batches); or a maintainer promotes by hand |

A **promotion** moves a commit up one step, and only through `scripts/promote.sh`, run by a maintainer in a
clone whose `origin` is this repository:

```sh
bash scripts/promote.sh beta [commit]     # a commit of dev (default: its head)
bash scripts/promote.sh canary [commit]   # a commit of beta (default: its head): the stable candidate
bash scripts/promote.sh stable [commit]   # a commit of canary (default: its head), by hand
```

It refuses unless the commit is on the branch one step below (`stable` never takes a commit straight from
`beta`), the move is a fast-forward of the steadier branch, and the commit's image built on the branch below
(the `image` run, asked of `gh`), and the commit has no What's new fragments left in `whats-new/`. Then it pushes, as the maintainer, so the steadier branch's image build
starts. `beta` and `stable` therefore only ever hold what ran one step below; nothing is merged or committed
on them. A fix for something found on `beta` or `stable` lands on `main` like any change, reaches `dev` with its batch
run, and is promoted from there. There is no schedule and nothing promotes on its own: the maintainer decides. Only the step below `dev` is the
hopper's: after N merges into `main`, or on a timer, and only when `main` has something new, it opens a
batch run (a pull request of `main`'s tip into `dev`), and merges it once the full suite passed on it.


**The canary** (issue #1073 part 5, docs/design.md "Landing batches: the canary"). A stable release reaches the installs
that take stable releases early (Settings → Version → Take stable releases early) first. In the hopper, Settings → Landing
batches → the repository's **Canary window** (hours) turns the canary step on. Each pass compares `stable` with `canary`:
a new candidate starts the window; a bug report (`user-report`) that names the candidate's commit holds it and files one
issue for Intake; the window passed with none, the hopper moves `stable` to the candidate (a fast-forward, with its
admin's GitHub connection, so branch protection on `stable` must let that account update it). Without a canary window,
`promote.sh stable` is the only way `stable` moves.

**Setting up the landing branch** (once, by a maintainer):

1. Move `main` to `dev`'s head. `main` is not an ancestor of `dev`, so the push replaces it: `git push --force origin origin/dev:refs/heads/main`.
2. Optional: make `main` the default branch (the repository's Settings → General → Default branch), so a job's pull
   request opens into `main` at once. The batch runner does not need it: it reads the landing branch from its settings
   (issue #1142), and moves a job's pull request on `dev` to `main` at its next pass.
3. Require `pr / test` on `main` as on `dev` (a branch protection rule or ruleset), so yolo mode merges only on
   it.
4. In the hopper, Settings → Landing batches: add the repository, landing branch `main` (the default), tested branch `dev`. Open job pull requests on `dev`
   move to `main` at the next pass.

**Assemble What's new first (issue #824).** Pull requests add their What's new lines as fragments in
`whats-new/`, never in `WHATS-NEW.md`. Before `promote.sh beta`, move them into `WHATS-NEW.md` on `main`:

```sh
node scripts/whats-new.ts assemble        # in a branch of main; then open a pull request to main and merge it
```

Then wait for the batch run that carries it to `dev`, and promote that merge. The move keeps each line's text, so it brings no update news.

**What a hopper updates to (issue #652).** A hopper offers its channel's head only when that commit is the merge of a
pull request whose checks passed (asked of GitHub's API). Promote a merge commit of `dev` (`scripts/promote.sh` takes
`dev`'s head by default, which is one). A direct push to a channel's branch, or a pull request merged with no checks or
failed checks, is **held**: the update notice says "Update held" and why, and no hopper applies it until a merged pull
request with passing checks is the branch's head.

**A change with a store migration.** Moving a hopper to a steadier channel installs that channel's head,
which can be older than the build that already migrated its database. So a migration must leave a store
the build before it still runs on: add tables, columns and values; never drop, rename or reshape what the
older build reads, until that older build is on no channel any more (it has been promoted past `stable`).
A value an older build does not know is skipped by it, as an unknown update channel is. Promote such a
change one step at a time, and check each step's hopper starts and runs a job before the next. A build stops at
the start on a store whose schema version is above its own, naming both versions (issue #527): run that newer
release again, or restore a backup of the database from before it. Builds from before that check run on such a
store without a word, which is why the rule above holds.

**The hopper's own secrets moved into the vault.** The first start of a build with the vault's system scope moves the
GitHub connection's tokens, the webhook signing secrets and the sign-in realms' secrets out of their old places, once,
and removes the old copies (the owner's direction: one place for them). A build from before it, run on that store again,
finds none of them: connect GitHub again, replace each webhook's secret, and set each realm's secret again — a realm
that is on and needs one stops that build at start. Builds since the schema check above refuse such a store anyway.

What each push publishes: `.github/workflows/image.yml` builds the image tag of the branch's name
(`stable` also moves `latest`); `.github/workflows/pages.yml` publishes the Pages site, its `install.sh` and
its `compose.yaml` from `stable` only.

A hopper picks its channel in Settings → Version (dev, beta, stable); it takes effect without a restart.
An install from `scripts/install.sh` or the curl install starts on the branch it was installed from
(`HOPPER_SOURCE_REF`, default `stable`). An image is replaced by its user pulling the tag of its channel
(`HOPPER_IMAGE`, "In containers, with Podman", "Update"): the channel picked in Settings → Version only
decides what the update check compares against.

**From before.** The channels were `dev`, `beta`, `main` and `release`. A hopper set to `main` or `release`
is set to `stable` when it starts on a version with these channels (store migration 26). `main` is now the landing
branch, no channel. No release tag was ever published, so a hopper on `release` had nothing to update to: choose
a channel in its Settings, or install again.

## Repository setup

A job pushes only to a branch of its own work, and yolo mode merges only a trusted or approved job's pull request, after its checks pass (a repository with no checks:
after a two-minute grace window). GitHub keeps everyone
else off the release branches. Sources → **Repository setup** checks each job repository and names what is missing
(`docs/design.md` "Repository setup"). For the hopper's own repository (https://github.com/henningfutrell/hopper),
and the same for any job repository:

1. **Protect `dev`, `beta` and `stable`** (the default branch and each release branch the repository has):
   Settings → Rules → Rulesets → New branch ruleset (https://github.com/henningfutrell/hopper/settings/rules), or
   Settings → Branches (classic branch protection). Target the three branches. Turn on:
   - **Require a pull request before merging.** Leave the bypass list empty, or name only the repository admin: then
     nobody else pushes to the branch directly.
   - **Require status checks to pass**, and add **`pr / test`** (the PR check, "Local development and tests" below).
   - **Block force pushes** (a ruleset's "Block force pushes"; classic: leave "Allow force pushes" off).
   `scripts/promote.sh` moves `beta` and `stable` by a push: run it as the repository admin, on the bypass list.
2. **Secret scanning and push protection:** Settings → Code security
   (https://github.com/henningfutrell/hopper/settings/security_analysis) → Secret Protection, and Push protection: on.
3. **Actions:** the PR check uses `pull_request` with a read-only token and no secrets. Settings → Actions → General
   (https://github.com/henningfutrell/hopper/settings/actions) → Workflow permissions: **Read repository contents and
   packages permissions**.

GitHub shows branch protection and the security settings only to a repository admin. Connected as anyone else, Sources
says which points it could not read (`unknown`), never that they are off. `hopper repo checks <repo>` prints the same as
JSON.

## Rename from job-hopper

The product was called job-hopper (issue #112). An install from before keeps its config, secrets and
database, and runs as hopper; `docs/design.md` "Rename from job-hopper" says what moves.

- **This host, self-update on:** nothing to do. The update moves the install once no job holds a pane in
  herdr session `job-hopper`; until then the update notice says which jobs it waits for, and the old
  daemon runs on. Auto-update takes it at the first check after; else Update now.
- **This host, by hand:** run the curl install or `bash scripts/install.sh` from a clone, as for any
  upgrade. With a job holding a pane it stops, names the jobs, and leaves the old daemon running: run it
  again once they finish.
- **A container:** rename every `JOB_HOPPER_*` variable it is given (at launch, or in `compose.override.yaml`) to
  `HOPPER_*`; the daemon
  refuses to start while the old names give its database. The bundled Postgres keeps its volume
  (`job-hopper_postgres`), so `docker compose -f deploy/compose.yaml down` with the old file, then `up` with
  the new one, finds the same data.
- **Client targets** move themselves when the hopper next loads its client release onto them (when no job
  runs there). **ssh-attached machines** keep running their jobs in session `job-hopper`; run
  `scripts/attach-machine.sh` again to move one, and follow what it prints.
- **Webhook receivers** read `x-hopper-event`, `x-hopper-delivery`, `x-hopper-timestamp` and
  `x-hopper-signature`; the Grok Bot routine's payload says `source: hopper`.

## Local development and tests

`deploy/compose.yaml` is the bundled Postgres alone: `up -d postgres` for a database (optional —
any Postgres will do). `npm test` starts its own throwaway Postgres container (testcontainers;
needs docker or podman), each test in its own schema; `HOPPER_TEST_POSTGRES_URL=postgres://…` uses an
existing database instead. With no docker or podman socket the tests that start containers are skipped, and the run
names them. For a change, run the gates and the affected test files (`npx vitest run test/…`); the PR check runs the
full suite.

**The PR check** (issue #672): `.github/workflows/pr.yml` runs on every pull request to `dev`, `beta` or
`stable`. Its job `pr / gates` runs `npm ci`, `npm run typecheck`, `npm run lint` and `npm run build:ui`;
its jobs `pr / shard (1)` to `(10)` run `npm test` in ten shards, one test worker per core, so the whole check
takes about 4 minutes (issue #949). Every job takes `node_modules` from the cache of its `package-lock.json` and runs
`npm ci` only when there is none.
The check to require is **`pr / test`**: it passes only when the gates and every shard passed. The tests run
with `HOPPER_TEST_HOST_SERVICES=0`, which leaves out the tests that need
their own containers, a real sshd, LDAP or a vault (the list: `test/support/host-services.ts`; a new test
that needs one of those goes there). It reads the repository only and uses no secrets (`pull_request`, never
`pull_request_target`), so a fork's pull request is safe. Yolo mode merges a pull request only once a check
passed on it; this is that check. To have GitHub hold every merge to it, make `pr / test` a required status
check in the branch protection of `dev` (Settings → Branches): an owner's step, not the workflow's.

**Box images of every agent** (issue #865, `docs/design.md` "Agent boxes"): the image workflow publishes
`ghcr.io/henningfutrell/hopper:box-<agent>` for claude, codex, cursor, omp and opencode (`scripts/box/Dockerfile`,
build argument `AGENT`). The sandbox playground and the lane pods (`lanes.agent`) run them. `scripts/agent-boxes.sh`
went with issue #865: its ssh agent boxes were for testing only.
