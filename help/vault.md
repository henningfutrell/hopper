# The vault

The vault keeps secrets for jobs that run in sandbox boxes, and mints short-lived AWS and Kubernetes credentials for them. You set a secret once, and nobody can read it back: a job gets it only at the moment a tool asks, and only when a person allowed it.

## What the vault is

The vault is part of the hopper. It holds:

| Kind | What it is | Who sets it |
|---|---|---|
| **Vault secret** | A name, an optional scope (one line that says what it reaches), and a value. The value is sealed under the master key. | An admin, for their own user |
| **Minting credential** | A vault secret marked *Mints for* an AWS account or a Kubernetes cluster. The hopper mints short-lived credentials from it. It never leaves the vault. | An admin |
| **Shared secret** | A secret that the hopper's admin shares with the agents of every user, or of some users. Its name is `shared/<name>`. | The hopper's admin only |
| **System secret** | A secret the hopper keeps for itself, named `system/<name>`. It is never given to a job, a machine or a box. | The hopper, from other pages |

The vault is write-only. No page, no API answer and no log shows a value, to any role. The page shows only who set a secret, when, and where it was last used.

Open the vault at **Settings → Vault**. Every user can read the page. An admin edits secrets, templates and the read policy there. What jobs wait on a person for — credentials, vault grants and template approvals — is on **Access requests**, in the navigation. An operator can grant and revoke the vault for a job there.

## Who gets a secret

A job gets a vault secret, a shared secret or a minted credential only when **all** of these are true:

1. The ask comes from a **sandbox box** that the hopper started for one step of the job, from a **template**. The job itself runs on its own machine: there it gets nothing from the vault, and it has no `$HOPPER_SECRET`.
2. A person **approved** the template, and the secret or operation profile is in its approved scope now.
3. A person gave the job's item a **vault grant**.
4. The job is at work: it runs, or it waits and still holds its pane. An ended, failed or parked job gets nothing.
5. For a minted credential or a shared secret: **Access** allows it.

Templates and approvals are explained in [Sandboxes](sandboxes.md).

## Add a secret

1. Open **Settings → Vault**.
2. In the **Vault** panel, click **Add secret**.
3. Type the **Name**. A job asks for the secret by this name. Use a letter first, then letters, digits, `_`, `.` or `-`, at most 64 characters. You cannot change the name later.
4. Optional: type the **Scope**, for example `k3s lab, namespace default, read-only`.
5. Type the **Value**, and click **Set secret**.
6. Add the secret to a template, and approve the template (see [Sandboxes](sandboxes.md)).

To change a value, click **Replace** on the secret. To delete it, click **Remove**. A job that asks for a removed secret gets nothing.

From the command line, the value comes from standard input only, never from an argument:

```sh
hopper vault set KUBE_TOKEN --scope "lab cluster, read-only" < token-file
hopper vault remove KUBE_TOKEN
hopper vault          # the vault's secrets and templates, never a value
```

### Keep the value in a vault backend

You can keep a value in HashiCorp Vault, 1Password or Bitwarden Secrets Manager instead of in the hopper. First add the backend in **Settings → Plugins → Vault backends**. Then, in the secret's form, choose the backend under **Kept in**, and type where the value is there:

| Backend | Reference |
|---|---|
| HashiCorp Vault (KV version 2) | `path#key`, for example `apps/db#password` |
| 1Password | `op://vault/item/field` |
| Bitwarden Secrets Manager | the secret's id |

The hopper reads the value there each time a job asks, and keeps no copy. A wrong reference shows at the first ask, as a refusal. The backend's own token comes from the hopper's environment. The deploy guide has the set-up steps.

## Grant a job the vault

A job on a box gets nothing from the vault until a person grants it. This is the **vault grant**.

1. A job asks the vault. The hopper refuses it and tells the job: `has no vault grant: a person grants it the vault on Access requests, then ask again`.
2. **Access requests** shows the panel **Vault grants**, with a card *Grant this job the vault*. The card shows the job, its box and template, what it asked for, and its item.
3. Click **Grant**. The job asks again and gets what its template gives.

