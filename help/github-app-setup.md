# Set up the GitHub App source

The GitHub App source reads issues as an admin's own GitHub App, and acts as its bot. It needs three things: the app's id, the app's slug, and the app's private key. When the source is on and one of them is not set, it is **not configured**. Then it takes no job, and it asks for its setup.

## What you see when it is not configured

- **Sources** shows the source as **needs setup**. Its card names each missing part, for example `appId`, `slug` or `private key`. Its counts say *not configured*, not 0: the source did not look at GitHub.
- **Needs you** counts it in the **Setup** row, with what it lacks.
- The daemon log says it one time: `hopper: source github-app not configured: …`. It says `hopper: source github-app configured` one time when the setup is complete.

The source does not make sync passes while it is not configured. You do not have to restart the hopper after the setup. At its next sync the source checks its setup again. When the setup is complete, the setup problem goes away and the source reads issues.

When you do not want the GitHub App source, switch it off in **Plugins → Job sources**, or remove it. Most people do not need it: the GitHub connection on **Sources** reads your issues as you.

## Step 1: get a GitHub App

Do one of these:

- **Use an app you already have.** It must be installed on the account or organization that owns your job repositories. On GitHub, open the app's settings page. Its **App ID** and its slug (the last part of the app's URL, `https://github.com/apps/<slug>`) are on that page.
- **Make a new app.** On the machine that runs the hopper, run `bash scripts/create-github-app.sh` from the hopper's checkout. It opens GitHub's create-app page with the right permissions. When you confirm, the script prints the new app's id and slug, and writes its private key to a secrets file (by default `~/.config/hopper/daemon.env`, the line `GITHUB_APP_PRIVATE_KEY=`). Copy the key from that file for step 3, then remove the line. Then install the app on the account or organization that owns your job repositories.

Each hopper needs its own app. Do not share one app's private key between two hoppers.

## Step 2: set the app's id and slug

1. Open **Plugins → Job sources**.
2. Open the `github-app` source.
3. Set `appId` to the app's id, and `slug` to its slug.
4. Save.

## Step 3: save the private key in the hopper's vault

1. Open **Sources**. The `github-app` source shows its setup card.
2. Paste the app's private key into the key field. The whole key, from `-----BEGIN` to `-----END … PRIVATE KEY-----`, is necessary. A key on one line with `\n` in place of each line break is also correct.
3. Select **Save the key**.

The hopper checks that the value is a private key, and keeps it sealed in your vault. The field is write-only: the hopper never shows the key again. Settings → Vault lists it in the system scope, with who saved it and when.

Do not put the key in a file or in the hopper's environment. When the hopper's environment still gives `GITHUB_APP_PRIVATE_KEY` at a start and no key is saved, the hopper moves that key into the vault once, and does not read the variable again. Then remove the variable.

## Step 4: check it

Open **Sources** and select **Sync now**. The source no longer shows **needs setup**. When it still does, its card says what is still missing or wrong, for example *GITHUB_APP_PRIVATE_KEY is not a private key*.

The source takes the issues that are assigned to your connected GitHub account. When no GitHub account is connected, the source is paused and says so: connect GitHub on **Sources**.

See [How issues become jobs](intake.md) for what the source does with the issues it reads.
