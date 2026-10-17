# API tokens and grants

A grant lets an agent act for you over the API, unattended, for days. You make it one time, in the UI or with the command line. The agent then gets short-lived API tokens from it by itself. This page tells you how to make, refresh and revoke a grant, and how the hopper's admin sets the API-token lifetime.

## What a grant is

- The grant has a label, a holder (who keeps it, for example `grok-bot`), a role, scopes, and an optional box flag.
- Its role is `viewer`, `operator` or `admin`, and never higher than your role. When your sign-in gives you a lower role later, the grant gets that role too. When your sign-in gives you no role, the grant ends.
- Its **scopes** name the routes its tokens may use. A route that its scopes do not name is refused (`403`). See [Scopes](#scopes).
- It ends when you revoke it, when no refresh used it for 30 days, or at its end (90 days by default, 1 to 365 days). An admin can make a grant with no fixed end.
- The access service (OpenFGA) decides each use. When it does not run, no grant is made (503).
- The hopper keeps only hashes. You see the tokens one time, when the grant is made.
- An API token cannot make a grant.
- Only a **box grant** can do a box action: start a job, run a command, approve or merge work, update the hopper, or change the work on a machine (answer a question, end a wait, add a machine, apply lanes). See [Box grants](#box-grants).

## Refresh tokens and API tokens

When you make a grant, you get two tokens:

- The **refresh token** starts with `hopper_rt_`. The agent keeps it in its own secret store.
- The **API token** starts with `hopper_at_`. The agent sends it on each call. It lives 10 minutes by default. The hopper's admin sets this from 5 to 15 minutes in **Settings → API tokens**.

Before the API token ends, the agent gets a new pair:

```sh
curl -X POST http://localhost:4790/ui/auth/token/refresh \
  -H 'content-type: application/json' \
  -d '{"refresh": "hopper_rt_…"}'
```

The answer holds a new `token`, its `expiresAt`, and a new `refresh`. The agent must keep the new refresh token: the old one is spent.

- A retry within 30 seconds gets the same pair. A short network problem loses nothing.
- When a spent refresh token comes again later, someone may have stolen it. The hopper ends the whole grant at once, and records `api_grant.reuse_detected`. Subscribe a notifier or webhook to that event to be told.
- Each mint, refresh, reuse and end is an event of yours (`api_grant.minted`, `api_grant.refreshed`, `api_grant.reuse_detected`, `api_grant.revoked`).

## Scopes

A scope names routes by their area and their act:

| Route | Scope it needs |
|-------|----------------|
| `GET /api/<area>/…` | `<area>:read` |
| `POST /ui/api/<area>/…/<act>` | `<area>:<act>` |
| `POST /ui/api/<area>` | `<area>:edit` |

For example, `POST /ui/api/questions/:id/answer` needs `questions:answer`, and `POST /ui/api/sources/:name/intake` needs `sources:intake`. A grant holds `<area>:<act>`, `<area>:*`, `*:<act>` (`*:read` is every read) or `*` (everything its role allows).

Some routes do one of several actions. The body names the action, in `action` (or `kind`). Each action has a scope of its own: `<route scope>.<action>`. For example, `vault:edit.approve-template` lets an agent approve a vault template, and no other vault change. `sources:intake.approve` lets it approve a request card, and not assign or release an item. The route's scope (`vault:edit`) covers all of its actions. When a grant holds only some actions of a route, a request for another action gets `403`, and the answer names the scope it needs.

Every route has a scope. `GET /api/scopes` (or `hopper token scopes`) gives the full list, in sections by area of work. For each scope it gives what the scope lets an agent do, the routes it covers, the least role they need, and whether it is a box action. You do not need to know the scope names: the grant form shows the same list as boxes.

### Which scope approves what

| To approve | Scope | Only this action | Box action |
|------------|-------|------------------|------------|
| A request card, an assign, a release or a backburner in intake | `sources:intake` | `sources:intake.approve` (a request card) | yes |
| A held job | `jobs:approve` | | yes |
| A job's vault grant ask | `jobs:grant-vault` | | no |
| An infra plan (a high-risk one: a person confirms it) | `infra-plans:edit` | | yes |
| A vault template | `vault:edit` | `vault:edit.approve-template` | no |
| A template's profile (write, sync or apply: a person confirms it) | `vault:edit` | `vault:edit.approve-profile` | no |
| A credential request | `vault:edit` | `vault:edit.give-credential`, `vault:edit.decline-credential` | no |
| A question | `questions:answer` | | yes |
| A pull request merge | `pull-requests:merge` | | yes |
| Read the Needs you list | `*:read` | | no |

### What a person confirms

Some approvals are too risky for an agent alone. An API token does not approve:

- an infra plan whose risk is not low (it destroys, touches IAM, prod or data, or its risk is not known), and
- a template's write, sync or apply profile (a credential that can change something).

For these, the API answers `202` with `waiting`, and approves nothing. The hopper asks a person: it records the event `approval.confirmation_asked`, at most once an hour for an item. Subscribe a webhook (or a notifier that sends it) to that event to get the ask on your phone. The item shows who asked, on **Infra** or in **Access requests → Template approvals**. To confirm, approve the item there. Nothing else is needed: the agent asks again and sees it approved. A low-risk plan and a read profile the agent approves at once.

## Presets

A preset is a named set of scopes. On the grant form, one click ticks its boxes. You can then tick or clear more.

| Preset | Scopes | What a grant of it can do |
|--------|--------|---------------------------|
| **Read only** (`read-only`) | `*:read` | Reads everything you can see, the Needs you list included. Changes nothing. |
| **Agent: read everything and approve intake** (`agent-intake`) | `*:read`, `sources:intake` | Reads everything, and acts on intake: approves request cards, assigns issues to you, releases claims, takes issues off the backburner. A box grant. |
| **Agent: read everything and approve what waits** (`agent-approvals`) | `*:read`, `sources:intake`, `jobs:approve`, `jobs:grant-vault` | Reads everything, and approves request cards, held jobs and vault grant asks. A box grant. Infra plans and vault templates are not in it: tick them to add them. |
| **Full admin** (`full-admin`) | `*` | Everything your role allows, box actions included, and every route added later. |

`GET /api/scopes` gives the presets too. A grant made from a preset lives until it ends or you revoke it, and the agent refreshes it by itself: you do not mint again.

## Make a grant in the UI

1. Open **Settings → API tokens**.
2. Select **Mint grant**.
3. Fill in **Label**, **Holder**, the **Role — at most yours**, and how many days it lives at most.
4. Select a preset, for example **Agent: read everything and approve intake**. Its boxes are ticked.
5. Read the sections below the presets. Each one lists the permissions of one area of work: Jobs, Intake, Questions and reviews, Pull requests, Infra changes, Vault and credentials, Machines, and more. Tick or clear a box to add or remove one permission. A permission marked **box action** makes the grant a box grant. A permission marked **needs admin** does not work with a lower role.
6. Select **Mint grant**.
7. Copy the refresh token and the API token now. They are not shown again.

The list shows each live grant: its holder, role, scopes, when it was made, when and from where it was last used, and when it ends. **Revoke** ends one at once, with its API tokens. **Revoke all** ends every one.

## Make a grant from the command line

```sh
hopper token mint --label "nightly report" --scope '*:read' --role viewer
hopper token mint --label "Grok Bot" --holder grok-bot --scope '*:read' --scope questions:answer --scope sources:intake --role operator --box
hopper token mint --label "intake agent" --holder grok-bot --preset agent-intake --role operator
hopper token scopes
hopper token list
hopper token revoke <id>
hopper token revoke-all
```

`--preset` gives a preset's scopes, and its box flag unless you give `--box`. `--scope` adds more. `--role` is `admin` when you leave it out. `--days` sets its end (1 to 365); `--no-expiry` (an admin's only) gives it no fixed end; `--minutes` gives its API tokens a shorter life than the admin's setting.

## Let an agent ask for a grant

An agent can ask for a grant itself, with no token. You approve the ask in the UI. You do not copy a token to the agent.

1. The agent asks for the grant it needs. It names the same fields as a mint: `label`, `holder`, `role`, `scopes`, `preset`, `box`, `days`, `minutes`.

   ```sh
   curl -X POST http://localhost:4790/ui/auth/device-grant \
     -H 'content-type: application/json' \
     -d '{"label": "Grok Bot", "holder": "grok-bot", "preset": "agent-intake", "role": "operator"}'
   ```

   The answer holds a `deviceCode` (the agent keeps it and shows it to nobody), a `userCode` such as `BCDF-GHJK`, and `verificationPathComplete`, a link to **Settings → API tokens** that holds the code.
2. The agent shows you the code, or the link at the hopper's URL.
3. In **Settings → API tokens → Approve a device**, enter the code, or open the link. You see what the agent asks for and from where it asked. Approve only a code that the agent showed to you yourself.
4. Click **Approve** or **Deny**. When you approve, the grant is yours, as if you minted it: its role is at most yours, and its scopes are checked as at a mint.
5. The agent polls every `interval` seconds (5):

   ```sh
   curl -X POST http://localhost:4790/ui/auth/device-grant/poll \
     -H 'content-type: application/json' \
     -d '{"deviceCode": "hopper_dc_…"}'
   ```

   It gets `{"state": "waiting"}` until you answer. After you approve, it gets `{"state": "granted"}` with the grant's first API token and refresh token, one time. After you deny, it gets `403`.

An ask ends after 10 minutes, and when the hopper restarts. Then the agent asks again. At most 50 asks wait at one time.

From the command line:

```sh
hopper token device BCDF-GHJK     # what the ask is for
hopper token approve BCDF-GHJK    # --role sets the most role it can get (admin when you leave it out)
hopper token deny BCDF-GHJK
```

## Tie a grant to the agent's key

A refresh token is a password for the grant: whoever copies it can use the grant. You can tie a grant to a key that only the agent holds. Then a copied token alone does not work. This is DPoP (RFC 9449).

1. The agent makes a key pair (for example ES256 or Ed25519) and keeps the private key.
2. For each request that uses the grant, the agent signs a short proof with that key and sends it in the `DPoP` header. The proof names the method (`htm`), the full URL (`htu`), the time (`iat`, at most 60 seconds off the hopper's clock), a new random id (`jti`), and, with an API token, the token's SHA-256 in base64url (`ath`). DPoP libraries make it, for example `dpop` on npm.
3. The grant is tied to the key in one of three ways:
   - The agent sends a proof with its device grant request. The approval form then says **bound to the asking agent's key**.
   - You mint with the key's thumbprint: `"jkt": "<thumbprint>"`, or `hopper token mint --jkt <thumbprint>`. The thumbprint is the key's JWK SHA-256 thumbprint (RFC 7638), 43 characters.
   - The agent sends a proof with its first refresh.

After that, the grant works only with a proof of that key:

- A refresh without the proof gets `401`. The grant stays: a copied refresh token cannot end it.
- An API token of the grant goes as `Authorization: DPoP <token>`, with a proof. `Bearer` gets `401`.
- The refresh answer says `"tokenType": "DPoP"`.

The list shows **bound to its agent's key** for such a grant. To use a new key, revoke the grant and make a new one.

## Limit a grant to repositories or job sources

The scopes say which actions a grant can do. Limits say on what. A grant with limits changes only the work of the repositories and job sources that you name.

- In Settings → API tokens, fill in **Only these repositories** (`owner/name`, separated by commas), **Only these job sources**, or both.
- In the API, add `"limits": { "repos": ["acme/app"], "sources": ["github"] }` to the mint or to a device grant request.
- From the command line: `hopper token mint ... --repo acme/app --source github`. Repeat a flag for more.

Each action of the grant must then act on a job, question, research report, proposal, pull request or item of these repositories and job sources:

- An action on a job of another repository gets `403`.
- With repositories named, an action on a job with no repository gets `403`.
- An action that is not about one job or item, for example a change to a setting, gets `403`.
- Reads are not limited. The scopes alone decide what the grant reads.

The list shows the limits, for example **only acme/app**. An agent that asks by device code can name limits too. You see them before you approve.

## Exchange a sign-in for a token

An agent with no UI session can exchange a sign-in for one API token. It sends a token the hopper already accepts for reads: a GitHub token of your connected account, or the JWT an auth gateway forwards.

```sh
curl -X POST http://localhost:4790/ui/auth/api-token \
  -H "Authorization: Bearer $(gh auth token)" \
  -H 'content-type: application/json' \
  -d '{"label": "my agent", "minutes": 10}'
```

The answer holds `token`. It lives the admin's API-token lifetime at most, and it has no refresh token: the agent exchanges its sign-in again. The role is at most the one your sign-in settings give that account. The account must have signed in to the hopper before: this makes no new user. An exchange never gives a box token: `"box": true` gets `400`.

## Box grants

A box grant's API tokens may also do box actions, where its scopes allow. Only a person makes one: in **Settings → API tokens** (tick a permission marked **box action**), with `hopper token mint --box`, or with `"box": true` at `POST /ui/api/api-tokens` from a signed-in session. The list says `box` for each one.

- The access service decides each box action too (`api_token#can_run_on_box`). You can narrow it in **Settings → Access**.
- A token without box gets `403` on a box action: `this is a box action: it needs a box token`.
- Give a box grant only the scopes the agent needs.

## Use a token

Send it in the `Authorization` header on any `GET /api/*` read and any `POST /ui/api/*` change:

```sh
curl -H "Authorization: Bearer $HOPPER_TOKEN" http://localhost:4790/api/queue
curl -X POST -H "Authorization: Bearer $HOPPER_TOKEN" -H 'content-type: application/json' \
  -d '{"repos": {"owner/repo": true}}' http://localhost:4790/ui/api/yolo-mode
```

A change needs a JSON body. Events record the action with `via: api`, under your name.

## Revoke a grant

1. Open **Settings → API tokens**.
2. Select **Revoke** beside the grant. It ends at once, with every API token it made.
3. To end every grant you made, select **Revoke all**.

From the command line: `hopper token revoke <id>` or `hopper token revoke-all`. A revoke records `api_grant.revoked`.

A grant also ends by itself:

- when no refresh used it for 30 days;
- at its end;
- when a spent refresh token comes again (`api_grant.reuse_detected`);
- when your sign-in gives you no role.

## Set the API-token lifetime

Only the hopper's admin can do this.

1. Open **Settings → API tokens**.
2. In **API-token lifetime in minutes**, type a number from 5 to 15. The default is 10.
3. Select **Save**.

It applies to the API tokens issued from then on. A token already issued keeps its own end. A grant made with `--minutes` gives its API tokens a shorter life, never a longer one. The change records `api_tokens.settings_changed`.

A short lifetime limits what a stolen API token can do. The refresh token is the long-lived secret: the agent must keep it in a secret store.

## Reach the hopper from anywhere

An agent on another network reaches the API through remote access. See [Remote access](remote-access.md).
