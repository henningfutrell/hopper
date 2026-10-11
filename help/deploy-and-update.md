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
6. Add the key to `.env` beside `compose.yaml`, and recreate the hopper:

   ```sh
   echo 'HOPPER_MASTER_KEY=<the 64 hex digits>' >> .env
   podman compose up -d --force-recreate --no-deps hopper
   ```

7. Sign in to Claude Code in the container one time: `podman compose exec hopper claude`, then `/login`, then `/exit`.
8. Make the stack start after a reboot. Do this one time:

   ```sh
   systemctl --user enable podman-restart.service
   sudo loginctl enable-linger "$USER"
   ```

Docker works the same: use `docker compose` in place of `podman compose`.

## Change settings

Do not edit `compose.yaml`. Each update replaces it.

1. Put your settings in `.env` beside `compose.yaml`. Examples: `HOPPER_PORT` moves the UI port, and `HOPPER_BIND=0.0.0.0` publishes the UI on every interface for a LAN install.
2. Put what `.env` cannot hold (a service of your own, a host folder mounted into a service) in `compose.override.yaml`. Compose reads it beside `compose.yaml`.
3. Recreate the stack: `podman compose up -d`.

To turn on an optional service, add these lines to `.env`, then run `podman compose up -d`:

| You want | `.env` lines |
|---|---|
| The vault in a container of its own | `COMPOSE_PROFILES=hopper-vault` and `HOPPER_VAULT_URL=http://hopper-vault:4791` |
| That, with a local KMS | `COMPOSE_PROFILES=hopper-vault,kms`, `HOPPER_VAULT_URL=http://hopper-vault:4791` and `HOPPER_KMS_URL=http://kms:8080` |
| A local KMS, with the vault in the hopper | `COMPOSE_PROFILES=kms` and `HOPPER_KMS_URL=http://kms:8080` |

To turn a service off, remove its lines and run `podman compose up -d --remove-orphans`.

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
4. Put the new key in `.env` as `HOPPER_MASTER_KEY` before the next start. A start with the old key is refused.
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

You update a container install. The hopper never updates its own container, and it has no Update now or Auto-update there. Each image carries the compose file of its version. The update script puts that file in and starts the whole stack.

1. Make sure `.env` has `HOPPER_MASTER_KEY`. The script stops if the running hopper made its key at this start and `.env` does not have it.
2. Look at the update notice. It says how many running jobs a restart would end. Wait until there are none.
3. In the folder that holds `compose.yaml`, make the update script from the image of your channel:

   ```sh
   podman run --rm --pull=always ghcr.io/henningfutrell/hopper:<channel> hopper update podman > hopper-update.sh
   ```

   For Docker, use `docker run … hopper update docker`. For podman-compose alone, use `hopper update podman-compose`.
4. Read `hopper-update.sh`. Then run it:

   ```sh
   sh hopper-update.sh
   ```

5. Optional: remove the image it replaced:

   ```sh
   podman image prune -f --filter label=org.opencontainers.image.title=hopper
   ```

The script does these steps in order, and stops at the first step that fails:

1. Checks `.env` for the master key.
2. Backs up the database (`hopper-backup-<time>.dump`), `compose.yaml` and `.env`.
3. Pulls the image.
4. Moves your own settings from the old `compose.yaml` to `.env` and `compose.override.yaml`, and sets `HOPPER_IMAGE`.
5. Puts in the compose file of the new version.
6. Pulls and recreates the whole stack.
7. Checks that the hopper and OpenFGA answer.

When it stops, its last line says why and how to go back. Fix the cause and run the script again.

To change the channel, run the update with the image of the new channel. Then pick the same channel in Settings → Version.

Do not update the hopper service alone (`pull hopper`, `up -d --no-deps hopper`). A new version can add required services and settings, and they never arrive.

### Stack drift

A container hopper compares its stack with the compose file of its own version, at start and while the UI is open. When a required service is missing, a setting is missing, or `hopper-vault` runs another version, a banner says "This hopper's stack differs from the compose file of its version". It names what is off. The fix is always the update script, never a hand edit. `GET /api/update/drift` gives the same answer.

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
| The master key | Your password manager, and `.env` or `daemon.env` | Keep it apart from the database backups. |
| Your settings | `.env` and `compose.override.yaml`, or `~/.config/hopper/daemon.env` | Copy the files. |
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
| A "Limited" banner | Put `HOPPER_MASTER_KEY` in `.env` and recreate the hopper. |
| "Access checks are off" | OpenFGA does not run. Run the update script, or `podman compose up -d`. Read `podman compose logs openfga openfga-migrate`. |
| "This hopper's stack differs from the compose file of its version" | Run the update script with the image the hopper runs. |
| The hopper stops at start and names two schema versions | The database is from a newer version. Run that newer version again, or restore a backup from before it. |
| `unrecognized command "podman compose"` | Your Podman is older than 4.7. Use `podman-compose`, or install a newer Podman. |
| Host install: `did not answer /api/health` | Read `journalctl --user -u hopper -n 50`. |