The grant is kept for the job's item, so **Run again** and **Rework** keep it. Each grant shows who granted it. Click **Revoke** to take it back.

With no browser, use the command line. `hopper vault` lists the grant asks (`grantAsks`) with each job's id. Then:

- `hopper vault grant <job>` grants the job the vault.
- `hopper vault revoke <job>` takes the grant back.

An agent with an API token uses the same routes: `POST /ui/api/jobs/<job>/grant-vault` and `POST /ui/api/jobs/<job>/revoke-vault`. Its grant needs the scope `jobs:grant-vault`. See [API tokens and grants](api-tokens.md).

A grant widens nothing: the template's approved scope still limits what the job gets. A grant covers the whole approved scope of the template, not one secret. A job never grants itself. Access (OpenFGA) decides each grant; when OpenFGA cannot be reached, nothing is granted.

## Use a secret in a job

On a box of a template, each job gets the variable `HOPPER_SECRET`: the path of the `hopper-secret` helper. Run it when a tool needs the secret:

| Run | Prints |
|---|---|
| `$HOPPER_SECRET get NAME` | the value, as it is. For one command: `"$("$HOPPER_SECRET" get NAME)"` |
| `$HOPPER_SECRET git NAME [USER] get` | a git credential helper answer, the value as the password (user `x-access-token` unless you name one) |
| `$HOPPER_SECRET aws NAME` | an AWS `credential_process` answer. The secret holds JSON with `AccessKeyId` and `SecretAccessKey` (and `SessionToken`, `Expiration` when it has them) |
| `$HOPPER_SECRET kube NAME` | a kubeconfig exec credential, the value as the token |
| `$HOPPER_SECRET get shared/NAME` | a shared secret, in any of the forms above |
| `$HOPPER_SECRET aws OPERATION ASSET` | an AWS session the vault mints, for example `aws read aws-role/123456789012/diag` |
| `$HOPPER_SECRET kube OPERATION ASSET` | a Kubernetes token the vault mints, for example `kube read namespace/lab/web` |

The value goes only to standard output, for the tool that ran the helper. The hopper never puts it in the job's environment or on the box's disk. On the wire it is sealed to that one request.

### When a job needs a credential the template does not give

A job can ask a person for a credential. This is a **credential request**:

```sh
sh "$HOPPER_SKILL" kube-diagnostics                       # a skill the hopper knows
sh "$HOPPER_SKILL" SERVICE --credential "an API token, read-only" --why "read the build logs" --wait
```

A job that runs on no box asks for the template of its approved sandbox runs. The credential then goes to the box steps of that template:

```sh
sh "$HOPPER_SKILL" sandbox --template NAME --why "deploy the web service" --wait     # first: the sandbox runs, approved
sh "$HOPPER_SKILL" SERVICE --template NAME --credential "an API token" --why "deploy the web service" --wait
sh "$HOPPER_STEP" box NAME --command 'TOKEN="$("$HOPPER_SECRET" get SERVICE)" ./deploy.sh'
```

A template request cannot name a vault secret that does not exist yet. Ask for the template without it, then ask for the credential as above.

The request shows on **Access requests**, panel **Asked for**. The card says which jobs wait, why, and how to get the credential. An admin then:

