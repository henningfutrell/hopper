# Command line and API

Everything you do in the hopper's UI, a script or an agent can also do: with the `hopper` command line on the hopper's host, or over the HTTP API with a short-lived API token. This page lists the commands, tells you how to get a token, and where to find the API reference and these help pages.

## Which one to use

| You are | Use |
|---|---|
| A person or a script on the hopper's host | The operator command line, `hopper`. It needs no sign-in. |
| An agent or a service on another machine | The HTTP API with an API token. |
| A job the hopper runs | The helpers in the job: `sh "$HOPPER_ARTIFACT"`, `sh "$HOPPER_GH"`, `sh "$HOPPER_SKILL"`. A job never gets an API token. |

## The operator command line

`hopper` works on the hopper's database. Whoever runs it holds the database's credentials, so it needs no sign-in.

1. Run it where the hopper runs. In the container install, run `podman compose exec hopper hopper <command>`.
2. Make sure `HOPPER_DATABASE_URL` (or `HOPPER_DATABASE_URL_FILE`) is set: the database the hopper uses. Every command but `help` and `update` needs it.
3. Run `hopper help` to read every command.

Most commands act on the **running** hopper, as a click in the UI does. They pass the same checks and record the same events, with `via: cli`. For these commands:

- `--url <address>` names the hopper. The default is `HOPPER_URL`, else `http://127.0.0.1:<HOPPER_PORT>` (port 4790 by default).
- `--user <id>` names the user when the hopper has more than one. `hopper users` lists them.
- Each command prints the hopper's answer as JSON. Exit code 2 is a refusal or a bad call, with the reason.

A secret never goes on the command line. `hopper vault set` and `hopper typesafe-key set` read the value from standard input.

## Commands

### Setup and users

| Command | What it does |
|---|---|
| `hopper config get\|version <record>` | Print a config record as JSON, or its version. Records: `plugins`, `rules`, `job-rules`, `sign-in`. |
| `hopper config set <record> --if-version <v>` | Replace it with the JSON on standard input, if it is still at version `v`. |
| `hopper users` | The users: id, name, when added. |
| `hopper user add <name>` | Add a user. |
| `hopper user transfer <from> <to>` | `<to>` takes over the work of `<from>`. Stop the hopper first. |
| `hopper join-code` | A one-time join code for 10 minutes. A machine joins with `<hopper address>#<code>`. |
| `hopper ssh-key` | The public half of the hopper's ssh key. |
| `hopper update <tool>\|compose\|skill` | Print the update script of a container install, the compose file, or the update steps for an agent. Needs no database. See [Deploy and update](deploy-and-update.md). |

### Jobs and the queue

| Command | What it does |
|---|---|
| `hopper job accept <id>` | Let a waiting job through the queue gate. |
| `hopper job reject <id> [--reason <text>]` | Reject a waiting job. |
| `hopper job rerun <id>` | Run a failed, finished or rejected job again. |
| `hopper job rework <id> --notes <text>` | Send a done job's pull request back for rework. |
| `hopper job keep-original <id>` | A job held because its issue changed runs the original text. |
| `hopper job accept-new-text <id>` | It runs the new text (the owner only). |
| `hopper queue order <id>...` | Put these waiting jobs first, in this order. |
| `hopper queue gate auto-accept\|review [--per-hour <n>\|none]` | Set the queue gate. |

### Questions, proposals and failures

| Command | What it does |
|---|---|
| `hopper question list [--reason <reason>]` | The open questions, with why each came to a person. |
| `hopper question answer <id> <text>` | Answer. The job goes on. |
| `hopper question close\|dismiss <id>` | Close it without an answer, or drop it and cancel its job. |
| `hopper proposal list`, `hopper proposal paths <id>` | The open proposals, or one proposal's paths. |
| `hopper proposal select <id> <path>... [--path-note <path>=<text>]... [--note <text>]` | Continue with the paths you select. |
| `hopper proposal accept\|more-paths\|steer\|reject <id> …` | The other actions of a proposal card. |
| `hopper problem list\|release <id>\|resolve <id> [--note <text>]` | Problems that hold jobs. |
| `hopper handoff list\|continue\|fixed\|done-by-hand\|wont-do …` | Needs a person. |
| `hopper failure list\|retry <id>` | Failed jobs. |
| `hopper backfill done-check` | Judge again each done-check failure that waits on a person. |
| `hopper auto-park [set [--minutes <n>] [--high-priority-minutes <n>]]` | Read or set how long a question waits before its job parks. 0 turns it off. |

See [Questions](questions.md) for what each action does.

### Pull requests and repositories

