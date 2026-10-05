# Signing in — none, password, local, OIDC and SAML

How people sign in to the hopper UI, and how to plug it into an identity provider. The
design and its reasons: `docs/design.md` "Sign-in: none, password, local, OIDC and SAML".

Every way of signing in ends the same: a **UI session** with a **UI role**. Sessions, roles and
logout behave the same whichever provider signed the user in.

- [Pick a setup](#pick-a-setup)
- [auth.yaml](#authyaml)
- [No sign-in](#no-sign-in) · [Password sign-in](#password-sign-in)
- [UI roles and role rules](#ui-roles-and-role-rules)
- [The sign-in origin and a public URL](#the-sign-in-origin-and-a-public-url)
- [Providers](#providers): [Google](#google) · [Microsoft Entra ID](#microsoft-entra-id-oidc) ·
  [Okta](#okta-oidc) · [Auth0](#auth0) · [Keycloak](#keycloak-oidc) · [GitHub](#github) ·
  [SAML (any)](#saml-any-identity-provider) · [Entra SAML](#microsoft-entra-id-saml) ·
  [Okta SAML](#okta-saml) · [Keycloak SAML](#keycloak-saml)
- [Sessions and logout](#sessions-and-logout)
- [Troubleshooting](#troubleshooting)

## Pick a setup

| setup | what to do |
|---|---|
| One person, one machine | Nothing. With no `auth.yaml`, the one-time login code is the only way in: `hopper login-code` mints one (good once, 10 minutes); on the host install `bash ~/.local/lib/hopper/scripts/open-ui.sh` opens the UI already logged in. It signs in as `admin`. |
| One person, a few devices on a home LAN | `HOPPER_LAN_NAMES` / `HOPPER_LAN_PEERS` (`docs/design.md` "Reaching the UI across the LAN") and device links. Add a provider if you prefer signing in with an account. |
| Behind a proxy or network that already decides who gets in | [No sign-in](#no-sign-in): `none: { role: … }`. Everyone who reaches the UI acts with that role. |
| A few people, no identity provider | [Password sign-in](#password-sign-in): accounts with argon2id hashes in `auth.yaml`. |
| A team, or anyone reaching it over the internet | A reverse proxy with TLS, `HOPPER_PUBLIC_URL`, one or more providers in `auth.yaml` (or password sign-in), role rules, and usually `local: { enabled: false }`. |

## auth.yaml

`auth.yaml` is a **config document** in the daemon's database, not a file. Write or change it with
`hopper config edit auth.yaml` (opens `$EDITOR`, writes back against the version it read), or
`hopper config set auth.yaml --if-version <version>` with the text on stdin;
`hopper config version auth.yaml` prints the version. A document that does not load, or that
moved since you read it, is refused. **Read at start**: after changing it, restart the daemon
(`systemctl --user restart hopper` on the host install). An invalid document stops the daemon
with a message naming the field (`journalctl --user -u hopper`): sign-in fails closed, never
open.

```yaml
version: 1
local:
  enabled: true          # the one-time login code (signs in as admin). Default true.
none:                    # no sign-in: everyone gets this role. Absent: off.
  role: viewer
password:                # password sign-in. Absent: off.
  users:
    - { username: ada, passwordHash: "$argon2id$v=19$…", role: operator }
providers:
  - name: google         # lowercase letters, digits, dashes: it is part of the callback URL
    label: Google        # the button says "Sign in with Google"; default: the name
    type: oidc           # oidc | github | saml
    # … the type's settings, below …
    roles:               # who gets which UI role; nobody, if left out
      admin:    { emails: [ada@example.com] }
      operator: { emailDomains: [example.com] }
      defaultRole: null  # the role of a signed-in account no rule matches; null: no session
```

A client secret comes **only** from the runtime: `clientSecretEnv` names the variable. Put the
variable in the daemon's environment — `daemon.env` on the host install, the container's env file
otherwise — or mount the secret as a file and set `<variable>_FILE` to its path (design.md "Secrets"). Inline `clientSecret` and `clientSecretFile` are refused. The SAML certificate is not a
secret: `idpCert`, inline only (PEM or bare base64; a YAML block scalar `|` holds a PEM).
`idpCertFile` is refused.

**Per type:**

| type | setting | default | |
|---|---|---|---|
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

## No sign-in

```yaml
version: 1
none: { role: viewer }   # viewer | operator | admin
```

Anyone who reaches the UI gets a session with that role, without a credential: the UI takes it by
itself (`POST /ui/auth/none`; the exact UI origin is required, so another site cannot mint one in a
visitor's browser). The daemon logs `NO SIGN-IN is on` at every start. It combines with the rest:
`none: { role: viewer }` plus password sign-in, a provider or the login code means everyone may
look and those who sign in may act. Use it only where something in front — a VPN, a proxy with
its own login, a network only you reach — already decides who gets in. With `role: admin`, anyone
who reaches the UI can change every setting.

## Password sign-in

```yaml
version: 1
password:
  users:
    - username: ada
      passwordHash: "$argon2id$v=19$m=65536,p=4,t=3$…"
      role: operator     # viewer | operator | admin
```

`auth.yaml` holds an **argon2id hash**, never a password. Make one with the operator CLI (it asks
twice without echo on a terminal; from a pipe it reads the first line):

```sh
hopper password-hash
```

then paste it with `hopper config edit auth.yaml` and restart. Usernames are unique, case
ignored. A wrong password, an unknown username and an empty password get the same 403, and an
unknown username costs the same time as a wrong password. To change a password, replace the hash;
to remove an account, delete its entry — either way restart, and its sessions end at that start.
The UI shows a username and password form; the form works on every UI origin (loopback, a LAN
name, the public URL).

**Rate limit.** Every sign-in route (`/ui/login`, `/ui/auth/…`) together accepts 20 attempts a
minute per client address; past that, 429 until the minute is over. Behind a reverse proxy every
client has the proxy's address, so the limit is shared: add a per-client limit at the proxy for a
public deploy.

## UI roles and role rules

| UI role | may |
|---|---|
| `viewer` | read everything the UI shows |
| `operator` | + cancel and approve jobs; answer, close, dismiss questions and mark them seen |
| `admin` | + change configuration: plugins, machines, routing rules, webhooks, the rules file, router mode; apply updates; hand out device links |

The login code always signs in as `admin`. For a provider, `roles` decides, the same way for every
type:

- `admin`, `operator`, `viewer` each take any of `subjects`, `usernames`, `emails`, `emailDomains`,
  `groups`. Any one match grants the role; **the highest matching role wins**.
- `emails`, `emailDomains`, `usernames` ignore case; `subjects` and `groups` compare exactly.
- Prefer identifiers the user cannot change: `subjects`, groups, verified emails. `usernames` is only
  as stable as the provider makes it — a GitHub login can be renamed and taken by someone else; an
  OIDC `preferred_username` is user-editable at some issuers.
  `emailDomains: [example.com]` matches `a@example.com`, not `a@sub.example.com`.
- Nothing matches → `defaultRole`; absent or `null` → **no session** ("signed in, but auth.yaml
  grants this account no role"). Leaving `roles` out lets nobody in — on purpose.
- Only an email the provider vouches for counts: OIDC `email_verified: true` (or
  `trustUnverifiedEmail`), GitHub's primary verified email, SAML's asserted email.

What fills each field:

| field | OIDC | GitHub | SAML |
|---|---|---|---|
| subject | `sub` | numeric user id | NameID |
| username | `claims.username` | login | `attributes.username`, else NameID |
| email | `claims.email` if verified | primary verified email | `attributes.email` |
| groups | `claims.groups` | teams as `org/team-slug` (asks for `read:org` only when a rule names groups) | `attributes.groups` |

A UI role is not a plugin role: see `docs/glossary.md`.

## The sign-in origin and a public URL

A provider sends the browser back to one fixed address, the **sign-in origin**:

- `HOPPER_PUBLIC_URL` when set (origin only: `https://hopper.example.com`), else
- `http://localhost:<port>` — fine for one machine; most providers accept `localhost` redirects.

Register these with the provider (`<origin>` = the sign-in origin, `<name>` = the provider's name):

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

## Providers

Each section: what to create at the provider, then the `auth.yaml` entry. Replace `<origin>` with
the sign-in origin. Put each `clientSecretEnv` variable, as `NAME=<secret>`, in the daemon's
environment (`daemon.env` on the host install), then restart.

### Google

1. https://console.cloud.google.com/apis/credentials → **Create credentials → OAuth client ID** →
   *Web application*.
2. Authorized redirect URI: `<origin>/ui/auth/google/callback`.
3. Copy the client id and secret.

```yaml
  - name: google
    label: Google
    type: oidc
    issuer: https://accounts.google.com
    clientId: 1234-abc.apps.googleusercontent.com
    clientSecretEnv: GOOGLE_CLIENT_SECRET
    roles:
      admin: { emails: [ada@example.com] }
```

In the daemon's environment: `GOOGLE_CLIENT_SECRET=<secret>`.

Google sends no groups. For "everyone in our Google Workspace", match the hosted-domain claim
rather than the email domain (a personal Google account can carry a verified address at any domain):
set `claims: { groups: hd }` and grant `groups: [example.com]`.

### Microsoft Entra ID (OIDC)

1. https://entra.microsoft.com → **App registrations → New registration**, single tenant.
   Redirect URI: *Web*, `<origin>/ui/auth/entra/callback`.
2. **Certificates & secrets → New client secret**.
3. For group rules: **Token configuration → Add groups claim** (security groups; the ID token then
   carries group object ids), or define **App roles** and assign them (claim `roles`).

```yaml
  - name: entra
    label: Microsoft
    type: oidc
    issuer: https://login.microsoftonline.com/<tenant-id>/v2.0
    clientId: <application (client) id>
    clientSecretEnv: ENTRA_CLIENT_SECRET
    claims: { groups: roles }        # app roles; leave out to use the groups claim (object ids)
    roles:
      admin:    { groups: [Hopper.Admin] }
      operator: { groups: [Hopper.Operator] }
```

Use the tenant-specific issuer, not `common`/`organizations`. Entra does not send `email_verified`:
match on groups, app roles or `usernames` (the UPN in `preferred_username`), not on `emails`.

### Okta (OIDC)

1. Okta admin → **Applications → Create App Integration** → *OIDC*, *Web Application*.
   Sign-in redirect URI: `<origin>/ui/auth/okta/callback`. Assign people or groups.
2. For group rules: in the app's **Sign On** tab, *OpenID Connect ID Token* → Groups claim type
   *Filter*, name `groups`, e.g. *Starts with* `hopper-`.

```yaml
  - name: okta
    label: Okta
    type: oidc
    issuer: https://<your-org>.okta.com
    clientId: <client id>
    clientSecretEnv: OKTA_CLIENT_SECRET
    scopes: [openid, email, profile, groups]
    roles:
      admin:    { groups: [hopper-admins] }
      operator: { groups: [hopper-operators] }
```

With a custom authorization server the issuer is `https://<your-org>.okta.com/oauth2/default`.

### Auth0

1. Auth0 dashboard → **Applications → Create Application** → *Regular Web Application*.
   Allowed Callback URLs: `<origin>/ui/auth/auth0/callback`.
2. For role rules: an Action on *Login* that adds the user's roles as a namespaced claim:
   `api.idToken.setCustomClaim('https://hopper.example.com/roles', event.authorization?.roles ?? [])`.

```yaml
  - name: auth0
    label: Auth0
    type: oidc
    issuer: https://<tenant>.auth0.com/     # the trailing slash is part of Auth0's issuer
    clientId: <client id>
    clientSecretEnv: AUTH0_CLIENT_SECRET
    claims: { groups: https://hopper.example.com/roles }
    roles:
      admin: { groups: [hopper-admin] }
      defaultRole: viewer
```

### Keycloak (OIDC)

1. Realm → **Clients → Create client**, *OpenID Connect*, client authentication on, standard flow.
   Valid redirect URI: `<origin>/ui/auth/keycloak/callback`.
2. For group rules: the client's dedicated scope → **Add mapper → Group Membership**, token claim
   name `groups`, *Full group path* off, *Add to ID token* on.

```yaml
  - name: keycloak
    label: Keycloak
    type: oidc
    issuer: https://keycloak.example.com/realms/<realm>
    clientId: hopper
    clientSecretEnv: KEYCLOAK_CLIENT_SECRET
    roles:
      admin:    { groups: [hopper-admins] }
      operator: { groups: [hopper-operators] }
```

### GitHub

GitHub's OAuth apps are OAuth 2.0, not OIDC; the `github` type reads the user, their primary
verified email and (when a rule names groups) their teams from the API.

1. https://github.com/settings/developers → **OAuth Apps → New OAuth App** (for an organization:
   the organization's *Settings → Developer settings*). Authorization callback URL:
   `<origin>/ui/auth/github/callback`.
2. **Generate a new client secret**.
3. Team rules need the organization to allow the app (*Third-party access* policy).

```yaml
  - name: github
    label: GitHub
    type: github
    clientId: <client id>
    clientSecretEnv: GITHUB_OAUTH_CLIENT_SECRET
    roles:
      admin:    { subjects: ["583231"] }        # the numeric user id: https://api.github.com/users/<login> → id
      operator: { groups: [acme/platform] }     # org/team-slug
```

Grant by `subjects` (the numeric id) or teams, not `usernames`: a GitHub login can be renamed, and
the old name registered by someone else.

GitHub Enterprise Server: add `webUrl: https://ghe.example.com` and
`apiUrl: https://ghe.example.com/api/v3`. Teams are read from the first page (100).

### SAML (any identity provider)

hopper is a SAML service provider: SP-initiated sign-in, HTTP-Redirect for the request,
HTTP-POST for the response. Unsolicited (IdP-initiated) responses are refused.

1. Give the IdP these (or the metadata at `<origin>/ui/auth/<name>/metadata`, served once the
   provider is in `auth.yaml` and the daemon restarted):
   - entity id / audience: `<origin>/ui/auth/<name>/metadata`
   - assertion consumer service (HTTP-POST): `<origin>/ui/auth/<name>/callback`
2. Have it sign assertions (SHA-256), with a persistent NameID, and send email, display name and
   groups attributes.
3. From the IdP take: its SSO URL (`entryPoint`), signing certificate (`idpCert`) and entity id
   (`idpIssuer`).

```yaml
  - name: corp
    label: Corp SSO
    type: saml
    entryPoint: https://idp.example.com/sso/saml
    idpCert: |
      -----BEGIN CERTIFICATE-----
      <base64 certificate>
      -----END CERTIFICATE-----
    idpIssuer: https://idp.example.com/metadata
    attributes: { email: email, name: displayName, groups: groups }
    roles:
      admin: { groups: [hopper-admins] }
      defaultRole: viewer
```

### Microsoft Entra ID (SAML)

Entra → **Enterprise applications → New application → Create your own** (non-gallery) → **Single
sign-on → SAML**. Identifier: `<origin>/ui/auth/entra-saml/metadata`; Reply URL:
`<origin>/ui/auth/entra-saml/callback`. Under *Attributes & Claims* add a group claim. Download
*Certificate (Base64)*; *Login URL* is the entry point, *Microsoft Entra Identifier* the issuer.

```yaml
  - name: entra-saml
    label: Microsoft
    type: saml
    entryPoint: https://login.microsoftonline.com/<tenant-id>/saml2
    idpCert: |
      -----BEGIN CERTIFICATE-----
      <base64 certificate>
      -----END CERTIFICATE-----
    idpIssuer: https://sts.windows.net/<tenant-id>/
    attributes:
      email: http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress
      name: http://schemas.microsoft.com/identity/claims/displayname
      groups: http://schemas.microsoft.com/ws/2008/06/identity/claims/groups
    roles:
      admin: { groups: [<group object id>] }
```

### Okta (SAML)

Okta admin → **Create App Integration → SAML 2.0**. Single sign-on URL:
`<origin>/ui/auth/okta-saml/callback`; Audience URI: `<origin>/ui/auth/okta-saml/metadata`.
Attribute statements `email` → `user.email`, `displayName` → `user.displayName`; group attribute
statement `groups`, filter e.g. *Starts with* `hopper-`. From *View SAML setup instructions* take
the SSO URL, issuer and certificate.

```yaml
  - name: okta-saml
    label: Okta
    type: saml
    entryPoint: https://<your-org>.okta.com/app/<app>/<id>/sso/saml
    idpCert: |
      -----BEGIN CERTIFICATE-----
      <base64 certificate>
      -----END CERTIFICATE-----
    idpIssuer: http://www.okta.com/<id>
    roles:
      operator: { groups: [hopper-operators] }
```

### Keycloak (SAML)

Realm → **Clients → Create client**, *SAML*, client id `<origin>/ui/auth/keycloak-saml/metadata`.
Valid redirect URI and *Assertion Consumer Service POST Binding URL*:
`<origin>/ui/auth/keycloak-saml/callback`. *Sign assertions* on. Mappers: *User Property* `email`
→ attribute `email`; *Group list* → attribute `groups`, full path off. The realm's certificate is
in `https://keycloak.example.com/realms/<realm>/protocol/saml/descriptor`.

```yaml
  - name: keycloak-saml
    label: Keycloak
    type: saml
    entryPoint: https://keycloak.example.com/realms/<realm>/protocol/saml
    idpCert: |
      -----BEGIN CERTIFICATE-----
      <base64 certificate>
      -----END CERTIFICATE-----
    idpIssuer: https://keycloak.example.com/realms/<realm>
    roles:
      admin: { groups: [hopper-admins] }
```

## Sessions and logout

The same for every provider, password sign-in, no sign-in and the login code:

- A session is a random token in the browser's `localStorage` for the exact origin, sent as the
  `x-hopper-session` header. The daemon stores only its SHA-256, with the role and identity.
- It lasts `HOPPER_UI_SESSION_HOURS` (default 12) and survives daemon restarts.
- **Log out** (the header's button) ends the hopper session. It does not sign you out of the
  provider: signing in again may need no password.
- At every start the daemon applies `auth.yaml` to the stored sessions: a removed provider, a
  removed password account, no sign-in turned off, or an account no rule grants a role any more,
  loses its session; a changed rule (or account or `none` role) changes its role. To
  cut someone off at once: change `auth.yaml` and restart.
- Sign-ins, refusals and logouts are logged to the journal
  (`journalctl --user -u hopper | grep 'UI session\|sign-in'`).

## Troubleshooting

| symptom | cause |
|---|---|
| Daemon will not start, `invalid auth.yaml: providers.0.…` | The named field is wrong; the message says how. |
| `invalid auth.yaml: password.users.0.passwordHash: must be an argon2id hash` | The entry holds a password or another hash kind. Run `hopper password-hash`. |
| 429 "too many sign-in attempts" | Over 20 sign-in attempts a minute from one address. Wait a minute. |
| "Sign in on the sign-in address" | The page is open on another address than the sign-in origin. Open the origin shown. |
| Provider says the redirect URI does not match | Register exactly `<origin>/ui/auth/<name>/callback`; check `HOPPER_PUBLIC_URL`. |
| "signed in, but auth.yaml grants this account no role" | No rule matched. The journal line names the account; for OIDC check that the email is verified or match on groups. |
| "unknown or expired sign-in; start again" | The sign-in took over 10 minutes, the daemon restarted meanwhile, or the callback was opened twice. |
| "another browser began it" | The callback page ran in a browser (or private window) other than the one that clicked *Sign in*. |
| SAML "Invalid signature" | `idpCert` is not the IdP's current signing certificate, or the IdP signs only the response — sign the assertion. |
| 421 through the proxy | The proxy rewrites `Host`; pass the original host. |
