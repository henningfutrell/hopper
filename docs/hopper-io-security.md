# hopper.io — threat model, account isolation and privacy

Issue #468, child of the cloud-hosting tracking issue #469. **Status: a design, written before any code.** hopper.io
itself does not exist. On the instance, only the cloud link's record (issue #467 part 1), its cloud link key (issue #467 part 2), its registration code (issue #465 part 2), its
unregistration (issue #465 part 3), the messages about them (issue #465 part 4) and the state snapshot the dashboard shows
(issue #466 parts 1 and 2) are built, and at hopper.io its GitHub sign-in, account deletion, records, registrations and their tombstones (issue #463 parts 2 to 5, `cloud/`)
("What is built" below).
This document states the threats and the rules that every hopper.io change must obey. The open owner
decisions of #469 (scope, what the link carries, transport, sign-in on instances, sharing, who operates hopper.io) do
not change these rules. Where a decision changes what a rule demands, the rule says so.

Terms: **hopper.io**, **hopper.io account**, **cloud link** and **cloud link key** (`docs/glossary.md`). The issues of
#469 say "install" for an **instance**; in the glossary an **install** is the directory the daemon runs from. The **link**
and the **link key** of a machine (issue #308) are different things: this document always writes "cloud link" for the
instance's link to hopper.io, its record and its connection.

## What we protect, and where it is

| Asset | Where it is today | Where it must stay |
|-------|-------------------|--------------------|
| Control of an instance: jobs, questions, settings, plugins, sign-in | the instance's database and its UI session (`POST /ui/api/*`) | the instance. hopper.io gets no route that changes an instance |
| Code execution on an instance and its machines: jobs, plugins, command-bearing options (#198), box steps | the instance and its machines | the instance |
| GitHub access tokens and refresh tokens (#441, #658) | system secrets in the instance's vault | the instance |
| The database URL, `HOPPER_MASTER_KEY`, `HOPPER_GITHUB_CLIENT_SECRET`, ssh keys (`src/secrets/runtime.ts`) | the runtime of the instance | the instance |
| Sealed secrets: vault secrets, shared secrets, system secrets (#451, #558, #658) | the instance's database, sealed (`src/secrets/sealer.ts`) | the instance |
| Client tokens and machine link keys (#308) | each end of a machine's link | the machine and the instance |
| Job content: issue text, diffs, logs, artifacts, questions and answers | the instance's database | the instance |
| The list of an account's instances and machines, and their last-known state | — (new) | hopper.io, only what the dashboard shows |
| The cloud link key of each instance | — (new) | the instance (private half), hopper.io (public half) |

## Trust boundaries

1. **The instance and hopper.io.** The instance trusts hopper.io with nothing it can act on. The cloud link is
   outbound from the instance. It carries allow-listed state out. By default nothing that comes in on it is a command.
2. **hopper.io accounts.** Each hopper.io account is one isolation unit at hopper.io. One account never reads or
   changes another account's records.
3. **A person and hopper.io.** A person signs in at hopper.io with GitHub (#463). A hopper.io session is not a UI session
   of any instance, and an instance does not accept it as one.
4. **The instance and its machines.** Unchanged (#308). hopper.io is not a party to a machine's link.

## Threats

Each threat has: what an attacker gets, what stops it, and what stays (the residual risk).

### T1 — hopper.io is compromised

The attacker controls hopper.io's code, its database or its hosting.

- **What the attacker gets:** the records hopper.io keeps: account identities (GitHub login and id), the list of each
  account's instances and machines, their last-known state, and the public halves of the cloud link keys. The
  attacker can send any message down any open cloud link and can show false state on the dashboard.
- **What stops more:**
  - R1 (no control from hopper.io): an instance acts on no message from hopper.io, except a remote action the
    instance's admin turned on for that instance (R2). With no opt-in, a compromised hopper.io can change nothing on an
    instance.
  - R4 (credentials stay): hopper.io holds no credential of an instance. A database dump of hopper.io gives no access to
    GitHub, to an instance's database or to a machine.
  - R5 (minimal data): hopper.io keeps no job content, so a dump does not show it.
  - The instance checks every message it gets against a closed schema and a size cap, and refuses the rest (R7). A
    refusal is an event on the instance.
- **What stays:**
  - The dashboard can lie. A person must not take a security decision from what hopper.io shows alone.
  - If an instance turned on remote actions (R2), the attacker can do those actions, within the roles the instance
    gave them. The opt-in says so where the admin turns it on.
  - If the owner decides that the link carries the instance's UI (#469 decision 3b), a compromised hopper.io can
    capture what a person types into that UI through it. The cloud link must then carry the UI end to end
    encrypted between the browser and the instance, or the decision accepts this risk in writing.
  - If an instance trusts hopper.io as a sign-in issuer (#469 decision 5b), a compromised hopper.io can sign in as any
    person that instance maps to it. That realm must be off by default, its role rules must never give `admin` by
    default, and the instance must list it as a residual risk where the admin turns it on.

### T2 — a stolen cloud link key

The attacker has the private half of one instance's cloud link key.

- **What the attacker gets:** the attacker can connect to hopper.io as that instance, and send false state for that
  instance to the dashboard of the accounts it is registered to.
- **What stops more:**
  - The cloud link key is per instance (R4). It opens nothing else: no other instance, no account's sign-in, no
    machine.
  - The key is not derived from and gives no access to the instance's secrets. It is not a machine's link key, a client
    token or the master key.
  - Rotation and revocation from either side (R4). A revoked key connects no more. A second connection with the same key
    replaces the first and is an event on both sides, so the true instance sees that another end used its key.
- **What stays:** false dashboard state for that one instance until the key is revoked.

### T3 — a malicious or compromised instance

An instance, or the person who runs it, attacks hopper.io or other accounts.

- **What the attacker gets:** the attacker controls everything that instance sends.
- **What stops more:**
  - R3 (account isolation): hopper.io writes what an instance sends only under the accounts that registered that
    instance. An instance cannot name another account, another instance or another instance's machines.
  - R7 (abuse limits): caps on connections, registrations and message sizes.
  - hopper.io parses state against a closed schema. It never runs, renders as HTML or follows what an instance sends.
    Text fields are plain text and the dashboard escapes them.
- **What stays:** an instance can lie about its own state. hopper.io shows what an instance said, not what is true.

### T4 — a hopper.io account is taken over

The attacker signs in at hopper.io as a person.

- **What the attacker gets:** what the dashboard shows for that account. The attacker can register instances (with a
  code from the instance, R4), unregister instances, and delete the account.
- **What stops more:**
  - hopper.io sign-in is GitHub only (#463), so GitHub's own controls (two-factor authentication) protect it.
  - R1: the hopper.io account gives no control of an instance, unless that instance turned on remote actions (R2).
  - Registration needs a one-time code that only the instance's admin can mint on the instance (the join code's shape,
    `src/machines/join-code.ts`). An attacker who holds the account cannot add an instance the person does not run.
  - R6 (audit on both sides): every register, unregister and link event is a record that the account owner sees, and
    an event on the instance.
  - Unregistering at hopper.io stops the dashboard. It does not change the instance. The instance's admin can revoke the
    cloud link from the instance side too.
- **What stays:** the attacker can read last-known state and can do any remote action an instance turned on (R2).

### T5 — one account reads another account's data

A bug or an attack at hopper.io shows one account's records to another account.

- **What stops it:** R3. Every record at hopper.io is keyed by account. Every query is scoped to the signed-in account
  in one place, not by each caller. Tests prove that one account cannot read or change another account's instances or
  machines.
- **What stays:** the data that leaks is only what R5 lets hopper.io keep.

## Rules

Each hopper.io change cites the rules it touches. A change that cannot obey a rule changes this document first, with the
owner's decision.

**R1 — hopper.io cannot run anything on an instance.** By default the cloud link carries allow-listed state out of
the instance only. The instance acts on no message from hopper.io. The instance starts the cloud link; hopper.io has no
way to open a connection to an instance. The hopper still pulls: no job, question, webhook or setting comes from hopper.io.

**R2 — remote actions are an opt-in, per instance.** A remote action (#469 decision 3c) runs only when:

- the instance's admin turned it on for that instance, through the UI session, one action kind at a time;
- the instance maps the hopper.io account to one of its own users, and that user's role (`src/auth/roles.ts`) allows the
  action, the same as a UI session of that user;
- the instance takes it as one `POST /ui/api/*`, through the same Access checks and box actions (`BOX_ACTIONS`) as a
  person's, never a route of its own;
- the instance records it as an event, with the hopper.io account and the action.

Turned off, the instance refuses each remote action and records the refusal. No remote action can change sign-in,
plugins, command-bearing options, the vault, remote access or the cloud link itself.

**R3 — account isolation at hopper.io.**

- Every record at hopper.io carries its account id. A record with no account is an error.
- Every query is scoped to the signed-in account by one data layer. A handler never builds an unscoped query.
- Tests: two accounts, each with instances and machines. Account A cannot list, read, change or delete account B's
  instances, machines, state, link events or audit records, by any route, also with B's ids in the request.
- An instance registered to two accounts (#469 decision 6) is two registrations. Each account sees only its own.

**R4 — credentials stay where they are.**

- No GitHub token, refresh token, database URL, master key, sealed secret, vault secret, client token, machine link key,
  proxy token, API token or session ever goes on the cloud link. The allow-list (R5) has no field for one.
- The instance scans each outgoing message for secrets before it sends it, and drops a message that holds one. The drop
  is an event on the instance.
- **The cloud link key** is one X25519 key per instance, minted on the instance, kept as a system secret in the
  instance's vault. Only its public half goes to hopper.io. It is not a machine's link key.
- The instance's admin can rotate it (a new key, the old one revoked after the new one connects) and revoke it, through
  the UI session or the operator CLI. Until the cloud link connects (issue #464), nothing connects with a key, so a
  rotation replaces the key at once, and an unlink revokes it by dropping it. The hopper.io account owner can revoke it at hopper.io. A revoked key connects no
  more, on either side.
- Registration takes a one-time code the instance's admin mints (10 minutes, kept hashed, taken once).

**R5 — minimal data with stated retention.**

- hopper.io keeps only what the dashboard shows. The allow-list is a closed schema, versioned, in the instance's code:
  the **hopper.io state snapshot** (`src/domain/hopper-io-state.ts`, issue #466; #464 sends it). A new field is a change to that schema and to the privacy note, in the same change.
- No job content goes out: no issue text, diffs, logs, artifacts, questions, answers, file paths, host names, IP
  addresses or people's names other than the account's own GitHub login.
- Last-known state has a retention period. After it, hopper.io deletes the state, not only hides it. The period is an
  owner decision (#469 decision 7).
- Deleting a hopper.io account deletes all its records at hopper.io. Unregistering an instance deletes that instance's
  records at hopper.io. Both revoke the cloud link key. Backups age out within a stated period.
- A short privacy note lists each field hopper.io collects, why, and for how long. It ships with the first hopper.io
  release.

**R6 — audit on both sides.** Each of these is an event on the instance and a record at hopper.io that the account owner
can read: connect, disconnect, key rotation, revoke (and which side revoked), registration, unregistration, a refused
message (and why), a dropped outgoing message, and each remote action and its result. An instance with no hopper.io
link records nothing of this.

**R7 — abuse limits.** hopper.io rate-limits cloud link connections per instance and per address, registrations per
account and per address, and sign-ins. It caps the size of each message and the rate of messages per instance. The instance
caps what it takes from hopper.io the same way. A message over a cap is refused, not cut.

**R8 — self-hosting stays complete.** An instance with no cloud link makes no outbound connection to hopper.io and
loses nothing (#469 non-goals). The cloud link is off until the instance's admin turns it on.

## What is built

- **The cloud link's record** (issue #467 part 1, `docs/design.md` "The cloud link"): the instance's settings key
  `cloudLink`, which the instance admin writes and deletes through the UI session (`POST /ui/api/cloud-link`,
  `POST /ui/api/cloud-link/unlink`). It is the switch of R8: with no record the instance has no cloud link. It obeys:
  - R1, R8: it makes no connection to hopper.io at all, linked or not.
  - R4: it holds no credential. Its `installId` is the instance id (issue #465 part 2), and opens nothing.
  - R5: a link moves no data (`test/http/cloud-link-fixture.test.ts` compares every row of every schema before and after).
  - R6, on the instance side: `cloud_link.linked` and `cloud_link.unlinked`, with who.
- **The cloud link key** (issue #467 part 2, `docs/design.md` "The cloud link key"): minted at the link, one X25519 key,
  its private half the system secret `cloud-link.key` in the instance's vault, sealed under the master key, its public
  half in the link record. It obeys:
  - R4: the private half is a system secret, never answered by a route, in an event or in the record; the instance admin
    rotates it through the UI session (`POST /ui/api/cloud-link/rotate-key`); an unlink drops it. No operator CLI command
    and no revocation from hopper.io's side yet: both come with the connection (issue #464).
  - R1, R8: nothing uses it yet; it makes no connection.
  - R5: a link writes only the record, the code and this one vault row (`test/http/cloud-link-fixture.test.ts`).
  - R6, on the instance side: `vault.secret_set` (with `rotated`) and `vault.secret_removed`, with who and no value.
- **The instance's half of registration** (issue #465 part 2, `docs/design.md` "Registering at hopper.io"). It obeys:
  - R4: the **registration code** is minted only by the instance admin, through the UI session, while the instance is
    linked; 10 minutes, kept only as its SHA-256, taken once, one at a time; never in a view or an event.
  - R3: the instance registers only for the hopper.io account its admin linked; a code handed back for another account is
    refused. The link's id is the instance id, so one instance is one registration per account.
  - R6, on the instance side: `cloud_link.registration_code_minted` and `cloud_link.registered`.
- **The instance's half of unregistering at hopper.io** (issue #465 part 3, `docs/design.md` "Unregistering at
  hopper.io"). It obeys:
  - R1, R8: hopper.io's removal changes only the link's registration state, back to `pending`. The link record stays, so
    the cloud link stays on or off as the instance's admin set it; nothing else on the instance changes.
  - R3: only a removal for the linked hopper.io account counts; one for another account changes nothing.
  - R6, on the instance side: `cloud_link.unregistered`.
- **The cloud link's messages about registration** (issue #465 part 4, `docs/design.md` "The cloud link's messages"),
  transport-free: what the agent hands on from hopper.io and answers. It obeys:
  - R1: only `register` and `unregister` come in, and each changes the registration only, as parts 2 and 3.
  - R7: each message is checked against a closed schema and a cap of 1024 bytes; anything else is refused, not cut.
  - R6, on the instance side: `cloud_link.message_refused`, with the reason only.
  - R5: what goes out is the outcome, and before an unlink the instance id and the account.
- **The hopper.io state snapshot and what hopper.io would get** (issue #466 parts 1 and 2, `docs/design.md` "The
  hopper.io state snapshot"). It obeys:
  - R5: the schema `HOPPER_IO_STATE_SCHEMA` (`src/domain/hopper-io-state.ts`) is the allow-list: counts, closed states and
    an opaque machine key, never free text. The instance makes it from its live state and checks it against the schema.
  - R5: the instance admin reads it in Settings → hopper.io (`GET /api/cloud-link/state`) before anything is sent: the
    data boundary a person can read on their own instance.
  - R1, R8: making it and reading it sends nothing and changes nothing.
- **The executors each machine offers, in the hopper.io state snapshot** (issue #465 part 5, `docs/design.md` "The
  machines the link reports"), `schema: 2`. It obeys:
  - R5: only the kind of each executor goes out, from a closed list of the built-in executor plugins, else `other`. Never
    an executor's name from the plugins config, which can hold a host name, and never a third-party plugin's id.
- **GitHub sign-in at hopper.io** (issue #463 part 2, `cloud/`, `docs/cloud-hosting-identity.md` "What is built"). It
  obeys:
  - T4: sign-in is GitHub only, through hopper.io's own GitHub App with no permissions, so GitHub's own controls protect
    the account. The **hopper.io account** is keyed by GitHub's numeric user id, never the login.
  - R3: the `account` table is keyed by the account; every `session` row carries its account. `sign_in` holds no
    account: it is a sign-in under way, before GitHub named one, kept 10 minutes. The one route that reads an account
    (`GET /api/account`) reads only the signed-in one; `test/cloud/sign-in.test.ts` signs in two accounts.
  - R4: hopper.io keeps no GitHub token. The access token is dropped after `GET /user`. A hopper.io session is kept only
    as its SHA-256, and no instance accepts it.
  - R5: it keeps the login and the avatar URL for display and nothing else of GitHub's answer.
  - R7: sign-ins are rate-limited per address (`SIGN_IN_LIMIT`).
  - T4, R5: **account deletion** (issue #463 part 3) needs a fresh GitHub sign-in as the same account, not only a
    hopper.io session, so a stolen session cannot delete the account. It deletes the account and all its sessions in
    one statement, and then the person's grant of the hosted app at GitHub. It keeps nothing of the account: no
    login, no id. Its registrations go with it; a **registration tombstone** of each keeps the instance id and
    the time only, for 90 days, so the instance learns it at its next hello (part 5, below).
  - R6, at hopper.io: a **hopper.io record** of each sign-in, sign-out and deletion confirmed as another GitHub
    account (issue #463 part 4), which the account owner reads at `GET /` and `GET /api/account/records`, and only
    their own (R3). A record is its kind and its time: no address, no browser, no other person (R5).
  - R5: records are kept 90 days and then deleted; a deleted account takes them with it. The **privacy note**
    (`cloud/privacy.ts`, `GET /privacy`) lists each column of hopper.io's store, why and for how long;
    `test/cloud/privacy.test.ts` fails when a column has no line in it.
  - R3: a **hopper.io registration** (issue #463 part 5, `cloud/link.ts`) is kept only for the account whose owner
    entered the code, and only when the instance answered `registered`; R7: that answer is checked against a closed
    schema and a cap of 1024 bytes, as the instance checks hopper.io's messages. R1: the tombstone's answer is
    `unregister`, a message the instance already takes, which changes its registration only.
  - Not yet: the R6 records of registration, the cloud link and remote actions at hopper.io (with #465 and #464),
    and the connection that carries the registration messages and the hello (#464).
- Nothing else. The connection (and so who carries these messages and sends the snapshot), the cloud link key and
  everything at hopper.io wait for the issues in the table below. The connection's design — its data boundary, no inbound
  actions, and its transport (one WebSocket over TLS that the instance opens, with hopper.io's key pinned) — is
  `docs/design.md` "Cloud link" (issue #464), a design, not built.

## What each child issue must show

| Issue | Rules it must show it obeys |
|-------|-----------------------------|
| #463 GitHub account as the identity at hopper.io | R3, R7 (sign-in limits), T4 |
| #464 outbound link and what data leaves | R1, R4, R5 (the allow-list), R6, R7, R8, T1, T2 |
| #465 register instances and machines under one account | R3 (and its tests), R4 (registration code), R6 |
| #466 hosted dashboard | R3, R5 (shows only kept fields), T1 (the dashboard can lie), T3 (escaping) |
| #467 onboard an existing instance | R4, R5 (no data migration), R8. Complete: parts 1 and 2 obey them ("What is built"); the connection is #464's install side and obeys the rules of #464 |
| any remote action | R2 |

## Open questions (for #469)

- Who operates hopper.io, where it is hosted, and in which region (decision 7). This sets where the data of R5 is and
  which law applies to it.
- Whether hopper.io's code is public, so a person can check the data boundary of R5 (decision 7). If it is not public,
  the instance's allow-list (R5) is the only boundary a person can read.
- The retention period of last-known state, and of backups (R5).
- Whether the cloud link carries the instance's UI (decision 3b) or the instance trusts hopper.io as an issuer
  (decision 5b). Both widen T1, as T1 says.
