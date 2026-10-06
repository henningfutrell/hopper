# Signing in — realms

How people sign in to the hopper UI. A **realm** is one way of checking who signs in: GitHub (through
the hopper's app; every hopper has it), an LDAP or Active Directory directory, OpenID Connect, SAML, or an
auth gateway in front of the hopper that has already signed people in. Signing in with GitHub also
connects it: that is the GitHub the person's jobs work through (issue #214). The realms are an
ordered list, each on or off, managed in **Settings → Sign-in**; a change works at once. Beside them:
the one-time login code and no sign-in. The design and its reasons: `docs/design.md` "Sign-in: realms".

Every way of signing in ends the same: a **UI session** with a **UI role**, acting for one **user**
(issue #158). Sessions, roles and logout behave the same whichever realm signed the user in.

- [Pick a setup](#pick-a-setup)
- [Managing sign-in in Settings](#managing-sign-in-in-settings) · [Realm settings](#realm-settings) · [Sign-in from the environment](#sign-in-from-the-environment) · [The sign-in config from the CLI](#the-sign-in-config-from-the-cli)
- [No sign-in](#no-sign-in) · [No bootstrap login](#no-bootstrap-login) · [LDAP realm](#ldap-realm) · [Behind an auth gateway](#behind-an-auth-gateway)
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
| One person, one machine | Nothing: sign in with GitHub, which every hopper offers ([GitHub](#github)). The first person to sign in with GitHub is the admin. There is [no bootstrap login](#no-bootstrap-login). |
| One person, a few devices on a home LAN | `HOPPER_LAN_NAMES` / `HOPPER_LAN_PEERS` (`docs/design.md` "Reaching the UI across the LAN") and device links. |
| Behind a proxy or network that already decides who gets in | [No sign-in](#no-sign-in), with a role. Everyone who reaches the UI acts with that role. |
| A few people, no directory or identity provider | A [GitHub](#github) realm: each person signs in with their own GitHub account. The hopper keeps no username-and-password accounts of its own. |
| A company directory (OpenLDAP, Active Directory, FreeIPA) | An [LDAP realm](#ldap-realm): people sign in with their directory username and password; directory groups grant roles. |
| Behind an auth gateway that signs people in (Envoy Gateway with OIDC, oauth2-proxy, …) | A [gateway realm](#behind-an-auth-gateway): the gateway signs people in and forwards their token; the hopper checks the token, gives roles by its claims, and asks nobody to sign in. |
| People whose work is on GitHub (the hopper's main way) | Nothing: every hopper has the [GitHub realm](#github). People sign in with a device code through the hopper's app, the first of them becomes admin, and that connection is what their jobs work through. Role rules name everyone after by username or id. |
| A team, or anyone reaching it over the internet | A reverse proxy with TLS, `HOPPER_PUBLIC_URL`, one or more realms, role rules, and usually the login code off. |
| A deploy that sets everything up at launch (container, Kubernetes) | [Sign-in from the environment](#sign-in-from-the-environment): the realms as `HOPPER_SIGN_IN_*` variables, secrets as mounted files. |

## Managing sign-in in Settings

Sign-in is not a file. Everything about it — the realms, their settings, the login code and no
sign-in — is kept in the daemon's database and changed in **Settings → Sign-in**,
by an admin. Every setting is a field of a form; nothing is written as YAML or JSON.

The page lists the realms in order, each with its type, a switch to turn it on or off, and — for
OIDC and SAML — the callback URL (and SAML metadata URL) to register with the identity
provider, ready to copy. A new hopper starts with one realm, **GitHub** ([GitHub](#github)): the first
person to sign in with it becomes admin. There is [no bootstrap login](#no-bootstrap-login): a new
hopper holds no user until someone signs in.

- **Add realm**: pick a type, fill in its fields (every one: [Realm settings](#realm-settings)) and
  **Save**. A field left empty takes its default, shown greyed in the field.
- **Edit** (pencil): the same form, filled in. The name stays: sign-ins are linked to users by it,
  and the identity provider holds it in the callback URL. To rename, remove the realm and add a new one.
- **Move up / down**: the order. The username and password form tries the LDAP realms that are on in
  this order, and the first that accepts the password signs in. The GitHub, OIDC and
  SAML realms that are on are sign-in buttons, in this order.
- **On / off**: a realm that is off signs nobody in, and the sessions it made end at once. Its secret
  need not be set while it is off.
- **Without a realm**: the login code on or off, and no sign-in with its role.

A change **works at once**, without a restart: the sign-in page follows it, and sessions follow it as
they would at a restart (a realm off or removed, or an account no rule lets in any more, loses its
sessions; a changed role applies). A change that would not load is refused with the reason, naming
the field (a missing secret is named too) — nothing is saved. A change that would end **your
own** admin session (turning off or removing the realm you signed in with, lowering your own role,
turning off the login code you signed in with) is refused: sign in as an admin another way first.
Invalid sign-in config stop the daemon at start, with a message naming the field (`journalctl
--user -u hopper`): sign-in fails closed, never open.

**Locked out.** If nobody can sign in as admin any more, give yourself admin with a role rule in
[the sign-in config from the CLI](#the-sign-in-config-from-the-cli) where the hopper runs, and restart it.

**Secrets are typed into the realm's form** (**Client secret**, **Bind password**) and stored with the
realm in the database, like every other setting. They are never shown again: the field says whether
one is set, a save with the field left empty keeps it, and the cross beside it removes it (an OIDC
realm without one is a public client). Nothing to set where the daemon runs, and no restart. The SAML
certificate is not a secret: it is pasted into its field (PEM or bare base64). A realm can also be
set up, secret and all, from the daemon's environment: [Sign-in from the environment](#sign-in-from-the-environment).

## Realm settings

Every type has a **Name** (lowercase letters, digits, dashes; part of the callback URL), a **Label**
(shown in Settings and on the sign-in button; default: the name), and is on or off. Every type has **role rules** and a **default role** ([UI roles and role rules](#ui-roles-and-role-rules)).
The setting's name in error messages is in brackets.

| type | field | default | |
|---|---|---|---|
| `ldap` | Directory URL (`url`) | — | `ldaps://host[:port]`, or `ldap://` with StartTLS on; plain `ldap://` only to `127.0.0.1`/`localhost`. |
| | StartTLS (`startTls`) | off | Upgrade an `ldap://` connection with StartTLS. |
| | Bind DN, Bind password (`bindDn`, `bindPassword`) | none (anonymous search) | The account that searches for the user, and its password (a secret: stored, never shown). |
| | User base (`userBase`) | — | Where people are: `ou=people,dc=example,dc=com`. |
| | User filter (`userFilter`) | `(uid={username})` | `{username}` is the typed username, escaped. Active Directory: `(sAMAccountName={username})`. |
| | Subject attribute (`attributes.subject`) | the entry's DN | A stable id: `entryUUID` (OpenLDAP), `objectGUID` (AD). |
| | Username / Email / Name / Group attribute (`attributes.…`) | `uid` / `mail` / `cn` / `memberOf` | Attribute names. Group values are group DNs. |
| | Group search base, filter, name attribute (`groupSearch.…`) | none; `(member={dn})`; `cn` | Groups found by search, for a directory without `memberOf`; the group is known by its name attribute. |
| `oidc` | Issuer URL (`issuer`) | — | Discovery reads `<issuer>/.well-known/openid-configuration`. https (http only to `127.0.0.1`/`localhost`). |
| | Client ID (`clientId`) | — | |
| | Client secret (`clientSecret`) | none | A secret: stored, never shown. None for a public client (PKCE only). |
| | Scopes (`scopes`) | `openid email profile` | Space-separated. Add what your groups claim needs (`groups` at Okta). |
| | Email / Username / Name / Groups claim (`claims.…`) | `email` / `preferred_username` / `name` / `groups` | Claim names, read from the ID token, then userinfo. Groups may be a list or one string. |
| | Trust unverified email (`trustUnverifiedEmail`) | off | Count the email even without `email_verified: true`. Only for an issuer whose emails you control. |
| `github` | Role rules only | — | It signs in through the hopper's app (its public client id, no secret): nothing of an app is set on the realm. Another app or GitHub Enterprise: `HOPPER_GITHUB_URL`, `HOPPER_GITHUB_CLIENT_ID`, `HOPPER_GITHUB_APP_SLUG` in the daemon's environment. |
| `saml` | Sign-on URL (`entryPoint`) | — | The IdP's single sign-on URL (HTTP-Redirect binding). |
| | Identity provider certificate (`idpCert`) | — | The IdP's signing certificate: PEM or bare base64. |
| | Identity provider issuer (`idpIssuer`) | none | The IdP's entity id. Set it: a response from another issuer is then refused. |
| | Entity ID (`entityId`) | `<sign-in origin>/ui/auth/<name>/metadata` | This service's entity id (the IdP calls it Identifier or Audience). |
| | Email / Name / Groups / Username attribute (`attributes.…`) | `email` / `displayName` / `groups` / NameID | Attribute names in the assertion. |
| | Require a signed response (`requireSignedResponse`) | off | Also require the whole response signed. The assertion must be signed either way. |
| `gateway` | Issuer URL (`issuer`) | — | The issuer of the tokens the gateway forwards. Discovery reads `<issuer>/.well-known/openid-configuration` for its keys or its introspection endpoint. https (http only to `127.0.0.1`/`localhost`). |
| | Check (`check`) | `jwt` | `jwt`: verify the token's signature against the issuer's keys, and its issuer, audience and times. `introspection`: ask the issuer whether the token is active (RFC 7662), for opaque tokens. |
| | Audience (`audience`) | — | Space-separated. A token must name one of them in `aud`. Required for `jwt`; for `introspection`, checked when set. |
| | Token header (`header`) | `authorization` | The request header the gateway forwards the token in. `authorization` carries `Bearer <token>`; any other header carries the token alone (`x-forwarded-access-token` for oauth2-proxy). |
| | Client ID, Client secret (`clientId`, `clientSecret`) | none | `introspection` only, and then both required (the secret once the realm is on): the hopper's client at the issuer, sent with HTTP Basic. The secret is stored, never shown. |
| | Email / Username / Name / Groups claim (`claims.…`) | `email` / `preferred_username` / `name` / `groups` | Claim names, read from the token or the introspection answer. |
| | Trust unverified email (`trustUnverifiedEmail`) | off | Count the email even without `email_verified: true`. |

## Sign-in from the environment

Realms, the login code and no sign-in can be set up at launch by the daemon's environment, the way
Grafana takes its settings: for a container or Kubernetes deploy that is set up from its manifests,
with no config file and no persistent volume. The variables are read at **every start** and written to
the database, so the environment wins: a realm it sets up replaces the stored realm of the same name,
in its place (or is added at the end), and a change made to it in Settings lasts until the next start
(Settings marks it *set from the environment*). Realms the environment does not name are left as they
are. Remove the variables and the realm stays as last set.

| variable | |
|---|---|
| `HOPPER_SIGN_IN_REALM_<NAME>_TYPE` | Sets up the realm `<name>`: `ldap`, `oidc`, `github`, `saml` or `gateway`. The name is `<NAME>` in lowercase, `_` as `-`: `HOPPER_SIGN_IN_REALM_COMPANY_SSO_TYPE` is the realm `company-sso`. |
| `HOPPER_SIGN_IN_REALM_<NAME>_<SETTING>` | One setting of it: the setting's name in [Realm settings](#realm-settings) in upper snake case — `LABEL`, `ENABLED`, `ISSUER`, `CLIENT_ID`, `CLIENT_SECRET`, `SCOPES`, `CLAIMS_GROUPS`, `BIND_DN`, `BIND_PASSWORD`, `ATTRIBUTES_SUBJECT`, `GROUP_SEARCH_BASE`, `IDP_CERT`, `AUDIENCE`, … Role rules: `ROLES_<ROLE>_<MATCH>` (`ROLES_ADMIN_GROUPS`, `ROLES_OPERATOR_EMAIL_DOMAINS`) and `ROLES_DEFAULT_ROLE`. |
| `HOPPER_SIGN_IN_LOCAL_ENABLED` | The login code: `true` or `false`. |
| `HOPPER_SIGN_IN_NONE_ROLE` | No sign-in: `viewer`, `operator`, `admin`, or `off`. |

Values: a switch is `true` or `false`; scopes and audiences are separated by spaces or commas; a role
rule's values by commas, or a JSON array when a value holds a comma (an LDAP group DN). **Every one can
come from a file**: `<variable>_FILE` names it (a mounted secret; one trailing newline dropped) — the way
to hand in a client secret or a certificate. A variable the hopper cannot use — an unknown setting, a
value the realm refuses, a realm without its `_TYPE` — stops the daemon at start, naming the variable;
nothing is written.

Step by step for each way in — an auth gateway, OIDC, SAML, a directory, GitHub — with where the
variables go in each deploy and how to check it worked: `docs/deploy.md` "Sign-in set up at launch".

An OIDC realm in a compose file or a Kubernetes manifest:

```sh
HOPPER_SIGN_IN_REALM_CORP_TYPE=oidc
HOPPER_SIGN_IN_REALM_CORP_LABEL=Corp SSO
HOPPER_SIGN_IN_REALM_CORP_ISSUER=https://idp.example.com/realms/corp
HOPPER_SIGN_IN_REALM_CORP_CLIENT_ID=hopper
HOPPER_SIGN_IN_REALM_CORP_CLIENT_SECRET_FILE=/run/secrets/corp_client_secret
HOPPER_SIGN_IN_REALM_CORP_ROLES_ADMIN_GROUPS=hopper-admins
HOPPER_SIGN_IN_REALM_CORP_ROLES_DEFAULT_ROLE=viewer
HOPPER_SIGN_IN_LOCAL_ENABLED=false
```

## The sign-in config from the CLI

For scripts, and to mend sign-in that locks everyone out, the operator CLI reads and replaces the
**sign-in config** — the realms with their settings, the login code and no sign-in, the config record
`sign-in`, as one JSON value — on the daemon's host. `hopper config get sign-in` prints it,
`hopper config version sign-in` prints its version, and `hopper config set sign-in --if-version
<version>` replaces it with the JSON on stdin. A record that does not load, or that changed since you
read its version, is refused and nothing is written. A change made with the CLI applies at the next
start (`systemctl --user restart hopper` on the host install).

After a lockout, give yourself admin with a role rule in a realm you can sign in with — your GitHub user
id (`id` in `https://api.github.com/users/<login>`) in the GitHub realm's `roles.admin.subjects`:

```sh
hopper config get sign-in > sign-in.json      # add your id to the GitHub realm's "roles": { "admin": { "subjects": [...] } }
hopper config version sign-in
hopper config set sign-in --if-version <version> < sign-in.json
systemctl --user restart hopper
```

For a realm set from the environment, set `HOPPER_SIGN_IN_REALM_<NAME>_ROLES_ADMIN_SUBJECTS` instead and
restart: the environment wins.

The record holds the realms' secrets as stored: whoever runs the CLI holds the database's credentials,
which open them anyway. In the record each field has the name in brackets in [Realm settings](#realm-settings); `version` is
`1`, `local.enabled` the login code (default on), `none.role` no sign-in (absent: off), `githubAdmin`
the [first GitHub admin](#ui-roles-and-role-rules) (absent: nobody yet), and `realms`
the realms in order, each with `name`, `label`, `type`, `enabled` (absent: on) and `roles`.

**From before.** Older installs were migrated when the daemon updated: the sign-in document of an
earlier version became realms (issue #185), then the JSON record (issue #198). A realm that named the variable holding its secret (`clientSecretEnv`, `bindPasswordEnv`) takes
the secret from that variable into the database at the first start after the update (issue #216);
after that the variable can go. Nothing to do; sign-ins and sessions carry on. **The password user
realm is gone** (issue #237): the update removes every password realm, its accounts, and the links
of their sign-ins to users; the users and their work stay. Sign in with a login code (the start logs
one while nothing else signs `admin` in) or another realm. A sign-in config left with no way in turns
the login code on. `HOPPER_SIGN_IN_ADMIN_PASSWORD` and a `password` realm type stop the daemon at
start, naming the variable.

## No sign-in

Settings → Sign-in → **Without a realm** → **No sign-in**: pick the role (viewer, operator or admin).

Anyone who reaches the UI gets a session with that role, without a credential: the UI takes it by
itself (`POST /ui/auth/none`; the exact UI origin is required, so another site cannot mint one in a
visitor's browser). The daemon logs `NO SIGN-IN is on` at every start. It combines with the rest:
no sign-in as viewer plus a realm or the login code means everyone may look and those who sign
in may act. Use it only where something in front — a VPN, a proxy with its own login, a network only
you reach — already decides who gets in. As admin, anyone who reaches the UI can change every setting.
No sign-in signs everyone in as one user — its own, made by its first visitor (`admin` on a hopper from
before, issue #238) — so it stays off while the hopper has more than one user, and no user is added
while it is on.

## No bootstrap login

There is no bootstrap login (issue #238). A new hopper creates no user, no account, no password and no
login code, and no command on the host signs anyone in (`hopper login-code` and `open-ui.sh` are gone;
the first sign-in by login code of issue #237 is gone too). The hopper keeps no username-and-password
accounts of its own (issue #237). The way in is a realm:

- **Sign in with GitHub**, which every hopper offers ([GitHub](#github)). [The first person to sign in
  with GitHub](#ui-roles-and-role-rules) is the admin, so sign in before anyone else can reach the UI.
- **Each person gets a whole environment of their own**: the first sign-in of each identity makes its
  user ([Who signs in as which user](#who-signs-in-as-which-user)).
- **A hopper from before** keeps its default admin account `admin` and its work. Its start hands out no
  login code any more: sign in with GitHub (which makes a new user) and move `admin`'s work to it with
  [`hopper user transfer`](#who-signs-in-as-which-user).
- **No way in** — no realm that is on, no sign-in off — is left as it is: the sign-in page says that
  sign-in with GitHub is not set up. Turn the GitHub realm back on from
  [the sign-in config from the CLI](#the-sign-in-config-from-the-cli) or the environment.

A login code still exists, minted only from a signed-in session: a device link (for the session's own
user) and a new user's login link. It signs in with role `admin`.

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
| Bind password | the search account's password |
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
| Bind password | the search account's password |
| User base | `DC=corp,DC=example,DC=com` |
| User filter | `(sAMAccountName={username})` |
| Subject attribute | `objectGUID` |
| Username attribute | `sAMAccountName` |
| Name attribute | `displayName` |
| Role rules | admin for these groups: `CN=Hopper Admins,OU=Groups,DC=corp,DC=example,DC=com` |


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
- With two LDAP realms on, the form tries them in their order; the first that
  accepts the password signs in. When none accepts and a directory could not be reached, the answer
  is "sign-in could not be checked", naming the realm — not "wrong password".

## Behind an auth gateway

When an auth gateway in front of the hopper already signs people in — Envoy Gateway with its OIDC
filter, oauth2-proxy, an ingress with OIDC plugged in — the hopper does not sign anyone in itself. The
gateway gets the token from the identity provider and forwards it on every request; a **gateway realm**
checks that token and turns it into a UI session. Nobody sees a sign-in form: the UI takes the session
by itself when it opens.

The token is checked one of two ways, each through an established library:

- **`jwt`** (the default): the signature against the issuer's published keys (JWKS), and the token's
  issuer, audience (`aud`), expiry and not-before, with 30 seconds of clock difference allowed (`jose`).
- **`introspection`**: the issuer's introspection endpoint answers whether the token is active, as the
  hopper's own client (RFC 7662, `openid-client`). For opaque access tokens.

Envoy Gateway with OIDC, its access token in `Authorization`:

```yaml
apiVersion: gateway.envoyproxy.io/v1alpha1
kind: SecurityPolicy
metadata: { name: hopper-oidc }
spec:
  targetRefs: [{ group: gateway.networking.k8s.io, kind: HTTPRoute, name: hopper }]
  oidc:
    provider: { issuer: https://idp.example.com/realms/corp }
    clientID: hopper-gateway
    clientSecret: { name: hopper-gateway-secret }
    redirectURL: https://hopper.example.com/oauth2/callback
    forwardAccessToken: true
```

and in Settings → Sign-in (or the sign-in config), the realm:

| field | value |
|---|---|
| Type | Auth gateway in front of the hopper |
| Name | `gateway` |
| Issuer URL | `https://idp.example.com/realms/corp` |
| Audience | the `aud` the identity provider puts in access tokens for this gateway (Keycloak: add an audience mapper naming `hopper`) |
| Role rules | admin for these groups: `hopper-admins`; default role `viewer` |

Then turn the login code off, and remove or turn off the other realms, so the gateway is the only way
in. `HOPPER_PUBLIC_URL` is the address people reach through the gateway.

- **Reach the hopper only through the gateway.** The token is the credential: anyone who holds a valid
  token for the audience and reaches the hopper's port directly signs in too. Keep the port on
  loopback or a network only the gateway reaches (`HOPPER_LAN_PEERS` naming the gateway's address).
- **The audience matters.** Without it, any token the issuer gave any client would do; `jwt` refuses
  to start without one.
- **Several gateway realms** are tried in order; the first that accepts the token signs in. A token
  refused by all of them is 403 with the reasons; an issuer that could not be reached is 502, naming
  the realm.
- **The session is the hopper's own**, as for every realm: it outlives the gateway's sign-in until it
  expires or the realm changes. Logging out of the hopper ends the hopper session only; with the
  gateway still signed in, the next visit takes a new one.
- The gateway realm composes with the others: with an LDAP realm also on, the sign-in page shows
  both, and **Sign in through the gateway** tries the token again.

## UI roles and role rules

| UI role | may |
|---|---|
| `viewer` | read everything the UI shows |
| `operator` | + cancel and approve jobs; answer, close, dismiss questions and mark them seen |
| `admin` | + change configuration: plugins, machines, routing rules, webhooks, the rules, the queue gate, sign-in realms; apply updates; hand out device links |

A login code signs in with role `admin`, to the user it was minted for. For every realm, its **role rules** decide, the same way for every type:

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
- **The first person to sign in with GitHub becomes admin** (issue #239), whatever the GitHub realm's
  rules say, and stays admin while that realm is on — across restarts and realms set from the
  environment. The hopper records them once, as `githubAdmin` (the realm and the GitHub user id) in
  [the sign-in config](#the-sign-in-config-from-the-cli); everyone after them gets what the rules grant.
  Only a hopper nobody has signed in to with GitHub yet records one: one where someone already has
  makes nobody admin this way. Sign in with GitHub yourself before you let anyone else reach the UI.
  To take it back, remove `githubAdmin` from the record with the CLI and restart.

What fills each field:

| field | LDAP | OIDC | GitHub | SAML |
|---|---|---|---|---|
| subject | `attributes.subject`, else the DN | `sub` | numeric user id | NameID |
| username | `attributes.username` | `claims.username` | login | `attributes.username`, else NameID |
| email | `attributes.email` | `claims.email` if verified | primary verified email | `attributes.email` |
| groups | `attributes.groups`, plus `groupSearch` | `claims.groups` | none | `attributes.groups` |

A UI role is not a plugin role: see `docs/glossary.md`.

A role acts only inside the session's own user: an admin changes their own plugins, machines,
routing, webhooks, rules and the queue gate, never another user's. What all users share — adding users,
the plugin store, updates, sign-in realms — needs `admin`.

## Who signs in as which user

One hopper can work for several people (issue #158, `docs/design.md` "Users: one hopper, separate
users"). Each **user** has their own jobs, questions, events, machines, plugins, routing, rules,
webhooks and credentials; nobody sees or touches another user's. **Each person gets a whole
environment of their own**: a new hopper holds no user, and the first sign-in of each identity makes
its user (issue #238). A hopper from before keeps its **default admin account**, `admin`, which holds
everything from before there were several (an earlier hopper's `owner` became `admin` on update, issue
#220); it is reached through the identities linked to it, and `hopper user transfer` moves its work to
the user a person signs in as (below).

| sign-in | user |
|---|---|
| login code | the user it was minted for: a device link is for the session's own user; a new user's login link for that user |
| no sign-in (`none`) | its own user, made by its first visitor (on a hopper from before: `admin`, which it signed in as there) |
| a realm (LDAP, OIDC, GitHub, SAML, gateway) | the user its identity (realm and subject) is linked to; the **first** sign-in of an identity a role rule lets in creates a new user for it, named after its username, else its name, else its email (made unique: `ada`, `ada 2`), and links it |

- An admin adds a user from **Settings → Users** (or `hopper user add <name>`) and hands over the
  one-time login link it shows.
- A user added later reads its secrets under its own prefix: a plugin option naming `GITHUB_TOKEN`
  reads `HOPPER_USER_<ID>_GITHUB_TOKEN` (or its `_FILE`), so set the variable for that user in the
  daemon's environment. `admin` reads the names as they are.
- Its `gh` and `claude` logins are its own: they live in `<work dir>/users/<id>/gh` and `…/claude`.
  Log it in to GitHub from its own Sources view.
- An identity that signed in before there were several users is linked to `admin` when its session
  was still stored; one whose sessions had all expired gets a new user at its next sign-in.
- **Moving work to the user a person signs in as** (issue #212): `hopper user transfer <from> <to>`,
  with the daemon stopped. `<to>` takes over everything `<from>` holds: `<to>`'s sign-ins (realm
  links), sessions and login codes move onto `<from>`'s record, which takes `<to>`'s name; `<to>`'s
  own record and schema are removed. The record keeps its id, schema, work dir, secret prefix and
  herdr session, so running jobs and their panes are untouched. Refused while a daemon holds the
  database, and when `<to>` has jobs, questions, decisions or webhooks of its own; its config,
  settings and events go with its schema. Typical use: `admin` signed in by login code only, and the
  same person signs in later with GitHub, as a new user — after the transfer, signing in with GitHub
  (from any device) reaches the work.

  ```sh
  systemctl --user stop hopper
  hopper user transfer admin <user id>
  systemctl --user start hopper
  ```

## The sign-in origin and a public URL

An OIDC or SAML realm's identity provider sends the browser back to one fixed address, the **sign-in origin**:

- `HOPPER_PUBLIC_URL` when set (origin only: `https://hopper.example.com`), else
- `http://localhost:<port>` — fine for one machine; most providers accept `localhost` redirects.

Register these with the identity provider (`<origin>` = the sign-in origin, `<name>` = the realm's
name; Settings → Sign-in shows them for each realm):

| | URL |
|---|---|
| redirect / callback URI (OIDC) | `<origin>/ui/auth/<name>/callback` |
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

Use TLS for anything beyond one machine. On a hopper with one user, requests straight to
`127.0.0.1:<port>` stay readable without a session by any process on the host — keep the daemon on a
machine only you and the proxy use. With several users, such a request reads no user's work.

## Identity providers

Each section: what to create at the identity provider, then the realm's fields — fill them in at
**Settings → Sign-in → Add realm**; a field not listed stays empty (its default). Replace `<origin>`
with the sign-in origin. The client secret is typed into the realm's **Client secret** field.

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
| Client secret | the client secret |
| Role rules | admin for these emails: `ada@example.com` |


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
| Client secret | the client secret |
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
| Client secret | the client secret |
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
| Client secret | the client secret |
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
| Client secret | the client secret |
| Role rules | admin for these groups: `hopper-admins`; operator for these groups: `hopper-operators` |

### GitHub

GitHub is how people sign in to the hopper and how it works for them (issue #214). Every hopper has a
`github` realm, a new one too (migration 23 adds it where there is none): **Sign in with GitHub** on the
sign-in page shows a code; the person enters it at `https://github.com/login/device` and approves the
hopper's GitHub App; the page signs them in. Nothing secret is involved — the hopper ships only the app's
public client id. The first person to sign in with GitHub becomes admin (below); the realm's role rules
grant everyone after. The same sign-in **connects** their GitHub: their issues labelled `hopper` become
their jobs, and their jobs act as them on GitHub, with GitHub showing the hopper's app on what they do.

| field | value |
|---|---|
| Type | GitHub |
| Name | `github` |
| Label | GitHub |
| Role rules | admin for these subjects: `583231`; operator for these usernames: `octocat` |

A subject is the numeric user id (`id` in `https://api.github.com/users/<login>`). Prefer subjects for
anything that matters: a GitHub login can be renamed and the old name registered by someone else. Teams
are not read: a group rule matches nothing here.

The hopper's GitHub App reaches only the repositories it is **installed** on. After signing in, the
Sources page says where it is installed and links to install it or choose its repositories.

Someone signed in at the edge (SSO, SAML, an auth gateway) connects their GitHub from **Sources → GitHub
account → Connect GitHub**, the same code at the same address. That account is then linked to their
user: signing in with it later lands in the same user.

**Running your own GitHub App instead of the hopper's** (a fork, GitHub Enterprise):
https://github.com/settings/apps/new (or the organization's *Developer settings → GitHub Apps*). Homepage
URL: anything. Callback URL: required by the form, never used. Webhook: off. **Enable Device Flow**: on.
Optional features: **opt out of user-to-server token expiration** — GitHub renews an expiring token only
with the app's client secret, which the hopper never has. Repository permissions: Issues read/write, Pull
requests read/write, Contents read/write, Metadata read; organization Projects read; account Email
addresses read. Where can it be installed: any account. Generate no private key and no client secret.
Set `HOPPER_GITHUB_CLIENT_ID` (the app's client id) and `HOPPER_GITHUB_APP_SLUG`.

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
  sessions: a realm removed or turned off, no sign-in turned off, or an
  account no rule grants a role any more, loses its session; a changed rule (or `none` role) changes its role. To cut someone off at once: change the realm in Settings → Sign-in.
- Sign-ins, refusals and logouts are logged to the journal
  (`journalctl --user -u hopper | grep 'UI session\|sign-in'`).

## Troubleshooting

| symptom | cause |
|---|---|
| Daemon will not start, or Settings refuses a change: `invalid sign-in config: realms.0.…` | The named field of the first realm (`realms.1` the second, …) is wrong; the message says how. |
| `realms.0.clientSecret: …` or `realms.0.bindPassword: …` | The realm is on without its secret: type it into the field, or save the realm turned off until you have it. |
| `invalid sign-in environment: HOPPER_SIGN_IN_…` | A sign-in variable the hopper cannot use; the message names it and says why ([Sign-in from the environment](#sign-in-from-the-environment)). |
| `environment variable … is not set; the realm's secret is taken from it into the database once` | A realm from before still names its secret's variable, and the daemon's environment lacks it: set it for one start, or turn the realm off with `hopper config set sign-in` and type the secret in Settings. |
| "this change would end your own admin session" | You signed in with the realm (or the login code) the change turns off, or the change lowers your own role. Sign in as an admin another way, then make the change. |
| Nobody can sign in as an admin any more | Give yourself admin with a role rule, from [the sign-in config from the CLI](#the-sign-in-config-from-the-cli) or the environment, and restart. |
| LDAP: "sign-in could not be checked: <realm>: …" | The directory did not answer, or the search account's bind failed: check `url`, the certificate (`NODE_EXTRA_CA_CERTS`), `bindDn` and its password. |
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
