# Infra

**Infra** is a page in the main menu. It is where you decide on infrastructure changes. It always shows, even when nothing waits. Its menu badge counts the plans that wait for a person to approve them and the out-of-band changes that no one marked yet.

## Plans

No apply without a plan. A job records the plan of each infrastructure change. The vault mints a credential that changes infrastructure only for a plan that a person approved. Approve a plan on this page.

Who approves a plan depends on its risk:

- A low-risk plan in uat only: an operator or an admin.
- Any other plan (prod, IAM and identity, destroys, data, another environment, or a diff the hopper cannot read): an admin. The page asks the admin to confirm a high-risk plan.
- A plan that failed a check (a new resource without the MAP tag): nobody. The job fixes the code and plans again.

An admin can turn on **Auto-approve**. Then the hopper approves a low-risk uat plan when the job records it. The plan still shows on this page and on the job's timeline.

## Applies and drift

One list, newest first: plans recorded and approved, applies, drift, out-of-band writes, and marks.

## Out-of-band changes

An out-of-band change is a change to infrastructure that did not come through IaC or GitOps. It is drift, or a write by a person or tool that is not a controller identity and holds no credential minted for an approved plan. The checks of jobs find them. A check that runs outside the hopper can report them with an API token.

- The hopper sends each one to the notifiers, with a link to this page.
- Mark each one **Adopted** (brought into git), **Reverted**, or **Accepted** with a reason.
- Admins set the controller identities here: the principals whose writes are GitOps's, one per line. A trailing `*` names a group.

The hopper only tracks these changes. It reverts nothing.
