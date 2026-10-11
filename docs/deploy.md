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
| Credentials the hopper is given | for outside services, from the runtime (docs/design.md "Secrets"): each one the variable `NAME`, or the mounted file the variable `NAME_FILE` names (never both) — `GITHUB_APP_PRIVATE_KEY`, `GROKBOT_WEBHOOK_URL`, `GROKBOT_WEBHOOK_KEY` (with the user's secret prefix, `HOPPER_USER_<ID>_`, as Settings → Plugins names them; as `_FILE` they can change without a restart), a realm's secrets only when the realm is set up from the environment (`HOPPER_SIGN_IN_REALM_<NAME>_CLIENT_SECRET`, docs/sign-in.md "Sign-in from the environment"; typed in Settings otherwise, and stored); `CLAUDE_CODE_OAUTH_TOKEN` for the claude CLI where its own login is not on the machine (a variable only: the CLI reads it). A job holds no GitHub token: its `git` and GitHub steps go through the hopper, which uses the connected account's token (docs/design.md "Git through the hopper"). A leftover `HOPPER_SECRET_KEY` line: delete it. |
| Secrets the hopper owns, and the master key | kept in the database, encrypted under the **master key** `HOPPER_MASTER_KEY` (32 bytes, `openssl rand -hex 32`): the vault secrets, and the hopper's own secrets in the vault's system scope — each webhook's signing secret, the connected account's tokens, each sign-in realm's client secret or bind password, each user's TypeSafe API key —, listed with an audit trail on Settings → Vault and never given to a job. Given at launch as a variable, never from a file or a volume: "The master key" below. |
| Process settings | `HOPPER_*` variables: port, LAN names and peers, public URL, tick, limits (`src/config.ts`). |
| Plugins | Optional. `HOPPER_PLUGIN_DIR` (plugins put there by hand; a container mounts it read-only) and `HOPPER_PLUGIN_STORE` (seeds the plugin store setting on a hopper that never had one set; the plugin store is set in the UI, Plugins → Plugin store, and defaults to the one the Pages site publishes: docs/plugins.md). Store installs are kept in the database and restored into the work dir at start: they need no plugin dir and no volume. |
| Config | the plugins, rules and sign-in configs and the webhook subscriptions, all in the database, all edited in the UI (Settings → Plugins, Settings → Question gates, Settings → Sign-in, Settings → Webhooks); no config file. The first boot writes the built-in plugins config. |
| GitHub | each user's GitHub sign-in, the **connected account** (default; sign in with GitHub, or Sources → Connect GitHub, then choose the job repositories in Sources), or a GitHub App an admin creates for this hopper with `scripts/create-github-app.sh` (its key in `GITHUB_APP_PRIVATE_KEY`). Each hopper has its own App and key; there is no shared one. No gh CLI source and no gh login since issue #359. Setting up either: `README.md` "Connect GitHub". |
| Where jobs run | machines: this host's herdr session (`hopper-herdr`; not in a container, issue #141), and attached machines, instances in the plugins config's machine sources (Settings → Plugins → Machine sources, or the Machines view) — `client` targets (a computer or a sandbox box, joined with one line), `ssh` targets, `docker` container targets. Setting each one up, step by step: `README.md` "Add machines". |

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
variable `HOPPER_MASTER_KEY`. It is never read from a file or a volume: a container is ephemeral, and a key
kept beside it is lost with it. No KMS gives the master key: `HOPPER_KMS_URL` changes only the key of the vault's
own secrets (`docs/design.md` "A KMS as the master key's source: not built").

**Keep the master key in a password manager.** Without it, a new container on the same database opens none
of the secrets. Keep it apart from the database's backups: a backup with its key beside it holds every secret.

- **First start.** With no key and a database that keeps no secret, the hopper makes a key. It shows the key
  once in the UI, to the hopper's admin (**Show the key (once)**). The key never goes to the log: the start log
  says only where the key came from and its fingerprint (`master key: made for this new hopper (generated),
  fingerprint <16 hex digits>`). The banner stays until the admin clicks **I saved it**. Then give the key at each launch:
  - compose: add `HOPPER_MASTER_KEY=<the 64 hex digits>` to `.env`, then
    `podman compose up -d --force-recreate --no-deps hopper`;
  - host install: add `HOPPER_MASTER_KEY=<the 64 hex digits>` to `~/.config/hopper/daemon.env`, then
    `systemctl --user restart hopper`;
  - any other runtime: set the variable `HOPPER_MASTER_KEY` in the container's or service's environment.
- **A wrong key.** The hopper does not start: `the master key does not match this database`. Nothing in the
  database changes. Give the right key.
- **No key, while the database keeps secrets.** The hopper starts **limited**. The log (`LIMITED`) and a
  banner name the missing key by its fingerprint. Nothing is deleted. Nothing that needs a secret works: no
  secret is stored or opened, and no new GitHub token is kept. Do not connect GitHub again: give the key and
  restart.
- **Moving from the old token key.** An install from before kept its key in the compose `secrets` volume
  (`token_key`) or as `HOPPER_TOKEN_KEY` in `daemon.env`. While `HOPPER_MASTER_KEY` is unset, a host install reads
  `HOPPER_TOKEN_KEY`, checks it against the secrets it keeps, and shows it once in the UI to be saved. Give it as
  `HOPPER_MASTER_KEY`, and restart. The log then says the old key is not read and can be removed: delete the
  `HOPPER_TOKEN_KEY` line. The compose file no longer mounts the `secrets` volume or reads its `token_key`: save the key
  from the UI and put it in `.env` **before** you update (the update script refuses until then). A compose install
  that updated without it starts limited, and nothing is lost: the key is still in the old volume. Read it once,
  put it in `.env` as `HOPPER_MASTER_KEY`, and recreate the hopper:
  `podman run --rm -v hopper_secrets:/s:ro docker.io/library/alpine:3 cat /s/token_key`. Once the hopper starts with
  the key, remove the old volume: `podman volume rm hopper_secrets` (with the stack stopped, or after
  `podman compose up -d --remove-orphans`).

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

**With one command** (issue #659): the hopper's admin rotates the key from Settings → Vault → Master key → **Rotate the
master key**, or from the operator CLI: `hopper master-key rotate` (in compose:
`podman compose exec hopper hopper master-key rotate`). The hopper makes a new key and seals every secret it keeps
again under it, in one transaction: if anything fails, nothing changes. The running hopper goes on under the new key,
with no restart. The new key is shown once — in the UI banner, or in the command's answer (`key`) —, never in the log.

1. Save the new key in your password manager now.
2. Put it in place of the old one at launch, before the next start: in compose, `HOPPER_MASTER_KEY=<the new key>` in
   `.env`; on a host install, in `~/.config/hopper/daemon.env`. A start with the old key is refused: `the master key
   does not match this database: it was rotated …`. Nothing changes then: give the new key.
3. Click **I saved it** in the banner. Delete the old key from your password manager and from every place it was
   written.

The answer also says how many secrets were sealed again (`resealed`), and how many the old key sealed that do not open
(`unreadable`, left as they were; they did not open before either). With the vault in a container of its own
(`HOPPER_VAULT_URL`), the command is refused: that container keeps the key it started with. Rotate at launch instead:

**At launch** (the vault in a container of its own, or a key you made yourself):

1. Make a new key: `openssl rand -hex 32`. Save it in your password manager.
2. Give it as `HOPPER_MASTER_KEY`, and the old one as `HOPPER_MASTER_KEY_PREVIOUS` (one per line). In
   compose: both in `.env`.
3. Restart the hopper. Every secret the hopper keeps for itself is sealed again under the new key; the log says how
   many (`system secret(s) sealed again under the current HOPPER_MASTER_KEY`, and the same for the sign-in realms').
4. Remove `HOPPER_MASTER_KEY_PREVIOUS` and restart again.

With compose (`podman compose`, or `podman-compose` directly: the commands are the same), in the directory of
`compose.yaml` and `.env`:

```sh
# 1. The current key's fingerprint, to compare at the end.
podman-compose exec hopper hopper master-key status
# 2. The new key, with the old one as the previous key. Keep the new key in your password manager first.
#    Edit .env: set HOPPER_MASTER_KEY=<the new 64 hex digits>, and add HOPPER_MASTER_KEY_PREVIOUS=<the old key>.
# 3. Recreate the hopper (and the vault container, when the hopper-vault profile is on) with the new .env.
podman-compose up -d --force-recreate --no-deps hopper
podman-compose up -d --force-recreate --no-deps hopper-vault   # only with COMPOSE_PROFILES=hopper-vault
podman-compose logs hopper | grep 'sealed again'
podman-compose exec hopper hopper master-key status            # the new fingerprint, "previous": true
# 4. Remove the HOPPER_MASTER_KEY_PREVIOUS line from .env, then recreate again.
podman-compose up -d --force-recreate --no-deps hopper
podman-compose exec hopper hopper master-key status            # "previous": false
```

Then delete the old key from your password manager, and from every place it was written. A `.env` edit does not reach
a running container: `--force-recreate` does. A plain `restart` keeps the old environment.

The connected account's tokens are among them: no new GitHub sign-in. A secret that neither key opens is named at
start (`start check: system secret <name> cannot be opened: …`) and on Settings → Vault.
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

**Save the master key now.** The first start makes the master key and shows it once, in the UI banner, to the admin
(**Show the key (once)**). It is never in `podman compose logs hopper`: the log has only its fingerprint. Put it in
your password manager. Then add it to `.env` beside `compose.yaml` and recreate the hopper:

```sh
echo 'HOPPER_MASTER_KEY=<the 64 hex digits>' >> .env
podman compose up -d --force-recreate --no-deps hopper
```

Without it, a new container on the same database is limited ("The master key" above). No volume holds it.

| service | |
|---|---|
| `postgres` | the database (`POSTGRES_PASSWORD_FILE`), on no host port; data in the `postgres` volume. Before it starts, it makes a random database password and the database URL from it, and OpenFGA's and the vault container's preshared keys, in `runtime-secrets`, and sets the password again once it takes connections. Each file is readable only by the one service that uses it. Nobody types or keeps the password. |
| `hopper` | the image `HOPPER_IMAGE` names (default `ghcr.io/henningfutrell/hopper:latest`). `HOPPER_DATABASE_URL_FILE` from `runtime-secrets`. Its home, `/home/node`, is the `home` volume: the claude sign-in and git's identity. |
| `openfga-migrate` | brings OpenFGA's tables in the `openfga` schema up to its version, then exits; retries until postgres has made the schema. Nothing depends on it ("Access: OpenFGA" below). |
| `openfga` | OpenFGA, which access asks before every credential a job is given; on no host port, behind a preshared key `postgres` makes. |

No secret is in a persistent volume (issue #659). `runtime-secrets` is in memory (tmpfs): the services share it while
any of them runs, it is gone after a full stop, and `postgres` makes its files again at the next start. The master key
is only in `.env`.

- **The container is not a machine** (issue #141). The image sets `HOPPER_LOCAL_MACHINE=false`: no
  `local` machine, and the boot removes one an earlier version wrote into the plugins config. Jobs run on
  attached machines (`README.md` "Add machines"); the image carries herdr's CLI for them. The Machines
  view offers no **Add this machine** here. To run jobs on the computer the container runs on, use
  **Add machine** → *A computer*, and run the line it shows there (issue #308, `README.md` "A computer
  or a sandbox box: one line"): the computer dials in to the published port, so nothing is set up
  inside the container and nothing leans on a `~/.ssh` (issue #293). *A sandbox box* starts a
  locked-down container on the compose network `hopper_default`, which reaches the hopper as
  `http://hopper:<port>` — the compose file's `HOPPER_LAN_NAMES` and `HOPPER_LAN_PEERS` defaults let it
  through. The box keeps no copy of the join code (issue #606): its entrypoint moves `HOPPER_JOIN` into a
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
  flag. Or, for Claude Code, `CLAUDE_CODE_OAUTH_TOKEN` in `.env`: every job's Claude gets it, and the hopper seeds
  Claude's config in an empty home, so a job starts with no first-run screen. A job gets no GitHub token: its git
  and GitHub steps go through the hopper, with the connected account (docs/design.md "Git through the hopper"). Who jobs commit as: `git config --global` in the container, or the
  `GIT_AUTHOR_*`/`GIT_COMMITTER_*` variables in `.env`.
- **Settings and secrets: `.env` beside `compose.yaml`**, optional (`.env.example`, mode 600). Compose
  reads it for the file's own variables and passes all of it to the hopper.
- **The UI** is published on this computer's loopback, `127.0.0.1:${HOPPER_PORT:-4790}`, the same port
  inside and out. `HOPPER_BIND` in `.env` names another address: `HOPPER_BIND=0.0.0.0` publishes it on every
  interface, for a LAN install (issue #697). Those requests reach the daemon from the compose network, so they are LAN requests:
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
  and Settings → Version give the commands below with the selected channel's tag.
  - **The channel is the image tag.** `HOPPER_IMAGE=ghcr.io/henningfutrell/hopper:<channel>` in `.env` beside
    `compose.yaml`, where `<channel>` is the channel picked in Settings → Version: `dev`, `beta` or `stable`.
    Unset, it is `:latest`, the same image as `:stable`. A container on `:latest` with the channel set to `dev`
    never reaches `dev`'s head by pulling, so the notice says "this container runs the `stable` image; the
    selected channel is `dev`: switch the image tag". **Switch channels** by running the update below with the
    channel's image (it sets `HOPPER_IMAGE`); pick the same channel in Settings → Version.
  - **Before you update, check that `.env` holds `HOPPER_MASTER_KEY`.** The new container gets the key only from
    there. An install from before keeps it in the old `secrets` volume's `token_key`, which the new compose file does
    not read: save the key the UI shows, and put it in `.env` first ("The master key" above). The update script
    refuses until then.
  - **Update with the compose file the new image ships with, the whole stack** (issue #697). Every image carries
    the `compose.yaml` of its commit. In the folder that holds `compose.yaml`, make the update script from the image of
    the channel, read it, then run it:

    ```sh
    podman run --rm --pull=always ghcr.io/henningfutrell/hopper:<channel> hopper update podman > hopper-update.sh   # Podman
    docker run --rm --pull=always ghcr.io/henningfutrell/hopper:<channel> hopper update docker > hopper-update.sh   # Docker
    sh hopper-update.sh
    ```

    (`hopper update podman-compose` for podman-compose without `podman compose`; `--image <ref>` for another image.)
    In order, the script:
    1. stops when `.env` lacks `HOPPER_MASTER_KEY` and the running hopper made its key at this start (a recreate
       would lose it);
    2. backs up the database (`hopper-backup-<time>.dump`, `pg_dump -Fc`), `compose.yaml` (as
       `compose.yaml.bak-<commit>`) and `.env`;
    3. pulls the image;
    4. moves the install's own settings from the old `compose.yaml` to `.env` — the published port's address
       (`HOPPER_BIND`), the port, and `HOPPER_*` settings written into the file —; sets `HOPPER_IMAGE` to the image;
       and moves what `.env` cannot hold to `compose.override.yaml`: a service of the install's own with the volumes it
       names, a host folder mounted into a service, a key of a service the hopper never sets, and the project name when
       the install gave its own (another one would start the stack on new, empty volumes). It adds to an existing
       `compose.override.yaml` (kept as `compose.override.yaml.bak-<commit>`), keeps its comments, replaces nothing it
       has, and shows the change. A service the hopper once shipped and no longer does is dropped, and said so;
    5. puts in the image's `compose.yaml`, stamped `# hopper version: <branch> <commit>`, and shows the change;
    6. pulls the images of the whole stack and recreates it (`up -d --force-recreate`, never `--no-deps hopper`);
    7. checks that the hopper and OpenFGA answer.

    It stops at the first step that fails and says how to go back: put back `compose.yaml.bak-<commit>`,
    `.env.bak-<commit>` and `compose.override.yaml.bak-<commit>` (or remove a `compose.override.yaml` it made), then
    `podman compose up -d --force-recreate`.
  - **Never update the hopper's container alone** (`pull hopper`, `up -d --no-deps hopper`). It keeps the old
    compose file: a version that adds a required service (OpenFGA, issue #559) or a setting never gets it, and
    features fail. **Never edit `compose.yaml`**: each update replaces it whole. Put your own settings in `.env`
    (`HOPPER_IMAGE`, `HOPPER_MASTER_KEY`, `HOPPER_BIND`, `HOPPER_PORT`, `HOPPER_LAN_NAMES`, `HOPPER_PUBLIC_URL`, …) or in
    `compose.override.yaml`, which compose reads beside it.
  - **The hopper checks its stack** (issue #697). At start, and each minute while the UI is open, a container hopper
    compares the stack it runs in with the compose file of its own version: each service that must run (no profile,
    or one `COMPOSE_PROFILES` in `.env` turns on), by its name on the compose network; the settings that file gives the
    hopper's container; and the version `hopper-vault` runs. A gap is logged at start and shown in a banner over every
    view: what is missing, what is off until then, and the fix — the update script made from the image the hopper runs.
    `GET /api/update/drift` answers the same (`StackDrift`). It sees only from inside its container: a service of the
    install's own, and the versions of OpenFGA and Postgres, are not compared.
  - **An agent that updates a hopper** follows the update skill: `GET /api/update/skill` on the running hopper, or
    `podman run --rm <image> hopper update skill`. `GET /api/update/compose` answers the compose file the running
    build ships with, and its version.
  - **From a beta install on an old compose file** (one without `openfga`): run the update above once. It keeps
    a LAN install's `0.0.0.0` as `HOPPER_BIND=0.0.0.0` in `.env`, moves its own services and mounts (a container
    socket for boxes, say) to `compose.override.yaml`, adds OpenFGA, and keeps the old files as the backups. Until then
    the stack banner names the gaps.
    An image from before this change has no `hopper update`: make the script from the new image, as above.
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
other fix is a link base that the machine reaches: set `HOPPER_PUBLIC_URL` in `.env`, then recreate the hopper.

**Fallback: a seat in another Podman engine** (a rootful Podman, or another user's rootless one). Such a container
cannot join `hopper_default`. It can reach the hopper through `host.containers.internal`, but only on an address the
port is published on. The hopper publishes its port on `127.0.0.1` only, which the gateway does not reach. To use the
fallback:

1. In that engine, find the address `host.containers.internal` names:
   `podman run --rm docker.io/library/alpine:3 getent hosts host.containers.internal`.
2. Publish the port on that address too, in a `compose.override.yaml` beside `compose.yaml` (compose adds it to the
   loopback port; with `compose.sandboxes.yaml` already saved there, add the lines to that file):

   ```yaml
   services:
     hopper:
       ports:
         - "<that address>:4790:4790"
   ```

3. Add the name to the hopper's LAN names in `.env`: `HOPPER_LAN_NAMES=hopper,host.containers.internal`. The seat's
   address must be in `HOPPER_LAN_PEERS` (by default, the private ranges).
4. `podman compose up -d`. The next probe finds `http://host.containers.internal:4790`, and the seat's jobs use it.

Publish on that address only, never on every interface: the port then stays off the LAN.

## Access: OpenFGA

Access (OpenFGA) decides each mint and each renewal, each shared-secret read and each vault grant (issue #559,
docs/design.md "Access: OpenFGA decides each mint"). With no OpenFGA, or one the hopper cannot reach, the vault mints
nothing, gives no shared secret, and nobody can grant a job the vault; Settings → Access says why. Intake asks it too (`intake#can_start_jobs`): without
OpenFGA no login is a trusted actor, every issue is a request card, and Approve and Accept the new text are refused.

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
- **Upgrade from an older `compose.yaml`** (a beta install from before issue #559 has no `openfga` service): do not
  copy services into it. Run the update ("In containers, with Podman" → Upgrade, issue #697): it puts in the
  `compose.yaml` the image ships with, which has OpenFGA, keeps your own settings in `.env`, and starts the whole
  stack. The banner goes within a minute of OpenFGA answering.

### Minting short-lived credentials

The vault mints short-lived credentials for a box's job from a **minting credential** (issue #580, docs/design.md
"Minting: short-lived credentials"), and asks access before each one. It needs nothing beyond the stack above: the
hopper calls the AWS STS or the Kubernetes API that the minting credential names.

- **Kubernetes.** In the cluster, make a service account `hopper-<operation>` (`hopper-read`, `hopper-write`) in
  each namespace a template may reach, and in the namespace `hopper` for a whole cluster; bind each to the role you
  want for that operation (for `hopper-read`, the `view` cluster role). Make an identity whose token may only
  `create` on `serviceaccounts/token` for those service accounts. In Settings → Vault, set a secret with *Mints for*
  `cluster/<name>` and the value `{"server": "https://…:6443", "token": "…", "certificateAuthorityData": "<base64 PEM>"}`.
  Each token the hopper mints lives 10 minutes. For read on a whole cluster, this sets up both service accounts in the
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
  rules: [{ apiGroups: [""], resources: [serviceaccounts/token], resourceNames: [hopper-read], verbs: [create] }]
  ---
  apiVersion: rbac.authorization.k8s.io/v1
  kind: RoleBinding
  metadata: { name: hopper-minter, namespace: hopper }
  roleRef: { apiGroup: rbac.authorization.k8s.io, kind: Role, name: hopper-minter }
  subjects: [{ kind: ServiceAccount, name: hopper-minter, namespace: hopper }]
  ```

  Then `kubectl -n hopper create token hopper-minter --duration=8760h` gives the minting credential's `token`; renew it
  before it expires.
- **AWS.** Make an IAM user (or role) that may only `sts:AssumeRole` the roles templates may reach. In Settings →
  Vault, set a secret with *Mints for* `aws-account/<id>` and the value `{"AccessKeyId": "…", "SecretAccessKey": "…"}`
  (optional `Region`, and `Endpoint` for an STS other than AWS's). Each session lives 15 minutes; a `read` session
  carries the `ReadOnlyAccess` session policy. The hopper names each session `hopper-<job id>`. When the role's trust
  policy allows only one session name (a condition on `sts:RoleSessionName`), add `"SessionName": "<that name>"` to
  the value; when it allows a prefix (`StringLike`, `ci-*`), add `"SessionNamePrefix": "ci-"`, and the hopper names
  each session `ci-<job id>`. Then the IAM role needs no change. To check it before a job needs it, run
  `hopper vault mint-test aws-role/<id>/<role>`: the hopper mints a read session (named `hopper-mint-test`,
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

  3. In Settings → Vault, set a secret with *Mints for* `aws-account/<id>` and the access key as its value, as above.
  4. Check it: `hopper vault mint-test aws-role/<id>/hopper-read`.

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
- **The template** declares the operation profiles (`read` on `namespace/<cluster>/<ns>`, on `cluster/<name>` or on
  `aws-role/<id>/<role>`), and a person approves them on Settings → Vault. A minting credential is never given to a box,
  and no template lists it in its scope.
- **A vault grant** is needed too: a job gets a minted credential only after a person grants it the vault
  (Settings → Vault, Vault grants).
- **The read-only check** (issue #797) uses the same minting credentials: before a check box of a template of read
  needs starts, the hopper mints a read session for each `aws-role` and a `hopper-read` token for each cluster or
  namespace, and the box's probes run with them. A need with no minting credential fails the check and says which one
  to add. The AWS session is named `hopper-read-only-check` (or `<prefix>read-only-check`, or the fixed `SessionName`).
  Set `Region` in an AWS minting credential when the account's services are not in `us-east-1`.
## Optional services

`compose.yaml` has required services and optional ones (issue #586). Nothing outside the stack is required.

- **Required**: `postgres`, `hopper`, `openfga` (and `openfga-migrate`, which runs once). A plain
  `podman compose up -d` starts only these, and the vault works: it runs in the hopper, under the master key.
- **Optional**: `hopper-vault`, `kms`, `vault` and `tunnel`, each behind a compose profile of the same name. The hopper
  starts and works without them. No required service depends on them, and none is on a host port. `vault` is HashiCorp
  Vault, a vault backend ("Vault backends" below); the others are here.

Turn them on with lines in the `.env` file beside `compose.yaml`, then run `podman compose up -d`:

| You want | `.env` lines |
|---|---|
| The vault in a container of its own | `COMPOSE_PROFILES=hopper-vault` and `HOPPER_VAULT_URL=http://hopper-vault:4791` |
| That, with a local KMS | `COMPOSE_PROFILES=hopper-vault,kms`, `HOPPER_VAULT_URL=http://hopper-vault:4791` and `HOPPER_KMS_URL=http://kms:8080` |
| A local KMS, with the vault in the hopper | `COMPOSE_PROFILES=kms` and `HOPPER_KMS_URL=http://kms:8080` |
| The API reached from anywhere, through an ngrok tunnel | `COMPOSE_PROFILES=tunnel`, `NGROK_AUTHTOKEN`, `HOPPER_PUBLIC_URL` and `HOPPER_TUNNEL_API=http://tunnel:4040` ("The tunnel" below) |

Check: Settings → Vault (http://127.0.0.1:4790/#settings/vault) shows no problem. `podman compose ps` lists
`hopper-vault` and `kms` as running. To turn a service off, remove its lines and run
`podman compose up -d --remove-orphans`.

### The vault container (`hopper-vault`)

The hopper's vault runs in its own container, from the hopper's image (`node src/vault/main.ts`). It holds the vault's
key and the secret values, in the hopper's Postgres. Templates and their approvals, and secrets kept in a vault backend,
stay in the hopper. The hopper holds none of the vault's keys: it asks the vault at `HOPPER_VAULT_URL` with the
preshared key `HOPPER_VAULT_KEY`. The `postgres` service makes that key on its first start
(`vault_key` in `runtime-secrets`). A stack from before gets it with the new `compose.yaml`: `podman compose up -d`
recreates `postgres` once.

- The vault keeps its write-only rule and every check of a delivery (docs/design.md "The vault in a container of its own").
- When the vault container is not running, the hopper still works. Settings → Vault says the vault is not reachable,
  a change answers 503, and a box's ask is refused.
- Its key: the master key, or the KMS's data key when `HOPPER_KMS_URL` is set. `HOPPER_MASTER_KEY_PREVIOUS` in `.env`
  reaches it too (key rotation, "Rotating the master key").
- **Elsewhere** (not compose): run `node src/vault/main.ts` with `HOPPER_DATABASE_URL`, `HOPPER_MASTER_KEY` and
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

### The tunnel (`tunnel`)

An ngrok agent forwards the hopper's public URL to its API (issue #795). An agent that acts for you (Grok Bot) then
reaches the hopper from anywhere, with an API token ("API tokens" in docs/design.md). This machine needs no inbound port
and no public address: the agent dials out to ngrok. The hopper tells your Grok Bot routine where it is reached.

1. In the ngrok dashboard (https://dashboard.ngrok.com/domains), reserve a domain. Copy your authtoken from
   https://dashboard.ngrok.com/get-started/your-authtoken.
2. Add these lines to `.env`, beside `compose.yaml`:
   ```
   COMPOSE_PROFILES=tunnel
   NGROK_AUTHTOKEN=<your authtoken>
   HOPPER_PUBLIC_URL=https://<the reserved domain>
   HOPPER_TUNNEL_API=http://tunnel:4040
   ```
   Keep other profiles in the same line, comma-separated (`COMPOSE_PROFILES=hopper-vault,tunnel`).
3. Run `podman compose up -d`.

Check: `podman compose logs hopper` shows `the tunnel is up: https://<the reserved domain>`.
`curl -s -o /dev/null -w '%{http_code}\n' https://<the reserved domain>/api/jobs` answers `401` (the API, with no
token) and `https://<the reserved domain>/` answers `404` (the UI is not on the tunnel).

What it does, and what it keeps out:

- **Its own network.** The tunnel forwards to `http://hopper:<port>` over the `hopper_tunnel` network, which only the
  hopper shares. It never forwards to the hopper's loopback: an internet request is a **public request**, which reads
  the API only with a session or an API token. No box the hopper starts is on that network, so none reaches the ngrok
  agent's local API.
- **Only the API at the edge.** ngrok answers `404` for every path but `/api/`, `/ui/api/` and `/ui/auth/api-token`,
  and for the event stream (`/api/events/stream`, whose session is in the query). The UI, its sign-in pages and the
  installer stay off the internet.
- **A limit per caller at the edge.** 120 requests a minute per address, and 5 API-token exchanges a minute per address.
- **A limit per caller in the hopper.** The edge names each caller's address to the hopper (`x-hopper-caller`, after it
  drops one the caller sent). The hopper reads that header only from the ngrok agent, so its sign-in limit (20 a minute,
  the API-token exchange on its own count) counts each caller. A stranger cannot use up your agent's exchanges.
- **The URL must be fixed.** The Host guard takes `HOPPER_PUBLIC_URL` only. A random URL that changes at each start
  does not pass it: the log says so (`the tunnel's endpoint is not HOPPER_PUBLIC_URL`), and nothing is announced.
- **Grok Bot is told.** While the tunnel is up, the Grok Bot routine gets `hopper.reachable` with the URL: at start,
  when the tunnel comes back, and every 5 minutes (docs/design.md "Grok Bot routine webhook").
- **No box action without a box token.** The token an agent gets for its own sign-in reads, holds and cancels. To let it
  start jobs, answer questions, merge, update or change a machine, mint a box token for it in Settings → API tokens (tick
  Box token), for an hour at most (docs/design.md "Box tokens").

Residual risk, stated: callers behind one address (a NAT, a shared egress) share one count of each limit. The ngrok log
shows the authtoken when ngrok refuses it.

To turn it off: remove the four lines and run `podman compose up -d --remove-orphans`.

## Sandbox boxes the hopper starts

Optional (issues #603, #708). Give the hopper your rootless Podman socket, and it starts, stops and removes sandbox
boxes itself. Without it, Add machine → *A sandbox box* shows a line that you run. The line carries the same sandbox
flags as the boxes the hopper starts: one builder makes both. Its CPUs and memory start at the template's defaults
(the hopper's for a box of no template); change them before *Show the line*, within the template's max.

**Requirement: a rootless runtime.** Podman is the default whenever it is reachable. Rootless Docker works too, through
the Docker Engine API (never the docker CLI): `HOPPER_DOCKER_SOCKET` names its socket, used when no Podman socket is
given or Podman is not reached, or always with `HOPPER_SANDBOX_RUNTIME=docker`. The hopper refuses a rootful socket of
either (root on the computer), and an image that runs as root.

Turn it on, in the directory of `compose.yaml`:

```sh
systemctl --user enable --now podman.socket
curl -fsSL https://henningfutrell.github.io/hopper/compose.sandboxes.yaml -o compose.override.yaml
podman compose up -d
```

Saved as `compose.override.yaml` beside `compose.yaml`, it is read with `compose.yaml` by every compose command
(`podman compose`, `podman-compose`, `docker compose`), with no flag. It mounts `$XDG_RUNTIME_DIR/podman/podman.sock` into the hopper at `/run/podman/podman.sock`,
sets `HOPPER_PODMAN_SOCKET` to that path, and adds group 0 to the hopper's user: in a rootless container, group 0 is
your own group, which may open the socket (`podman.socket` makes it mode 0660). A hopper on this host (not in a
container) needs only `HOPPER_PODMAN_SOCKET=$XDG_RUNTIME_DIR/podman/podman.sock` in its environment.

What the hopper then does:

| When | The hopper |
|---|---|
| A person adds a sandbox box (Machines → Add machine → *A sandbox box* → **Start the box**) | writes a sandbox record, then starts the container `hopper-sandbox-<agent>` (or `hopper-sandbox-<template>`, with `-2`, `-3`, … when taken) with the sandbox flags, the resource limits of the launch (what the person set under *A sandbox box*, within the template's maximums; it starts at the template's defaults, or 4 CPUs and 8 GiB for a box of no template; a template's defaults and maximums are set on its form in Settings → Vault), its home the volume `<name>-home`, and a join code minted for it. Then it runs the box's start check: from inside the box, the box fetches the hopper at its address. Until that passes (at most 30 seconds), the launch does not answer; if it does not pass, the launch fails with what the check wrote and removes the box. The box joins as that machine, and its record is then *ready*. A template's box runs only once its image is approved (Settings → Vault). |
| A box has tools (a template's, or `--tool` on a launch) | first builds the image with them added through the same runtime, once per base image and set of tools, as `localhost/hopper-box-tools:<hash>`. The build fetches each tool from its own release and checks its SHA-256, so the runtime needs network access to awscli.amazonaws.com, get.helm.sh, dl.k8s.io, releases.hashicorp.com, Docker Hub and Debian's mirrors. Old tools images stay in the runtime's storage: `podman image prune` or `podman rmi` removes them. |
| A person removes that machine | stops the container and removes it within about 20 seconds, and its record. Its home volume stays, so a box of that name later keeps its sign-in, unless the template's limits say `keepHome: false`. `/tmp` in the box is a tmpfs: it goes with the container. |
| A box's time limit passes (a template's `ttlMinutes`, or the launch's) | stops the container and removes it, and its record. The home volume stays, as above. A box of no template has no time limit unless the launch names one. |
| The hopper starts | reads its sandbox records and the boxes it started (label `io.hopper.box` = its instance id). A box of its own with no record that a machine names (one started before the records) is taken on as a record; one that no machine names and no live join code waits for is removed, its home volume kept. A box another hopper started is left alone. |
| It cannot stop or remove a box | shows the box and the reason on Machines, under *Sandbox boxes not removed*, and tries again every 10 seconds. |
| Every 10 seconds | runs each box's start check again, in the box. A box that cannot reach the hopper is shown on Machines, under *Sandbox boxes that cannot reach the hopper*, with what the check wrote, and the hopper logs it once. It is ready again when its check passes. |

The sandbox network is `hopper_default` for the hopper in its container and `host` for a hopper on the host;
`HOPPER_SANDBOX_NETWORK` names another (a compose project of another name: `<project>_default`). On the host network,
a box reaches the hopper at `http://127.0.0.1:<port>`. Else the hopper reads its own container's names on that network
and takes the first that is also in `HOPPER_LAN_NAMES`: on the compose network that is `hopper`, which compose.yaml
sets. When the hopper's container is not on that network, or none of its names there is in `HOPPER_LAN_NAMES`, Add
machine says so and what to do, and starts nothing. A hopper on the host with another network uses its first
`HOPPER_LAN_NAMES` name, and the start check says whether a box there reaches it.

When a launch fails with `the hopper does not answer at <address>`, the rest of the line is curl's own words from
inside the box: `Could not resolve host` (the name is not known on that network), `Failed to connect` (nothing
listens there), or `returned error: 403` / `421` (the hopper refused the box: its address is not in
`HOPPER_LAN_PEERS`, or the name is not in `HOPPER_LAN_NAMES`).

**Residual risk.** The socket is your account: whoever controls the hopper's process can start any container as you.
The hopper itself only starts locked-down boxes — every capability dropped, no new privileges, a read-only root,
the image's own non-root user, CPU and memory limits, nothing of the computer mounted — from the published box image
or an approved template's image, and a request to it can name only an agent or a template and parameters within the
template's limits, never an image, a mount or a flag. An admin UI session can start and remove
boxes, as it can add and remove any machine.

Turn it off: remove `compose.override.yaml` and run `podman compose up -d`. The boxes it started keep
running; remove their machines in the Machines view first if you want them gone.

### Sandbox boxes on another machine

A machine that joined with Add machine → *A computer* can hold sandbox boxes too (issue #708). The hopper starts
them in that machine's own rootless Podman (or rootless Docker when Podman is not there), through the machine's
client: no socket of that machine is given to the hopper, and nothing listens on the machine. On the machine, once:

```sh
systemctl --user enable --now podman.socket
loginctl enable-linger "$USER"
```

The second line keeps your user's services, the socket included, running after you sign out. Under WSL, also keep
the distro running: WSL stops an idle distro, and its containers with it.

Then Machines → Add machine → *A sandbox box* shows **on** with the hopper's computer and each machine online now:
pick the machine, then **Start the box**. The box is on that machine's network and reaches the hopper at the address
the machine's client dialled in on, and its start check proves that from inside it, as for a box beside the hopper. The machine's client checks each call again: it creates only a container with the
sandbox flags and no mount of the machine, and stops or removes only the boxes the hopper made. While the machine is
away, its boxes and their records stay, past their time limit too; the hopper checks them when the machine dials in
again. A box with tools on a machine runs a tools image the hopper builds in that machine's runtime, through its
client, once per base image and set of tools; the client builds only a tools image, from the hopper's one
Containerfile. A client of an older release refuses the build: the hopper loads its own release there once no job
runs on it.

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
Secrets go in the same `daemon.env`. The first start makes the master key and shows it once in the UI: save it, add
`HOPPER_MASTER_KEY=<it>` to `daemon.env`, and run `systemctl --user restart hopper` ("The master key"). No OpenFGA is
installed: set `HOPPER_OPENFGA_URL` ("Access: OpenFGA"), or every credential is denied.
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
(the `image` run, asked of `gh`), and the commit has no What's new fragments left in `whats-new/`. Then it pushes, as the maintainer, so the steadier branch's image build
starts. `beta` and `stable` therefore only ever hold what ran one step below; nothing is merged or committed
on them. A fix for something found on `beta` or `stable` lands on `dev` like any change and is promoted from
there. There is no schedule and nothing promotes on its own: the maintainer decides.

**Assemble What's new first (issue #824).** Pull requests add their What's new lines as fragments in
`whats-new/`, never in `WHATS-NEW.md`. Before `promote.sh beta`, move them into `WHATS-NEW.md` on `dev`:

```sh
node scripts/whats-new.ts assemble        # in a branch of dev; then open a pull request to dev and merge it
```

Then promote the merge of that pull request. The move keeps each line's text, so it brings no update news.

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
(`HOPPER_IMAGE`, "In containers, with Podman", "Upgrade"): the channel picked in Settings → Version only
decides what the update check compares against.

**From before.** The channels were `dev`, `beta`, `main` and `release`. A hopper set to `main` or `release`
is set to `stable` when it starts on a version with these channels (store migration 26). Once that version
reached `stable`, `main` was moved to it one last time, so a hopper still on an older version, which follows
`main`, updates once to it and from then on follows `stable`. Nothing is promoted to `main` after that. No release tag was ever published, so a hopper on `release` had nothing to update to: choose
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

**The PR check** (issue #672): `.github/workflows/pr.yml` runs on every pull request to `dev`, `beta` or
`stable`. Its job `pr / gates` runs `npm ci`, `npm run typecheck`, `npm run lint` and `npm run build:ui`;
its jobs `pr / shard (1)` to `(3)` run `npm test` in three shards, so the check stays well under 10 minutes.
The check to require is **`pr / test`**: it passes only when the gates and every shard passed. The tests run
with `HOPPER_TEST_HOST_SERVICES=0`, which leaves out the tests that need
their own containers, a real sshd, LDAP or a vault (the list: `test/support/host-services.ts`; a new test
that needs one of those goes there). It reads the repository only and uses no secrets (`pull_request`, never
`pull_request_target`), so a fork's pull request is safe. Yolo mode merges a pull request only once a check
passed on it; this is that check. To have GitHub hold every merge to it, make `pr / test` a required status
check in the branch protection of `dev` (Settings → Branches): an owner's step, not the workflow's.

**Agent boxes** (`docs/design.md` "Agent boxes"): `bash scripts/agent-boxes.sh` starts one container per
agent CLI (claude, codex, cursor, omp, opencode), each an ssh target with its own herdr session, and
attaches every one to the hopper, running its agent's executor. It finds the hopper itself: the compose
container (the boxes join its network; nothing to copy, no database to reach) or, with
`HOPPER_DATABASE_URL`, one installed here. Run it again any time: it puts every box back as it should be.
`--sign-in` signs in the agents not signed in yet (opencode needs none); `ssh -t hopper-box-<agent>` opens
a terminal there. `--check` proves the hopper in its container reaches every box: ssh as the hopper,
the box's herdr session running, its agent CLI answering — one line per box, exit 1 on any failure.
`--remove` takes them away again.
