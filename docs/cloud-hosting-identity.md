# Cloud hosting: the GitHub account as the identity at hopper.io

**Status: decided, and the first part is built.** On 2026-10-17 the owner accepted the five
recommendations of this document as written ([Decisions for the owner](#decisions-for-the-owner)); the
decisions are recorded on the tracking issue #469. The first implementation part, the hopper.io account and GitHub
sign-in at hopper.io, is built in `cloud/` ([What is built](#what-is-built)). This document does not
pick a domain, a host or a database. It does not change any GitHub App setting or secret: the hosted
app is registered by hand ([Run it](#run-it)).

The terms *hopper.io account*, *hopper.io session*, *hopper.io registration* and *registration
tombstone* are in `docs/glossary.md`. This document says *install registration* for a hopper.io
registration: the glossary's **install** is the directory the daemon runs from.

## What is fixed already

These points come from the issue. The paths below keep all of them.

- A hopper.io account is keyed by GitHub's **numeric user id** (`id` from `GET /user`), never by the
  login. A login can be renamed, and someone else can then register the old name.
- hopper.io keeps only the account id, the login and the avatar URL (for display), and the
  installs the account registered. It keeps no GitHub access or refresh token after sign-in.
- **Each install keeps its own sign-in.** A hopper.io session never gives a session on an install.
- Sign-out and account deletion are covered in [Decision 5](#5-sign-out-and-account-deletion).

## How an install signs in with GitHub today

- `src/connected-accounts/hopper-app.ts`: the shipped app is `hopper-qm`. The hopper ships its
  public client id and slug only. The app is public: any account or organization installs it
  (issue #352). Its permissions are issues, pull requests and contents read/write, and checks,
  commit statuses and metadata read.
- `src/connected-accounts/device-flow.ts`: the device flow needs no secret. This is the default way in.
- `src/connected-accounts/web-flow.ts`: the browser redirect (authorization code with PKCE, through
  openid-client) needs the app's client secret, `HOPPER_GITHUB_CLIENT_SECRET`, from the runtime. The
  callback `<sign-in origin>/ui/auth/github/callback` must be registered on the app. GitHub allows
  **at most 10 callback URLs** per app (`docs/sign-in.md`).
- `src/connected-accounts/identity.ts`: `whoIs()` reads `GET /user` (and the verified emails when
  the app may read them). The subject is the numeric id.
- `src/connected-accounts/revocation.ts`: GitHub keeps **at most ten tokens per user and app**. An
  eleventh grant revokes an older one, whoever holds it. The token a person signs in with is also the
  token their jobs work through (issue #214).
- `src/users/identities.ts`: `userForIdentity()` links *(realm, subject)* to one user of the
  install. An unlinked identity whose realm vouches for an email signs in as the user with that
  email (issue #1380).
- `src/auth/gateway.ts`: the `gateway` realm checks a token that a gateway in front of the hopper
  forwards on **every request**, by JWKS (jose) or by introspection (openid-client).

## 1. Which GitHub App hopper.io signs in through

### Path A: the shipped `hopper-qm` app

- **Client secret.** hopper.io signs in by browser redirect, so it needs the client secret of
  `hopper-qm`. That secret then lives on a public, always-on service. A leak of it lets an attacker
  delete or reset tokens of `hopper-qm` (`DELETE /applications/{client_id}/token`), and these are the
  tokens every install's jobs work through. An install that uses the web flow on `hopper-qm` holds
  the same secret. A rotation for one breaks all of them at once.
- **Redirect URLs.** hopper.io takes one of the 10 callback slots. The slots are shared with every
  install that signs in by redirect on `hopper-qm`. Ten is already too few for a public app.
- **What breaks when the app is shared with installs.**
  - The ten-token limit is per user and app. Each sign-in at hopper.io is a new grant. Enough
    sign-ins at hopper.io revoke the token of a person's install, and **their jobs stop working on
    GitHub** until they sign in again there.
  - A token from `hopper-qm` may write issues, pull requests and contents wherever the app is
    installed. hopper.io would receive that power at each sign-in, though it needs only `GET /user`.
    It drops the token at once, but it holds it during the exchange.
  - GitHub's consent page and the person's *Authorized GitHub Apps* list show one app for two
    different things. A person who revokes the app to leave hopper.io also cuts off their install.
- **For it:** no new app to register. One consent for a person who uses both.

### Path B: a separate hosted GitHub App for hopper.io

- **Client secret.** A new secret that only hopper.io holds. hopper.io gives it from its runtime, as
  an install gives `HOPPER_GITHUB_CLIENT_SECRET` (`docs/design.md` "Secrets": a credential the
  service is *given*). A leak touches only hopper.io sign-in. No install uses it.
- **Redirect URLs.** hopper.io's own callback(s) only. Installs keep all 10 slots of `hopper-qm`.
- **Permissions.** No repository permissions, no account permissions. `GET /user` needs none. The
  app is never installed on a repository. Its user tokens can read the person's public profile and
  nothing else.
- **What breaks:** nothing at the installs. Its tokens count toward a separate ten-token limit.
- **Against it:** one more app to register and one more secret to rotate. A person sees a second
  consent page.

### Recommendation: Path B

A separate app keeps hopper.io's secret, its callbacks and its token limit away from the token that
jobs work through. It also needs no permissions, which is the least privilege for what hopper.io
does. The cost is one app registration and one secret. **Decision for the owner.**

## 2. Where the hopper.io service lives

### What it would reuse

From `src/connected-accounts/`, with little or no change:

| File | Use at hopper.io |
|---|---|
| `hopper-app.ts` | the `HopperApp` shape and `hopperApps()`, given the hosted app's client id |
| `web-flow.ts` | the browser sign-in, PKCE and state, through openid-client |
| `identity.ts` | `whoIs()`: the numeric id, the login (the avatar URL is one more field of `GET /user`) |
| `revocation.ts` | delete the token after sign-in, and the grant at account deletion |

From `src/auth/`, nothing at first. The realms, role rules, tickets and the UI session are an
install's. hopper.io has one way in and no roles. If [Decision 4](#4-whether-installs-may-trust-hopperio-as-an-issuer)
makes hopper.io an issuer, its token format must match what `src/auth/oidc.ts` or
`src/auth/gateway.ts` checks, and the tests of those realms are the contract.

### Path A: a `cloud/` service in this repository

- Imports the files above directly. One change to GitHub sign-in updates both sides in one pull
  request. The tests run in the same suite.
- Needs changes to the repo law in the same change: a row in `docs/design.md` "Directories and what
  each must not know" (`cloud/` imports only `src/connected-accounts/` and `src/domain/types.ts`;
  nothing in `src/` imports `cloud/`), and the rule "The UI is the daemon's one built part" names a
  second built part.
- hopper.io would move main → dev → beta → canary → stable with the daemon. That is safe, but a fix
  to hopper.io waits for the same promotions, unless its deploy takes `main` or `dev` directly.
- The daemon image must not carry `cloud/`, and the hopper.io image must not carry the daemon.

### Path B: a separate repository

- Its own deploy cadence, its own checks, its own law.
- It must copy the four files (about 150 lines) or this repo must publish them as a package. A copy
  drifts. A package adds a release step for one caller.
- A change to the sign-in contract becomes two pull requests in two repositories.

### Recommendation: Path A

The shared code is small, and it is the code most likely to change with GitHub. Keeping it in one
place stops drift, and a package for one caller is generality not yet earned. Move hopper.io out
when its deploy cadence or its law starts to fight the daemon's. **Decision for the owner.**

## 3. Personal accounts only, or GitHub organizations too

### Path A: personal accounts only

Data model:

| Table | Columns |
|---|---|
| `account` | `github_user_id` (bigint, primary key), `login`, `avatar_url`, `created_at`, `seen_at` |
| `install_registration` | `id`, `account_id` → `account`, the install's own fields (from the multiple-installs issue), `created_at` |

- `login` and `avatar_url` are display only. Each sign-in updates them from `GET /user`.
- Every registration has one owner. Only that account sees it.
- The app needs no permissions. hopper.io needs no token after sign-in.

### Path B: GitHub organizations too, installs shared with an org's members

Data model, in addition to Path A:

| Table | Columns |
|---|---|
| `organization` | `github_org_id` (bigint, primary key), `login`, `avatar_url` |
| `install_registration` | `owner_kind` (`account` or `organization`), `owner_id` in place of `account_id` |
| `membership` (or none) | `account_id`, `org_id`, `role`, `checked_at` |

- hopper.io must know who is a member of an org, and keep it current. GitHub answers this only to
  a token with organization **Members: read**, and only where the app is installed on that org. So
  the hosted app needs a permission and an install per org.
- Membership changes. hopper.io must read it again at each sign-in at least. A person removed from
  the org keeps their access until then. To cut that gap, hopper.io must keep a token or receive
  `organization` webhooks. Both go against "stores no GitHub tokens beyond sign-in", or add a
  webhook receiver.
- An org owner, not an individual, decides who may register an install for the org. That is a
  role model hopper.io does not have yet.

### Recommendation: Path A first

Personal accounts meet the stated need with no permissions and no kept token. Org sharing adds a
permission, an install per org, a freshness problem and a role model. Moving later is one migration:
add `organization`, add `owner_kind`, and set every existing row to `account`. The registrations are
the users' saved data, so that migration must keep them. **Decision for the owner.**

## 4. Whether installs may trust hopper.io as an issuer

### Path A: each install keeps strictly its own realms

- hopper.io is a directory: it says which installs an account registered, and links to them. To
  reach an install, a person signs in there, as today.
- No new trust. A compromise of hopper.io gives no session on any install.

### Path B: hopper.io is an issuer that an install may trust

hopper.io would have to be an OpenID provider: a discovery document, a JWKS, signed ID tokens with
`sub` = the GitHub numeric id. Two ways for an install to trust it:

- **`gateway` realm** (`src/auth/gateway.ts`). It fits badly. The gateway realm expects a proxy in
  front of the install that forwards a token on **every request**. hopper.io would have to be that
  proxy. That means the install's traffic passes through hopper.io, which is against "the hopper
  pulls" and against the loopback default.
- **`oidc` realm** (`src/auth/oidc.ts`). It fits. The install redirects to hopper.io and back. The
  install's admin adds the realm and its role rules. It needs a callback at hopper.io per install,
  so hopper.io keeps a client per registration.

Risks with either way:

- Whoever controls hopper.io's signing key can sign in to every install that trusts it. An install
  that trusted only GitHub before now trusts GitHub **and** hopper.io.
- `userForIdentity()` links an identity to the user of the same verified email (issue #1380). An
  issuer that vouches for emails could sign in as an existing admin. A hopper.io realm must not
  vouch for emails, and role rules must match subjects only.
- `sub` from hopper.io is the GitHub numeric id, but in a different realm from the `github` realm.
  The same person gets a second identity on the install unless the two are linked.

### Recommendation: Path A now

Keep each install on its own realms. It is the safe default, it keeps requirement 3 of the issue,
and it needs no change in `src/auth/`. If the owner later wants single sign-on through hopper.io,
use an **opt-in `oidc` realm** that an install's admin adds, with subject-only role rules and no
email trust, not the `gateway` realm. **Decision for the owner.**

## 5. Sign-out and account deletion

The issue lists these two together. This proposal keeps them apart:

- **Sign-out** ends the hopper.io session only. The account and its registrations stay. Nothing is
  told to any install, because nothing at the install changed.
- **Account deletion** removes the account and all its install registrations at hopper.io, in one
  transaction. hopper.io also deletes the person's grant to the hosted app at GitHub
  (`DELETE /applications/{client_id}/grant`, the same call shape as `revocation.ts`), so the consent
  goes away too. Logs and events keep no login or avatar after the deletion, only the numeric id
  where an audit needs it.

### How linked installs are told

An install is often on loopback or a LAN, behind no public URL. hopper.io cannot reach it. So the
install asks, and hopper.io answers:

1. At registration, hopper.io gives the install a **registration token** (kept hashed at hopper.io).
2. The install calls hopper.io with that token from time to time (a heartbeat), and when its admin
   opens the hopper.io settings.
3. After a deletion, hopper.io keeps a **tombstone** for each removed registration: its id and the
   time, nothing else. The install's next call gets "registration removed". The install then drops
   the token and shows its admin that it is no longer registered. Its own users, realms and data do
   not change.
4. Tombstones expire after a fixed time (for example 90 days). After that, an unknown token gets the
   same answer as a removed one.

This keeps the rule that the hopper pulls, and needs no inbound route on the install.

### Recommendation

Sign-out ends the session only. Deletion removes the account, its registrations and the GitHub
grant, and leaves tombstones that installs read at their next call. This depends on the
registration design of the multiple-installs issue. **Decision for the owner.**

## Decisions for the owner

| # | Decision | Recommended |
|---|---|---|
| 1 | Which GitHub App hopper.io signs in through | a separate hosted app, no permissions |
| 2 | Where the service lives | `cloud/` in this repository |
| 3 | Personal accounts or organizations too | personal accounts first |
| 4 | Whether installs may trust hopper.io as an issuer | no, own realms only; later an opt-in `oidc` realm |
| 5 | Sign-out and account deletion | session-only sign-out; deletion with tombstones that installs pull |

The issue names four open decisions (1, 3, 4 and where the service lives). Item 5 follows from the
issue's requirement 4 and is listed so it is not lost.

All five are accepted as recommended (2026-10-17).

## What is built

Parts 2 to 5 of #463 (part 1 was this document): the hopper.io account, GitHub sign-in at hopper.io,
account deletion, the hopper.io records and the privacy note, and the registrations with their
tombstones, in `cloud/` (decision 2).

- `cloud/store.ts`: the `account` table, keyed by GitHub's numeric user id (`github_user_id`), with `login`
  and `avatar_url` for display, `created_at` and `seen_at`. Each sign-in updates the login and the avatar,
  so a renamed account stays one account. Also the `session` table (only the SHA-256 of each token, 7 days)
  and `sign_in` (a sign-in under way: the SHA-256 of its state and its PKCE verifier, for 10 minutes, taken
  once). No table has a column for a GitHub token. Schema changes are migrations in `MIGRATIONS`.
- `cloud/server.ts`: `GET /auth/github` sends the browser to GitHub through the hosted app's web flow
  (`src/connected-accounts/web-flow.ts`, PKCE), with the state also in an HttpOnly cookie, so only the
  browser that started a sign-in can finish it. `GET /auth/github/callback` exchanges the code, reads
  `GET /user` (`whoIs`), keeps the account and opens a hopper.io session. The access token is then
  dropped. `POST /auth/sign-out` (only with hopper.io's own Origin) ends that session only (decision 5).
  `GET /api/account` answers the signed-in account, else 401. `GET /` is a minimal page.
- Sign-ins are limited per address (`SIGN_IN_LIMIT`, 30 a minute, `@fastify/rate-limit`;
  `docs/hopper-io-security.md` R7).
- **Account deletion** (part 3, decision 5). `POST /account/delete` (only with hopper.io's own Origin,
  signed in) sends the browser to GitHub again. The sign-in under way names the account it is to delete
  (`sign_in.deletes`). Back at the callback, the GitHub account must be the same one. Then, in one
  statement, the account, all its sessions and its deletion sign-ins go. After that, hopper.io deletes the
  person's grant of the hosted app at GitHub (`DELETE /applications/{client_id}/grant`, `grantDeletion` in
  `src/connected-accounts/revocation.ts`), with the token of that sign-in. GitHub needs a token for this,
  and hopper.io keeps none, so the fresh sign-in gives it. It also proves that the person holds the GitHub
  account now, not only a hopper.io session (`docs/hopper-io-security.md` T4). Another GitHub account at
  GitHub, or a denial, deletes nothing. When GitHub refuses the grant deletion, the account is still gone,
  and the page links to GitHub's *Authorized GitHub Apps*, so the person can remove the app there.
  The same statement leaves a tombstone for each of the account's registrations (part 5, below).
- **hopper.io records** (part 4, `docs/hopper-io-security.md` R6). Each sign-in, each sign-out of an open
  session, and each deletion confirmed as another GitHub account is a row of `record` on the account: its
  kind and its time only, no address and no browser. The owner reads them on `GET /` and at
  `GET /api/account/records` (newest first, at most 100). A record older than 90 days (`RECORD_MS`) is
  deleted at the next write, not only hidden. A deleted account takes its records with it, and no record of
  the deletion stays: nobody could read it.
- **The privacy note** (part 4, R5): `cloud/privacy.ts`, served at `GET /privacy` and linked from `GET /`.
  It lists each column of the store, what it holds, why and for how long, and what hopper.io never keeps.
  `test/cloud/privacy.test.ts` holds it to the store's columns, so a new column without its line fails.
- **Registrations and their tombstones** (part 5, decision 5, with #465). `registration` keeps one
  instance id under one account, and when: the instance's own id (8 random bytes as hex), never its name.
  `cloud/link.ts` is hopper.io's side of the cloud link's registration messages, transport-free, as the
  instance's side (`src/http/cloud-link-messages.ts`): the connection (#464) is not built. When the
  instance answers `{ type: 'registration', outcome: 'registered' }` to the code its owner entered (a
  registration request, part 7 of #465), `registration()` keeps it; a second answer keeps no second row, and any other answer, shape or size
  (over 1024 bytes) keeps nothing. An account deletion deletes the registrations with the account
  (`ON DELETE CASCADE`) and, in the same statement, leaves a `registration_tombstone` for each: the
  instance id and the time, nothing of the account. At the instance's next hello, `hello()` answers
  `{ type: 'unregister', account }`, with the account the hello names, so the instance takes it as it
  takes an owner's removal: its link goes back to `pending`, and nothing else on it changes. An instance
  still registered under another account, and an instance hopper.io never knew, get no answer. A tombstone
  older than 90 days (`TOMBSTONE_MS`) is not read, and is deleted at the next deletion. When the instance
  registers again, its tombstone goes. This replaces the registration token of "How linked installs are
  told": the instance proves itself at its hello with its cloud link key (`docs/design.md` "Cloud link"),
  so hopper.io keeps no token for it.
- **An account's instances** (issue #465 part 6, `docs/design.md` "Instances at hopper.io"). One registration per
  instance id: an instance that registers under another account moves there. `registration.name` is the owner's name for
  it, typed at hopper.io; `registration.seen_at` is its last hello. The owner reads them at `GET /api/account/instances`
  and on `GET /`, names one (`POST /account/instances/:id/name`) and removes one (`POST /account/instances/:id/remove`,
  with a tombstone, so the instance's next hello is answered `unregister`). `unlinked()` in `cloud/link.ts` takes the
  instance's unlink notice and removes its registration. Tests: `test/cloud/instances.test.ts`.
- **Registration requests** (issue #465 part 7, `docs/design.md` "Registration requests at hopper.io"). The owner enters
  an instance id and its registration code on `GET /` (`POST /account/instances/register`). hopper.io keeps it in memory
  only (`cloud/requests.ts`), for 10 minutes, and `registerMessage` in `cloud/link.ts` gives it as `register` only to that
  instance while its link names the owner's account. `registration` takes the account from that request. The owner reads
  the open requests, and why an instance did not take a code, at `GET /api/account/registration-requests`. Tests:
  `test/cloud/registration-requests.test.ts`.
- **Instance states** (issue #465 part 8, `docs/design.md` "Instance states at hopper.io"). `snapshot` in `cloud/link.ts`
  takes an instance's state snapshot, checks it against hopper.io's own copy of the schema and a size cap, and keeps it in
  memory only (`cloud/states.ts`), while the instance is registered to the account its link names. `GET /api/account/instances`
  and `GET /` show each instance's machines under it, with when hopper.io got the state. A removal, an unlink, a move and
  an account deletion drop it. Tests: `test/cloud/instance-states.test.ts`.
- **Machine names** (issue #465 part 9, `docs/design.md` "Machine names at hopper.io"). The owner names a machine of the
  instance's state on `GET /` (`POST /account/instances/:id/machines/:key/name`); `machine_name` keeps it by the instance id
  and the machine's opaque key, at most 500 per instance. `GET /api/account/instances` gives each instance its
  `machineNames`. A removal, an unlink, a move and an account deletion drop them. Tests: `test/cloud/machine-names.test.ts`.
- Personal accounts only (decision 3). No route accepts a hopper.io session on an instance, and no
  instance realm changes (decision 4).
- Tests: `test/cloud/sign-in.test.ts`, `test/cloud/delete-account.test.ts`, `test/cloud/records.test.ts`,
  `test/cloud/registrations.test.ts` and `test/cloud/privacy.test.ts` (real Postgres, real
  server, a fake GitHub, `test/cloud/harness.ts`) and
  `test/cloud/config.test.ts` (the config, and the `cloud/` seam both ways).

## Run it

1. Register a GitHub App for hopper.io by hand. Give it no repository and no account permissions. Set its
   callback URL to `<public URL>/auth/github/callback`. Do not install it on any repository.
2. Start a Postgres for hopper.io. It is not an instance's database.
3. Set the runtime and start it with `npm run cloud`:

| Variable | Value |
|---|---|
| `HOPPER_IO_DATABASE_URL` | `postgres://…` (required) |
| `HOPPER_IO_PUBLIC_URL` | the origin people reach, https (http only on loopback) (required) |
| `HOPPER_IO_GITHUB_CLIENT_ID` | the hosted app's client id (required) |
| `HOPPER_IO_GITHUB_CLIENT_SECRET` or `HOPPER_IO_GITHUB_CLIENT_SECRET_FILE` | the hosted app's client secret (required) |
| `HOPPER_IO_GITHUB_URL` | GitHub's origin; default `https://github.com` |
| `HOPPER_IO_HOST`, `HOPPER_IO_PORT` | where it listens; default `127.0.0.1`, `8080` |
| `HOPPER_IO_TRUST_PROXY` | `1` behind a reverse proxy, so the sign-in limit counts the client's address |

No deploy is part of this: where hopper.io runs is decision 7 of #469.

## After the decisions

The implementation follows, in this order: the `account` table and GitHub sign-in at hopper.io
(built, part 2), account deletion (built, part 3), the records and the privacy note (built, part 4), the install registrations and their tombstones
(built, part 5, transport-free), then the cloud link's connection (#2039, the install side of #464), which carries the messages
and the hello, and the install side of the heartbeat. Each part adds its glossary entries and its row in
`docs/design.md` "Directories and what each must not know" in the same change.