| Command | What it does |
|---|---|
| `hopper prs` | The Pull requests list. |
| `hopper pr merge\|close <n> [--repo <owner/repo>]` | **Merge now** or **Close PR** on a waiting pull request. |
| `hopper yolo <owner/repo> on\|off\|default` | Yolo mode for one repository. |
| `hopper repo checks <owner/repo>` | A repository's checks and its setup on GitHub. |

See [Pull requests](pull-requests.md).

### Lanes and artifacts

| Command | What it does |
|---|---|
| `hopper lanes plan\|costs` | Lane recommendations, or job cost profiles. |
| `hopper lanes tune <machine> [--auto on\|off] [--min <n>] [--max <n>]` | A machine's lane tuning. |
| `hopper lanes apply\|dismiss\|undo <machine>` | Act on a lane recommendation. |
| `hopper artifact list\|get\|revisions\|restore\|revise\|merge\|share\|revoke\|rm …` | Artifacts. |

See [Lanes and lane tuning](lanes.md) and [Artifacts](artifacts.md).

### Vault, sandboxes and keys

| Command | What it does |
|---|---|
| `hopper vault` | The vault: its secrets and templates, never a value. |
| `hopper vault set <name> [--scope <text>] [--shared [--reader <user id>]...]` | Set a secret from standard input. |
| `hopper vault remove <name> [--shared]` | Remove a secret. |
| `hopper vault mint-test aws-role/<account>/<role>` | Test an AWS minting credential. |
| `hopper template list\|save\|approve\|approve-profile\|revoke\|remove\|check\|read-policy …` | Sandbox templates. |
| `hopper sandbox list\|launch …` | Sandbox boxes. |
| `hopper master-key status` | Where the master key came from, and its fingerprint. Never the key. |
| `hopper master-key rotate` | Make a new master key. It is printed one time: save it. |
| `hopper typesafe-key [set\|remove]` | Jev's TypeSafe API key. |
| `hopper token mint\|list\|revoke\|revoke-all …` | Grants and API tokens (below). |

See [Vault](vault.md) and [Sandboxes](sandboxes.md).

## API tokens

A **grant** lets an agent act for you over the API, unattended, for days. You make it one time. The agent then gets short-lived **API tokens** from it by itself.

