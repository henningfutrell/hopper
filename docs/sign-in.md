# Signing in — realms

How people sign in to the hopper UI. A **realm** is one way of checking who signs in: password
accounts, an LDAP or Active Directory directory, OpenID Connect, GitHub or SAML. The realms are an
ordered list, each on or off, managed in **Settings → Sign-in**; a change works at once. Beside them:
the one-time login code and no sign-in. The design and its reasons: `docs/design.md` "Sign-in: realms".

Every way of signing in ends the same: a **UI session** with a **UI role**, acting for one **user**
(issue #158). Sessions, roles and logout behave the same whichever realm signed the user in.

- [Pick a setup](#pick-a-setup)
- [Managing sign-in in Settings](#managing-sign-in-in-settings) · [Realm settings](#realm-settings) · [The sign-in config from the CLI](#the-sign-in-config-from-the-cli)
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
| One person, one machine | Nothing. The one-time login code works: `hopper login-code` mints one (good once, 10 minutes); on the host install `bash ~/.local/lib/hopper/scripts/open-ui.sh` opens the UI already logged in. It signs in as `admin`. To sign in with a username and password instead, add an account to the **Password** realm. |
| One person, a few devices on a home LAN | `HOPPER_LAN_NAMES` / `HOPPER_LAN_PEERS` (`docs/design.md` "Reaching the UI across the LAN") and device links, or a password account. |
| Behind a proxy or network that already decides who gets in | [No sign-in](#no-sign-in), with a role. Everyone who reaches the UI acts with that role. |
| A few people, no directory or identity provider | The [password realm](#password-realm): an account per person, added in Settings → Sign-in. |
| A company directory (OpenLDAP, Active Directory, FreeIPA) | An [LDAP realm](#ldap-realm): people sign in with their directory username and password; directory groups grant roles. |
| A team, or anyone reaching it over the internet | A reverse proxy with TLS, `HOPPER_PUBLIC_URL`, one or more realms, role rules, and usually the login code off. |

## Managing sign-in in Settings

Sign-in is not a file. Everything about it — the realms, their settings, the password accounts, the
login code and no sign-in — is kept in the daemon's database and changed in **Settings → Sign-in**,
by an admin. Every setting is a field of a form; nothing is written as YAML or JSON.

The page lists the realms in order, each with its type, a switch to turn it on or off, and — for
OIDC, GitHub and SAML — the callback URL (and SAML metadata URL) to register with the identity
provider, ready to copy. A new hopper starts with one realm, **Password**, with no accounts.

- **Add realm**: pick a type, fill in its fields (every one: [Realm settings](#realm-settings)) and
  **Save**. A field left empty takes its default, shown greyed in the field.
- **Edit** (pencil): the same form, filled in. The name stays: sign-ins are linked to users by it,
  and the identity provider holds it in the callback URL. To rename, remove the realm and add a new one.
- **Move up / down**: the order. The username and password form tries the password and LDAP realms
  that are on in this order, and the first that accepts the password signs in. The OIDC, GitHub and
  SAML realms that are on are sign-in buttons, in this order.
- **On / off**: a realm that is off signs nobody in, and the sessions it made end at once. Its secret
  variable need not be set while it is off.
- **Accounts** (under a password realm): add, change the role of, give a new password to, or remove
  an account: [Password realm](#password-realm).
- **Without a realm**: the login code on or off, and no sign-in with its role.

A change **works at once**, without a restart: the sign-in page follows it, and sessions follow it as
they would at a restart (a realm off or removed, or an account no rule lets in any more, loses its
sessions; a changed role applies). A change that would not load is refused with the reason, naming
the field (a missing secret variable is named too) — nothing is saved. A change that would end **your
own** admin session (turning off or removing the realm you signed in with, lowering your own role,
turning off the login code you signed in with) is refused: sign in as an admin another way first.
Invalid sign-in config stop the daemon at start, with a message naming the field (`journalctl
--user -u hopper`): sign-in fails closed, never open.

**Locked out.** If nobody can sign in as admin any more, turn the login code back on in
[the sign-in config from the CLI](#the-sign-in-config-from-the-cli) where the hopper runs, restart it, and sign in with a code.

Secrets are never entered into a realm: it names the variable that holds one (**Client secret
variable**, **Bind password variable**). Set the variable in the daemon's environment — `daemon.env`
on the host install, the container's env file otherwise — or mount the secret as a file and set
`<variable>_FILE` to its path (design.md "Secrets"), and restart once; after that the realm can be
changed in Settings without a restart. The SAML certificate is not a secret: it is pasted into its
field (PEM or bare base64).

## Realm settings

Every type has a **Name** (lowercase letters, digits, dashes; part of the callback URL), a **Label**
(shown in Settings and on the sign-in button; default: the name), and is on or off. Every type but
password has **role rules** and a **default role** ([UI roles and role rules](#ui-roles-and-role-rules)).
The setting's name in error messages is in brackets.

| type | field | default | |
|---|---|---|---|
| `password` | — | | Its accounts, under the realm: [Password realm](#password-realm). |
| `ldap` | Directory URL (`url`) | — | `ldaps://host[:port]`, or `ldap://` with StartTLS on; plain `ldap://` only to `127.0.0.1`/`localhost`. |
| | StartTLS (`startTls`) | off | Upgrade an `ldap://` connection with StartTLS. |
| | Bind DN, Bind password variable (`bindDn`, `bindPasswordEnv`) | none (anonymous search) | The account that searches for the user, and the variable holding its password. |
| | User base (`userBase`) | — | Where people are: `ou=people,dc=example,dc=com`. |
| | User filter (`userFilter`) | `(uid={username})` | `{username}` is the typed username, escaped. Active Directory: `(sAMAccountName={username})`. |
| | Subject attribute (`attributes.subject`) | the entry's DN | A stable id: `entryUUID` (OpenLDAP), `objectGUID` (AD). |
| | Username / Email / Name / Group attribute (`attributes.…`) | `uid` / `mail` / `cn` / `memberOf` | Attribute names. Group values are group DNs. |
| | Group search base, filter, name attribute (`groupSearch.…`) | none; `(member={dn})`; `cn` | Groups found by search, for a directory without `memberOf`; the group is known by its name attribute. |
| `oidc` | Issuer URL (`issuer`) | — | Discovery reads `<issuer>/.well-known/openid-configuration`. https (http only to `127.0.0.1`/`localhost`). |
| | Client ID (`clientId`) | — | |
| | Client secret variable (`clientSecretEnv`) | none | The environment variable holding the secret. Empty for a public client (PKCE only). |
| | Scopes (`scopes`) | `openid email profile` | Space-separated. Add what your groups claim needs (`groups` at Okta). |
| | Email / Username / Name / Groups claim (`claims.…`) | `email` / `preferred_username` / `name` / `groups` | Claim names, read from the ID token, then userinfo. Groups may be a list or one string. |
| | Trust unverified email (`trustUnverifiedEmail`) | off | Count the email even without `email_verified: true`. Only for an issuer whose emails you control. |
| `github` | Client ID, Client secret variable (`clientId`, `clientSecretEnv`) | — | An OAuth app (not a GitHub App). Both are required. |
| | GitHub URL / API URL (`webUrl` / `apiUrl`) | `https://github.com` / `https://api.github.com` | GitHub Enterprise Server: `https://ghe.example.com` and `https://ghe.example.com/api/v3`. |
| `saml` | Sign-on URL (`entryPoint`) | — | The IdP's single sign-on URL (HTTP-Redirect binding). |
| | Identity provider certificate (`idpCert`) | — | The IdP's signing certificate: PEM or bare base64. |
| | Identity provider issuer (`idpIssuer`) | none | The IdP's entity id. Set it: a response from another issuer is then refused. |
| | Entity ID (`entityId`) | `<sign-in origin>/ui/auth/<name>/metadata` | This service's entity id (the IdP calls it Identifier or Audience). |
| | Email / Name / Groups / Username attribute (`attributes.…`) | `email` / `displayName` / `groups` / NameID | Attribute names in the assertion. |
| | Require a signed response (`requireSignedResponse`) | off | Also require the whole response signed. The assertion must be signed either way. |

## The sign-in config from the CLI

For scripts, and to mend sign-in that locks everyone out, the operator CLI reads and replaces the
**sign-in config** — the realms with their settings, the login code and no sign-in, the config record
`sign-in`, as one JSON value — on the daemon's host. It does not hold the password accounts: those are only changed in
Settings → Sign-in, and a record that carries them is refused. `hopper config get sign-in` prints it,
`hopper config version sign-in` prints its version, and `hopper config set sign-in --if-version
<version>` replaces it with the JSON on stdin. A record that does not load, or that changed since you
read its version, is refused and nothing is written. A change made with the CLI applies at the next
start (`systemctl --user restart hopper` on the host install).

To turn the login code back on after a lockout:

```sh
hopper config get sign-in > sign-in.json      # set "local": { "enabled": true } in it
hopper config version sign-in
hopper config set sign-in --if-version <version> < sign-in.json
systemctl --user restart hopper
hopper login-code --link http://127.0.0.1:4790
```

In the record each field has the name in brackets in [Realm settings](#realm-settings); `version` is
`1`, `local.enabled` the login code (default on), `none.role` no sign-in (absent: off), and `realms`
the realms in order, each with `name`, `label`, `type`, `enabled` (absent: on) and `roles`.

**From before.** Older installs were migrated when the daemon updated: the sign-in document of an
earlier version became realms (issue #185), then the JSON record (issue #198), then its password
accounts moved out of it into a table of their own (issue #200), each with its username, hash and
role. Nothing to do; sign-ins and sessions carry on. `hopper password-hash` is gone: an admin sets a
password in Settings → Sign-in.

## No sign-in

Settings → Sign-in → **Without a realm** → **No sign-in**: pick the role (viewer, operator or admin).

Anyone who reaches the UI gets a session with that role, without a credential: the UI takes it by
itself (`POST /ui/auth/none`; the exact UI origin is required, so another site cannot mint one in a
visitor's browser). The daemon logs `NO SIGN-IN is on` at every start. It combines with the rest:
no sign-in as viewer plus a realm or the login code means everyone may look and those who sign
in may act. Use it only where something in front — a VPN, a proxy with its own login, a network only
you reach — already decides who gets in. As admin, anyone who reaches the UI can change every setting.

## Password realm

Its **accounts** are listed under it in Settings → Sign-in: username, role, and the user each signs
in as.

- **Add account**: a username, a password (8 characters or more), a role (viewer, operator or admin),
  and **Signs in as**: an existing user (Settings → Users), or "a new user of its own", made at its
  first sign-in ([Who signs in as which user](#who-signs-in-as-which-user)). To sign in to your own
  work with a password, pick your user — `owner` on a hopper with one user.
- **Role**: change it in the account's row; it applies at once, also to its open sessions.
- **New password** (key): sets a new one; the old one stops working at once.
- **Remove** (bin): its sessions end at once. The user it signed in as, and their work, stay.

The hopper keeps only an **argon2id hash** of each password, never the password. Usernames are
unique within the realm, case ignored. The user an account signs in as is fixed once it has signed
in; to change it, remove the account and add it again. A wrong password, an unknown username and an
empty password get the same 403, and an unknown username costs the same time as a wrong password.
A password realm with no account offers no username and password form. The form works on every UI
origin (loopback, a LAN name, the public URL).

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

| field | value |
|---|---|
| Type | LDAP or Active Directory |
| Name | `directory` |
| Label | Directory |
| Directory URL | `ldaps://ldap.example.com` |
| Bind DN | `cn=hopper,ou=services,dc=example,dc=com` |
| Bind password variable | `LDAP_BIND_PASSWORD` |
| User base | `ou=people,dc=example,dc=com` |
| Subject attribute | `entryUUID` |
| Role rules | admin for these groups: `cn=hopper-admins,ou=groups,dc=example,dc=com`; operator for these groups: `cn=hopper-operators,ou=groups,dc=example,dc=com` |

Active Directory:

| field | value |
|---|---|
| Type | LDAP or Active Directory |
| Name | `ad` |
| Label | Company account |
| Directory URL | `ldaps://dc1.corp.example.com` |
| Bind DN | `CN=hopper,OU=Service Accounts,DC=corp,DC=example,DC=com` |
| Bind password variable | `AD_BIND_PASSWORD` |
| User base | `DC=corp,DC=example,DC=com` |
| User filter | `(sAMAccountName={username})` |
| Subject attribute | `objectGUID` |
| Username attribute | `sAMAccountName` |
| Name attribute | `displayName` |
| Role rules | admin for these groups: `CN=Hopper Admins,OU=Groups,DC=corp,DC=example,DC=com` |

In the daemon's environment: `LDAP_BIND_PASSWORD=<password>` (or `AD_BIND_PASSWORD`), then restart
once.

- **Groups** are the values of the **Group attribute** (default `memberOf`): full group DNs, compared
  exactly as the directory gives them. A directory without `memberOf` (an OpenLDAP without the
  memberof overlay): set **Group search base** to `ou=groups,dc=example,dc=com` and match on the
  group's `cn` (a rule for the group `hopper-admins`).
- **Subject**: set **Subject attribute** to an id that survives a rename (`entryUUID`, `objectGUID`).
  Left out, it is the entry's DN, which changes when the person is moved or renamed — and then signs
  in as a new user.
- The **email** (`mail`) counts as verified: the directory vouches for it, so `emails` and
  `emailDomains` rules apply.
- **TLS**: `ldaps://`, or `ldap://` with **StartTLS** on; the server's certificate must be trusted by
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

The login code always signs in as `admin`, a password account as its own role. For every other
realm, its **role rules** decide, the same way for every type:

- A rule grants a role — `admin`, `operator` or `viewer` — to the subjects, usernames, emails, email
  domains or groups it lists, one per line. Any one match grants the role; **the highest matching
  role wins**.
- `emails`, `emailDomains`, `usernames` ignore case; `subjects` and `groups` compare exactly.
- Prefer identifiers the user cannot change: `subjects`, groups, verified emails. `usernames` is only
  as stable as the realm makes it — a GitHub login can be renamed and taken by someone else; an
  OIDC `preferred_username` is user-editable at some issuers.
  The email domain `example.com` matches `a@example.com`, not `a@sub.example.com`.
- Nothing matches → the **default role**; none → **no session** ("signed in, but the sign-in config
  grants this account no role"). A realm with no rules and no default role lets nobody in — on purpose.
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

Each section: what to create at the identity provider, then the realm's fields — fill them in at
**Settings → Sign-in → Add realm**; a field not listed stays empty (its default). Replace `<origin>`
with the sign-in origin. Put each client secret variable, as `NAME=<secret>`, in the daemon's
environment (`daemon.env` on the host install), and restart once so the daemon has it.

### Google

1. https://console.cloud.google.com/apis/credentials → **Create credentials → OAuth client ID** →
   *Web application*.
2. Authorized redirect URI: `<origin>/ui/auth/google/callback`.
3. Copy the client id and secret.

| field | value |
|---|---|
| Type | OpenID Connect |
| Name | `google` |
| Label | Google |
| Issuer URL | `https://accounts.google.com` |
| Client ID | `1234-abc.apps.googleusercontent.com` |
| Client secret variable | `GOOGLE_CLIENT_SECRET` |
| Role rules | admin for these emails: `ada@example.com` |

In the daemon's environment: `GOOGLE_CLIENT_SECRET=<secret>`.

Google sends no groups. For "everyone in our Google Workspace", match the hosted-domain claim
rather than the email domain (a personal Google account can carry a verified address at any domain):
set **Groups claim** to `hd` and add the rule "groups: `example.com`".

### Microsoft Entra ID (OIDC)

1. https://entra.microsoft.com → **App registrations → New registration**, single tenant.
   Redirect URI: *Web*, `<origin>/ui/auth/entra/callback`.
2. **Certificates & secrets → New client secret**.
3. For group rules: **Token configuration → Add groups claim** (security groups; the ID token then
   carries group object ids), or define **App roles** and assign them (claim `roles`).

| field | value |
|---|---|
| Type | OpenID Connect |
| Name | `entra` |
| Label | Microsoft |
| Issuer URL | `https://login.microsoftonline.com/<tenant-id>/v2.0` |
| Client ID | `<application (client) id>` |
| Client secret variable | `ENTRA_CLIENT_SECRET` |
| Groups claim | `roles` |
| Role rules | admin for these groups: `Hopper.Admin`; operator for these groups: `Hopper.Operator` |

**Groups claim** `roles` matches on app roles. Leave it empty to match on the groups claim (group
object ids).
Use the tenant-specific issuer, not `common`/`organizations`. Entra does not send `email_verified`:
match on groups, app roles or `usernames` (the UPN in `preferred_username`), not on `emails`.

### Okta (OIDC)

1. Okta admin → **Applications → Create App Integration** → *OIDC*, *Web Application*.
   Sign-in redirect URI: `<origin>/ui/auth/okta/callback`. Assign people or groups.
2. For group rules: in the app's **Sign On** tab, *OpenID Connect ID Token* → Groups claim type
   *Filter*, name `groups`, e.g. *Starts with* `hopper-`.

| field | value |
|---|---|
| Type | OpenID Connect |
| Name | `okta` |
| Label | Okta |
| Issuer URL | `https://<your-org>.okta.com` |
| Client ID | `<client id>` |
| Client secret variable | `OKTA_CLIENT_SECRET` |
| Scopes | `openid email profile groups` |
| Role rules | admin for these groups: `hopper-admins`; operator for these groups: `hopper-operators` |

With a custom authorization server the issuer is `https://<your-org>.okta.com/oauth2/default`.

### Auth0

1. Auth0 dashboard → **Applications → Create Application** → *Regular Web Application*.
   Allowed Callback URLs: `<origin>/ui/auth/auth0/callback`.
2. For role rules: an Action on *Login* that adds the user's roles as a namespaced claim:
   `api.idToken.setCustomClaim('https://hopper.example.com/roles', event.authorization?.roles ?? [])`.

| field | value |
|---|---|
| Type | OpenID Connect |
| Name | `auth0` |
| Label | Auth0 |
| Issuer URL | `https://<tenant>.auth0.com/` |
| Client ID | `<client id>` |
| Client secret variable | `AUTH0_CLIENT_SECRET` |
| Groups claim | `https://hopper.example.com/roles` |
| Role rules | admin for these groups: `hopper-admin` |
| Default role | viewer |

Keep the trailing slash of `issuer`: it is part of Auth0's issuer.

### Keycloak (OIDC)

1. Realm → **Clients → Create client**, *OpenID Connect*, client authentication on, standard flow.
   Valid redirect URI: `<origin>/ui/auth/keycloak/callback`.
2. For group rules: the client's dedicated scope → **Add mapper → Group Membership**, token claim
   name `groups`, *Full group path* off, *Add to ID token* on.

| field | value |
|---|---|
| Type | OpenID Connect |
| Name | `keycloak` |
| Label | Keycloak |
| Issuer URL | `https://keycloak.example.com/realms/<realm>` |
| Client ID | `hopper` |
| Client secret variable | `KEYCLOAK_CLIENT_SECRET` |
| Role rules | admin for these groups: `hopper-admins`; operator for these groups: `hopper-operators` |

### GitHub

GitHub's OAuth apps are OAuth 2.0, not OIDC; the `github` type reads the user, their primary
verified email and (when a rule names groups) their teams from the API.

1. https://github.com/settings/developers → **OAuth Apps → New OAuth App** (for an organization:
   the organization's *Settings → Developer settings*). Authorization callback URL:
   `<origin>/ui/auth/github/callback`.
2. **Generate a new client secret**.
3. Team rules need the organization to allow the app (*Third-party access* policy).

| field | value |
|---|---|
| Type | GitHub |
| Name | `github` |
| Label | GitHub |
| Client ID | `<client id>` |
| Client secret variable | `GITHUB_OAUTH_CLIENT_SECRET` |
| Role rules | admin for these subjects: `583231`; operator for these groups: `acme/platform` |

A subject is the numeric user id: `id` in `https://api.github.com/users/<login>`. A group is a team,
as `org/team-slug`. Grant by `subjects` (the numeric id) or teams, not `usernames`: a GitHub login can be renamed, and
the old name registered by someone else.

GitHub Enterprise Server: set **GitHub URL** `https://ghe.example.com` and **API URL**
`https://ghe.example.com/api/v3`. Teams are read from the first page (100).

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

| field | value |
|---|---|
| Type | SAML |
| Name | `corp` |
| Label | Corp SSO |
| Sign-on URL | `https://idp.example.com/sso/saml` |
| Identity provider certificate | the certificate, PEM (`-----BEGIN CERTIFICATE-----` …) |
| Identity provider issuer | `https://idp.example.com/metadata` |
| Email attribute | `email` |
| Name attribute | `displayName` |
| Groups attribute | `groups` |
| Role rules | admin for these groups: `hopper-admins` |
| Default role | viewer |

`idpCert` is the PEM on one line, its line breaks written `\n`; the bare base64 alone works too.

### Microsoft Entra ID (SAML)

Entra → **Enterprise applications → New application → Create your own** (non-gallery) → **Single
sign-on → SAML**. Identifier: `<origin>/ui/auth/entra-saml/metadata`; Reply URL:
`<origin>/ui/auth/entra-saml/callback`. Under *Attributes & Claims* add a group claim. Download
*Certificate (Base64)*; *Login URL* is the entry point, *Microsoft Entra Identifier* the issuer.

| field | value |
|---|---|
| Type | SAML |
| Name | `entra-saml` |
| Label | Microsoft |
| Sign-on URL | `https://login.microsoftonline.com/<tenant-id>/saml2` |
| Identity provider certificate | the certificate, PEM (`-----BEGIN CERTIFICATE-----` …) |
| Identity provider issuer | `https://sts.windows.net/<tenant-id>/` |
| Email attribute | `http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress` |
| Name attribute | `http://schemas.microsoft.com/identity/claims/displayname` |
| Groups attribute | `http://schemas.microsoft.com/ws/2008/06/identity/claims/groups` |
| Role rules | admin for these groups: `<group object id>` |

### Okta (SAML)

Okta admin → **Create App Integration → SAML 2.0**. Single sign-on URL:
`<origin>/ui/auth/okta-saml/callback`; Audience URI: `<origin>/ui/auth/okta-saml/metadata`.
Attribute statements `email` → `user.email`, `displayName` → `user.displayName`; group attribute
statement `groups`, filter e.g. *Starts with* `hopper-`. From *View SAML setup instructions* take
the SSO URL, issuer and certificate.

| field | value |
|---|---|
| Type | SAML |
| Name | `okta-saml` |
| Label | Okta |
| Sign-on URL | `https://<your-org>.okta.com/app/<app>/<id>/sso/saml` |
| Identity provider certificate | the certificate, PEM (`-----BEGIN CERTIFICATE-----` …) |
| Identity provider issuer | `http://www.okta.com/<id>` |
| Role rules | operator for these groups: `hopper-operators` |

### Keycloak (SAML)

Realm → **Clients → Create client**, *SAML*, client id `<origin>/ui/auth/keycloak-saml/metadata`.
Valid redirect URI and *Assertion Consumer Service POST Binding URL*:
`<origin>/ui/auth/keycloak-saml/callback`. *Sign assertions* on. Mappers: *User Property* `email`
→ attribute `email`; *Group list* → attribute `groups`, full path off. The realm's certificate is
in `https://keycloak.example.com/realms/<realm>/protocol/saml/descriptor`.

| field | value |
|---|---|
| Type | SAML |
| Name | `keycloak-saml` |
| Label | Keycloak |
| Sign-on URL | `https://keycloak.example.com/realms/<realm>/protocol/saml` |
| Identity provider certificate | the certificate, PEM (`-----BEGIN CERTIFICATE-----` …) |
| Identity provider issuer | `https://keycloak.example.com/realms/<realm>` |
| Role rules | admin for these groups: `hopper-admins` |

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
| Daemon will not start, or Settings refuses a change: `invalid sign-in config: realms.0.…` | The named field of the first realm (`realms.1` the second, …) is wrong; the message says how. |
| `realms.0.bindPasswordEnv: environment variable … is not set` | Put the variable in the daemon's environment and restart, or save the realm turned off until then. |
| "this change would end your own admin session" | You signed in with the realm (or the login code) the change turns off, or the change lowers your own role. Sign in as an admin another way, then make the change. |
| Nobody can sign in as an admin any more | Turn the login code back on in [the sign-in config from the CLI](#the-sign-in-config-from-the-cli) on the daemon's host, restart it, then `hopper login-code`. |
| LDAP: "sign-in could not be checked: <realm>: …" | The directory did not answer, or the search account's bind failed: check `url`, the certificate (`NODE_EXTRA_CA_CERTS`), `bindDn` and its variable. |
| LDAP: "wrong username or password" for a real account | `userFilter` under `userBase` finds no entry, or finds two. Try the filter with `ldapsearch -H <url> -D <bindDn> -W -b <userBase> '<filter>'`. |
| LDAP: groups do not match | Group values are full DNs, compared exactly, one per line in the rule. No `memberOf` on the entry: set a group search base. |
| 429 "too many sign-in attempts" | Over 20 sign-in attempts a minute from one address. Wait a minute. |
| "Sign in on the sign-in address" | The page is open on another address than the sign-in origin. Open the origin shown. |
| The identity provider says the redirect URI does not match | Register exactly `<origin>/ui/auth/<name>/callback`; check `HOPPER_PUBLIC_URL`. |
| "signed in, but the sign-in config grants this account no role" | No rule matched. The journal line names the account; for OIDC check that the email is verified or match on groups. |
| "unknown or expired sign-in; start again" | The sign-in took over 10 minutes, the daemon restarted meanwhile, or the callback was opened twice. |
| "another browser began it" | The callback page ran in a browser (or private window) other than the one that clicked *Sign in*. |
| SAML "Invalid signature" | `idpCert` is not the IdP's current signing certificate, or the IdP signs only the response — sign the assertion. |
| 421 through the proxy | The proxy rewrites `Host`; pass the original host. |
