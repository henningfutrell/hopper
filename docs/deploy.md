# Deploying hopper

Everything the daemon keeps is in one Postgres database it is given — the only store; it keeps no
local file. Its secrets come from its runtime — environment variables or mounted secret files — and it
stores none; its config is config records in that database, edited in the UI, with no config file
(docs/design.md "Deployable"). It runs as a self-hosted service anywhere it can reach its database:
containers from one compose file, systemd `--user` units on a host that also runs the jobs, or any
platform that runs a container and hands it a managed Postgres. **Recommended: the published image,
with Podman** ("In containers, with Podman"); the host install is the other way.

## What every deploy needs

| | where |
|---|---|
| `HOPPER_DATABASE_URL` | `postgres://user:password@host:port/database[?schema=<name>][&sslmode=require]`, or `HOPPER_DATABASE_URL_FILE` naming a mounted file holding it. Required. Put Postgres near the hopper: every store call waits one round trip. |
| Credentials the hopper is given | for outside services, from the runtime (docs/design.md "Secrets"): each one the variable `NAME`, or the mounted file the variable `NAME_FILE` names (never both) — `GITHUB_APP_PRIVATE_KEY`, `GROKBOT_WEBHOOK_URL`, `GROKBOT_WEBHOOK_KEY` (with the user's secret prefix, `HOPPER_USER_<ID>_`, as Settings → Plugins names them; as `_FILE` they can change without a restart), `TYPESAFE_API_KEY`, a realm's secrets only when the realm is set up from the environment (`HOPPER_SIGN_IN_REALM_<NAME>_CLIENT_SECRET`, docs/sign-in.md "Sign-in from the environment"; typed in Settings otherwise, and stored); `CLAUDE_CODE_OAUTH_TOKEN` for the claude CLI where its own login is not on the machine (a variable only: the CLI reads it). A job's `GH_TOKEN` is no runtime secret: the hopper hands each job the connected account's token. A leftover `HOPPER_SECRET_KEY` line: delete it. |
| Secrets the hopper owns, and the token key | kept in the database, encrypted under the **token key** `HOPPER_TOKEN_KEY` (also `_FILE`; 32 bytes, `openssl rand -hex 32`): each webhook's signing secret (typed in or made in Settings → Webhooks, write-only) and the connected account's tokens. The compose install makes the key in its secrets volume; `install.sh` writes one into `daemon.env`. Keep it with the database's backups but never in them: a database restored without it asks for every webhook secret again and to connect GitHub again. Without it no webhook secret is stored, and the tokens are kept in clear (said at start). A key that is not 32 bytes stops the daemon. Rotate it: "Rotating the token key" below. |
| Process settings | `HOPPER_*` variables: port, LAN names and peers, public URL, tick, limits (`src/config.ts`). |
| Plugins | Optional. `HOPPER_PLUGIN_DIR` (plugins put there by hand; a container mounts it read-only) and `HOPPER_PLUGIN_STORE` (seeds the plugin store setting on a hopper that never had one set; the plugin store is set in the UI, Plugins → Plugin store, and defaults to the one the Pages site publishes: docs/plugins.md). Store installs are kept in the database and restored into the work dir at start: they need no plugin dir and no volume. |
| Config | the plugins, rules and sign-in configs and the webhook subscriptions, all in the database, all edited in the UI (Settings → Plugins, Settings → Question gates, Settings → Sign-in, Settings → Webhooks); no config file. The first boot writes the built-in plugins config. |
| GitHub | each user's GitHub sign-in, the **connected account** (default; sign in with GitHub, or Sources → Connect GitHub, then choose the job repositories in Sources), or a GitHub App an admin creates for this hopper with `scripts/create-github-app.sh` (its key in `GITHUB_APP_PRIVATE_KEY`). Each hopper has its own App and key; there is no shared one. No gh CLI source and no gh login since issue #359. Setting up either: `README.md` "Connect GitHub". |
| Where jobs run | machines: this host's herdr session (`hopper-herdr`; not in a container, issue #141), and attached machines, instances in the plugins config's machine sources (Settings → Plugins → Machine sources, or the Machines view) — `client` targets (a computer or a sandbox box, joined with one line), `ssh` targets, `docker` container targets. Setting each one up, step by step: `README.md` "Add machines". |

`hopper` is the operator CLI (`hopper config …`, `hopper users`, `hopper user add`, `hopper user transfer`); it needs `HOPPER_DATABASE_URL` (or `_FILE`) and nothing else. `hopper help` lists its commands; `node src/main.ts --help` lists every daemon setting with its default.

Once it runs, the API reference is at `/docs/` (Scalar; the OpenAPI document at `/docs/openapi.json`), on every address the UI answers on. A first-time walkthrough is `README.md`.

### Webhook secrets from before

A webhook subscription added before its signing secret was kept in the hopper names a runtime variable
(`WEBHOOK_SECRET_<NAME>`, also `_FILE`), and keeps reading it: nothing stops signing on upgrade. Its card
in Settings → Webhooks says "secret from runtime variable X". To move it into the hopper: **Replace
secret** with the value the receiver already has (nothing changes for the receiver), or **Rotate secret**
and give the receiver the new one. From then on the variable is not read: delete it from the runtime.

### Rotating the token key

1. Make a new key: `openssl rand -hex 32`.
2. Give it as `HOPPER_TOKEN_KEY`, and the old one as `HOPPER_TOKEN_KEY_PREVIOUS` (one per line; also
   `_FILE`). In compose: put the new key in the secrets volume's `token_key` file and set
   `HOPPER_TOKEN_KEY_PREVIOUS` in `.env`.
3. Restart the hopper. Each user's webhook secrets are sealed again under the new key; the log says how
   many (`webhook signing secret(s) sealed again under the current HOPPER_TOKEN_KEY`).
4. Remove `HOPPER_TOKEN_KEY_PREVIOUS` and restart again.

The connected account's tokens open under `HOPPER_TOKEN_KEY_PREVIOUS` too, and are sealed again under the
new key within a minute of the restart (log: `tokens of <account> sealed at rest`): no new GitHub sign-in.
Keep the key with the database: a hopper on the database with neither key reads the connection as
*cannot be read* and asks for the key back. Connecting again instead makes another GitHub grant (docs/design.md
"One grant per connection").

Mounted secrets: in compose, a `secrets:` entry (added to `compose.yaml`) appears at `/run/secrets/<name>` — set
`<NAME>_FILE=/run/secrets/<name>`; in Kubernetes, a Secret volume; under systemd, `LoadCredential=` in
a drop-in with `Environment=<NAME>_FILE=%d/<name>`.

## In containers, with Podman (recommended)

`compose.yaml` (issues #119, #125): the whole hopper in containers, from that one file — no clone, no
host install, no build, nothing to set before the first start. The hopper is the public image
`ghcr.io/henningfutrell/hopper` (`latest` follows `stable`; `dev`, `beta` and `stable` follow the branch of
that name; `sha-<commit>` pins one build; Intel/AMD and ARM), built and pushed by `.github/workflows/image.yml`
on every change to those three branches ("Update channels and promotion" below). The install page serves the
compose file. The update channel is the image tag: to run another channel, set `HOPPER_IMAGE=ghcr.io/henningfutrell/hopper:dev`
(or `:beta`, `:stable`) in `.env` ("Upgrade" below).

Needs Podman 4.7 or later with a compose provider: `podman compose` runs `docker-compose` or
`podman-compose`, whichever is installed (Debian/Ubuntu: `sudo apt install podman podman-compose`;
Fedora: `sudo dnf install podman podman-compose`). Rootless: run it as your own user, no sudo. Docker
works the same — `docker compose` in place of `podman compose` everywhere below.

```sh
curl -fsSLO https://henningfutrell.github.io/hopper/compose.yaml
podman compose up -d
```

Then open `http://localhost:4790/` and sign in with GitHub: the first person to do so is the admin.
There is no bootstrap login: a new hopper creates no user, no password and no login code (issue #238).

| service | |
|---|---|
| `secrets` | runs once per start: makes a random database password on the first one, in the `secrets` volume, and writes the database URL from it. Each file is readable only by the one service that uses it. Nobody types or keeps the password. |
| `postgres` | the database (`POSTGRES_PASSWORD_FILE`), on no host port; data in the `postgres` volume. |
| `hopper` | the image `HOPPER_IMAGE` names (default `ghcr.io/henningfutrell/hopper:latest`). `HOPPER_DATABASE_URL_FILE` from `secrets`. Its home, `/home/node`, is the `home` volume: the claude sign-in and git's identity. |
| `openfga-migrate` | brings OpenFGA's tables in the `openfga` schema up to its version, then exits; retries until postgres has made the schema. Nothing depends on it ("Access: OpenFGA" below). |
| `openfga` | OpenFGA, which access asks before every credential a job is given; on no host port, behind a preshared key `postgres` makes. |

- **The container is not a machine** (issue #141). The image sets `HOPPER_LOCAL_MACHINE=false`: no
  `local` machine, and the boot removes one an earlier version wrote into the plugins config. Jobs run on
  attached machines (`README.md` "Add machines"); the image carries herdr's CLI for them. The Machines
  view offers no **Add this machine** here. To run jobs on the computer the container runs on, use
  **Add machine** → *A computer*, and run the line it shows there (issue #308, `README.md` "A computer
  or a sandbox box: one line"): the computer dials in to the published port, so nothing is set up
  inside the container and nothing leans on a `~/.ssh` (issue #293). *A sandbox box* starts a
  locked-down container on the compose network `hopper_default`, which reaches the hopper as
  `http://hopper:<port>` — the compose file's `HOPPER_LAN_NAMES` and `HOPPER_LAN_PEERS` defaults let it
  through. Attaching over ssh (`you@host.containers.internal`, Docker `you@host.docker.internal`) stays
  for a computer that cannot run the client. A reverse proxy in front of a public hopper must pass the
  dial-in's HTTP upgrade (`Upgrade: hopper-client/1`) to `/client/connect`.
- **Sign-ins.** GitHub: sign in with GitHub in the UI (or Sources → Connect GitHub); the hopper keeps
  that connection, and nothing in the container signs in to GitHub (the image has no gh since issue
  #359). Claude Code: `podman compose exec hopper claude` (`/login`), once, kept in the home volume. No
  `-it`: `podman compose exec` is interactive with a terminal by default, and podman-compose refuses the
  flag. Or, for Claude Code, `CLAUDE_CODE_OAUTH_TOKEN` in `.env`: every job's Claude gets it, and the hopper seeds
  Claude's config in an empty home, so a job starts with no first-run screen. A job gets its GitHub token from the
  connected account (`GH_TOKEN`) on the machine that runs it. Who jobs commit as: `git config --global` in the container, or the
  `GIT_AUTHOR_*`/`GIT_COMMITTER_*` variables in `.env`.
- **Settings and secrets: `.env` beside `compose.yaml`**, optional (`.env.example`, mode 600). Compose
  reads it for the file's own variables and passes all of it to the hopper.
- **The UI** is published on this computer's loopback, `127.0.0.1:${HOPPER_PORT:-4790}`, the same port
  inside and out. Those requests reach the daemon from the compose network, so they are LAN requests:
  `/api/` needs a UI session (docs/design.md "Reaching the UI across the LAN"). `HOPPER_LAN_PEERS`
  defaults to the private ranges and `HOPPER_LAN_NAMES` to `hopper`, the name a reverse proxy on the
  compose network reaches it by; set `HOPPER_PUBLIC_URL` for one.
- **Health:** the image's HEALTHCHECK reads `/api/health` on loopback inside the container.
- **Keep it running.** Every container restarts unless stopped. Rootless Podman has no daemon, so
  nothing starts them after a reboot by itself: `systemctl --user enable podman-restart.service` (it
  starts every container whose restart policy is `always` or `unless-stopped`) and
  `sudo loginctl enable-linger "$USER"`, once.
- **Upgrade: you update a container install, never the hopper** (issues #51, #409, #494). Self-update and
  Auto-update do not apply to a container: the UI offers neither Update now nor the Auto-update switch, and the
  server ignores an auto-update setting for it. When the update check finds a newer build, the update notice
  and Settings → Version give these commands with the selected channel's tag.
  - **The channel is the image tag.** `HOPPER_IMAGE=ghcr.io/henningfutrell/hopper:<channel>` in `.env` beside
    `compose.yaml`, where `<channel>` is the channel picked in Settings → Version: `dev`, `beta` or `stable`.
    Unset, it is `:latest`, the same image as `:stable`. A container on `:latest` with the channel set to `dev`
    never reaches `dev`'s head by pulling, so the notice says "this container runs the `stable` image; the
    selected channel is `dev`: switch the image tag". **Switch channels** by changing `HOPPER_IMAGE` and running
    the commands below; pick the same channel in Settings → Version.
  - **Pull and recreate the hopper's container alone**, in the folder that holds `compose.yaml`. Postgres and
    every volume stay as they are:

    ```sh
    podman compose pull hopper && podman compose up -d --force-recreate --no-deps hopper   # Podman
    docker compose pull hopper && docker compose up -d --force-recreate --no-deps hopper   # Docker
    ```

    `--force-recreate`: podman-compose keeps the old container on a newly pulled image without it.
  - **Optionally, remove the image it replaced:** `podman image prune -f --filter label=org.opencontainers.image.title=hopper`
    (`docker image prune …` the same). It removes only untagged hopper images, so repeated upgrades do not
    pile up images.
  - **When.** Recreating the container is a restart. A job whose machine reattaches (a herdr pane on an
    attached machine) keeps running through restart recovery (issue #368); a job a restart would lose (a
    restart blocker) ends. The notice shows how many there are, the same count the host updater waits on:
    wait until it is zero.
  - A pinned build: `HOPPER_IMAGE=ghcr.io/henningfutrell/hopper:sha-<commit>` in `.env`.
- **Remove:** `podman compose down` keeps the volumes; `down -v` deletes the database and the sign-ins.
- **An image from a checkout:** `bash scripts/build-image.sh` (Docker, else Podman; `HOPPER_BUILDER` picks one),
  then `HOPPER_IMAGE=localhost/hopper` in `.env`. It builds `localhost/hopper` with the checkout's repository,
  branch and commit written into the image, so Settings → Version history and the update check work as for an
  install; a bare `docker build .` cannot see the commit and the hopper then says it lacks it. Without the claude
  CLI: `bash scripts/build-image.sh --build-arg INSTALL_CLAUDE=false` (then jobs need attached machines, and
  the escalation levels a designated machine or an API key). An image is updated by pulling or rebuilding it:
  the update check says when one is newer, and self-update never replaces an image in place.
- **Who answers questions:** the container has no Claude sign-in of its own, so its escalation levels
  escalate every question to you until one can run. In Settings → Question gates: set a level's
  `machine` (picked from the machines) to a machine signed in to claude — one joined with Add machine (its client runs claude) or an attached ssh machine —, or add an `anthropic-api` level and give the
  container `ANTHROPIC_API_KEY` (or `ANTHROPIC_API_KEY_FILE`, a mounted secret) in `.env`.

**From the build-from-source compose file** (before issue #125): the volumes are the same, so the new
file, downloaded into the same folder, starts on the old data with `docker compose up -d`. Docker and
Podman keep separate volumes: moving such a stack from Docker to Podman moves the database once, with
`pg_dump` from one and `psql` into the other, before the hopper's first start under Podman.

**From the earlier container deploy** (`deploy/compose.yaml --profile container`, removed): its database
is the `job-hopper_postgres` volume, which `deploy/compose.yaml` still serves. Move it into the new stack
once, before the hopper's first start, with `pg_dump` from one and `psql` into the other.

## Access: OpenFGA

Before the vault gives a job a credential, access asks OpenFGA whether the job's template is approved for it
(issue #559, docs/design.md "Access: OpenFGA decides each mint"). With no OpenFGA, or one the hopper cannot reach,
every credential is denied, and Settings → Access says why.

- **In containers** it is set up: `compose.yaml` runs `docker.io/openfga/openfga` as `openfga-migrate` and `openfga`,
  with its tables in the `openfga` schema of the hopper's Postgres. The `postgres` service writes OpenFGA's config
  (`/run/hopper-secrets/openfga/config.yaml`: the database URL, the preshared key; uid 65532 only) and the key the
  hopper sends (`openfga_key`, uid 1000 only) at each start, and makes the schema once it takes connections. The
  hopper gets `HOPPER_OPENFGA_URL=http://openfga:8080` and `HOPPER_OPENFGA_KEY_FILE`. A stack from before picks
  it up with the new `compose.yaml` and `podman compose up -d`: the `postgres` service is recreated (a restart of
  the database) and writes the new files.
- **Elsewhere**: run OpenFGA (`openfga migrate`, then `openfga run`, its datastore any it supports), and set
  `HOPPER_OPENFGA_URL` and, with `--authn-method preshared`, `HOPPER_OPENFGA_KEY` (or `HOPPER_OPENFGA_KEY_FILE`).
  The key is read at each call: rotate it in OpenFGA and the runtime together.
- **Update OpenFGA** by changing the image tag in `compose.yaml` (`openfga-migrate` and `openfga` together), then
  `podman compose up -d`.
- **What the hopper keeps**: the approvals and the model are in its own database, so an emptied or new OpenFGA is
  filled again from it within 30 seconds; OpenFGA holds nothing only it knows.

### Minting short-lived credentials

The vault mints short-lived credentials for a box's job from a **minting credential** (issue #580, docs/design.md
"Minting: short-lived credentials"), and asks access before each one. It needs nothing beyond the stack above: the
hopper calls the AWS STS or the Kubernetes API that the minting credential names.

- **Kubernetes.** In the cluster, make a service account `hopper-<operation>` (`hopper-read`, `hopper-write`) in
  each namespace a template may reach, and in the namespace `hopper` for a whole cluster; bind each to the role you
  want for that operation (for `hopper-read`, the `view` cluster role). Make an identity whose token may only
  `create` on `serviceaccounts/token` for those service accounts. In Settings → Vault, set a secret with *Mints for*
  `cluster/<name>` and the value `{"server": "https://…:6443", "token": "…", "certificateAuthorityData": "<base64 PEM>"}`.
  Each token the hopper mints lives 10 minutes.
- **AWS.** Make an IAM user (or role) that may only `sts:AssumeRole` the roles templates may reach. In Settings →
  Vault, set a secret with *Mints for* `aws-account/<id>` and the value `{"AccessKeyId": "…", "SecretAccessKey": "…"}`
  (optional `Region`, and `Endpoint` for an STS other than AWS's). Each session lives 15 minutes; a `read` session
  carries the `ReadOnlyAccess` session policy.
- **The template** declares the operation profiles (`read` on `namespace/<cluster>/<ns>`, on `cluster/<name>` or on
  `aws-role/<id>/<role>`), and a person approves them on Settings → Vault. A minting credential is never given to a box,
  and no template lists it in its scope.
## Optional services

`compose.yaml` has required services and optional ones (issue #586). Nothing outside the stack is required.

- **Required**: `postgres`, `hopper`, `openfga` (and `openfga-migrate`, which runs once). A plain
  `podman compose up -d` starts only these, and the vault works: it runs in the hopper, under the token key.
- **Optional**: `hopper-vault`, `kms` and `vault`, each behind a compose profile of the same name. The hopper starts
  and works without them. No required service depends on them, and none is on a host port. `vault` is HashiCorp
  Vault, a vault backend ("Vault backends" below); the other two are here.

Turn them on with lines in the `.env` file beside `compose.yaml`, then run `podman compose up -d`:

| You want | `.env` lines |
|---|---|
| The vault in a container of its own | `COMPOSE_PROFILES=hopper-vault` and `HOPPER_VAULT_URL=http://hopper-vault:4791` |
| That, with a local KMS | `COMPOSE_PROFILES=hopper-vault,kms`, `HOPPER_VAULT_URL=http://hopper-vault:4791` and `HOPPER_KMS_URL=http://kms:8080` |
| A local KMS, with the vault in the hopper | `COMPOSE_PROFILES=kms` and `HOPPER_KMS_URL=http://kms:8080` |

Check: Settings → Vault (http://127.0.0.1:4790/#settings/vault) shows no problem. `podman compose ps` lists
`hopper-vault` and `kms` as running. To turn a service off, remove its lines and run
`podman compose up -d --remove-orphans`.

### The vault container (`hopper-vault`)

The hopper's vault runs in its own container, from the hopper's image (`node src/vault/main.ts`). It holds the vault's
key and the secret values, in the hopper's Postgres. Templates and their approvals, and secrets kept in a vault backend,
stay in the hopper. The hopper holds none of the vault's keys: it asks the vault at `HOPPER_VAULT_URL` with the
preshared key `HOPPER_VAULT_KEY`. The `postgres` service makes that key on its first start
(`vault_key` in the `secrets` volume). A stack from before gets it with the new `compose.yaml`: `podman compose up -d`
recreates `postgres` once.

- The vault keeps its write-only rule and every check of a delivery (docs/design.md "The vault in a container of its own").
- When the vault container is not running, the hopper still works. Settings → Vault says the vault is not reachable,
  a change answers 503, and a box's ask is refused.
- Its key: the token key, or the KMS's data key when `HOPPER_KMS_URL` is set. `HOPPER_TOKEN_KEY_PREVIOUS` in `.env`
  reaches it too (key rotation, "Rotating the token key").
- **Elsewhere** (not compose): run `node src/vault/main.ts` with `HOPPER_DATABASE_URL`, `HOPPER_TOKEN_KEY` and
  `HOPPER_VAULT_KEY` (each also `_FILE`), and optionally `HOPPER_KMS_URL`; `HOPPER_VAULT_PORT` moves its port (4791).
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
- When the KMS is down, the vault stores and delivers nothing and Settings → Vault says why. The vault container asks
  the KMS again at the next request; a vault in the hopper asks again at the next restart.
- local-kms checks no credentials. A KMS that checks them (AWS KMS) is not supported yet.

## Vault backends (optional)

The vault keeps its secrets itself. It can also keep a secret in HashiCorp Vault, 1Password or Bitwarden (issue #585,
docs/design.md "Vault backends"): the hopper then reads the value there each time a box's job asks, and keeps no copy.
None is needed: without one the hopper starts and its own vault works.

- **HashiCorp Vault in the compose stack**: `podman compose --profile vault up -d` starts the `vault` service beside the
  hopper. Its first start sets Vault up and makes a read-only token for the hopper, which the hopper reads as
  `VAULT_TOKEN_FILE`. Then:
  1. Settings → Plugins → Vault backends → add `hashicorp-vault`. Its defaults reach the service.
  2. Write a secret: `podman compose exec vault sh -c 'VAULT_TOKEN=$(cat /vault/keys/root_token) vault kv put secret/apps/db password=...'`.
  3. Settings → Vault → Add secret → Kept in: the backend, reference `apps/db#password`. Add it to a template and approve it.

  The unseal key and the root token are in the `vault-keys` volume, beside Vault's data: whoever can read that volume
  can open it. Keep a copy of `root_token` elsewhere if you need it. To stop using it: remove the backend in Settings →
  Plugins, then `podman compose --profile vault down` (add `-v` only to delete its secrets).
- **An outside HashiCorp Vault**: add `hashicorp-vault` with its `address` (and `mount`, `namespace`). Give a token that
  may read the secrets as `VAULT_TOKEN_FILE` in `.env` (a file you mount), or name another variable in the instance's
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
Secrets go in the same `daemon.env`.
Open the UI at `http://localhost:4790/` and sign in with GitHub: the first person to do so is the admin.

A managed Postgres works the same: put its URL (with `sslmode=require`) in `daemon.env`.

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
| containers (`compose.yaml`) | `.env` beside `compose.yaml` (mode 600) | a `secrets:` entry added to `compose.yaml`, then `<variable>_FILE=/run/secrets/<name>` in `.env`; or the secret's value in `.env` itself | `podman compose up -d` |
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

The repository has three long-lived branches, and they are the update channels (issue #423), least stable
first:

| Branch | What is on it | Who moves it, and when |
|---|---|---|
| `dev` | the default branch: every pull request, a job's included, merges here | each merge |
| `beta` | changes that ran on `dev` | a maintainer promotes, once a `dev` hopper has run the change without trouble |
| `stable` | changes that ran on `beta` | a maintainer promotes, once a `beta` hopper has run the change without trouble |

A **promotion** moves a commit up one step, and only through `scripts/promote.sh`, run by a maintainer in a
clone whose `origin` is this repository:

```sh
bash scripts/promote.sh beta [commit]     # a commit of dev (default: its head)
bash scripts/promote.sh stable [commit]   # a commit of beta (default: its head)
```

It refuses unless the commit is on the branch one step below (`stable` never takes a commit straight from
`dev`), the move is a fast-forward of the steadier branch, and the commit's image built on the branch below
(the `image` run, asked of `gh`). Then it pushes, as the maintainer, so the steadier branch's image build
starts. `beta` and `stable` therefore only ever hold what ran one step below; nothing is merged or committed
on them. A fix for something found on `beta` or `stable` lands on `dev` like any change and is promoted from
there. There is no schedule and nothing promotes on its own: the maintainer decides.

**A change with a store migration.** Moving a hopper to a steadier channel installs that channel's head,
which can be older than the build that already migrated its database. So a migration must leave a store
the build before it still runs on: add tables, columns and values; never drop, rename or reshape what the
older build reads, until that older build is on no channel any more (it has been promoted past `stable`).
A value an older build does not know is skipped by it, as an unknown update channel is. Promote such a
change one step at a time, and check each step's hopper starts and runs a job before the next. A build stops at
the start on a store whose schema version is above its own, naming both versions (issue #527): run that newer
release again, or restore a backup of the database from before it. Builds from before that check run on such a
store without a word, which is why the rule above holds.

What each push publishes: `.github/workflows/image.yml` builds the image tag of the branch's name
(`stable` also moves `latest`); `.github/workflows/pages.yml` publishes the Pages site, its `install.sh` and
its `compose.yaml` from `stable` only.

A hopper picks its channel in Settings → Version (dev, beta, stable); it takes effect without a restart.
An install from `scripts/install.sh` or the curl install starts on the branch it was installed from
(`HOPPER_SOURCE_REF`, default `stable`). An image is replaced by its user pulling the tag of its channel
(`HOPPER_IMAGE`, "In containers, with Podman", "Upgrade"): the channel picked in Settings → Version only
decides what the update check compares against.

**From before.** The channels were `dev`, `beta`, `main` and `release`. A hopper set to `main` or `release`
is set to `stable` when it starts on a version with these channels (store migration 26). Once that version
reached `stable`, `main` was moved to it one last time, so a hopper still on an older version, which follows
`main`, updates once to it and from then on follows `stable`. Nothing is promoted to `main` after that. No release tag was ever published, so a hopper on `release` had nothing to update to: choose
a channel in its Settings, or install again.

## Rename from job-hopper

The product was called job-hopper (issue #112). An install from before keeps its config, secrets and
database, and runs as hopper; `docs/design.md` "Rename from job-hopper" says what moves.

- **This host, self-update on:** nothing to do. The update moves the install once no job holds a pane in
  herdr session `job-hopper`; until then the update notice says which jobs it waits for, and the old
  daemon runs on. Auto-update takes it at the first check after; else Update now.
- **This host, by hand:** run the curl install or `bash scripts/install.sh` from a clone, as for any
  upgrade. With a job holding a pane it stops, names the jobs, and leaves the old daemon running: run it
  again once they finish.
- **A container:** rename every `JOB_HOPPER_*` variable in `deploy/hopper.env` to `HOPPER_*`; the daemon
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
needs docker), each test in its own schema; `HOPPER_TEST_POSTGRES_URL=postgres://…` uses an
existing database instead.

**Agent boxes** (`docs/design.md` "Agent boxes"): `bash scripts/agent-boxes.sh` starts one container per
agent CLI (claude, codex, cursor, omp, opencode), each an ssh target with its own herdr session, and
attaches every one to the hopper, running its agent's executor. It finds the hopper itself: the compose
container (the boxes join its network; nothing to copy, no database to reach) or, with
`HOPPER_DATABASE_URL`, one installed here. Run it again any time: it puts every box back as it should be.
`--sign-in` signs in the agents not signed in yet (opencode needs none); `ssh -t hopper-box-<agent>` opens
a terminal there. `--check` proves the hopper in its container reaches every box: ssh as the hopper,
the box's herdr session running, its agent CLI answering — one line per box, exit 1 on any failure.
`--remove` takes them away again.
