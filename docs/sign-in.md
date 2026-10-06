# Signing in — realms

How people sign in to the hopper UI. A **realm** is one way of checking who signs in: password
accounts, an LDAP or Active Directory directory, OpenID Connect, GitHub or SAML. The realms are an
ordered list, each on or off, managed in **Settings → Sign-in**; a change works at once. Beside them:
the one-time login code and no sign-in. The design and its reasons: `docs/design.md` "Sign-in: realms".

Every way of signing in ends the same: a **UI session** with a **UI role**, acting for one **user**
(issue #158). Sessions, roles and logout behave the same whichever realm signed the user in.

- [Pick a setup](#pick-a-setup)
- [Managing realms in Settings](#managing-realms-in-settings) · [The sign-in config](#the-sign-in-config)
- [No sign-in](#no-sign-in) · [Password realm](#password-realm) · [LDAP realm](#ldap-realm)
- [UI roles and role rules](#ui-roles-and-role-rules)
- [Who signs in as which user](#who-signs-in-as-which-user)
- [The sign-in origin and a public URL](#the-sign-in-origin-and-a-public-url)
- [Identity providers](#identity-providers): [Google](#google) · [Microsoft Entra ID](#microsoft-entra-id-oidc) ·
  [Okta](#okta-oidc) · [Auth0](#auth0) · [Keycloak](#keycloak-oidc) · [GitHub](#github) ·
  [SAML (any)](#saml-any-identity-provider) · [Entra SAML](#microsoft-entra-id-saml) ·
  [Okta SAML](#okta-saml) · [Keycloak SAML](#keycloak-saml)
- [Sessions and logout](#sessions-and-logout)
- [Troubleshooting](#troubleshooting)

## Pick a setup

| setup | what to do |
|---|---|
| One person, one machine | Nothing. With no realm, the one-time login code is the only way in: `hopper login-code` mints one (good once, 10 minutes); on the host install `bash ~/.local/lib/hopper/scripts/open-ui.sh` opens the UI already logged in. It signs in as `admin`. |
| One person, a few devices on a home LAN | `HOPPER_LAN_NAMES` / `HOPPER_LAN_PEERS` (`docs/design.md` "Reaching the UI across the LAN") and device links. Add a realm if you prefer signing in with an account. |
| Behind a proxy or network that already decides who gets in | [No sign-in](#no-sign-in): `"none": { "role": … }`. Everyone who reaches the UI acts with that role. |
| A few people, no directory or identity provider | A [password realm](#password-realm): accounts with argon2id hashes in the realm. Each account gets a [user of its own](#who-signs-in-as-which-user). |
| A company directory (OpenLDAP, Active Directory, FreeIPA) | An [LDAP realm](#ldap-realm): people sign in with their directory username and password; directory groups grant roles. |
| A team, or anyone reaching it over the internet | A reverse proxy with TLS, `HOPPER_PUBLIC_URL`, one or more realms, role rules, and usually the login code off (`"local": { "enabled": false }`). |

## Managing realms in Settings

An admin opens **Settings → Sign-in**. It lists the realms in order, each with its type, a switch to
turn it on or off, and — for OIDC, GitHub and SAML — the callback URL (and SAML metadata URL) to
register with the identity provider, ready to copy.

- **Add realm**: pick a type; the editor starts with that type's settings and example values. Replace
  them (every setting: [The sign-in config](#the-sign-in-config) below) and **Save**.
- **Edit** (pencil): the realm's entry, one JSON object. Its `name` stays: sign-ins are linked to
  users by it, and the identity provider holds it in the callback URL. To rename, remove it and add
  a new one.
- **Move up / down**: the order. The username and password form tries the password and LDAP realms
  that are on in this order, and the first that accepts the password signs in. The OIDC, GitHub and
  SAML realms that are on are sign-in buttons, in this order.
- **On / off**: a realm that is off signs nobody in, and the sessions it made end at once. Its secret
  variable need not be set while it is off.
- **Without a realm**: the login code on or off, and no sign-in with its role.

A change **works at once**, without a restart: the sign-in page follows it, and sessions follow it as
they would at a restart (a realm off or removed, or an account no rule lets in any more, loses its
sessions; a changed role applies). A change that would not load is refused with the reason, naming
the field (a missing secret variable is named too) — nothing is saved. A change that would end **your
own** admin session (turning off or removing the realm you signed in with, lowering your own role,
turning off the login code you signed in with) is refused: sign in as an admin another way first.

Secrets are never written into a realm: it names the variable that holds one (`clientSecretEnv`,
`bindPasswordEnv`). Set the variable in the daemon's environment — `daemon.env` on the host install,
the container's env file otherwise — and restart once; after that the realm can be changed in
Settings without a restart.

## The sign-in config

The realms live in the **sign-in config**, a config record in the daemon's database, not a file. It
is shared by every user. Settings → Sign-in edits it: each realm as a JSON object, the login code and
no sign-in under **Without a realm**. A change that does not load is refused with the reason.

For scripts, and to mend a sign-in config that locks everyone out, the operator CLI reads and
replaces it whole, as JSON: `hopper config get sign-in` prints it, `hopper config version sign-in`
prints its version, and `hopper config set sign-in --if-version <version>` replaces it with the JSON
on stdin. A config that does not load, or that changed since you read its version, is refused and
nothing is written. A change made with the CLI applies at the next start (`systemctl --user restart
hopper` on the host install). An invalid sign-in config stops the daemon with a message naming the
field (`journalctl --user -u hopper`): sign-in fails closed, never open.

The whole sign-in config, as `hopper config get sign-in` prints it:

```json
{
  "version": 1,
  "local": { "enabled": true },
  "none": { "role": "viewer" },
  "realms": [
    {
      "name": "staff",
      "label": "Staff",
      "type": "password",
      "users": [
        { "username": "ada", "passwordHash": "$argon2id$v=19$…", "role": "operator" }
      ]
    },
    {
      "name": "google",
      "label": "Google",
      "type": "oidc",
      "enabled": false,
      "issuer": "https://accounts.google.com",
      "clientId": "1234-abc.apps.googleusercontent.com",
      "clientSecretEnv": "GOOGLE_CLIENT_SECRET",
      "roles": {
        "admin": { "emails": ["ada@example.com"] },
        "operator": { "emailDomains": ["example.com"] },
        "defaultRole": null
      }
    }
  ]
}
```

| field | |
|---|---|
| `version` | `1`. |
| `local.enabled` | The one-time login code (signs in as admin). Default `true`. |
| `none` | No sign-in: everyone gets `none.role`. Absent: off. |
| `realms` | The realms, in order. |
| `name` | Lowercase letters, digits, dashes: it is part of the callback URL. |
| `label` | Shown in Settings, and on the button of an OIDC, GitHub or SAML realm: `Google` makes the button "Sign in with Google". Default: the name. |
| `type` | `password`, `ldap`, `oidc`, `github` or `saml`. The type's settings follow it (table below). |
| `enabled` | `false` turns the realm off. Default `true`. |
| `roles` | Who gets which UI role ([role rules](#ui-roles-and-role-rules)); nobody, if left out. |
| `roles.defaultRole` | The role of a signed-in account no rule matches; `null`: no session. |

A secret comes **only** from the runtime: `clientSecretEnv` and `bindPasswordEnv` name the variable.
Put it in the daemon's environment, or mount the secret as a file and set `<variable>_FILE` to its
path (design.md "Secrets"). Inline `clientSecret`, `clientSecretFile` and `bindPassword` are refused.
The SAML certificate is not a secret: `idpCert`, inline only (PEM or bare base64; in JSON a PEM's
line breaks are written `\n`). `idpCertFile` is refused.

**Per type:**

| type | setting | default | |
|---|---|---|---|
| every type | `name`, `type` | — | |
| | `label` | the name | |
| | `enabled` | `true` | |
| `password` | `users` | — | `{ username, passwordHash, role }` each; no `roles`: each account carries its role. |
| `ldap` | `url` | — | `ldaps://host[:port]`, or `ldap://` with `startTls: true`; plain `ldap://` only to `127.0.0.1`/`localhost`. |
| | `startTls` | `false` | Upgrade an `ldap://` connection with StartTLS. |
| | `bindDn`, `bindPasswordEnv` | none (anonymous search) | The account that searches for the user. `bindPasswordEnv` names the variable holding its password. |
| | `userBase` | — | Where people are: `ou=people,dc=example,dc=com`. |
| | `userFilter` | `(uid={username})` | `{username}` is the typed username, escaped. Active Directory: `(sAMAccountName={username})`. |
| | `attributes.subject` | the entry's DN | A stable id: `entryUUID` (OpenLDAP), `objectGUID` (AD). |
| | `attributes.username` / `.email` / `.name` / `.groups` | `uid` / `mail` / `cn` / `memberOf` | Attribute names. `groups` values are group DNs. |
| | `groupSearch` | none | `{ base, filter, name }`: groups found by search, for a directory without `memberOf`. `filter` default `(member={dn})`, `name` default `cn` (the group is known by that value). |
| `oidc` | `issuer` | — | The issuer URL; discovery reads `<issuer>/.well-known/openid-configuration`. https (http only to `127.0.0.1`/`localhost`). |
| | `clientId` | — | |
| | `clientSecretEnv` | none | Name of the environment variable holding the secret. Omit for a public client (PKCE only). |
| | `scopes` | `[openid, email, profile]` | Add what your groups claim needs (`groups` at Okta). |
| | `claims.email` / `.username` / `.name` / `.groups` | `email` / `preferred_username` / `name` / `groups` | Claim names, read from the ID token, then userinfo. `groups` may be a list or one string. |
| | `trustUnverifiedEmail` | `false` | Count `email` even without `email_verified: true`. Only for an issuer whose emails you control. |
| `github` | `clientId`, `clientSecretEnv` | — | An OAuth app (not a GitHub App). `clientSecretEnv` is required. |
| | `webUrl` / `apiUrl` | `https://github.com` / `https://api.github.com` | GitHub Enterprise Server: `https://ghe.example.com` and `https://ghe.example.com/api/v3`. |
| `saml` | `entryPoint` | — | The IdP's single sign-on URL (HTTP-Redirect binding). |
| | `idpCert` | — | The IdP's signing certificate, inline: PEM or bare base64. |
| | `idpIssuer` | none | The IdP's entity id. Set it: a response from another issuer is then refused. |
| | `entityId` | `<sign-in origin>/ui/auth/<name>/metadata` | This service's entity id (the IdP calls it Identifier or Audience). |
| | `attributes.email` / `.name` / `.groups` / `.username` | `email` / `displayName` / `groups` / NameID | Attribute names in the assertion. |
| | `requireSignedResponse` | `false` | Also require the whole response signed. The assertion must be signed either way. |

**From before realms.** Older installs were migrated when the daemon updated. First to realms
(issue #185): the sign-in document of an earlier version — `password:` and `providers:` — became
realms; the password accounts became the first realm, `password`, and the providers followed in their
order, under the same names. Then to a JSON config record (issue #198): the YAML document became the
sign-in config, every value kept; its YAML comments were not (JSON has none). Nothing to do; sign-ins
and sessions carry on.

## No sign-in

```json
{ "version": 1, "none": { "role": "viewer" } }
```

`role` is `viewer`, `operator` or `admin`. In Settings → Sign-in it is set under **Without a realm**.
Anyone who reaches the UI gets a session with that role, without a credential: the UI takes it by
itself (`POST /ui/auth/none`; the exact UI origin is required, so another site cannot mint one in a
visitor's browser). The daemon logs `NO SIGN-IN is on` at every start. It combines with the rest:
no sign-in as `viewer` plus a realm or the login code means everyone may look and those who sign
in may act. Use it only where something in front — a VPN, a proxy with its own login, a network only
you reach — already decides who gets in. With `role: admin`, anyone who reaches the UI can change
every setting.

## Password realm

```json
{
  "name": "staff",
  "type": "password",
  "users": [
    { "username": "ada", "passwordHash": "$argon2id$v=19$m=65536,p=4,t=3$…", "role": "operator" }
  ]
}
```

Each account's `role` is `viewer`, `operator` or `admin`. The realm holds an **argon2id hash**, never
a password. Make one with the operator CLI (it asks
twice without echo on a terminal; from a pipe it reads the first line):

```sh
hopper password-hash
```

then paste it into the realm in Settings → Sign-in. Usernames are unique within the realm, case
ignored. A wrong password, an unknown username and an empty password get the same 403, and an
unknown username costs the same time as a wrong password. To change a password, replace the hash;
to remove an account, delete its entry — its sessions end when the change is saved. The UI shows a
username and password form; the form works on every UI origin (loopback, a LAN name, the public URL).

**Rate limit.** Every sign-in route (`/ui/login`, `/ui/auth/…`) together accepts 20 attempts a
minute per client address; past that, 429 until the minute is over. Behind a reverse proxy every
client has the proxy's address, so the limit is shared: add a per-client limit at the proxy for a
public deploy.

## LDAP realm

People sign in on the same username and password form with their directory account. The hopper
binds as a search account (or anonymously), finds the one entry `userFilter` names under `userBase`,
then binds as that entry with the password typed: the directory checks the password, the hopper
never sees a hash.

OpenLDAP or FreeIPA:

```json
{
  "name": "directory",
  "label": "Directory",
  "type": "ldap",
  "url": "ldaps://ldap.example.com",
  "bindDn": "cn=hopper,ou=services,dc=example,dc=com",
  "bindPasswordEnv": "LDAP_BIND_PASSWORD",
  "userBase": "ou=people,dc=example,dc=com",
  "attributes": { "subject": "entryUUID" },
  "roles": {
    "admin": { "groups": ["cn=hopper-admins,ou=groups,dc=example,dc=com"] },
    "operator": { "groups": ["cn=hopper-operators,ou=groups,dc=example,dc=com"] }
  }
}
```

Active Directory:

```json
{
  "name": "ad",
  "label": "Company account",
  "type": "ldap",
  "url": "ldaps://dc1.corp.example.com",
  "bindDn": "CN=hopper,OU=Service Accounts,DC=corp,DC=example,DC=com",
  "bindPasswordEnv": "AD_BIND_PASSWORD",
  "userBase": "DC=corp,DC=example,DC=com",
  "userFilter": "(sAMAccountName={username})",
  "attributes": { "subject": "objectGUID", "username": "sAMAccountName", "name": "displayName" },
  "roles": {
    "admin": { "groups": ["CN=Hopper Admins,OU=Groups,DC=corp,DC=example,DC=com"] }
  }
}
```

In the daemon's environment: `LDAP_BIND_PASSWORD=<password>` (or `AD_BIND_PASSWORD`), then restart
once.

- **Groups** are the values of `attributes.groups` (default `memberOf`): full group DNs, compared
  exactly as the directory gives them. A directory without `memberOf` (an OpenLDAP without the
  memberof overlay): set `"groupSearch": { "base": "ou=groups,dc=example,dc=com" }` and match on
  the group's `cn` (`"groups": ["hopper-admins"]`).
- **Subject**: set `attributes.subject` to an id that survives a rename (`entryUUID`, `objectGUID`).
  Left out, it is the entry's DN, which changes when the person is moved or renamed — and then signs
  in as a new user.
- The **email** (`mail`) counts as verified: the directory vouches for it, so `emails` and
  `emailDomains` rules apply.
- **TLS**: `ldaps://`, or `ldap://` with `"startTls": true`; the server's certificate must be trusted by
  Node (a private CA: `NODE_EXTRA_CA_CERTS=/path/ca.pem` in the daemon's environment).
- With a password realm and an LDAP realm both on, the form tries them in their order; the first that
  accepts the password signs in. When none accepts and a directory could not be reached, the answer
  is "sign-in could not be checked", naming the realm — not "wrong password".

## UI roles and role rules

| UI role | may |
|---|---|
| `viewer` | read everything the UI shows |
| `operator` | + cancel and approve jobs; answer, close, dismiss questions and mark them seen |
| `admin` | + change configuration: plugins, machines, routing rules, webhooks, the rules, router mode, sign-in realms; apply updates; hand out device links |

The login code always signs in as `admin`, a password realm account as its own `role`. For every
other realm, `roles` decides, the same way for every type:

- `admin`, `operator`, `viewer` each take any of `subjects`, `usernames`, `emails`, `emailDomains`,
  `groups`. Any one match grants the role; **the highest matching role wins**.
- `emails`, `emailDomains`, `usernames` ignore case; `subjects` and `groups` compare exactly.
- Prefer identifiers the user cannot change: `subjects`, groups, verified emails. `usernames` is only
  as stable as the realm makes it — a GitHub login can be renamed and taken by someone else; an
  OIDC `preferred_username` is user-editable at some issuers.
  `"emailDomains": ["example.com"]` matches `a@example.com`, not `a@sub.example.com`.
- Nothing matches → `defaultRole`; absent or `null` → **no session** ("signed in, but the
  sign-in config grants this account no role"). Leaving `roles` out lets nobody in — on purpose.
- Only an email the realm vouches for counts: OIDC `email_verified: true` (or
  `trustUnverifiedEmail`), GitHub's primary verified email, SAML's asserted email, LDAP's `mail`.

What fills each field:

| field | LDAP | OIDC | GitHub | SAML |
|---|---|---|---|---|
| subject | `attributes.subject`, else the DN | `sub` | numeric user id | NameID |
| username | `attributes.username` | `claims.username` | login | `attributes.username`, else NameID |
| email | `attributes.email` | `claims.email` if verified | primary verified email | `attributes.email` |
| groups | `attributes.groups`, plus `groupSearch` | `claims.groups` | teams as `org/team-slug` (asks for `read:org` only when a rule names groups) | `attributes.groups` |

A UI role is not a plugin role: see `docs/glossary.md`.

A role acts only inside the session's own user: an admin changes their own plugins, machines,
routing, webhooks, rules and router mode, never another user's. What all users share — adding users,
the plugin store, updates, sign-in realms — needs `admin`.

## Who signs in as which user

One hopper can work for several people (issue #158, `docs/design.md` "Users: one hopper, separate
users"). Each **user** has their own jobs, questions, events, machines, plugins, routing, rules,
webhooks and credentials; nobody sees or touches another user's. Every hopper starts with the user
`owner`, which holds everything from before there were several.

| sign-in | user |
|---|---|
| login code | the user it was minted for: `hopper login-code --user <id>` (default `owner`); a device link is for the session's own user; a new user's login link for that user |
| no sign-in (`none`) | `owner` |
| a realm (password, LDAP, OIDC, GitHub, SAML) | the user its identity (realm and subject) is linked to; the **first** sign-in of an identity a role rule lets in creates a new user for it, named after its username, else its name, else its email (made unique: `ada`, `ada 2`), and links it |

- An admin adds a user from **Settings → Users** (or `hopper user add <name>`) and hands over the
  one-time login link it shows.
- A user added later reads its secrets under its own prefix: a plugin option naming `GITHUB_TOKEN`
  reads `HOPPER_USER_<ID>_GITHUB_TOKEN` (or its `_FILE`), so set the variable for that user in the
  daemon's environment. `owner` reads the names as they are.
- Its `gh` and `claude` logins are its own: they live in `<work dir>/users/<id>/gh` and `…/claude`.
  Log it in to GitHub from its own Sources view.
- An identity that signed in before there were several users is linked to `owner` when its session
  was still stored; one whose sessions had all expired gets a new user at its next sign-in.
  `hopper login-code` always reaches `owner`.

## The sign-in origin and a public URL

An OIDC, GitHub or SAML realm's identity provider sends the browser back to one fixed address, the **sign-in origin**:

- `HOPPER_PUBLIC_URL` when set (origin only: `https://hopper.example.com`), else
- `http://localhost:<port>` — fine for one machine; most providers accept `localhost` redirects.

Register these with the identity provider (`<origin>` = the sign-in origin, `<name>` = the realm's
name; Settings → Sign-in shows them for each realm):

| | URL |
|---|---|
| redirect / callback URI (OIDC, GitHub) | `<origin>/ui/auth/<name>/callback` |
| assertion consumer service, HTTP-POST (SAML) | `<origin>/ui/auth/<name>/callback` |
| SP entity id and metadata (SAML) | `<origin>/ui/auth/<name>/metadata` |

Sign-in starts and ends on the sign-in origin. A browser on another address (a LAN name) is pointed
there first.

**Behind a reverse proxy.** Set the public URL in `~/.config/hopper/daemon.env` (the unit's
`EnvironmentFile`), then restart:

```sh
HOPPER_PUBLIC_URL=https://hopper.example.com
```

The daemon then answers to that host as well: the proxy must pass the original `Host` header. A
request on the public host reads `/api/` only with a UI session, and the public origin may post
UI mutations. With the proxy on the same machine the daemon keeps listening on `127.0.0.1` only. A
proxy on another machine: add its address to `HOPPER_LAN_PEERS` (the daemon then listens on
every interface and refuses any other peer).

The proxy must route only requests for the public host to the daemon, with that host as `Host`. A
proxy that forwards any client-chosen `Host` unchanged would let a request claiming
`Host: localhost:4790` read as a local one.

Two more things belong at the proxy:

- **Rate-limit `/ui/auth/`.** Starting a sign-in needs no session; the daemon keeps at most 10 000
  pending sign-ins and drops the oldest past that, so a flood can make a real user start again.
- **Keep the event stream's query out of access logs.** The browser's `EventSource` cannot send
  headers, so `/api/events/stream` carries the session token as `?session=`.

Caddy (TLS included; Caddy logs no access lines unless `log` is set; `rate_limit` needs the
caddy-ratelimit plugin):

```
hopper.example.com {
	reverse_proxy 127.0.0.1:4790
}
```

nginx:

```nginx
limit_req_zone $binary_remote_addr zone=hopper_signin:10m rate=10r/m;

server {
    server_name hopper.example.com;
    # listen 443 ssl; ssl_certificate …; ssl_certificate_key …;

    location / {
        proxy_pass http://127.0.0.1:4790;
        proxy_set_header Host $host;
        proxy_buffering off;              # the event stream must not be buffered
        proxy_read_timeout 1h;
    }
    location /ui/auth/ {
        limit_req zone=hopper_signin burst=20;
        proxy_pass http://127.0.0.1:4790;
        proxy_set_header Host $host;
    }
    location /api/events/stream {
        access_log off;                   # the session token is in the query
        proxy_pass http://127.0.0.1:4790;
        proxy_set_header Host $host;
        proxy_buffering off;
        proxy_read_timeout 1h;
    }
}
```

Use TLS for anything beyond one machine. Requests straight to `127.0.0.1:<port>` stay readable
without a session by any process on the host — keep the daemon on a machine only you and the proxy use.

## Identity providers

Each section: what to create at the identity provider, then the realm's entry, one JSON object —
paste it into **Settings → Sign-in → Add realm**. Replace `<origin>` with the sign-in origin. Put each `clientSecretEnv` variable, as `NAME=<secret>`, in the daemon's environment
(`daemon.env` on the host install), and restart once so the daemon has it.

### Google

1. https://console.cloud.google.com/apis/credentials → **Create credentials → OAuth client ID** →
   *Web application*.
2. Authorized redirect URI: `<origin>/ui/auth/google/callback`.
3. Copy the client id and secret.

```json
{
  "name": "google",
  "label": "Google",
  "type": "oidc",
  "issuer": "https://accounts.google.com",
  "clientId": "1234-abc.apps.googleusercontent.com",
  "clientSecretEnv": "GOOGLE_CLIENT_SECRET",
  "roles": {
    "admin": { "emails": ["ada@example.com"] }
  }
}
```

In the daemon's environment: `GOOGLE_CLIENT_SECRET=<secret>`.

Google sends no groups. For "everyone in our Google Workspace", match the hosted-domain claim
rather than the email domain (a personal Google account can carry a verified address at any domain):
set `"claims": { "groups": "hd" }` and grant `"groups": ["example.com"]`.

### Microsoft Entra ID (OIDC)

1. https://entra.microsoft.com → **App registrations → New registration**, single tenant.
   Redirect URI: *Web*, `<origin>/ui/auth/entra/callback`.
2. **Certificates & secrets → New client secret**.
3. For group rules: **Token configuration → Add groups claim** (security groups; the ID token then
   carries group object ids), or define **App roles** and assign them (claim `roles`).

```json
{
  "name": "entra",
  "label": "Microsoft",
  "type": "oidc",
  "issuer": "https://login.microsoftonline.com/<tenant-id>/v2.0",
  "clientId": "<application (client) id>",
  "clientSecretEnv": "ENTRA_CLIENT_SECRET",
  "claims": { "groups": "roles" },
  "roles": {
    "admin": { "groups": ["Hopper.Admin"] },
    "operator": { "groups": ["Hopper.Operator"] }
  }
}
```

`"claims": { "groups": "roles" }` matches on app roles. Leave it out to match on the groups claim
(group object ids).
Use the tenant-specific issuer, not `common`/`organizations`. Entra does not send `email_verified`:
match on groups, app roles or `usernames` (the UPN in `preferred_username`), not on `emails`.

### Okta (OIDC)

1. Okta admin → **Applications → Create App Integration** → *OIDC*, *Web Application*.
   Sign-in redirect URI: `<origin>/ui/auth/okta/callback`. Assign people or groups.
2. For group rules: in the app's **Sign On** tab, *OpenID Connect ID Token* → Groups claim type
   *Filter*, name `groups`, e.g. *Starts with* `hopper-`.

```json
{
  "name": "okta",
  "label": "Okta",
  "type": "oidc",
  "issuer": "https://<your-org>.okta.com",
  "clientId": "<client id>",
  "clientSecretEnv": "OKTA_CLIENT_SECRET",
  "scopes": ["openid", "email", "profile", "groups"],
  "roles": {
    "admin": { "groups": ["hopper-admins"] },
    "operator": { "groups": ["hopper-operators"] }
  }
}
```

With a custom authorization server the issuer is `https://<your-org>.okta.com/oauth2/default`.

### Auth0

1. Auth0 dashboard → **Applications → Create Application** → *Regular Web Application*.
   Allowed Callback URLs: `<origin>/ui/auth/auth0/callback`.
2. For role rules: an Action on *Login* that adds the user's roles as a namespaced claim:
   `api.idToken.setCustomClaim('https://hopper.example.com/roles', event.authorization?.roles ?? [])`.

```json
{
  "name": "auth0",
  "label": "Auth0",
  "type": "oidc",
  "issuer": "https://<tenant>.auth0.com/",
  "clientId": "<client id>",
  "clientSecretEnv": "AUTH0_CLIENT_SECRET",
  "claims": { "groups": "https://hopper.example.com/roles" },
  "roles": {
    "admin": { "groups": ["hopper-admin"] },
    "defaultRole": "viewer"
  }
}
```

Keep the trailing slash of `issuer`: it is part of Auth0's issuer.

### Keycloak (OIDC)

1. Realm → **Clients → Create client**, *OpenID Connect*, client authentication on, standard flow.
   Valid redirect URI: `<origin>/ui/auth/keycloak/callback`.
2. For group rules: the client's dedicated scope → **Add mapper → Group Membership**, token claim
   name `groups`, *Full group path* off, *Add to ID token* on.

```json
{
  "name": "keycloak",
  "label": "Keycloak",
  "type": "oidc",
  "issuer": "https://keycloak.example.com/realms/<realm>",
  "clientId": "hopper",
  "clientSecretEnv": "KEYCLOAK_CLIENT_SECRET",
  "roles": {
    "admin": { "groups": ["hopper-admins"] },
    "operator": { "groups": ["hopper-operators"] }
  }
}
```

### GitHub

GitHub's OAuth apps are OAuth 2.0, not OIDC; the `github` type reads the user, their primary
verified email and (when a rule names groups) their teams from the API.

1. https://github.com/settings/developers → **OAuth Apps → New OAuth App** (for an organization:
   the organization's *Settings → Developer settings*). Authorization callback URL:
   `<origin>/ui/auth/github/callback`.
2. **Generate a new client secret**.
3. Team rules need the organization to allow the app (*Third-party access* policy).

```json
{
  "name": "github",
  "label": "GitHub",
  "type": "github",
  "clientId": "<client id>",
  "clientSecretEnv": "GITHUB_OAUTH_CLIENT_SECRET",
  "roles": {
    "admin": { "subjects": ["583231"] },
    "operator": { "groups": ["acme/platform"] }
  }
}
```

A subject is the numeric user id: `id` in `https://api.github.com/users/<login>`. A group is a team,
as `org/team-slug`. Grant by `subjects` (the numeric id) or teams, not `usernames`: a GitHub login can be renamed, and
the old name registered by someone else.

GitHub Enterprise Server: add `"webUrl": "https://ghe.example.com"` and
`"apiUrl": "https://ghe.example.com/api/v3"`. Teams are read from the first page (100).

### SAML (any identity provider)

hopper is a SAML service provider: SP-initiated sign-in, HTTP-Redirect for the request,
HTTP-POST for the response. Unsolicited (IdP-initiated) responses are refused.

1. Give the IdP these (or the metadata at `<origin>/ui/auth/<name>/metadata`, served once the
   realm is saved and on):
   - entity id / audience: `<origin>/ui/auth/<name>/metadata`
   - assertion consumer service (HTTP-POST): `<origin>/ui/auth/<name>/callback`
2. Have it sign assertions (SHA-256), with a persistent NameID, and send email, display name and
   groups attributes.
3. From the IdP take: its SSO URL (`entryPoint`), signing certificate (`idpCert`) and entity id
   (`idpIssuer`).

```json
{
  "name": "corp",
  "label": "Corp SSO",
  "type": "saml",
  "entryPoint": "https://idp.example.com/sso/saml",
  "idpCert": "-----BEGIN CERTIFICATE-----\n<base64 certificate>\n-----END CERTIFICATE-----",
  "idpIssuer": "https://idp.example.com/metadata",
  "attributes": { "email": "email", "name": "displayName", "groups": "groups" },
  "roles": {
    "admin": { "groups": ["hopper-admins"] },
    "defaultRole": "viewer"
  }
}
```

`idpCert` is the PEM on one line, its line breaks written `\n`; the bare base64 alone works too.

### Microsoft Entra ID (SAML)

Entra → **Enterprise applications → New application → Create your own** (non-gallery) → **Single
sign-on → SAML**. Identifier: `<origin>/ui/auth/entra-saml/metadata`; Reply URL:
`<origin>/ui/auth/entra-saml/callback`. Under *Attributes & Claims* add a group claim. Download
*Certificate (Base64)*; *Login URL* is the entry point, *Microsoft Entra Identifier* the issuer.

```json
{
  "name": "entra-saml",
  "label": "Microsoft",
  "type": "saml",
  "entryPoint": "https://login.microsoftonline.com/<tenant-id>/saml2",
  "idpCert": "-----BEGIN CERTIFICATE-----\n<base64 certificate>\n-----END CERTIFICATE-----",
  "idpIssuer": "https://sts.windows.net/<tenant-id>/",
  "attributes": {
    "email": "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress",
    "name": "http://schemas.microsoft.com/identity/claims/displayname",
    "groups": "http://schemas.microsoft.com/ws/2008/06/identity/claims/groups"
  },
  "roles": {
    "admin": { "groups": ["<group object id>"] }
  }
}
```

### Okta (SAML)

Okta admin → **Create App Integration → SAML 2.0**. Single sign-on URL:
`<origin>/ui/auth/okta-saml/callback`; Audience URI: `<origin>/ui/auth/okta-saml/metadata`.
Attribute statements `email` → `user.email`, `displayName` → `user.displayName`; group attribute
statement `groups`, filter e.g. *Starts with* `hopper-`. From *View SAML setup instructions* take
the SSO URL, issuer and certificate.

```json
{
  "name": "okta-saml",
  "label": "Okta",
  "type": "saml",
  "entryPoint": "https://<your-org>.okta.com/app/<app>/<id>/sso/saml",
  "idpCert": "-----BEGIN CERTIFICATE-----\n<base64 certificate>\n-----END CERTIFICATE-----",
  "idpIssuer": "http://www.okta.com/<id>",
  "roles": {
    "operator": { "groups": ["hopper-operators"] }
  }
}
```

### Keycloak (SAML)

Realm → **Clients → Create client**, *SAML*, client id `<origin>/ui/auth/keycloak-saml/metadata`.
Valid redirect URI and *Assertion Consumer Service POST Binding URL*:
`<origin>/ui/auth/keycloak-saml/callback`. *Sign assertions* on. Mappers: *User Property* `email`
→ attribute `email`; *Group list* → attribute `groups`, full path off. The realm's certificate is
in `https://keycloak.example.com/realms/<realm>/protocol/saml/descriptor`.

```json
{
  "name": "keycloak-saml",
  "label": "Keycloak",
  "type": "saml",
  "entryPoint": "https://keycloak.example.com/realms/<realm>/protocol/saml",
  "idpCert": "-----BEGIN CERTIFICATE-----\n<base64 certificate>\n-----END CERTIFICATE-----",
  "idpIssuer": "https://keycloak.example.com/realms/<realm>",
  "roles": {
    "admin": { "groups": ["hopper-admins"] }
  }
}
```

## Sessions and logout

The same for every realm, no sign-in and the login code:

- A session is a random token in the browser's `localStorage` for the exact origin, sent as the
  `x-hopper-session` header. The daemon stores only its SHA-256, with the role, the identity and the
  user it acts for.
- It lasts `HOPPER_UI_SESSION_HOURS` (default 12) and survives daemon restarts.
- **Log out** (the header's button) ends the hopper session. It does not sign you out of the
  identity provider: signing in again may need no password.
- Every change saved in Settings → Sign-in, and every start, applies the sign-in config to the stored
  sessions: a realm removed or turned off, a removed password account, no sign-in turned off, or an
  account no rule grants a role any more, loses its session; a changed rule (or account or `none`
  role) changes its role. To cut someone off at once: change the realm in Settings → Sign-in.
- Sign-ins, refusals and logouts are logged to the journal
  (`journalctl --user -u hopper | grep 'UI session\|sign-in'`).

## Troubleshooting

| symptom | cause |
|---|---|
| Daemon will not start, or Settings refuses a change: `invalid sign-in config: realms.0.…` | The named field is wrong; the message says how. |
| `invalid sign-in config: realms.0.users.0.passwordHash: must be an argon2id hash` | The entry holds a password or another hash kind. Run `hopper password-hash`. |
| `realms.0.bindPasswordEnv: environment variable … is not set` | Put the variable in the daemon's environment and restart, or save the realm turned off until then. |
| "this change would end your own admin session" | You signed in with the realm (or the login code) the change turns off, or the change lowers your own role. Sign in as an admin another way, then make the change. |
| Nobody can sign in as an admin any more | Mend the sign-in config on the daemon's host: `hopper config get sign-in > sign-in.json`, fix it (turn the login code on: `"local": { "enabled": true }`), `hopper config version sign-in`, then `hopper config set sign-in --if-version <version> < sign-in.json` and restart the daemon. Then `hopper login-code`. |
| LDAP: "sign-in could not be checked: <realm>: …" | The directory did not answer, or the search account's bind failed: check `url`, the certificate (`NODE_EXTRA_CA_CERTS`), `bindDn` and its variable. |
| LDAP: "wrong username or password" for a real account | `userFilter` under `userBase` finds no entry, or finds two. Try the filter with `ldapsearch -H <url> -D <bindDn> -W -b <userBase> '<filter>'`. |
| LDAP: groups do not match | Group values are full DNs, compared exactly. No `memberOf` on the entry: use `groupSearch`. |
| 429 "too many sign-in attempts" | Over 20 sign-in attempts a minute from one address. Wait a minute. |
| "Sign in on the sign-in address" | The page is open on another address than the sign-in origin. Open the origin shown. |
| The identity provider says the redirect URI does not match | Register exactly `<origin>/ui/auth/<name>/callback`; check `HOPPER_PUBLIC_URL`. |
| "signed in, but the sign-in config grants this account no role" | No rule matched. The journal line names the account; for OIDC check that the email is verified or match on groups. |
| "unknown or expired sign-in; start again" | The sign-in took over 10 minutes, the daemon restarted meanwhile, or the callback was opened twice. |
| "another browser began it" | The callback page ran in a browser (or private window) other than the one that clicked *Sign in*. |
| SAML "Invalid signature" | `idpCert` is not the IdP's current signing certificate, or the IdP signs only the response — sign the assertion. |
| 421 through the proxy | The proxy rewrites `Host`; pass the original host. |
