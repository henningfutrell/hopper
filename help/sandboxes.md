# Sandboxes

A sandbox box is a locked-down container that runs jobs and reaches nothing of your computer. A template says what a box runs and which secrets and credentials its jobs may ask for, and a person approves it before any box of it takes a job.

## What a sandbox box is

A **sandbox box** is a machine of its own: a container that joins the hopper as a client target and runs jobs. The hopper starts it with the sandbox flags:

- every capability dropped, and no new privileges;
- a read-only root, with `/tmp` in memory;
- its home a volume of its own (`<name>-home`, at `/home/agent`);
- the image's own user, never root (the hopper refuses an image that runs as root);
- CPU and memory limits;
- nothing of the computer mounted.

A box runs the published box image (agent `claude`), or the image of its **template**. Its name is `hopper-sandbox-<template>`, or `hopper-sandbox-claude` with no template; the hopper adds `-2`, `-3`, … when the name is taken.

A box needs a **rootless** container runtime: Podman (the default) or Docker. The hopper refuses a rootful one.

## What a box gets, and what it does not

| A job on a box | |
|---|---|
| Agent sign-in | You sign the box's agent in once. The sign-in stays in the box's home volume. Nothing of your own sign-in is copied in. |
| GitHub | No token. `git` and `gh` go through the hopper, which acts for the job and refuses pushes to release branches. |
| Your ssh agent and keys | Never. |
| Vault secrets | Only through `$HOPPER_SECRET`, only on a box of an approved template, and only after a vault grant. See [The vault](vault.md). |
| Network | The hopper's network. It still reaches the internet. |

## Start a box

### The hopper starts it

When the hopper has a rootless Podman (or Docker) socket, it starts boxes itself:

1. Open **Machines → Add machine**, and pick **A sandbox box**.
2. Pick a **template**, or **none**.
3. Under **on**, pick **the hopper's computer** or another machine that is online now.
4. Set the launch parameters: **CPUs**, **Memory in GiB**, **Time limit in minutes**, which secrets, one **Operation profile**, and which tools. The form starts at the template's defaults and shows the maximum of each.
5. Click **Start the box**.
6. Sign its agent in once, on the computer the box runs on: `podman exec -it hopper-sandbox-<name> claude`.

Before the launch answers, the box runs its **start check**: from inside the box, it fetches the hopper at the box's address. When the check does not pass in 30 seconds, the launch fails with what the check wrote, and the hopper removes what it made.

From the command line:

```sh
hopper sandbox launch --template kube --secret KUBE_TOKEN --cpus 2 --memory-mb 4096 --ttl-minutes 120 --profile read/cluster/lab
hopper sandbox list
```

A value outside what the template allows is refused, with what it allows. It is never cut down to fit.

### You run the line

When the hopper has no runtime socket, Add machine says why and shows a line:

1. Pick **A sandbox box**, a template, and **podman** or **docker**.
2. Click **Show the line**.
3. Run the line on the computer the hopper runs on. The join code in it works once, for 10 minutes.
4. Sign its agent in once: `podman exec -it hopper-sandbox-<name> claude` (or `docker exec`).

The hopper does not own a box that you started from the line: it never stops or removes it.

### On another machine

A machine that joined as **A computer** can hold boxes too. On that machine, once:

```sh
systemctl --user enable --now podman.socket
loginctl enable-linger "$USER"
```

Then pick that machine under **on**. The hopper starts the box in that machine's own rootless Podman (or Docker), through its client. The client checks each call again: it creates only a box with the sandbox flags, and it stops or removes only the boxes the hopper made. While the machine is away, its boxes stay; the hopper checks them when it dials in again.

## Templates

A **template** is a kind of box. It has:

| Field | What it is |
|---|---|
| **Name** | Fixed once saved. Its boxes are named `hopper-sandbox-<name>`. |
| **Image** | What its boxes run. |
| **Secrets its boxes may ask for** | Vault secrets and `shared/<name>` shared secrets. A minting credential is never listed. |
| **Tools** | `aws`, `helm`, `kubectl`, `terraform`. The hopper adds them to the image, each pinned and checked by its SHA-256. |
| **Operation profiles** | An operation (`read`, `write`, `sync`, `apply`) on an asset (`cluster`, `namespace`, `argocd-app`, `terraform-workspace`, `aws-account`, `aws-role`). Its jobs may ask for minted credentials for these. |
| **Limits** | The default and the maximum of CPUs, memory and time limit, and whether a box's home volume stays when the box goes. |

