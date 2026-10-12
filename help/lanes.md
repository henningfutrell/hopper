# Lanes and lane tuning

A lane is one job slot on a machine: the lanes decide how many jobs run at once, and where. This page tells you how the hopper fills lanes, how usage and priority change them, and how to tune the number of lanes per machine.

## What a lane is

A **machine** runs jobs. Each machine has a number of **lanes**. One lane runs one job at a time.

- A lane is `idle` (no job), `busy` (a job runs on it) or `draining` (its job runs on, and the lane closes when the job ends).
- The hopper opens and closes lanes by itself. It never stops a running job to free a lane.
- A job that waits on a question, or that is parked, holds no lane.

The **lane cap** is the most lanes a machine may run now. It starts at the machine's lanes. Usage makes it smaller (see [Usage limits](#usage-limits)).

## Where a job goes

When a lane is free, the hopper takes the waiting jobs in queue order. For each job it picks a machine that:

- is online and runs the job's executor,
- matches the job's pin, when a routing rule pins it to one machine,
- has a lane free under its lane cap.

Of those machines, it picks the one with the most room. When two or more machines can take a job, other rules can come first: a free priority lane, the job's expected cost, the usage reset time, or Jev's pick (see below).

When no machine has room, the job **waits** for a lane. It stays queued, and its reason names the lane cap that stops it, for example `waiting for a lane: machine desk's lane cap is 4, all 4 in use`. The Dashboard's Waiting list shows the reason.

## Set the lanes of a machine

1. Open **Machines**.
2. Select **Edit** on the machine.
3. Set **lanes**: the jobs it runs at once. On this machine, 0 runs no jobs here.
4. Save.

The change applies at the next decision. The hopper opens new lanes, or drains busy lanes past the new number. **Machine defaults** on Machines sets the lanes and executors that a new machine starts with.

Two more machine options are in **Settings → Plugins**, in the options of each machine source:

