# The main menu

The main menu is the list of pages on the left of the UI. On a phone, select the menu button at the top left to open it as a drawer.

## The groups

Two pages are always at the top, above the groups:

- **Dashboard** is first. It shows the whole system at a glance: running jobs, lanes, waiting jobs, finished and failed jobs, the lane timeline and what needs attention. The UI opens on it. An old link to the Overview opens the Dashboard.
- **Needs you** is second. Its badge counts every decision that waits on you. See [Needs you](needs-you.md).

The menu puts the other pages in groups. Each group has a heading.

| Group | Pages |
|---|---|
| Waiting on you | Intake, Questions, Proposals, Approvals, Failures, Tagged |
| Work | Jobs, Pull requests, Research, Ask hopper, Artifacts, Activity |
| Fleet | Machines, Usage, Sources |
| Infra | Infra, Topology, Vault |
| Admin | Users & access, Skills, Plugins, Settings |

Some pages have tabs. Each tab shows one part of the same work:

| Page | Tabs |
|---|---|
| Approvals | Access requests, Pending approvals |
| Failures | Failures (stuck work is first), Parked |
| Jobs | Jobs, Queue order |
| Ask hopper | Run a job, Ask a question |
| Activity | Events, Decisions |
| Machines | Machines, Accounts, Logins |
| Usage | Usage, Resources |

- The badge of a page with tabs is the sum of the badges of its tabs. Each tab shows its own badge.
- An old link to a page that is now a tab, for example a link to Logins, opens that tab.
- **Tagged** lists the open issues and pull requests that ask for your review, mention you or are assigned to you.
- **Search** finds jobs by their words. Use the search box in the header. On a phone, select **Search** in the menu.
- **Ask a question** in Ask hopper lists the questions that callers asked the hopper directly.
- **Topology** shows the graph and the globe of the services in your AWS accounts and clusters.
- **Accounts** shows who the agent tool of each machine is signed in as. Its badge counts the machines that are signed in as nobody.
- **Skills** lists the skills that jobs get, and which skill each kind of work uses.
- **Your reports** and **Version history** are in your user menu: select your initials at the top right.

## Collapse a group

1. Select the heading of the group. The group collapses, and its pages go out of the list.
2. Select the heading again to open the group.

The menu keeps which groups you collapsed. It keeps them in this browser only. The sidebar and the phone drawer use the same groups, collapsed the same way.

## Badges in a collapsed group

A badge on a page tells you that something waits there. For example, a question waits on you, or a source has an error.

A collapsed group never hides a badge:

- The heading of a collapsed group shows one badge for all its pages. Its number is the sum of the pages' numbers.
- Its colour is the most urgent colour of its pages. Red (a failure) is first, then amber (a warning), then the colour of a decision, then a plain count, then a quiet count.
- When a high-priority job waits on one of its pages, the badge has a ring and an arrow.
- Hold the pointer on the badge to see each page and its count.
- The backburner count of Intake shows next to it, with a dashed edge.

Open the group to see the badge of each page.

## Pending approvals

**Pending approvals**, a tab of Approvals, lists each GitHub Actions run that waits for a deployment approval you can give, for example a terraform apply or a production promote. It looks in the repositories of the organizations your job repositories are in. Its badge counts them.

- Each row shows the repository, the workflow, the run, the environment and how long it waited. Select **Open run** to approve or reject it on GitHub. The hopper never approves or rejects a deployment.
- A run marked **stale** has a newer run of the same repository that waits on the same environment.
- The hopper reads GitHub every 5 minutes. A repository it cannot read shows under the list with the reason.
