# Cloud acceptance run: a runbook for testers

The sandbox module's tests use doubles for the cloud side. This run proves it with real `aws`, `kubectl`, `helm` and
`terraform`, against a real AWS account and a real Kubernetes cluster. You run it in your own environment, with your
own read-only credentials. Nothing of the hopper's maintainers is used, and nothing leaves your machine until you file
the report.

The run takes about 15 minutes, most of it the hopper's read-only check.

## What the run proves

One command (`scripts/cloud-acceptance.ts`) drives your hopper through its operator CLI:

1. The hopper answers its operator CLI.
2. A minting credential in your vault mints for the AWS account and for the cluster.
3. The vault mints a read session for the AWS role, and STS says who it is (`hopper vault mint-test`).
4. The vault mints a read token for the cluster, and the cluster says who it is.
5. The hopper makes a template from needs in plain words (`hopper template request`), as a person writes them.
6. The template is approved: by your read policy, or by you while the command waits.
7. The hopper runs the template's **read-only check**: a box of the template, on the hopper's container runtime (or on
   a client machine, see below), with minted credentials only. In the box, per tool:
   - `aws`: `sts get-caller-identity` works. A tag on a VPC (a dry run), an SSM parameter, an IAM user and an assume-role
     are refused.
   - `kubectl`: `get ns` (or the pods of a namespace) works. A namespace and a pod delete (server dry runs) are refused.
   - `helm`: `helm list` works. The objects of a chart install (a server dry run) are refused.
   - `terraform`: `plan` of a one-resource stack works. `apply`, `destroy`, `state push` and the other writes are refused.

Each write is a dry run where the service has one, and leaves nothing when it is refused. The probes are in
`src/sandbox/probes.ts`.

## Before you start

You need:

- A hopper of the version you test, running, with sandbox boxes on. On a compose install, start it with
  `compose.sandboxes.yaml` (`docs/deploy.md`).
- The operator CLI on the hopper's host: `hopper`, or `podman compose exec -T hopper hopper` on a compose install.
- A checkout of this repository at the same version, and Node 24 or later: `git clone
  https://github.com/henningfutrell/hopper.git && cd hopper && git checkout <your version> && npm ci`.
- At least one of:
  - An AWS account with a role that the hopper can assume, with read access only.
  - A Kubernetes cluster, with a credential that can read only. `helm list` reads Secrets: a `view` role cannot, so on
    a `view` role `helm list` is refused on secrets. The probe passes then (see "Read the report").
- A **minting credential** in your vault for each: `hopper vault set <name> --mints aws-account/<account id> <
  credential.json`, or `--mints cluster/<name>`. The vault help page (`help/vault.md`, "Minted credentials") says what
  each holds.

Optional: let your read policy approve the template, so the run needs no click:

```sh
hopper template read-policy set aws-role/<account id>/<role> cluster/<cluster>
```

## Run it

```sh
node scripts/cloud-acceptance.ts run \
  --aws-role <account id>/<role> \
  --cluster <cluster> \
  [--namespace <cluster>/<namespace>] \
  [--terraform-workspace <name>] \
  [--hopper "podman compose exec -T hopper hopper"]
```

- Name at least one asset. Name the AWS role and the cluster to cover all four tools.
- `--terraform-workspace` needs `--aws-role`: terraform's probes run with the AWS role's read session.
- When the template waits for a person, the command says so. Approve it with `hopper template approve <template>`, or
  on Vault. The command waits up to 30 minutes (`--wait <seconds>` changes it).
- Each step prints one line as it ends.

The command writes `cloud-acceptance/report.md` and `cloud-acceptance/report.json` (`--out <dir>` changes the place).
It exits 0 when the run passed, 1 when a step failed, and 2 on a bad call.

## Run it on a client machine

The check runs beside the hopper when the hopper has a container runtime. To prove a client machine:

1. Start the hopper with no runtime socket (on compose: without `compose.sandboxes.yaml`).
2. Join a client machine that has Podman (Machines → Add machine).
3. Run the same command again. The check runs as a box on the client machine (`docs/design.md` "The read-only check on a
   client target").

File one report for each place.

## Read the report

`report.md` has a table per tool, then each step with its result and a short output. Each tool is:

- **passed**: its read worked, and each of its writes was refused.
- **failed**: its read did not work, or a write went through. A write that went through is a real finding.
- **skipped**: no probe of it ran. The step `tool.<name>` says what to name to cover it.

A `helm list` refused with `Forbidden` on secrets on a `view` role passes: that is right for a read credential, and the
check's summary names it. A `helm list` refused on anything else fails.

The report is masked: your account id, role, cluster, namespace and workspace names show as `<account>`, `<role>`,
`<cluster>`, `<namespace>` and `<workspace>`. Keys, tokens, email addresses, IP addresses, private host names and your
host name are masked too. **Read it before you file it**, and remove anything else you do not want to share.

## Report it

1. Open the issue form: https://github.com/henningfutrell/hopper/issues/new?template=cloud-acceptance.yml
2. Paste all of `report.md`, including the `json hopper-cloud-acceptance` block at its end.
3. Fill in the hopper version, the install kind and where the check ran.
4. Submit it.

## Collect the reports (maintainers)

Each report is an issue with the label `cloud-acceptance`. To sum them up per tool:

```sh
gh issue list --repo henningfutrell/hopper --label cloud-acceptance --state all --json number,url,body > reports.json
node scripts/cloud-acceptance.ts collect reports.json
```

`collect` also reads `report.json` files that testers send in another way. It prints a table per tool (passed, failed,
skipped), one row per report with its failed steps, and the issues that hold no report.