- picks what to give (the first kind is the hopper's suggestion; any kind works, also one in your own words),
- types a vault secret name and the value, and clicks **Give**; or
- types a reason and clicks **Decline**.

A given credential becomes a vault secret in the template's scope. When the template is approved and its image did not change, giving it also approves that one secret. The job is told what you gave, never the value. Requests are kept in memory; a job that still waits asks again after a restart.

## Minted credentials

The vault can mint a short-lived credential for one job and one operation profile:

| Kind | For the asset | What the hopper mints | Lives |
|---|---|---|---|
| AWS | `aws-role/<account>/<role>` | an STS `AssumeRole` session on that role. A `read` session carries the `ReadOnlyAccess` session policy. | 15 minutes |
| Kubernetes | `namespace/<cluster>/<ns>` | a TokenRequest token for the service account `hopper-<operation>` in that namespace | 10 minutes |
| Kubernetes | `cluster/<name>` | the same, in the namespace `hopper` | 10 minutes |
| Postgres, SQL Server | `database/<cluster>/<namespace>/<database>` | a login in that database for one read: `SELECT` only on the schemas and tables you name. The hopper uses it itself and drops it after the read. A job never gets it. | one read, at most 15 minutes |

A Kubernetes token minted for a sandbox (a need step, a box step or a read-only check) stops working when its sandbox ends, whatever the outcome. An AWS session cannot be stopped one by one: it works for up to its 15 minutes after its sandbox ends.

The hopper decides *whether* a job gets the credential. The role's IAM policy or the cluster's RBAC decides *what* it can do.

### Set up a minting credential

1. In **Settings → Vault**, click **Add secret**.
2. In **Mints for**, type `aws-account/<account id>` or `cluster/<name>`.
3. Type the value as JSON:
   - AWS: `{"AccessKeyId": "…", "SecretAccessKey": "…"}`. Optional: `SessionToken`, `Region`, `Endpoint` (an STS other than AWS's), and `SessionName` or `SessionNamePrefix` (below).
   - Kubernetes: `{"server": "https://…:6443", "token": "…", "certificateAuthorityData": "<base64 PEM>"}`. The token needs `create` on `serviceaccounts/token`, and `create` and `delete` on `secrets` in the same namespace: each token a sandbox gets is bound to a Secret the hopper deletes when the sandbox ends, so the token stops working at once.
4. In a template, add the operation profile, for example `read` on `aws-role` `123456789012/diag`. Approve it (see [Sandboxes](sandboxes.md)).

From the command line, `--mints` sets **Mints for**. The value comes from standard input:

```sh
hopper vault set AWS_UTILITY --mints aws-account/123456789012 < aws-credential.json
hopper vault set LAB_KUBE --mints cluster/lab < kube-credential.json
hopper vault set AWS_UTILITY --mints none < aws-credential.json   # a plain secret again
```

A `set` without `--mints` keeps what the secret mints for. A shared secret mints nothing: `--mints` with `--shared` is refused.

A minting credential is never given to a box. No template can list it in its scope.

### A database's minting credential

A job reads a database through the hopper (see [Sandboxes](sandboxes.md), "Database reads"). For each read, the hopper makes a new login role in the database, runs the job's one `SELECT` with it, and drops the role. The minting credential is the login that makes and drops these roles. Set it up once for each database. For SQL Server, see "A SQL Server database's minting credential" below.

1. In the database, make the minting login. It needs only these privileges. Run as the database's owner or an admin:

   ```sql
   CREATE ROLE hopper_minter LOGIN CREATEROLE PASSWORD '<a long random password>';
   GRANT CONNECT ON DATABASE orders TO hopper_minter WITH GRANT OPTION;
   GRANT USAGE ON SCHEMA app TO hopper_minter WITH GRANT OPTION;
   GRANT SELECT ON ALL TABLES IN SCHEMA app TO hopper_minter WITH GRANT OPTION;
   ```

   - `CREATEROLE` lets it make and drop the database read roles. On Postgres 16 and later, it can change and drop only the roles it made.
   - Each `WITH GRANT OPTION` lets it give a database read role what it has itself, and nothing more. Give it `SELECT` on the tables a job may read, not more.
   - Do not give it `SUPERUSER`, `CREATEDB`, `BYPASSRLS` or a write privilege. It needs none.
2. Close every other database of the same server to `PUBLIC`: `REVOKE CONNECT ON DATABASE <other> FROM PUBLIC;`. A role is a login of the whole server: without this, a database read role could connect to another database. The hopper connects a database read role only to the credential's database, but close them all the same.
3. Do not give a write privilege on a table to `PUBLIC`. When a database read role could change anything — through its own grants or `PUBLIC`'s —, the hopper drops it at once and the read fails. It says what the role could change.
4. In **Settings → Vault**, click **Add secret**. In **Mints for**, type `database/<cluster>/<namespace>/<database>`, as jobs will name it. Type the value as JSON:

   ```json
   {"engine": "postgres", "host": "orders-db.internal", "database": "orders", "user": "hopper_minter", "password": "…", "schemas": ["app"]}
   ```

   Optional: `port` (5432 when absent), `sslmode` — `verify-full` (when absent: TLS with the certificate and the host name checked), `require` (TLS, no check) or `disable` (no TLS) —, and `ca` (the PEM the certificate is checked against).

   In place of `schemas`, or with it, `tables` names single tables as `<schema>.<table>`, for example `"tables": ["app.users"]`. A database read role then gets `SELECT` on those tables only. Give the minting login `USAGE` on their schemas and `SELECT` on each table, each `WITH GRANT OPTION`.

What a database read role gets:

- `LOGIN`, `NOINHERIT`, a connection limit of 2, and `VALID UNTIL` 15 minutes from its mint.
- `default_transaction_read_only = on`, `statement_timeout` 60 s and `idle_in_transaction_session_timeout` 30 s.
- `CONNECT` on the database, `USAGE` and `SELECT` on each schema in `schemas`, and `SELECT` on each table in `tables`. Nothing else.
- Its password is random for each read, made in the hopper and sent to the database as a SCRAM verifier. The password itself never reaches the database's log, an event, a box or the job.

The hopper must reach the database's host and port itself: it makes the role there, and runs the read there. When the vault runs in a container of its own, the vault container makes the role and runs the read, so it is the vault container that must reach the database. A box needs no route to the database.

### A SQL Server database's minting credential

On SQL Server, a database read role is a SQL login and its user in the database, both named `hopper_read_<16 hex>`. Set the minting login up once for each database:

1. Make the minting login. Run as a server admin:

   ```sql
   CREATE LOGIN hopper_minter WITH PASSWORD = '<a long random password>';
   GRANT ALTER ANY LOGIN TO hopper_minter;
   GRANT ALTER ANY CONNECTION TO hopper_minter;   -- to end a read login's sessions
   GRANT VIEW SERVER STATE TO hopper_minter;      -- to find those sessions
   USE crm;
   CREATE USER hopper_minter FOR LOGIN hopper_minter;
   GRANT ALTER ANY USER TO hopper_minter;
   GRANT SELECT ON dbo.customers TO hopper_minter WITH GRANT OPTION;
   GRANT SELECT ON dbo.contacts TO hopper_minter WITH GRANT OPTION;
   ```

   - `ALTER ANY LOGIN` lets it make, disable and drop the read logins. It does not let it give a login a server role or a server permission it does not have.
   - `ALTER ANY USER` lets it make and drop the read users in this database only.
   - Each `SELECT … WITH GRANT OPTION` lets it give a read user `SELECT` on that table, and nothing more. For a table named in `tables`, grant on the table itself: the grant option on its schema does not let it grant one table. For a schema named in `schemas`, `GRANT SELECT ON SCHEMA::<schema> … WITH GRANT OPTION`.
   - `ALTER ANY CONNECTION` and `VIEW SERVER STATE` let it end a read login's sessions when it drops the login. Without them, a session left open keeps the login until the session ends, and the sweep drops it later. `VIEW SERVER STATE` also shows other sessions' queries: leave both out when that is not acceptable.
   - Do not give it `sysadmin`, `securityadmin`, `db_owner`, `CONTROL` or a write permission. It needs none.
2. Keep `guest` off in every other database of the server (it is off by default). A read login has no user there, so it cannot open them.
3. Do not give a write permission, or `EXECUTE` on a procedure, to `public`. SQL Server has no read-only transaction: the hopper connects as each new read login and checks what it could change — a table or view it could write or alter, a procedure it could run, a schema it could alter, a database or server permission that changes something —, and drops the login when it could. It says what the login could change.
4. In **Settings → Vault**, add the secret as above, with `"engine": "sqlserver"`:

   ```json
   {"engine": "sqlserver", "host": "crm-db.internal", "database": "crm", "user": "hopper_minter", "password": "…", "tables": ["dbo.customers", "dbo.contacts"]}
   ```

   `port` is 1433 when absent. `sslmode` and `ca` work as for Postgres.

What a SQL Server read login gets:

- A SQL login with no password policy, its default database the credential's, and a user in that database with `SELECT` on the named schemas and tables. Nothing else.
- Its password is random for each read, made in the hopper and sent to SQL Server as a password hash (`PASSWORD = 0x… HASHED`). The password itself never reaches the server's log, an event, a box or the job.
- A statement stops after 60 s. The read runs in a transaction that the hopper rolls back.
- SQL Server has no `VALID UNTIL` and no connection limit for a login. The hopper drops the login at the read's end. When the hopper stops during a read, the sweep drops a read login older than 15 minutes, at the next start or within 5 minutes after that. While the hopper is stopped, the login stays, but only the hopper knew its password.

### Session names

An AWS session is named `hopper-<job id>` by default (at most 64 characters). When the role's trust policy allows only some names:

- add `"SessionName": "<name>"` to the value: every mint uses that one name; or
- add `"SessionNamePrefix": "ci-"` (at most 32 characters): the hopper names each session `ci-<job id>`.

Use one of them, not both. Use only letters, digits and `+ = , . @ _ -`.

### Test an AWS minting credential

Before a job needs it, run:

```sh
hopper vault mint-test aws-role/123456789012/diag
```

The hopper mints a read session from the account's minting credential, as for a job. Then it asks STS who the session is. The answer shows the assumed role's ARN and the session name (`hopper-mint-test`, `<prefix>mint-test`, or your fixed name). When STS refuses, it shows why. The answer never holds a key. There is no mint test for Kubernetes, and no button for it on the page.

### Renewal and Access

kubectl and the AWS CLI run the helper again when the last credential expires. Each run is a new mint. **Access** (OpenFGA) decides each mint and each renewal: it checks that the job's box is of a template approved for that operation on that asset. A deny mints nothing, and the job is told why. Each decision shows in **Settings → Access**, panel **Recent decisions**. When a person revokes an approval, the next renewal is denied. A credential already minted lives out its 10 or 15 minutes.

## Shared secrets

The hopper's admin can share one secret with every user's agents, so each user needs no copy:

1. **Settings → Vault**, panel **Shared secrets**, click **Share secret**.
2. Type the name, an optional scope, and optional **Readers** (user ids; empty means every user).
3. Type the value, and click **Share secret**.

Or: `hopper vault set AWS_DIAG --shared --reader <user id> < value-file`. Remove it with `hopper vault remove AWS_DIAG --shared`.

Every user sees each shared secret's name and readers, never its value. A template names it as `shared/<name>`. A job gets it only from a box of an approved template that names it, with a vault grant, and only when its user is a reader.

## The hopper's own secrets

The panel **Hopper's own secrets** lists the vault's system scope: the GitHub connection's tokens, webhook signing secrets, the TypeSafe API key, the artifact content URL signing key and the sign-in realms' secrets. Each shows what it is for, its last 4 characters, and the page where you change it. The **Audit trail** lists each set, replace, rotation, removal, read by the hopper and refused ask. No job, machine or box can ever get a system secret.

## Limits and troubleshooting

- **The master key.** Every value kept in the hopper is sealed under the master key. With no master key, the hopper does not start: its error names the key it needs by its fingerprint. The hopper's admin rotates the key in the panel **Master key** (**Rotate the master key**), or with `hopper master-key rotate`.
- **A job's ask is refused.** The job is told why. Common reasons: no vault grant; the box is no box of a template; the template is not approved; the secret is not in its scope; the box was launched without it; the job is not at work.
- **A mint is refused.** The reason says whether the profile waits for approval, the template does not declare it, or there is no minting credential for that account or cluster.
- **Not built.** Minting for an `aws-account` with no role, an Argo CD app or a Terraform workspace. Revoking a credential that is already minted. A vault backend that writes.
- **Optional parts.** The vault can run in a container of its own, and a local KMS can wrap its key. Both are optional; see the deploy guide.

See also: [Sandboxes](sandboxes.md), [CLI and API](cli-and-api.md), [Deploy and update](deploy-and-update.md).
