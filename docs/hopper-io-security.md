# hopper.io — threat model, account isolation and privacy

Issue #468, child of the cloud-hosting tracking issue #469. **Status: a design, written before any code.** No part of
hopper.io exists. This document states the threats and the rules that every hopper.io change must obey. The open owner
decisions of #469 (scope, what the link carries, transport, sign-in on installs, sharing, who operates hopper.io) do
not change these rules. Where a decision changes what a rule demands, the rule says so.

Terms: **hopper.io**, **hopper.io account**, **hopper.io link** and **hopper.io link key** (`docs/glossary.md`). An
**install** is one **instance**. The **link** and the **link key** of a machine (issue #308) are different things: this
document always writes "hopper.io link" for the install's connection.

## What we protect, and where it is

| Asset | Where it is today | Where it must stay |
|-------|-------------------|--------------------|
| Control of an install: jobs, questions, settings, plugins, sign-in | the install's database and its UI session (`POST /ui/api/*`) | the install. hopper.io gets no route that changes an install |
| Code execution on an install and its machines: jobs, plugins, command-bearing options (#198), box steps | the install and its machines | the install |
| GitHub access tokens and refresh tokens (#441, #658) | system secrets in the instance's vault | the install |
| The database URL, `HOPPER_MASTER_KEY`, `HOPPER_GITHUB_CLIENT_SECRET`, ssh keys (`src/secrets/runtime.ts`) | the runtime of the install | the install |
| Sealed secrets: vault secrets, shared secrets, system secrets (#451, #558, #658) | the install's database, sealed (`src/secrets/sealer.ts`) | the install |
| Client tokens and machine link keys (#308) | each end of a machine's link | the machine and the install |
| Job content: issue text, diffs, logs, artifacts, questions and answers | the install's database | the install |
| The list of an account's installs and machines, and their last-known state | — (new) | hopper.io, only what the dashboard shows |
| The hopper.io link key of each install | — (new) | the install (private half), hopper.io (public half) |

## Trust boundaries

1. **The install and hopper.io.** The install trusts hopper.io with nothing it can act on. The hopper.io link is
   outbound from the install. It carries allow-listed state out. By default nothing that comes in on it is a command.
2. **hopper.io accounts.** Each hopper.io account is one isolation unit at hopper.io. One account never reads or
   changes another account's records.
3. **A person and hopper.io.** A person signs in at hopper.io with GitHub (#463). A hopper.io session is not a UI session
   of any install, and an install does not accept it as one.
4. **The install and its machines.** Unchanged (#308). hopper.io is not a party to a machine's link.

## Threats

Each threat has: what an attacker gets, what stops it, and what stays (the residual risk).

### T1 — hopper.io is compromised

The attacker controls hopper.io's code, its database or its hosting.

- **What the attacker gets:** the records hopper.io keeps: account identities (GitHub login and id), the list of each
  account's installs and machines, their last-known state, and the public halves of the hopper.io link keys. The
  attacker can send any message down any open hopper.io link and can show false state on the dashboard.
- **What stops more:**
  - R1 (no control from hopper.io): an install acts on no message from hopper.io, except a remote action the
    install's admin turned on for that install (R2). With no opt-in, a compromised hopper.io can change nothing on an
    install.
  - R4 (credentials stay): hopper.io holds no credential of an install. A database dump of hopper.io gives no access to
    GitHub, to an install's database or to a machine.
  - R5 (minimal data): hopper.io keeps no job content, so a dump does not show it.
  - The install checks every message it gets against a closed schema and a size cap, and refuses the rest (R7). A
    refusal is an event on the install.
- **What stays:**
  - The dashboard can lie. A person must not take a security decision from what hopper.io shows alone.
  - If an install turned on remote actions (R2), the attacker can do those actions, within the roles the install
    gave them. The opt-in says so where the admin turns it on.
  - If the owner decides that the link carries the install's UI (#469 decision 3b), a compromised hopper.io can
    capture what a person types into that UI through it. The hopper.io link must then carry the UI end to end
    encrypted between the browser and the install, or the decision accepts this risk in writing.
  - If an install trusts hopper.io as a sign-in issuer (#469 decision 5b), a compromised hopper.io can sign in as any
    person that install maps to it. That realm must be off by default, its role rules must never give `admin` by
    default, and the install must list it as a residual risk where the admin turns it on.

### T2 — a stolen hopper.io link key

The attacker has the private half of one install's hopper.io link key.

- **What the attacker gets:** the attacker can connect to hopper.io as that install, and send false state for that
  install to the dashboard of the accounts it is registered to.
- **What stops more:**
  - The hopper.io link key is per install (R4). It opens nothing else: no other install, no account's sign-in, no
    machine.
  - The key is not derived from and gives no access to the install's secrets. It is not a machine's link key, a client
    token or the master key.
  - Rotation and revocation from either side (R4). A revoked key connects no more. A second connection with the same key
    replaces the first and is an event on both sides, so the true install sees that another end used its key.
- **What stays:** false dashboard state for that one install until the key is revoked.

### T3 — a malicious or compromised install

An install, or the person who runs it, attacks hopper.io or other accounts.

- **What the attacker gets:** the attacker controls everything that install sends.
- **What stops more:**
  - R3 (account isolation): hopper.io writes what an install sends only under the accounts that registered that
    install. An install cannot name another account, another install or another install's machines.
  - R7 (abuse limits): caps on connections, registrations and message sizes.
  - hopper.io parses state against a closed schema. It never runs, renders as HTML or follows what an install sends.
    Text fields are plain text and the dashboard escapes them.
- **What stays:** an install can lie about its own state. hopper.io shows what an install said, not what is true.

### T4 — a hopper.io account is taken over

The attacker signs in at hopper.io as a person.

- **What the attacker gets:** what the dashboard shows for that account. The attacker can register installs (with a
  code from the install, R4), unregister installs, and delete the account.
- **What stops more:**
  - hopper.io sign-in is GitHub only (#463), so GitHub's own controls (two-factor authentication) protect it.
  - R1: the hopper.io account gives no control of an install, unless that install turned on remote actions (R2).
  - Registration needs a one-time code that only the install's admin can mint on the install (the join code's shape,
    `src/machines/join-code.ts`). An attacker who holds the account cannot add an install the person does not run.
  - R6 (audit on both sides): every register, unregister and link event is a record that the account owner sees, and
    an event on the install.
  - Unregistering at hopper.io stops the dashboard. It does not change the install. The install's admin can revoke the
    hopper.io link from the install side too.
- **What stays:** the attacker can read last-known state and can do any remote action an install turned on (R2).

### T5 — one account reads another account's data

A bug or an attack at hopper.io shows one account's records to another account.

- **What stops it:** R3. Every record at hopper.io is keyed by account. Every query is scoped to the signed-in account
  in one place, not by each caller. Tests prove that one account cannot read or change another account's installs or
  machines.
- **What stays:** the data that leaks is only what R5 lets hopper.io keep.

## Rules

Each hopper.io change cites the rules it touches. A change that cannot obey a rule changes this document first, with the
owner's decision.

**R1 — hopper.io cannot run anything on an install.** By default the hopper.io link carries allow-listed state out of
the install only. The install acts on no message from hopper.io. The install starts the hopper.io link; hopper.io has no
way to open a connection to an install. The hopper still pulls: no job, question, webhook or setting comes from hopper.io.

**R2 — remote actions are an opt-in, per install.** A remote action (#469 decision 3c) runs only when:

- the install's admin turned it on for that install, through the UI session, one action kind at a time;
- the install maps the hopper.io account to one of its own users, and that user's role (`src/auth/roles.ts`) allows the
  action, the same as a UI session of that user;
- the install takes it as one `POST /ui/api/*`, through the same Access checks and box actions (`BOX_ACTIONS`) as a
  person's, never a route of its own;
- the install records it as an event, with the hopper.io account and the action.

Turned off, the install refuses each remote action and records the refusal. No remote action can change sign-in,
plugins, command-bearing options, the vault, remote access or the hopper.io link itself.

**R3 — account isolation at hopper.io.**

- Every record at hopper.io carries its account id. A record with no account is an error.
- Every query is scoped to the signed-in account by one data layer. A handler never builds an unscoped query.
- Tests: two accounts, each with installs and machines. Account A cannot list, read, change or delete account B's
  installs, machines, state, link events or audit records, by any route, also with B's ids in the request.
- An install registered to two accounts (#469 decision 6) is two registrations. Each account sees only its own.

**R4 — credentials stay where they are.**

- No GitHub token, refresh token, database URL, master key, sealed secret, vault secret, client token, machine link key,
  proxy token, API token or session ever goes on the hopper.io link. The allow-list (R5) has no field for one.
- The install scans each outgoing message for secrets before it sends it, and drops a message that holds one. The drop
  is an event on the install.
- **The hopper.io link key** is one X25519 key per install, minted on the install, kept as a system secret in the
  instance's vault. Only its public half goes to hopper.io. It is not a machine's link key.
- The install's admin can rotate it (a new key, the old one revoked after the new one connects) and revoke it, through
  the UI session or the operator CLI. The hopper.io account owner can revoke it at hopper.io. A revoked key connects no
  more, on either side.
- Registration takes a one-time code the install's admin mints (10 minutes, kept hashed, taken once).

**R5 — minimal data with stated retention.**

- hopper.io keeps only what the dashboard shows. The allow-list is a closed schema, versioned, in the install's code:
  the **hopper.io state snapshot** (`src/domain/hopper-io-state.ts`, issue #466; #464 sends it). A new field is a change to that schema and to the privacy note, in the same change.
- No job content goes out: no issue text, diffs, logs, artifacts, questions, answers, file paths, host names, IP
  addresses or people's names other than the account's own GitHub login.
- Last-known state has a retention period. After it, hopper.io deletes the state, not only hides it. The period is an
  owner decision (#469 decision 7).
- Deleting a hopper.io account deletes all its records at hopper.io. Unregistering an install deletes that install's
  records at hopper.io. Both revoke the hopper.io link key. Backups age out within a stated period.
- A short privacy note lists each field hopper.io collects, why, and for how long. It ships with the first hopper.io
  release.

**R6 — audit on both sides.** Each of these is an event on the install and a record at hopper.io that the account owner
can read: connect, disconnect, key rotation, revoke (and which side revoked), registration, unregistration, a refused
message (and why), a dropped outgoing message, and each remote action and its result. An install with no hopper.io
link records nothing of this.

**R7 — abuse limits.** hopper.io rate-limits hopper.io link connections per install and per address, registrations per
account and per address, and sign-ins. It caps the size of each message and the rate of messages per install. The install
caps what it takes from hopper.io the same way. A message over a cap is refused, not cut.

**R8 — self-hosting stays complete.** An install with no hopper.io link makes no outbound connection to hopper.io and
loses nothing (#469 non-goals). The hopper.io link is off until the install's admin turns it on.

## What each child issue must show

| Issue | Rules it must show it obeys |
|-------|-----------------------------|
| #463 GitHub account as the identity at hopper.io | R3, R7 (sign-in limits), T4 |
| #464 outbound link and what data leaves | R1, R4, R5 (the allow-list), R6, R7, R8, T1, T2 |
| #465 register installs and machines under one account | R3 (and its tests), R4 (registration code), R6 |
| #466 hosted dashboard | R3, R5 (shows only kept fields), T1 (the dashboard can lie), T3 (escaping) |
| #467 onboard an existing install | R4, R5 (no data migration), R8 |
| any remote action | R2 |

## Open questions (for #469)

- Who operates hopper.io, where it is hosted, and in which region (decision 7). This sets where the data of R5 is and
  which law applies to it.
- Whether hopper.io's code is public, so a person can check the data boundary of R5 (decision 7). If it is not public,
  the install's allow-list (R5) is the only boundary a person can read.
- The retention period of last-known state, and of backups (R5).
- Whether the hopper.io link carries the install's UI (decision 3b) or the install trusts hopper.io as an issuer
  (decision 5b). Both widen T1, as T1 says.
