# The main menu

The main menu is the list of pages on the left of the UI. On a phone, select the menu button at the top left to open it as a drawer.

## The groups

Two pages are always at the top, above the groups:

- **Dashboard** is first. It shows the whole system at a glance: running jobs, lanes, waiting jobs, finished and failed jobs, the lane timeline and what needs attention. The UI opens on it. An old link to the Overview opens the Dashboard.
- **Needs you** is second. Its badge counts every decision that waits on you. See [Needs you](needs-you.md).

The menu puts the other pages in groups. Each group has a heading.

| Group | Pages |
|---|---|
| Waiting on you | Intake, Access requests, Questions, Proposals, Research, Logins, Failures, Parked |
| Jobs | Jobs, Queue, Direct jobs, Pull requests, Artifacts, Decisions, Events, Your reports |
| Infra | Infra |
| Sources & machines | Sources, Machines, Usage, Resources |
| Settings | Settings |

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