| Option | What it does | Default |
|---|---|---|
| `reservedLanes` | Lanes the machine keeps for jobs pinned to it. Other jobs use at most its lane cap less these. | 0 |
| `elbowIns` | How many lanes [specialty jobs](#specialty-jobs-elbow-in) may start past the machine's lane cap at the same time. 0: none. | 1 |

## Usage limits

The hopper keeps each machine inside its plan usage. Two limits control this:

| Band | Usage | What the hopper does to lanes |
|---|---|---|
| free | below the soft limit (default 70%) | Every lane is open. |
| soft | from the soft limit to the hard limit | The lane cap gets smaller as usage goes up. Busy lanes past the cap drain: the lowest priority first, so high-priority work is cut last. |
| hard | at or above the hard limit (default 95%) | The lane cap is 0. Nothing new starts. Running jobs finish. |

To change the limits:

1. Open **Usage**.
2. In **Usage limits**, drag the **Soft** and **Hard** handles, or type the numbers. The panel shows each machine's lane cap at the new limits.
3. Select **Save**.

Saved limits apply at once, with no restart. They win over `HOPPER_SOFT_LIMIT` and `HOPPER_HARD_LIMIT`. **Defaults** puts back the environment's values. Only an admin changes the limits. The **Lane effect** panel on Usage shows each machine's used fraction and lane cap now.

A usage reading marked informational never limits lanes. In the last hours before a week window resets (`HOPPER_BURN_WINDOW_HOURS`, default 18), that window stops limiting lanes unless it is spent.

## Priority lanes

A **high-priority** job has a priority at or above the high-priority threshold (default 75: the label `hopper:high`). Some lanes are **priority lanes**: high-priority jobs get them first.

- The hopper chooses the most reliable lanes from its own history. A lane needs 5 runs in the window (default 14 days) to be ranked.
- A high-priority job takes a free priority lane first. When all are busy, it takes any free lane. It never waits for a priority lane.
- No running job is stopped for a high-priority job.

Set them in the **Priority lanes** panel on **Machines** (admin):

| Field | Meaning |
|---|---|
| **High priority from** | The high-priority threshold, 1 to 100. |
| **Priority lanes** | How many, 0 to 32. 0 turns them off. |
| **Window, days** | The history that reliability is measured over. |
| **Runs to be ranked** | The runs a lane needs before it is ranked. |
| **While a high-priority job waits** | *only it takes a priority lane* (default), or *default jobs take one too*: then only low-priority jobs leave it. A priority lane is held only while a high-priority job waits for one and could run on that machine. While none waits, any job takes a priority lane, after the other lanes of that machine. When the high-priority job ends, its lane is open to any job again. |

To choose the lanes yourself, tick them and select **Use these lanes**. **Choose by reliability** goes back to the hopper's choice. The Dashboard's **Lanes** panel marks each priority lane.

## Specialty jobs elbow in

A **specialty job** may **elbow in**: start one lane past a machine's lane cap when every lane is full.

1. Give the issue the label `hopper:specialty`.
2. The hopper reads the label when it takes the issue. A label you add to an issue whose job already waits applies to its next job.

A specialty job first gets a lane like any other job. Only when it fits on no machine does it elbow in. The hopper then picks a machine that:

- can run the job (online, its executor, its pin, no low disk, not held by the blast-radius gate),
- is not at its usage hard limit, for the machine or for the job's executor,
- shows no resource pressure: CPU less than 95% busy and memory less than 90% used,
- has fewer lanes past its cap than its `elbowIns` option allows.

The lane past the cap drains first. It closes when the specialty job ends, and the machine is back at its cap. Nothing is stopped. The Dashboard's **Lanes** panel shows the lane as `elbow-in · over the cap`, and the machine as, for example, `7/6 lanes in use · 1 over the cap`.

Priority does not make a job a specialty job. Only the label does.

A job at the critical priority (`HOPPER_CRITICAL_PRIORITY`, default 100; 0: off) may also take one lane past the cap when it fits nowhere. That is a rule of the priority, not a label.

## Lane tuning

The hopper measures how many lanes each machine can run, and **recommends** a number. It does not change any lanes by itself. An admin applies a recommendation.

The recommendation comes from the last 7 days of the machine's samples:

- the most lanes in use with no resource pressure (CPU 95%, memory 90%, disk 95%),
- the cost of one lane, and the room left at that cost (at most 2 lanes more than the most seen),
- failed runs: when jobs fail much more often with more lanes in use, it recommends fewer,
- usage: near the soft limit or past it, it never recommends more lanes than you have now.

It always stays between the machine's **Least** and **Most** lanes (default 1 and 8).

### Use the Lane tuning panel

1. Open **Machines**. Find the **Lane tuning** panel under the machine cards.
2. Read each machine's line, for example `Recommends 4 lanes; configured 2: 2 more`, with the reason and the confidence.
3. Select **Apply: 4 lanes** to set the machine's lanes to the recommendation. Or select **Dismiss** to hide it until the recommendation or the lanes change.
4. To go back, select **Undo: back to 2**. Undo is there only while the lanes are still the applied ones. An edit by hand since then stays.

Each change shows who made it and why. Per machine, an admin also sets **Auto-tune** on or off, and the **Least** and **Most** lanes. Select **Save** after a change. With auto-tune off, the panel shows no recommendation.

### See what lanes cost

- On each machine card, **Resources, lanes and usage** opens a graph: CPU, memory, disk, lanes in use and the usage that limits the machine. Each applied or undone lane change is a mark on the graph. Point at the mark to read who made it and why.
- The **Job costs** panel on Machines shows what finished jobs cost, per job kind, repository or sandbox template: duration, CPU, memory, disk and plan usage.

The hopper uses these costs to place a job. When similar jobs used much memory or CPU, a new one goes to a machine with room for it. When it fits nowhere, it is placed as before.

### Jev picks lanes and machines

In **Settings → Decider**, two decision points concern lanes:

| Decision | What Jev picks |
|---|---|
| **How many lanes a machine runs** | The lanes of a machine, from the lanes the rules allow. A sure pick becomes the machine's recommendation. An admin still applies it. |
| **The machine a waiting job goes to** | The machine, when more than one can take the job. A sure pick goes first when that machine has a free lane. |

Both start in **shadow**: Jev only records its pick, and the page shows how often it agrees. Set a point to **active** to use its sure picks.

## Lanes from the command line

`hopper lanes` reads and changes lane tuning. Each command prints JSON.

| Command | What it does |
|---|---|
| `hopper lanes plan` | Every machine's lane recommendation and its reason. |
| `hopper lanes costs` | The job cost profiles, grouped by repository, kind and template. |
| `hopper lanes tune <machine> [--auto on\|off] [--min <n>] [--max <n>]` | Auto-tune on or off, and the least and most lanes. |
| `hopper lanes apply <machine>` | Apply the machine's recommendation. |
| `hopper lanes dismiss <machine>` | Dismiss it until it changes. |
| `hopper lanes undo <machine>` | Undo the last applied recommendation. |

See [Command line and API](cli-and-api.md) for how the command line reaches the hopper.

## Troubleshooting

| You see | Do this |
|---|---|
| A job waits with `waiting for a lane: machine desk's lane cap is 4, all 4 in use` | Every lane it may use is busy. Add lanes, add a machine, or wait. |
| The reason ends `(usage soft limit, used 82%)` | Usage is past the soft limit, so the lane cap is smaller. Wait for the reset, or move the limits on Usage. |
| `usage hard limit stops executor …` | Usage is at the hard limit. Nothing new starts there until usage goes down. |
| `machine desk holds priority lane desk/lane-1 for high-priority jobs still to be placed` | A high-priority job after this one in the queue order needs that lane. The lane is open to any job again once that job is placed. |
| `machine desk keeps 1 of its 4 lanes for jobs pinned to it` | The machine's `reservedLanes` keep lanes for pinned jobs. |
| Lane tuning says `not enough history` | The machine must run at least one lane for 10 minutes in the last 7 days. |
| No **Apply** button | Auto-tune is off, the machine is offline, the recommendation is the lanes you have, it was dismissed, or you are not an admin. |
| A specialty job does not elbow in | Every machine is at its hard limit, under resource pressure, or at its `elbowIns`. Or the label came after the job was made. |
