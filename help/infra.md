# Infra changes

**Infra changes** is a page in the main menu. It is where you decide on infrastructure changes. It always shows, even when nothing waits. Its menu entry has a count of the out-of-band changes no one has marked yet.

## Plans

No apply without a plan. A job records the plan of each infrastructure change. The vault mints a credential that changes infrastructure only for a plan you approved. Approve a plan on this page.

## Out-of-band changes

An out-of-band change is a change to infrastructure that did not come through IaC or GitOps: drift, or a write by a person or tool that is no controller identity and holds no credential minted for an approved plan. Jobs' checks find them.

- Each one is sent to the notifiers, with a link to this page.
- Mark each one **Adopted** (brought into git), **Reverted**, or **Accepted** with a reason.
- Admins set the controller identities here: the principals whose writes are GitOps's, one per line. A trailing `*` names a group.

The hopper only tracks these changes. It reverts nothing.
