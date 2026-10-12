# Remote access

Remote access lets an agent reach the hopper's API from anywhere, through an ngrok tunnel, with no open port on your machine. The hopper's admin turns it on in the UI. No file on the host changes, so you can do it from a phone.

## What it is

- The compose stack runs a `tunnel` service. It is required, but it runs no ngrok while remote access is off.
- When remote access is on, the tunnel service starts ngrok at your domain, for example `https://hopper.example.ngrok.app`. That address is the **remote access URL**.
- Only the API goes through the tunnel: `/api/` (not the event stream), `/ui/api/`, `/ui/auth/api-token` and `/ui/auth/token/refresh`. The UI, its sign-in pages and the installer are not reached from the internet.
- ngrok limits each caller: 120 requests a minute, and 5 token exchanges or refreshes a minute.
- A request through the tunnel is a public request. It reads or changes something only with an API token. See [API tokens and grants](api-tokens.md).

## What you need

1. An ngrok account.
2. A domain reserved at ngrok: https://dashboard.ngrok.com/domains
3. Your ngrok authtoken: https://dashboard.ngrok.com/get-started/your-authtoken

## Turn it on

Only the hopper's admin can do this.

1. Open **Settings → Remote access**.
2. In **Domain**, type the domain you reserved, for example `hopper.example.ngrok.app`.
3. In **Authtoken**, paste your ngrok authtoken.
4. Select **Save**.
5. Turn on the **Remote access** switch.
6. Wait up to 10 seconds. The status line says `Up: agents reach the hopper's API at https://…`.

The hopper keeps the authtoken sealed in its vault, as a system secret. No page, log or API answer shows it again. The page shows only its last 4 characters, who set it and when.

An agent with an API token of the admin can do the same over the API: `POST /ui/api/remote-access` with `enabled`, `domain`, `authtoken` or `restart`.

## Change or turn it off

| You want | Do this |
|---|---|
| Turn it off | Turn off the **Remote access** switch. The tunnel service stops ngrok within 10 seconds. |
| A new authtoken | Paste it in **Authtoken** and select **Save**. The old one is replaced. |
| Another domain | Type it in **Domain** and select **Save**. |
| Start the tunnel again | Select **Restart the tunnel**. |
| Remove the authtoken | Turn remote access off first. Then select **Remove the authtoken**. |

You cannot turn it on without a domain and an authtoken. You cannot remove either one while it is on.

## Status

The page reads the status every 10 seconds.

| Status | What it means |
|---|---|
| `Off` | Remote access is off. The hopper is not reached from the internet. |
| `Up` | Agents reach the API at the URL it shows. |
| `Down` | ngrok stopped, with its last error, or the tunnel is starting. A refused authtoken or a domain that is not yours stops it until you save new settings. |
| `No tunnel service` | No tunnel service asked for the settings in the last 30 seconds. Run the update script, or `podman compose up -d`, so that the `tunnel` service runs. |

## From an install before

An older install gave the tunnel `NGROK_AUTHTOKEN`, `HOPPER_PUBLIC_URL` and `COMPOSE_PROFILES=tunnel` in a `.env` file. At its first start, the hopper moves the authtoken into its vault, takes the domain from `HOPPER_PUBLIC_URL`, and turns remote access on. The update script then removes the `.env` file. Keep `HOPPER_PUBLIC_URL` only when a reverse proxy also serves the UI at that address. See [Run and update the hopper](deploy-and-update.md).

## Risks

- The tunnel service is third-party code on the internet's path. It holds the authtoken in memory while ngrok runs.
- Callers behind one address (a NAT) share one rate limit.
