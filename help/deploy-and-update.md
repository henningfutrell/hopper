# Deploy and update

Run the hopper as a compose stack (recommended) or as systemd --user services on a host, keep its master key safe, and update it. For each setting in full, read [docs/deploy.md](https://github.com/henningfutrell/hopper/blob/dev/docs/deploy.md).

## Choose how to run it

- **Container install** (recommended): one `compose.yaml` starts the whole stack from the published image `ghcr.io/henningfutrell/hopper`. You need Podman 4.7 or later with a compose provider, or Docker with compose.
- **Host install**: the daemon and its herdr session run as systemd --user services. You need Node.js 24 or later at `/usr/bin/node`, git, npm, and a Postgres database.

The container is not a machine. Jobs run on the machines you attach (Machines → Add machine).

## What the stack runs

The `compose.yaml` has required services and optional services.

| Service | Required | What it does |
|---|---|---|
| `postgres` | yes | The database. Everything the hopper keeps is in it. |
| `hopper` | yes | The daemon and the UI. |
| `openfga` | yes | Access checks. The hopper asks it before it gives a job a credential. |
| `openfga-migrate` | yes | Brings OpenFGA's tables up to date, then stops. |
| `hopper-vault` | no (profile `hopper-vault`) | The vault in a container of its own. |
| `kms` | no (profile `kms`) | A local KMS that wraps the vault's data key. |
| `tunnel` | yes | Remote access through ngrok. It runs no ngrok until you turn remote access on with ngrok. See [Remote access](remote-access.md). |
| `cloudflared` | yes | Remote access through Cloudflare Tunnel. It runs no tunnel until you turn remote access on with Cloudflare Tunnel. See [Remote access](remote-access.md). |
| `vault` | no (profile `vault`) | HashiCorp Vault, a vault backend. See [Vault](vault.md). |

A plain `podman compose up -d` starts only the required services. Without an optional service, the hopper starts and works. The vault then runs in the hopper, under the master key.

Without OpenFGA, the hopper denies every credential. A banner on every page says "Access checks are off".

## First start (container install)

1. Make a folder for the hopper, and go into it.
2. Download the compose file and start the stack:

   ```sh
   curl -fsSLO https://henningfutrell.github.io/hopper/compose.yaml
   podman compose up -d
   ```

3. Open `http://localhost:4790/`. Sign in with GitHub. The first person to sign in is the admin. There is no starting account or password.
4. Save the master key now. The banner shows it once, to the admin only: click **Show the key (once)**. The key is never in the log.
5. Put the key in your password manager. Then click **I saved it**.
6. Give the key at launch, and recreate the hopper. Do not put it in a file:

   ```sh
   read -rs HOPPER_MASTER_KEY && export HOPPER_MASTER_KEY
   podman compose up -d --force-recreate --no-deps hopper
   ```

   `read -rs` shows nothing and keeps the key out of your shell history. Paste the 64 hex digits, then press Enter.

7. Sign in to Claude Code in the container one time: `podman compose exec hopper claude`, then `/login`, then `/exit`.
8. Make the stack start after a reboot. Do this one time:

   ```sh
   systemctl --user enable podman-restart.service
   sudo loginctl enable-linger "$USER"
   ```

Docker works the same: use `docker compose` in place of `podman compose`.

## Change settings

Do not edit `compose.yaml`. Each update replaces it. Do not make a `.env` file: the hopper uses none. The hopper keeps its own settings and secrets, and you set them in the UI. Remote access, sign-in, webhooks and vault secrets are all in Settings.

A setting that compose itself needs is given at launch, in the environment of the compose command:

1. Export the setting. Examples: `export HOPPER_PORT=4800` moves the UI port, and `export HOPPER_BIND=0.0.0.0` publishes the UI on every interface for a LAN install.
2. Give the master key too (`read -rs HOPPER_MASTER_KEY && export HOPPER_MASTER_KEY`): the hopper is recreated.
3. Recreate the stack: `podman compose up -d`.
4. The next update writes the setting into `compose.yaml` as the default of its variable, so you do not give it again.

Put what `compose.yaml` does not name (a service of your own, a host folder mounted into a service) in `compose.override.yaml`. Compose reads it beside `compose.yaml`. Never put a secret in it: name the variable only (`ANTHROPIC_API_KEY: ${ANTHROPIC_API_KEY:-}`), and give its value at launch.

To turn on an optional service, give these settings at launch, then run `podman compose up -d`:

| You want | Settings |
|---|---|
| The vault in a container of its own | `COMPOSE_PROFILES=hopper-vault` and `HOPPER_VAULT_URL=http://hopper-vault:4791` |
| That, with a local KMS | `COMPOSE_PROFILES=hopper-vault,kms`, `HOPPER_VAULT_URL=http://hopper-vault:4791` and `HOPPER_KMS_URL=http://kms:8080` |
| A local KMS, with the vault in the hopper | `COMPOSE_PROFILES=kms` and `HOPPER_KMS_URL=http://kms:8080` |

To turn a service off, give the settings without it and run `podman compose up -d --remove-orphans`. When an update already wrote them into `compose.yaml`, give the new value (for example `COMPOSE_PROFILES=`) and run the update again.

## The master key

Every secret the hopper keeps is sealed under the master key `HOPPER_MASTER_KEY`. The database keeps only the key fingerprint, never the key. You give the key at launch, as a variable. The hopper never reads it from a file or a volume, and a KMS does not give it.

- **A new hopper with no key** makes a key and shows it once in the UI. Save it and give it, as in "First start".
- **No key, but the database keeps secrets**: the hopper starts limited. Nothing is deleted. Nothing that needs a secret works. A banner and the log (`LIMITED`) name the missing key by its fingerprint. Do not connect GitHub again. Give the key and restart.
- **A wrong key**: the hopper does not start. The log says `the master key does not match this database`. Nothing changes. Give the right key.
- **`HOPPER_MASTER_KEY_FILE` is set**: the hopper does not start. Remove it and give the key as `HOPPER_MASTER_KEY`.

Keep the key in a password manager. Keep it apart from the database backups: a backup with its key holds every secret.

To see the key's status without the key:

```sh
podman compose exec hopper hopper master-key status
```

### Rotate the master key

Rotate the key when it may have been seen. Only the hopper's admin can rotate it.

1. Open Settings → Vault → Master key, and click **Rotate the master key**. Or run `podman compose exec hopper hopper master-key rotate`.
2. The hopper seals every secret again under a new key, in one transaction. It keeps running, with no restart.
3. Save the new key in your password manager. The UI or the command shows it once.
4. Give the new key at launch as `HOPPER_MASTER_KEY` at the next start. A start with the old key is refused.
5. Click **I saved it**. Delete the old key from every place it was written.

With the vault in a container of its own, the one-click rotation is refused. Rotate at launch instead: give the new key as `HOPPER_MASTER_KEY` and the old key as `HOPPER_MASTER_KEY_PREVIOUS`, recreate `hopper` and `hopper-vault`, then remove `HOPPER_MASTER_KEY_PREVIOUS` and recreate them again. The steps are in docs/deploy.md, "Rotating the master key".

## Update channels

The update channel says which versions count as newer. Pick it in Settings → Version.

| Channel | What you get |
|---|---|
| `dev` | Every change as soon as it is merged. Newest, and the first to break. |
| `beta` | Changes after they ran on `dev`. A preview of the next stable version. |
| `stable` | Changes after they ran on `beta`. The default. |

A maintainer promotes changes from `dev` to `beta` to `stable`, one step at a time.

The hopper offers an update only when the newest version is a merged pull request whose checks passed. Otherwise the update notice says "Update held" and gives the reason. A held update is not offered or applied.

For a container install, the channel is also the image tag: `ghcr.io/henningfutrell/hopper:dev`, `:beta` or `:stable`. With no `HOPPER_IMAGE`, the image is `:latest`, the same image as `:stable`.

## Update a container install

You update a container install. The hopper never updates its own container, and it has no Update now or Auto-update there. Each image carries the compose file of its version and the update itself. The update is one command.

1. Look at the update notice. It says how many running jobs a restart would end. Wait until there are none.
2. Go to the folder that holds `compose.yaml`. Run this command. The update notice gives it with the image of your channel. For Docker, use `docker run` in place of `podman run`:

   ```sh
   podman run --rm --pull=always ghcr.io/henningfutrell/hopper:<channel> hopper update script | bash -s -- ghcr.io/henningfutrell/hopper:<channel>
   ```

3. Paste the master key from your password manager when it asks. Nothing is shown, and it goes in no file. If you do not have the key, open the UI and save the key it shows first. Without the key, the update stops before it changes anything: a hopper started without it is limited.

   To update with no person at the keyboard (an agent or a scheduled task), put the key in the environment of the command from your secret manager, for example `export HOPPER_MASTER_KEY="$(pass show hopper/master-key)"`. Then it does not ask. The update does not read the key from the running container or from a file.
4. Read what it says. It:
   - uses the compose tool that started the stack (podman-compose, docker-compose or `docker compose`), with the project `hopper`. The wrong tool starts a second stack on the same data, so the update stops when the tool does not see the stack that runs;
   - backs up the database to `hopper-backup.dump`;
   - puts in the compose file of the new version, with your own settings as the defaults of its variables. The old file stays as `compose.yaml.bak`. When your old `compose.yaml` has a part that the new one cannot hold (a service of your own, a mounted folder), it shows that part. Add it to `compose.override.yaml`;
   - pulls, stops the stack and starts it on the new image. Your data stays. When the new stack does not start, it puts the old file back and starts the old stack;
   - checks that the hopper runs the new image, answers its health check, has its master key, and that the stack has no drift.

   It ends with `hopper update: done:` when all of this is true. Else it says what failed. Then it removes the older hopper images. It keeps the image it runs and the image it ran before, so you can go back.

`hopper update podman`, `hopper update docker` and `hopper update podman-compose` made an update script before. They are removed. Run them now and they print the update command.

To go back: run the update with the image you ran before (`ghcr.io/henningfutrell/hopper:sha-<commit>`; `compose.yaml.bak` names it). To restore the database too: `podman compose -p hopper exec -T postgres pg_restore -U hopper -d hopper --clean < hopper-backup.dump`.

To change the channel, run the update with the image of the new channel. Then pick the same channel in Settings → Version.

Do not update the hopper service alone (`pull hopper`, `up -d --no-deps hopper`). A new version can add required services and settings, and they never arrive.

### Stack drift

A container hopper compares its stack with the compose file of its own version, at start and while the UI is open. When a required service is missing, a setting is missing, or `hopper-vault` runs another version, a banner says "This hopper's stack differs from the compose file of its version". It names what is off. The fix is always the update of the whole stack, never a hand edit. `GET /api/update/drift` gives the same answer.

An agent that updates a hopper follows the agent update skill: `GET /api/update/skill`, or `hopper update skill`.

## Host install

1. Install the daemon with one line:

   ```sh
   curl -fsSL https://henningfutrell.github.io/hopper/install.sh | bash
   ```

   Without Docker, give it a database: `curl … | HOPPER_DATABASE_URL=postgres://… bash`. `HOPPER_SOURCE_REF` picks the channel to install from (default `stable`).
2. Open `http://localhost:4790/` and sign in with GitHub.
3. Save the master key from the UI banner, as in "First start". Add `HOPPER_MASTER_KEY=<the 64 hex digits>` to `~/.config/hopper/daemon.env`.
4. Restart: `systemctl --user restart hopper`.
5. Keep the services running after you log out: `sudo loginctl enable-linger "$USER"`.

The host install does not start OpenFGA. Until you run one and set `HOPPER_OPENFGA_URL`, access checks are off and every credential is denied. See docs/deploy.md, "Access: OpenFGA".

### Update a host install

1. Open Settings → Version. Pick the update channel.
2. Click **Update now** when an update is available. Or turn on **Auto-update**. Only the hopper's admins can do this.
3. The hopper builds the update beside the running install and checks that it loads. It waits until no restart blocker is left, swaps the install in, and restarts. Running jobs that can reattach keep running.

To update by hand, run the install line again.

## Back up

| What | Where | How to keep it |
|---|---|---|
| Everything the hopper keeps (jobs, settings, sealed secrets) | The Postgres database | `podman compose exec -T postgres pg_dump -U hopper -d hopper -Fc > hopper-backup.dump` |
| The master key | Your password manager (a container install keeps it in no file), or `daemon.env` | Keep it apart from the database backups. |
| Your settings | Settings in the UI (in the database), `compose.yaml` and `compose.override.yaml`, or `~/.config/hopper/daemon.env` | Copy the files. |
| The Claude sign-in and git identity | The `home` volume | Sign in again if you lose it. |
| The KMS keys | The `kms` volume | Back it up with the database. Without it, values sealed under a data key are lost. |

The `runtime-secrets` volume is in memory. Postgres makes its files again at each start, so do not back it up.

To restore the database:

```sh
podman compose exec -T postgres pg_restore -U hopper -d hopper --clean < hopper-backup.dump
```

`podman compose down` keeps the volumes. `podman compose down -v` deletes the database, the sign-ins and the KMS keys.

## Troubleshoot the first start

| You see | Do this |
|---|---|
| The UI does not open | Run `podman compose ps`. Check that `postgres`, `openfga` and `hopper` run. Read `podman compose logs hopper`. |
| `the master key does not match this database` | Give the key this database was set up with. After a rotation, give the new key. |
| A "Limited" banner | Give `HOPPER_MASTER_KEY` at launch and recreate the hopper (`podman compose up -d --force-recreate --no-deps hopper`). |
| "Access checks are off" | OpenFGA does not run. Run the update (see "Update a container install"), or `podman compose up -d`. Read `podman compose logs openfga openfga-migrate`. |
| "This hopper's stack differs from the compose file of its version" | Run the update with the image the hopper runs: the banner gives the command. |
| The hopper stops at start and names two schema versions | The database is from a newer version. Run that newer version again, or restore a backup from before it. |
| `does not see the hopper stack that runs` | Another compose tool started the stack, and the update cannot use it. Start the stack once with the tool that made it (`podman-compose -p hopper up -d`, or `docker compose -p hopper up -d`), then run the update again. |
| `postgres: another container runs on this data volume` | A second stack runs on the same data. Its Postgres does not start, and the first one keeps running. Remove the second stack with the tool that made it (`docker-compose down` or `podman-compose down`). Do not add `-v`: it removes the data. |
| `unrecognized command "podman compose"` | Your Podman is older than 4.7. Use `podman-compose`, or install a newer Podman. |
| Host install: `did not answer /api/health` | Read `journalctl --user -u hopper -n 50`. |
| A **stalled** badge in the top bar | The hopper stopped answering for more than 2 s. Point at the badge to see how long, and the requests in flight. Read the log line `the event loop stalled` (`podman compose logs hopper`). The badge goes after 10 minutes. |
