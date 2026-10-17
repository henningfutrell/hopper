# Remote access

Remote access lets an agent reach the hopper's API from anywhere, through a tunnel, with no open port on your machine. It is optional and off by default. The hopper works fully without it.

You pick the provider: **Cloudflare Tunnel** or **ngrok**. They are equal choices. You give the hopper one credential of that provider. The hopper then makes the tunnel and its address itself. You edit no file on the host, so you can do it from a phone.

## What it is

- The compose stack runs two services: `cloudflared` and `tunnel` (ngrok). They are required, but they run no tunnel while remote access is off. When it is on, only the service of the provider you picked runs its tunnel.
- The tunnel's address, for example `https://hopper.example.com`, is the **remote access URL**.
- Only the API goes through the tunnel: `/api/` (not the event stream), `/ui/api/`, `/ui/auth/api-token`, `/ui/auth/token/refresh`, and `/ui/auth/device-grant` with its poll. The UI, its sign-in pages and the installer are not reached from the internet.
- Each caller has a limit: 120 requests a minute, and 5 token exchanges or refreshes a minute.
- A request through the tunnel is a public request. It reads or changes something only with an API token. See [API tokens and grants](api-tokens.md).

## What you need

One credential, for the provider you pick:

| Provider | Credential | Where to make it | What it needs |
|---|---|---|---|
| Cloudflare Tunnel | API token | https://dash.cloudflare.com/profile/api-tokens | A custom token with **Account → Cloudflare Tunnel → Edit** and **Zone → DNS → Edit** on the zone of the host name. A domain on Cloudflare. |
| ngrok | API key | https://dashboard.ngrok.com/api-keys | An ngrok account. The hopper uses the account's domain, or reserves one. |

## Turn it on

Only the hopper's admin can do this.

1. Open **Settings → Remote access**.
2. Under **Provider**, select **Cloudflare Tunnel** or **ngrok**.
3. Paste the API token or the API key.
4. Optional: in **Host name**, type the address you want, for example `hopper.example.com`. Leave it empty, and the hopper picks one: `hopper.<your zone>` at Cloudflare, or the ngrok account's domain.
5. Turn on the **Remote access** switch.

The hopper then makes the tunnel:

- **Cloudflare Tunnel**: a tunnel, its token, and a DNS record for the host name.
- **ngrok**: an authtoken and a domain.

Wait up to 10 seconds. The status line says `Up: agents reach the hopper's API at https://…`.

If the provider refuses, the page shows why. The hopper removes what it made, and remote access stays off. For example: the token does not have the two permissions, or the host name is not in a zone of the token.

The hopper keeps the credential and the tunnel's token sealed in its vault, as system secrets. No page, log or API answer shows them again. The page shows only the last 4 characters of the credential, who set it and when.

## Copy the addresses

While remote access is on, a panel shows the addresses an agent uses, each with a **Copy** button:

| Address | What it is |
|---|---|
| Public URL | The remote access URL. |
| API | The API's address: `<public URL>/api/`. |
| API-token exchange | Where an agent exchanges its sign-in for an API token. |
| Token refresh | Where an agent with a grant gets a new API token. |

The panel also shows the status. The hopper takes no inbound webhooks: it pulls its jobs.

An agent with an API token of the admin can do all of this over the API: `GET /api/remote-access`, and `POST /ui/api/remote-access` with `provider`, `credential`, `domain`, `enabled` or `restart`.

## Change or turn it off

| You want | Do this |
|---|---|
| Turn it off | Turn off the **Remote access** switch. The hopper removes the tunnel, its token and its DNS record (Cloudflare), or revokes the authtoken and removes a domain it reserved (ngrok). |
| Switch the provider | Select the other provider, paste its credential, and select **Save**. The hopper removes the old tunnel first, then makes the new one. |
| Another host name | Type it in **Host name** and select **Save**. The hopper makes the tunnel again at that name. |
| A new credential | Paste it and select **Save**. While remote access is on, the hopper makes the tunnel again with it. |
| Start the tunnel again | Select **Restart the tunnel**. |
| Remove the credential | Turn remote access off first. Then select **Remove the API token** or **Remove the API key**. |

If the hopper cannot remove something at the provider (the provider does not answer, or the credential was revoked), the page lists it. Remove it at the provider yourself.

## Status

The page reads the status every 10 seconds.

| Status | What it means |
|---|---|
| `Off` | Remote access is off. The hopper is not reached from the internet. |
| `Up` | Agents reach the API at the URL it shows. |
| `Down` | The tunnel stopped, with its last error, or it is starting. |
| `No tunnel service` | The provider's service (`cloudflared` or `tunnel`) did not ask for its settings in the last 30 seconds. Run the update, or `podman compose up -d`. |

## From an install before

An install that pasted an ngrok authtoken and a domain by hand keeps them. Remote access goes on running. When you turn it off, the hopper keeps them, because it did not make them. To let the hopper make and remove them, select ngrok, paste an ngrok API key, and select **Save**.

An older install gave the tunnel `NGROK_AUTHTOKEN`, `HOPPER_PUBLIC_URL` and `COMPOSE_PROFILES=tunnel` in a `.env` file. At its first start, the hopper moves the authtoken into its vault, takes the domain from `HOPPER_PUBLIC_URL`, and turns remote access on. Then remove those three from the `.env` file, and delete it when nothing else is in it: the hopper reads none. Keep `HOPPER_PUBLIC_URL` only when a reverse proxy also serves the UI at that address. See [Run and update the hopper](deploy-and-update.md).

## Risks

- The tunnel's service is third-party code on the internet's path. It holds the tunnel's token in memory while the tunnel runs.
- The Cloudflare API token can make tunnels and change DNS records in its zone. Give it the one zone only.
- Callers behind one address (a NAT) share one rate limit.