Make one in **Settings → Vault**, panel **Templates**, with **Add template**, or:

```sh
hopper template save kube --image ghcr.io/example/box:1 --secret KUBE_TOKEN --profile read/cluster/lab \
  --tool kubectl --cpus 2:4 --memory-mb 4096:8192 --ttl-minutes 60:240 --keep-home on
hopper template list
```

A save keeps what it leaves out. Each template shows its **blast radius** rating, the secrets it gives now (**Gives now**), and who approved it.

## Approval

No box of a template takes a job or gets anything from the vault until a person approves the template.

- **Approve** approves the image, the tools, the secrets and the **read** profiles.
- A **write**, **sync** or **apply** profile is high-radius. It needs its own approval: **Approve `<profile>`**, or `hopper template approve-profile <name> <operation>/<kind>/<asset>`.
- A new secret, a new image, a change of tools or a new profile waits for approval again. Until then, boxes get only what was approved. A profile you remove loses its approval at once.
- Limits are not part of the approval. A change of limits applies to the next box.
- **Revoke** stops it at once: its boxes take no new job and get nothing from the vault. Jobs that run there now keep running.
- **Remove** is refused while a box of the template is attached.

While a template waits, its boxes show on **Machines** as *waiting for template approval*, and their jobs wait for another machine.

Each launch fixes its own set of secrets and its one profile. A secret added to the template later reaches new boxes, not running ones.

## Templates a job asks for

A running job can ask the hopper for the template its work needs:

```sh
sh "$HOPPER_SKILL" sandbox-template --needs "read/cluster/lab read/aws-account/123456789012" --wait
```

Each **need** is `<operation>/<kind>/<asset>`, at most 16. The hopper makes the template `asked-<hash>` from the needs: the box image, the tools the needs use, no vault secret, and one operation profile per need. The same needs always get the same template.

The hopper approves it with no person only when it makes it now and every need is a `read` on an asset the **read policy** holds. Anything else waits for a person on **Settings → Vault**. A job never widens, approves or re-approves a template. A job does not start the box: a person or the command line does.

### The read policy

The read policy lists the assets on which the hopper may approve read with no person. It is empty by default, so the hopper approves nothing by itself. An admin sets it in **Settings → Vault**, panel **Read policy**, one entry per line:

- an asset, for example `cluster/lab`; or
- a prefix with `*`, for example `aws-account/*` or `namespace/lab/*`.

Or: `hopper template read-policy set cluster/lab 'namespace/lab/*'`. `set` with no entry clears it. Write, sync and apply always wait for a person.

### The read-only check

A template that a job asked for with read needs only must pass the **read-only check** before its first box. The hopper runs probes in a one-shot check box of the template: each write must be refused, and each read must work. Until the check of its current version passed, no box of it starts, and its boxes take no job. A save makes the check stale.

The template shows the result in its **Read-only check** row. A failed check does not run again by itself: click **Run the check again**, or run `hopper template check <name>`.

## What the hopper does for you

- It checks every box every 10 seconds. It runs the start check again. A box that cannot reach the hopper shows on **Machines** under *Sandbox boxes that cannot reach the hopper*, with what the check wrote, and its jobs wait.
- When you remove the box's machine, or its time limit passes, the hopper stops and removes the box. Its home volume stays, unless the template's limits say not to keep it.
- A box that it cannot remove shows on **Machines** under *Sandbox boxes not removed*. The hopper tries again.
- It builds an image with the template's tools once per base image and set of tools, as `localhost/hopper-box-tools:<hash>`.

## Limits and troubleshooting

- **The start check fails** with `the hopper does not answer at <address>`: the rest is curl's own words from inside the box. `Could not resolve host`: the name is not known on that network. `Failed to connect`: nothing listens there. `403` or `421`: the hopper refused the box; check `HOPPER_LAN_PEERS` and `HOPPER_LAN_NAMES`.
- **No "Start the box" button**: the hopper has no rootless runtime socket. The deploy guide has the steps; or run the line.
- **The read-only check fails against a real account or cluster.** The check box gets no vault secret and no minted credential yet. So its probes cannot read, and the check fails closed.
- **Not built.** A box with tools on another machine (the image build is not carried there). The read-only check on another machine's runtime. Other agents than `claude` in a box.
- **One job at a time.** Jobs on one box share its user. A box of a template with secrets is best run with one lane.

See also: [The vault](vault.md), [Lanes](lanes.md), [Deploy and update](deploy-and-update.md), [CLI and API](cli-and-api.md).
