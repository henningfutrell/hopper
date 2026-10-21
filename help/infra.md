# Infra

**Infra** is a page in the main menu. It is where you decide on infrastructure changes. It always shows, even when nothing waits. Its menu badge counts the plans that wait for a person to approve them and the out-of-band changes that no one marked yet.

## Plans

No apply without a plan. A job records the plan of each infrastructure change. The vault mints a credential that changes infrastructure only for a plan that a person approved. Approve a plan on this page.

Who approves a plan depends on its risk:

- A low-risk plan in uat only: an operator or an admin.
- Any other plan (prod, IAM and identity, destroys, data, another environment, or a diff the hopper cannot read): an admin. The page asks the admin to confirm a high-risk plan.
- A plan that failed a check (a new resource without the MAP tag): nobody. The job fixes the code and plans again.

A job records the plan before it applies the change: the `terraform plan` (with its saved plan file), the `helm diff`, or the Argo CD diff, with the repository, branch and commit it was made at. It sends the plan to `POST /job/infra-plans`. Until a job does, the panel says *No plans yet*.

Each plan shows what it changes in plain words, its risk (*low* or *high*), its risk callouts (destroys, IAM, prod, data, network), its blast radius and its checks. **Show the plan** opens the raw plan. Its state is one of these:

| State | What it means |
|---|---|
| **Waits for approval** | A person approves it, as above. A job never approves a plan. |
| **Approved** | Until it is stale, the vault mints the credential for an apply that names it, while its branch is still at the plan's commit. |
| **Stale** | A plan is stale one hour after it was made. Nothing applies it. The job plans again. |
| **Failed its checks** | Nobody approves it. The job fixes the code and plans again. |
| **Rejected** | A person rejected it, with a note. Nobody can approve it after this. |

Under each plan, each apply shows the operation, the asset, the job that asked, and until when the credential is valid. The hopper never shows the credential.

A job that waits on a plan's approval links to the plan here: the link opens this page with that plan marked. When a person approves the plan, the job goes on by itself. From a terminal, `hopper infra plans` lists the plans that wait, and `hopper infra approve <plan>` approves one.

To stop a plan that you decided against, write why in the field beside **Reject**, then click **Reject**. An operator or an admin can reject any plan that waits. Nobody can approve a rejected plan, and the vault mints nothing for it. A job that waits on the plan goes on at once and gets your note. From a terminal: `hopper infra reject <plan> --note "<why>"`.

An admin can turn on **Auto-approve**. Then the hopper approves a low-risk uat plan when the job records it. The plan still shows on this page and on the job's timeline.

## Applies and drift

One list, newest first: plans recorded and approved, applies, drift, out-of-band writes, and marks.

## Out-of-band changes

An out-of-band change is a change to infrastructure that did not come through IaC or GitOps. It is drift, or a write by a person or tool that is not a controller identity and holds no credential minted for an approved plan. A job's read-only check reports what it finds to `POST /job/infra-signals`. A check that runs outside the hopper reports with an API token to `POST /ui/api/out-of-band/signals`.

- The hopper sends each one to the notifiers, with a link to this page.
- Mark each one **Adopted** (brought into git), **Reverted**, or **Accepted** with a reason.
- Admins set the controller identities here: the principals whose writes are GitOps's, one per line. A trailing `*` names a group.

The hopper only tracks these changes. It reverts nothing.

## Topology

The topology is a map of the services in your AWS accounts and Kubernetes clusters, and of what is linked to what: a cluster in its VPC, a service behind its load balancer, a workload and the IAM role it assumes, an app and the database or queue it uses, a role that another account may assume.

- The hopper reads the map itself every 6 hours. It reads each AWS account that a minting credential in Settings → Vault mints for, as the account's read role `hopper-read`. Then it reads each cluster that EKS lists in those accounts, and each cluster that has a minting credential of its own. It uses only short-lived read credentials that the vault mints, and only read calls.
- Click **Discover now** to read the map at once. The map shows what the hopper found when the read ends.
- A read-only check can also read one AWS account in one region, or one Kubernetes cluster, and report what it found with an API token to `POST /ui/api/topology/report`. Give its grant the scope `topology:report`.
- A job reads the same map with its own token, read-only. It loads the `topology` skill (`sh "$HOPPER_SKILL" topology`), which reads `$HOPPER_URL/job/topology`. A job does not read `/api/topology`, and it does not read the hopper at `127.0.0.1`: that is the job's own machine.
- Filter the map by account, cluster, region or kind. Click a node to see its details, its neighbours, and the changes that touched it: plans, approvals, applies, drift and out-of-band writes.
- In Applies and drift, each entry names the nodes it touched. Click one to see it on the map.
- Each source says when it was read, and who read it. When the hopper or a check cannot read a source, the map keeps what it found the last time, and the source says why it is stale. The other sources are read as usual.
- A faint node is one that only a link names, for example an IAM role in an account that no check read.

The hopper never writes to a cloud or a cluster here.

The same reads and acts are in the API, under the Infra tag: `GET /api/infra-plans`, `GET /api/out-of-band`, `GET /api/topology`, `POST /ui/api/infra-plans`, `POST /ui/api/out-of-band`, `POST /ui/api/topology/report` and `POST /ui/api/topology/discover`.