- The grant has a label, a holder (who keeps it, for example `grok-bot`), a role, scopes, and an optional box flag.
- Its role is `viewer`, `operator` or `admin`, and never higher than your role. When your sign-in gives you a lower role later, the grant gets that role too. When your sign-in gives you no role, the grant ends.
- Its **scopes** name the routes its tokens may use. A route that its scopes do not name is refused (`403`). See [Scopes](#scopes).
- It ends when you revoke it, when no refresh used it for 30 days, or at its end (90 days by default, 1 to 365 days). An admin can make a grant with no fixed end.
- The access service (OpenFGA) decides each use. When it does not run, no grant is made (503).
- The hopper keeps only hashes. You see the tokens one time, when the grant is made.
- An API token cannot make a grant.
- Only a **box grant** can do a box action: start a job, run a command, approve or merge work, update the hopper, or change the work on a machine (answer a question, end a wait, add a machine, apply lanes). See [Box grants](#box-grants).

### Refresh tokens and API tokens

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

### Scopes

A scope names routes by their area and their act:

| Route | Scope it needs |
|-------|----------------|
| `GET /api/<area>/…` | `<area>:read` |
| `POST /ui/api/<area>/…/<act>` | `<area>:<act>` |
| `POST /ui/api/<area>` | `<area>:edit` |

For example, `POST /ui/api/questions/:id/answer` needs `questions:answer`, and `POST /ui/api/sources/:name/intake` needs `sources:intake`. A grant holds `<area>:<act>`, `<area>:*`, `*:<act>` (`*:read` is every read) or `*` (everything its role allows). `GET /api/api-tokens` lists every scope there is.

### Make a grant in the UI

1. Open **Settings → API tokens**.
2. Select **Mint grant**.
3. Fill in **Label**, **Holder**, the **Role — at most yours**, the **Scopes**, and how many days it lives at most. Tick **Box grant** only when the agent must do box actions.
4. Select **Mint grant**.
5. Copy the refresh token and the API token now. They are not shown again.

The list shows each live grant: its holder, role, scopes, when it was made, when and from where it was last used, and when it ends. **Revoke** ends one at once, with its API tokens. **Revoke all** ends every one.

### Make a grant from the command line

```sh
hopper token mint --label "nightly report" --scope '*:read' --role viewer
hopper token mint --label "Grok Bot" --holder grok-bot --scope '*:read' --scope questions:answer --scope sources:intake --role operator --box
hopper token list
hopper token revoke <id>
hopper token revoke-all
```

`--role` is `admin` when you leave it out. `--days` sets its end (1 to 365); `--no-expiry` (an admin's only) gives it no fixed end; `--minutes` gives its API tokens a shorter life than the admin's setting.

### Exchange a sign-in for a token

An agent with no UI session can exchange a sign-in for one API token. It sends a token the hopper already accepts for reads: a GitHub token of your connected account, or the JWT an auth gateway forwards.

```sh
curl -X POST http://localhost:4790/ui/auth/api-token \
  -H "Authorization: Bearer $(gh auth token)" \
  -H 'content-type: application/json' \
  -d '{"label": "my agent", "minutes": 10}'
```

The answer holds `token`. It lives the admin's API-token lifetime at most, and it has no refresh token: the agent exchanges its sign-in again. The role is at most the one your sign-in settings give that account. The account must have signed in to the hopper before: this makes no new user. An exchange never gives a box token: `"box": true` gets `400`.

### Box grants

A box grant's API tokens may also do box actions, where its scopes allow. Only a person makes one: in **Settings → API tokens** (tick **Box grant**), with `hopper token mint --box`, or with `"box": true` at `POST /ui/api/api-tokens` from a signed-in session. The list says `box` for each one.

- The access service decides each box action too (`api_token#can_run_on_box`). You can narrow it in **Settings → Access**.
- A token without box gets `403` on a box action: `this is a box action: it needs a box token`.
- Give a box grant only the scopes the agent needs.

### Use a token

Send it in the `Authorization` header on any `GET /api/*` read and any `POST /ui/api/*` change:

```sh
curl -H "Authorization: Bearer $HOPPER_TOKEN" http://localhost:4790/api/queue
curl -X POST -H "Authorization: Bearer $HOPPER_TOKEN" -H 'content-type: application/json' \
  -d '{"repos": {"owner/repo": true}}' http://localhost:4790/ui/api/yolo-mode
```

A change needs a JSON body. Events record the action with `via: api`, under your name.

## How the API works

| Request | What it needs |
|---|---|
| `GET /api/*` from the hopper's own host (`127.0.0.1`, `localhost`) | Nothing, while the hopper has one user. |
| `GET /api/*` from a LAN address or the public URL | A UI session, an API token, or a sign-in token (a GitHub token of a connected account, or a gateway JWT). |
| `POST /ui/api/*` (every change) | A UI session with the exact Origin of a UI page, or an API token. The role must allow the change. A JSON body. |

Every action of the UI is a `POST /ui/api/*` route, so every action is also an API action. No route makes a job: jobs come from job sources. A request with another `Host` than the hopper's gets 421.

| Status | Meaning |
|---|---|
| 400 | The request is malformed. |
| 401 | No session or token, or the token is unknown, revoked or expired. |
| 403 | Refused: the role is too low, the Origin is wrong, the body is not JSON, or the access service said no. |
| 404 | Nothing by that id. |
| 409 | Not possible now. |
| 503 | The access service (OpenFGA) cannot be asked. |

Every error answer is `{ "error": "<the reason>" }`.

## The API reference

- `/docs/` is the API reference: every route, with its parameters, its body and the role it needs. You can try a route from the page. The book icon in the UI's top bar opens it.
- `/docs/openapi.json` (or `/docs/openapi.yaml`) is the OpenAPI document of the version that runs.

Both need no sign-in.

## Help for agents

These help pages are served by the hopper, for the version that runs. They need no sign-in.

| Address | What it is |
|---|---|
| `/help/` | The contents, as a page. In the UI, open the user menu and select **Help**. |
| `/help/<page>` | One page, as HTML. |
| `/help/<page>.md` | The same page as Markdown. |
| `/help/index.json` | Every page: its name, title, summary and both addresses. |

An agent that reaches the hopper's URL reads `/help/index.json` to find a page, then `/help/<page>.md`. A job the hopper runs reads the same pages with `sh "$HOPPER_SKILL" help [PAGE]`: that works on every machine, also where the job reaches the hopper only through its client.

## Troubleshooting

| You see | Do this |
|---|---|
| `HOPPER_DATABASE_URL is not set` | Set it to the database the hopper uses, or run the command in the hopper's container. |
| `no hopper answers at …: is the daemon running?` | Start the hopper, or give its address with `--url`. |
| `several users: name one with --user` | Add `--user <id>`. `hopper users` lists the ids. |
| `refused (403): …` from a token | The token's role is too low, or Access refused it. Mint a token with a higher role, at most your own. |
| `the API token is unknown, revoked or expired` | Mint a new token. |
| 503 when you mint a token | The access service (OpenFGA) does not run. Start it, then try again. |
| A read from another machine gets 401 | Send a UI session or a token. Only reads from the hopper's own host need none. |
