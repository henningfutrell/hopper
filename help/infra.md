# Infra

**Infra** is a page in the main menu. It is where you decide on infrastructure changes. It always shows, even when nothing waits. Its menu badge counts the plans that wait for an admin and the out-of-band changes that no one marked yet.

## Plans

No apply without a plan. A job records the plan of each infrastructure change. The vault mints a credential that changes infrastructure only for a plan that an admin approved. Approve a plan on this page.

## Applies and drift

One list, newest first: plans recorded and approved, applies, drift, out-of-band writes, and marks.

## Out-of-band changes

An out-of-band change is a change to infrastructure that did not come through IaC or GitOps. It is drift, or a write by a person or tool that is not a controller identity and holds no credential minted for an approved plan. The checks of jobs find them. A check that runs outside the hopper can report them with an API token.

- The hopper sends each one to the notifiers, with a link to this page.
- Mark each one **Adopted** (brought into git), **Reverted**, or **Accepted** with a reason.
- Admins set the controller identities here: the principals whose writes are GitOps's, one per line. A trailing `*` names a group.

The hopper only tracks these changes. It reverts nothing.
