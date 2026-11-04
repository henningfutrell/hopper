# Sandboxes

A sandbox box is a locked-down container that runs jobs and reaches nothing of your computer. A template says what a box runs and which secrets and credentials its jobs may ask for, and a person approves it before any box of it takes a job.

## What a sandbox box is

A **sandbox box** is a container that runs one step of a job, and is then burned. It is not a machine: it does not join the hopper, it takes no lane, and no job runs in it. The job runs on its own machine and sends each command to a new box (see [Sandboxes jobs start](#sandboxes-jobs-start)). The hopper starts each box with the sandbox flags:

- every capability dropped, and no new privileges;
- a read-only root, with `/tmp` in memory;
- a home of its own, at `/home/agent`, removed with the box;
- the image's own user, never root (the hopper refuses an image that runs as root);
- CPU and memory limits;
- nothing of the computer mounted.

A box runs the published box image, or the image of its **template**. Nothing is kept between two steps: a job brings back with `--output` what its next step needs.

A box needs a **rootless** container runtime: Podman (the default) or Docker, beside the hopper or on a machine that joined as **A computer**. The hopper refuses a rootful one.

## What a box gets, and what it does not

| A box step | |
|---|---|
| Credentials | The short-lived credentials the vault mints for the template's read profiles, and with an approved plan for each of its profiles. A `--secret` is refused. See [The vault](vault.md). |
| GitHub | No token. |
| Your ssh agent and keys | Never. |
| Network | The hopper's network. It still reaches the internet. |

## Try a template: the sandbox playground

Jobs start their own boxes: see [Sandboxes jobs start](#sandboxes-jobs-start). To try an image or a template by hand, an admin uses the **Sandbox playground** panel on **Machines**:

1. Set **How many**, a **Template** (or an agent's published image), **CPUs**, **Memory (MiB)** and **Time limit (minutes)**.
2. Click **Start**.

A playground sandbox runs its image idle, with no secret. It is not a machine: it takes no lane and gets no job. It runs beside the hopper only. Destroy one, a selection or all from the panel. The hopper destroys each one when its time limit passes, and after a restart it removes what is left.

A template must be approved, and its read-only check must have passed, before the playground starts a sandbox of it.

### A machine that holds boxes

A machine that joined as **A computer** can hold boxes too. On that machine, once:

```sh
systemctl --user enable --now podman.socket
loginctl enable-linger "$USER"
```

The hopper then can start a box in that machine's own rootless Podman (or Docker), through its client. It builds a template's tools image there too. The client checks each call again: it creates only a box with the sandbox flags, it builds only a tools image, and it stops or removes only the boxes the hopper made. While the machine is away, the boxes there stay; the hopper burns them when it dials in again.

## Templates

A **template** is a kind of box. It has:

| Field | What it is |
|---|---|
| **Name** | Fixed once saved. Its boxes are named `hopper-sandbox-<name>`. |
| **Image** | What its boxes run. |
| **Secrets its boxes may ask for** | Vault secrets and `shared/<name>` shared secrets. A minting credential is never listed. |
| **Tools** | `aws`, `helm`, `kubectl`, `terraform`. The hopper adds them to the image, each pinned and checked by its SHA-256. |
| **Operation profiles** | An operation (`read`, `write`, `sync`, `apply`) on an asset (`cluster`, `namespace`, `argocd-app`, `terraform-workspace`, `aws-account`, `aws-role`). Its jobs may ask for minted credentials for these. |
| **Limits** | The default and the maximum of CPUs and memory. A template sets no time limit. A box's home volume is removed with the box. |
| **Agent credential** | Not used. No box starts signed in: see [No box starts signed in](#no-box-starts-signed-in). |

Make one in **Settings → Vault**, panel **Templates**, with **Add template**, or:

```sh
hopper template save kube --image ghcr.io/example/box:1 --secret KUBE_TOKEN --profile read/cluster/lab \
  --tool kubectl --cpus 2:4 --memory-mb 4096:8192
hopper template list
```

A save keeps what it leaves out. Each template shows its **blast radius** rating, the secrets it gives now (**Gives now**), and who approved it.

## Approval

No step runs in a box of a template, and no box of it gets anything from the vault, until a person approves the template. A template that waits shows on **Access requests**, panel **Template approvals**, with its approve buttons. You edit, revoke and remove templates on **Settings → Vault**.

- **Approve** approves the image, the tools, the secrets and the **read** profiles.
- A **write**, **sync** or **apply** profile is high-radius. It needs an explicit approval: the card shows one **Approve all listed** action that approves the template and each listed profile, or `hopper template approve-profile <name> <operation>/<kind>/<asset>`.
- A new secret, a new image, a change of tools or a new profile waits for approval again. Until then, boxes get only what was approved. A profile you remove loses its approval at once.
- Limits are not part of the approval. A change of limits applies to the next box.
- **Revoke** stops it at once: no new step starts in a box of it, and its boxes get nothing from the vault.
- **Remove** is refused while a box of the template is attached.

While a template waits, the hopper refuses a step in a box of it, and the job is told that the template waits for a person or for its read-only check.

Each step gets a new box, which the hopper burns when the step ends. Credentials minted for the step stop working when it ends. A change to the template reaches the next step, not a step that runs now.

## No box starts signed in

A box runs one command of a job, and Claude does not run in it. So no box starts signed in. The **Agent credential** of a template has no effect: the hopper gives it to no box. You can leave it empty.

## Sandboxes jobs start

A job that needs AWS, a cluster or another sandboxed target asks the hopper for a sandbox. You do not create the box.

```sh
sh "$HOPPER_SKILL" sandbox --why "Create the report bucket in the utility account" \
  --plan "aws s3 mb s3://report. To undo: aws s3 rb s3://report." \
  --needs "write/aws-account/123456789012" --wait
```

The job must say why it needs the sandbox (`--why`). When a need changes an asset (write, sync or apply), the job must also say what the box will do (`--plan`): the commands, and for each change what it changes and whether it can be undone. The hopper refuses an ask without them. The approval cards show this text.

1. The hopper finds the template for these needs and uses it again. When there is none, the hopper makes it (see [Templates a job asks for](#templates-a-job-asks-for)).
2. A new template waits for a person on **Access requests → Template approvals**, unless the read policy approves it, the auto-approve policy holds its blast radius, or **Skip template approval** is on. By default, a template that only reads is approved with no person.
3. The sandbox run waits for a person on **Access requests → Sandbox runs**, unless the auto-approve policy holds the template's blast radius, a remembered write approval covers each change, **Skip sandbox approval** is on, or a person approved the template this job asked for. Select **Approve** to start the box, or write why not and select **Decline**. The job is told the reason.
4. An approval starts nothing. The job's `--wait` ends with how to run each command: `sh "$HOPPER_STEP" box <template> --command '<the command>'`. Each command runs in a new box of the template, which the hopper burns when the command ends.

### Skip approvals and YOLO

An admin sets these in **Settings → Vault**, panel **Sandbox approvals**. They are off by default.

| Toggle | What it does |
|---|---|
| **Skip template approval** | A new template a job asks for is approved at once, with its write, sync and apply profiles. |
| **Skip sandbox approval** | A sandbox run starts the moment a job asks, a high-blast-radius one too. |
| **YOLO** | Both toggles. Nobody has to do anything. |

**Auto-approve by blast radius.** In the same panel, one switch for each level: **Auto-approve low radius**, **medium** and **high**. A new template a job asks for, and a sandbox run, of a level that is on is approved with no person, `by: the auto-approve policy`. By default, low is on: a box that only reads, with no vault secret. Medium and high ask a person. The read policy approves first; YOLO stays the override.

When you approve a template that a job asked for, the run of that job starts with your approval: `by: the template's approval by <you>`.

**Remembered write approvals.** When you approve a write, sync or apply on an asset, the hopper remembers that approval for that asset and access. A later template or sandbox run whose every change you approved before, with no vault secret and with reads that need no person, is approved with no person: `by: a remembered write approval`. So a repeat write ask on the same account or namespace runs with zero clicks. The same panel lists each remembered approval, with who gave it and when it ends. Select **Forget** to remove one: the next ask waits for a person again. Set how long an approval is remembered in **hours** (default 168, one week; 0 keeps it until you forget it).

**The approval cards.** Each template and sandbox run card shows what the sandbox is for: a readable name made from the job's purpose (the `asked-<hash>` name stays beside it), **Why** in the job's words, the **Job** with its title and a link to its issue or pull request, the **Plan**, and each need in plain words. For an asset with a minting credential in the vault, the card shows that credential's name and scope next to the raw ID, for example `AWS_UTILITY2: ledger-utility2 account`.

Each approval a toggle gives is still an event, and it names the toggle: `by: skip template approval` on `vault.approved` and `template.profile_approved`, `by: skip sandbox approval` on `vault.sandbox_approved`. The job's timeline shows each one.

Through the API: `POST /ui/api/sandbox-approvals` with `yolo`, `skipTemplateApproval`, `skipSandboxApproval`, `autoApprove` (`{ "low": true, "medium": false, "high": false }`, each level named sets itself), `rememberWritesHours`, or `forgetWrite` (`{ "operation": "write", "asset": { "kind": "aws-account", "name": "123456789012" } }`), and `POST /ui/api/sandbox-requests` with `approve` or `decline`. Both are box actions: an API token needs a box grant.

A read template still takes the read-only check before its first box, with YOLO too.

## Templates a job asks for

A running job can ask the hopper for the template its work needs:

```sh
sh "$HOPPER_SKILL" sandbox-template --needs "read/cluster/lab read/aws-account/123456789012" --wait
```

Each **need** is `<operation>/<kind>/<asset>`, at most 16. You can also write a line in plain words, for example `kubectl get pods in namespace web on cluster lab` (see **Needs in plain words** below). The hopper makes the template `asked-<hash>` from the needs: the box image, the tools the needs use, no vault secret, and one operation profile per need. The same needs always get the same template.

The hopper approves it with no person only when it makes it now and every need is a `read` on an asset the **read policy** holds, when the **auto-approve policy** holds its blast radius (by default: read only), or when **Skip template approval** is on. Anything else waits for a person on **Access requests**. A job never widens, approves or re-approves a template. To get a box of it too, the job asks for `sandbox` in place of `sandbox-template`.

An admin can ask for a template the same way on **Settings → Vault**, panel **Template request**. Write what the box must do, one line each, in plain words or as needs, and select **Show the template**. The hopper shows the template it makes from them before it makes it: its name, its image, its tools, its needs, and who approves it. When it waits for a person, the panel says why. Then select **Ask for it**. If you change the needs, show the template again before you ask for it.

### Needs in plain words

A line in plain words names the assets and what the box does on them. The hopper reads it with a fixed set of words, so the same words always give the same needs. Show the template first: it lists the needs that the hopper read.

- **The asset:** a kind word, then the name. `cluster lab`, `namespace web`, `workspace network` (Terraform), `account 123456789012` (AWS), `role ReadOnly` (AWS), `Argo CD app billing`.
- **A namespace** goes in the cluster that the line names: `namespace web on cluster lab`. Or write `namespace lab/web`.
- **A role** goes in the account that the line names: `role ReadOnly in account 123456789012`.
- **What the box does:** a read word (`get`, `list`, `describe`, `logs`, `plan`, `show`) gives read. `apply` or `deploy` gives apply. `sync` gives sync. A change word (`delete`, `restart`, `install`, `upgrade`, `scale`) gives write. A command such as `get-caller-identity` counts too.
- A change word after `not` or `never` gives no change: `get pods on cluster lab, never delete them` is read only.
- The hopper refuses a line that names no asset or says nothing that the box does. Write that need as `<operation>/<kind>/<asset>`.
- A change waits for a person, as for a need you write out, unless **Skip template approval** is on.

### The read policy

The read policy lists the assets on which the hopper may approve read with no person. It is empty by default. The auto-approve policy then decides by blast radius: by default it approves read only. An admin sets it in **Settings → Vault**, panel **Read policy**, one entry per line:

- an asset, for example `cluster/lab`; or
- a prefix with `*`, for example `aws-account/*` or `namespace/lab/*`.

Or: `hopper template read-policy set cluster/lab 'namespace/lab/*'`. `set` with no entry clears it. The read policy never approves write, sync or apply: only **Skip template approval** does.

### The read-only check

A template that a job asked for with read needs only must pass the **read-only check** before its first box. The hopper runs probes in a one-shot check box of the template: each write must be refused, and each read must work. Until the check of its current version passed, no box of it starts. A save makes the check stale.

The template shows the result in its **Read-only check** row. A failed check does not run again by itself: click **Run the check again**, or run `hopper template check <name>`.

Each check that ends keeps a **check report**: a page that shows each probe, the result it expected and the result it got. The check report is an artifact of the job that asked for the template. Open it from **Check report** in the **Read-only check** row, or in the Artifacts view. Each later check (the daily check, or a check you run again) adds a new revision to the same artifact. A template that a person asked for has no job, so its check keeps no check report: the result is on the template only.

A passed check runs again once a day, because an account or a cluster can change. The template stays usable while it runs. If it fails, no new box of the template starts and its boxes take no new job, until a person runs it again and it passes.

A box of such a template cannot change infrastructure, in two layers:

- **AWS.** Each read session the hopper makes has AWS's `ReadOnlyAccess` policy and a policy that denies every create, delete, put, update and modify action, IAM changes, and the use of another role. A role that can write still gives the session no write.
- **Terraform.** `terraform` in the box is a wrapper that runs only `init`, `plan`, `show`, `validate`, `output`, `providers`, `providers schema`, `version`, `state list`, `state show`, `workspace list` and `workspace show`. It refuses all other commands, such as `apply`, `destroy`, `import` and `state rm`. `plan` takes no state lock. The real binary is in `$HOPPER_TOOLS`. When something calls it directly, AWS refuses the write.
- **Providers.** Terraform installs providers only from the box's image, which holds the AWS provider. It downloads none. A workspace that needs another provider, or another version of the AWS provider, cannot run `init` in the box.

The check proves these layers: it tries each terraform write through the wrapper, `apply`, `destroy` and a state push past it, and the install of a provider the image does not hold.

The network is not one of these layers yet. A box of such a template can reach any host on the internet. A later change limits it to AWS, the clusters and the hopper.

To read a Terraform workspace, ask for read on the workspace and read on the AWS role that its provider and its state are read with, for example `read/terraform-workspace/shop-prod read/aws-role/<account>/hopper-read`. The workspace gets that role's read session. Ask for exactly one AWS role: when there is none, or more than one, the check fails and says why. The read session reads the state, but cannot write it or take its lock.

To prove that, the check needs the workspace's **state backend**: the S3 bucket that holds its state, the bucket's region, and the key prefix of its states. Set it on the workspace's profile: in Settings → Vault, click **Edit** on the template and fill in **State backend**, or run `hopper template save <name> --image <image> --backend shop-prod=<bucket>/<key prefix>@<region>`. The check then pushes a state of its own, past the wrapper, to `<key prefix>/hopper-read-only-check/terraform.tfstate` in that bucket, and AWS must refuse it. It never writes the workspace's own state. If AWS lets the push through, the check deletes that key again and fails. Until a workspace has a state backend, the check shows that probe as **not run** and does not pass: the state write is not proven to be refused.

## What the hopper does for you

- Every 10 seconds, beside the hopper and on each machine that dialled in, it burns each box that no step holds: it stops it and removes it with its home.
- A box that it cannot remove shows on **Machines** under *Sandbox boxes not removed*. The hopper tries again.
- `hopper sandbox list` lists your latest box steps: the job, the template, the box, the machine, when each started and ended, and the outcome.
- It builds an image with the template's tools once per base image and set of tools, as `localhost/hopper-box-tools:<hash>`, on the runtime the box starts on: beside the hopper, or on the machine that holds the box. A runtime that builds nothing (Kubernetes) runs the tools image CI publishes.

## Bastions

A bastion is the one sandbox of a job that stays after a step. It holds a port-forward to each target the job named, for example a Grafana or a Prometheus service in a cluster. The job reaches each target through the hopper. The box keeps its own Kubernetes tokens, and the job never gets them.

A bastion ends by itself after an hour with no use, when its job ends, or when the job stops it. To stop one now:

1. Open **Access requests**, panel **Bastions**. Each card shows the template, the job, the targets and when the bastion ends.
2. Select **Stop**. The bastion's tokens stop working, and its box goes. The job can ask for a new bastion.

An operator can stop a bastion.

## Database reads

A job can read rows of a database through the hopper. The job never gets a credential, and no box reaches the database:

1. A person sets up the database's minting credential once (see [The vault](vault.md), "A database's minting credential"). For a database in a cluster, the person also keeps a port forward and a relay open (see [The vault](vault.md), "A database the hopper cannot reach").
2. The job asks for a template with read on the database, for example `read/database/lab/apps/orders`.
3. A person approves that read on **Access requests**. A database read is high radius: the read policy, the auto-approve policy and skip template approval never approve it.
4. For each read, the job runs `sh "$HOPPER_SKILL" database read --template <name> --database <name> --sql "SELECT …"`. The hopper makes a database read role in the database, runs the one `SELECT` with it in a read-only transaction, and drops the role. The answer is the rows as CSV, with a header line.

The limits:

- One statement, a `SELECT` (or `WITH … SELECT`, `VALUES`). A write fails: the role can change nothing, and the transaction is read-only.
- On SQL Server, the statement must answer one result set. A write fails: the read login can change nothing, and the hopper rolls the transaction back. Dates come as ISO 8601 in UTC, `bit` as 1 or 0, binary as `0x…`. A `decimal`, `numeric` or `money` value is read as a JavaScript number: for every digit, `CAST` it to `varchar` in the `SELECT`.
- At most 100000 rows or 16 MiB in one answer. A bigger answer fails, and is never cut: page the query.
- A statement stops after 60 s.

The job's timeline shows each read with its SQL, the role, and the Access decision: **database.role_minted**, **database.read** and **database.role_dropped**. When the hopper stops during a read, the role ends at its `VALID UNTIL`, and the hopper drops it at the next start or within 5 minutes after that time. SQL Server has no `VALID UNTIL`: there the hopper drops a read login older than 15 minutes at the same times.

## Windows sandbox steps

No hopper client, lane or agent runs on Windows. When a job needs Windows for one step (a .NET Framework build, a Windows app's tests), it asks the hopper to run that step on a **Windows host**:

1. On the Windows computer, turn on OpenSSH Server and give one account the hopper's public key in its authorized keys (the hopper shows its key when you add an ssh machine). Windows PowerShell must be there.
2. In **Settings → Windows hosts**, add the host: a name, `user@host`, and the working directory every step runs in. Read its host key, compare the fingerprint with the host's own, and pin it.
3. A job runs `sh "$HOPPER_STEP" run NAME --input src --command "msbuild App.sln" --output bin`. The hopper copies the inputs into the working directory, runs the command in PowerShell there, streams its output back, then gives the exit code and the outputs.

One step runs on a host at a time. A step gets no credential and no GitHub token. The job's timeline shows each step: its host, command, exit code and time.

## Limits and troubleshooting

- **The playground says it has no runtime**: the hopper has no rootless runtime socket. The deploy guide has the steps.
- **The read-only check of a Terraform workspace needs its state backend.** Without it, `terraform.state-push-direct` is *not run* and the check fails. Set the backend on the workspace's profile (see above).
- **The read-only check of a Terraform workspace needs one AWS role.** A workspace uses the read session of the template's one `aws-role` read need. A template with no such need, or with more than one, fails the check and says why.
- **Not built.** A playground sandbox on another machine: the playground starts them beside the hopper only.

See also: [The vault](vault.md), [Lanes](lanes.md), [Deploy and update](deploy-and-update.md), [CLI and API](cli-and-api.md).
