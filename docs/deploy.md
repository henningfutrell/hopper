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
| Secrets | from the runtime (docs/design.md "Secrets"): each one the variable `NAME`, or the mounted file the variable `NAME_FILE` names (never both) — `GITHUB_APP_PRIVATE_KEY`, `GROKBOT_WEBHOOK_URL`, `GROKBOT_WEBHOOK_KEY` (with the user's secret prefix, `HOPPER_USER_<ID>_`, as Settings → Plugins names them; as `_FILE` they can change without a restart), `TYPESAFE_API_KEY`, each webhook's `secretEnv` (`WEBHOOK_SECRET_<NAME>` from the UI; `openssl rand -hex 32`, given to the subscriber too), a realm's secrets only when the realm is set up from the environment (`HOPPER_SIGN_IN_REALM_<NAME>_CLIENT_SECRET`, docs/sign-in.md "Sign-in from the environment"; typed in Settings otherwise, and stored); `CLAUDE_CODE_OAUTH_TOKEN` for the claude CLI where its own login is not on the machine (a variable only: the CLI reads it). A job's `GH_TOKEN` is no runtime secret: the hopper hands each job the connected account's token. The hopper stores no secret but a realm's own (docs/design.md "Secrets"). A leftover `HOPPER_SECRET_KEY` line: delete it. |
| Process settings | `HOPPER_*` variables: port, LAN names and peers, public URL, tick, limits (`src/config.ts`). |
| Plugins | Optional. `HOPPER_PLUGIN_DIR` (plugins put there by hand; a container mounts it read-only) and `HOPPER_PLUGIN_STORE` (seeds the plugin store setting on a hopper that never had one set; the plugin store is set in the UI, Plugins → Plugin store, and defaults to the one the Pages site publishes: docs/plugins.md). Store installs are kept in the database and restored into the work dir at start: they need no plugin dir and no volume. |
| Config | the plugins, rules and sign-in configs and the webhook subscriptions, all in the database, all edited in the UI (Settings → Plugins, Settings → Question gates, Settings → Sign-in, Settings → Webhooks); no config file. The first boot writes the built-in plugins config. |
| GitHub | each user's GitHub sign-in, the **connected account** (default; sign in with GitHub, or Sources → Connect GitHub, then choose the job repositories in Sources), or a GitHub App an admin creates for this hopper with `scripts/create-github-app.sh` (its key in `GITHUB_APP_PRIVATE_KEY`). Each hopper has its own App and key; there is no shared one. No gh CLI source and no gh login since issue #359. Setting up either: `README.md` "Connect GitHub". |
| Where jobs run | machines: this host's herdr session (`hopper-herdr`; not in a container, issue #141), and attached machines, instances in the plugins config's machine sources (Settings → Plugins → Machine sources, or the Machines view) — `client` targets (a computer or a sandbox box, joined with one line), `ssh` targets, `docker` container targets. Setting each one up, step by step: `README.md` "Add machines". |

`hopper` is the operator CLI (`hopper config …`, `hopper users`, `hopper user add`, `hopper user transfer`); it needs `HOPPER_DATABASE_URL` (or `_FILE`) and nothing else. `hopper help` lists its commands; `node src/main.ts --help` lists every daemon setting with its default.

Once it runs, the API reference is at `/docs/` (Scalar; the OpenAPI document at `/docs/openapi.json`), on every address the UI answers on. A first-time walkthrough is `README.md`.

Mounted secrets: in compose, a `secrets:` entry (added to `compose.yaml`) appears at `/run/secrets/<name>` — set
`<NAME>_FILE=/run/secrets/<name>`; in Kubernetes, a Secret volume; under systemd, `LoadCredential=` in
a drop-in with `Environment=<NAME>_FILE=%d/<name>`.

## In containers, with Podman (recommended)

`compose.yaml` (issues #119, #125): the whole hopper in containers, from that one file — no clone, no
host install, no build, nothing to set before the first start. The hopper is the public image
`ghcr.io/henningfutrell/hopper` (`latest` follows `stable`; `dev`, `beta` and `stable` follow the branch of
that name; `sha-<commit>` pins one build; Intel/AMD and ARM), built and pushed by `.github/workflows/image.yml`
on every change to those three branches ("Update channels and promotion" below). The install page serves the
compose file. To run another channel, set `HOPPER_IMAGE=ghcr.io/henningfutrell/hopper:dev` (or `:beta`) in `.env`.

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
  flag. Or, for Claude Code, `CLAUDE_CODE_OAUTH_TOKEN` in `.env`. A job gets its GitHub token from the
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
- **Upgrade:** `podman compose pull && podman compose up -d && podman image prune -f --filter label=org.opencontainers.image.title=hopper` (self-update does not apply to a
  container). The prune removes the image the upgrade replaced, and only untagged hopper images, so
  repeated upgrades do not pile up images. It recreates the hopper's container, so it ends the running jobs' panes: upgrade when none
  runs. A pinned build: `HOPPER_IMAGE=ghcr.io/henningfutrell/hopper:sha-<commit>` in `.env`.
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
  `machine` (picked from the machines) to an attached ssh machine signed in to claude, or add an `anthropic-api` level and give the
  container `ANTHROPIC_API_KEY` (or `ANTHROPIC_API_KEY_FILE`, a mounted secret) in `.env`.

**From the build-from-source compose file** (before issue #125): the volumes are the same, so the new
file, downloaded into the same folder, starts on the old data with `docker compose up -d`. Docker and
Podman keep separate volumes: moving such a stack from Docker to Podman moves the database once, with
`pg_dump` from one and `psql` into the other, before the hopper's first start under Podman.

**From the earlier container deploy** (`deploy/compose.yaml --profile container`, removed): its database
is the `job-hopper_postgres` volume, which `deploy/compose.yaml` still serves. Move it into the new stack
once, before the hopper's first start, with `pg_dump` from one and `psql` into the other.

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
change one step at a time, and check each step's hopper starts and runs a job before the next.

What each push publishes: `.github/workflows/image.yml` builds the image tag of the branch's name
(`stable` also moves `latest`); `.github/workflows/pages.yml` publishes the Pages site, its `install.sh` and
its `compose.yaml` from `stable` only.

A hopper picks its channel in Settings → Version (dev, beta, stable); it takes effect without a restart.
An install from `scripts/install.sh` or the curl install starts on the branch it was installed from
(`HOPPER_SOURCE_REF`, default `stable`). An image is replaced by pulling the tag of its channel.

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
