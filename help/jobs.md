# The Jobs view

The Jobs view shows where every job stands, and how the jobs, their issues and their pull requests connect. Open it from **Jobs** in the navigation. The Overview tells you if the hopper is healthy. The Jobs view tells you where each piece of work is.

## What it is

### Stages

Each job is in one stage. The counts at the top show how many jobs are in each stage. Select a count to show only the jobs of that stage. Select it again to show all.

| Stage | What it means |
|---|---|
| queued | The job waits for a lane. A held job is queued too. |
| running | An agent works on the job now. |
| waiting | The job waits on a person or on the outside world: a question, an operator, a parked job, or its own wait. |
| PR open | The job is finished and its pull request is open. |
| partly done | The job shipped part of its issue. The rest runs when its pull request merges. |
| done | The job is finished. Its pull request merged, or it had none. |
| failed | The job failed. |
| cancelled | The job was cancelled, or the queue gate turned it away. |

An issue that no job works on yet shows as **no job**.

### The graph

The graph is the default mode. It shows each group of connected work as one **job tree**, named by its root. The root is usually the first issue.

- A node is a job, an issue, a pull request, an open question or an open hand-off. Its colour is its stage. A question or a hand-off is a pill shape, in the **waiting** stage: it waits on a person. A job node shows its task count as `x/y` when the job keeps a task list.
- A line between two nodes has a type. Hover a line to read it.

| Line | What it means |
|---|---|
| sub-issue | An issue to its sub-issue: a GitHub sub-issue, or a required issue a job filed. |
| follow-up | An issue to a follow-up issue a job filed. |
| job of | An issue to a job that works on it. |
| next part | A partly done job to the job that runs the rest of its issue. |
| run again | A job to the job that runs its issue again. |
| spawned | A job to a separate research or proposal job made from one of its questions. |
| plan → apply | A proposal's job to the job that carries out the path a person picked. |
| opened | A job to its pull request. |
| waits on merge | A partly done job to its pull request. The rest of the issue waits on this merge. |
| closes | A pull request to the issue its merge closes. |
| blocked by | An issue to an issue that blocks it: GitHub's "blocked by" link. |
| stacked on | A pull request to the open pull request whose branch it is based on. It can merge only after that one. |
| asks | A job to its open question. |
| hands off | A failed job to its open hand-off in **Needs a person**. |

**What blocks the root.** A node that is not done yet, and every node on the way from the root to it, has a dashed red ring. The lines to it are bold and red. The tree's header says how many nodes block it. A tree that nothing blocks starts folded when there are other trees. Select its header to open or fold it.

Select a node to read its details: its stage, status, task count, lane, time in stage, pull request and checks, and its lines to other nodes. Select the job's name to open its job page. For a question or a hand-off, the name opens the page of its job.

### The list

Select **List** for a row per job, the latest stage change first. A row shows:

- The job's goal, which links to its job page, its task count, and its stage.
- Its issue, its lane and machine, and how long it is in its stage.
- Its pull request, with its state and checks (for example `open · checks failing`).
- For a partly done job: the pull request that blocks the rest, and what runs after it merges.
- Its last event.

## How to use it

- To see what blocks a big piece of work, open its tree in the graph and follow the red lines from the root.
- To find the work that waits on you, look for the question and hand-off nodes. They block their root until a person answers or resolves them. Then open the **Questions** or **Needs a person** section.
- To see one repository only, select it in **Repository**. The counts then show that repository only.
- To check partly done work, select the **partly done** count and open each pull request it names.

The view updates live. A job that changes stage moves with no reload.

## Which jobs it shows

- Every job in the queue: waiting, running, waiting on a person, parked, and the jobs that ended in the last 24 hours.
- Every finished job whose pull request is still open, also when it ended earlier.
- The jobs that these came from: the run before, the job a fork came from, the proposal a job carries out.
- Every job with an open question or an open hand-off, also when it ended earlier.
- The issues that jobs filed, and the sub-issues, the blocking issues and the closing pull requests the hopper read for the issue graph.

## For agents: the API

`GET /api/jobs/graph` gives the same data as the view: `nodes`, typed `edges`, `trees` (each with its `root` and the nodes that block it, `blocking`) and `stages` (how many jobs are in each stage). An API token needs the scope `jobs:read`. See [The operator CLI and the API](cli-and-api.md) and [API tokens and grants](api-tokens.md).

## Limits and troubleshooting

| Symptom | Cause and fix |
|---|---|
| A job has no `x/y` | The job has not reported a task list yet. |
| Time in stage starts at the wrong moment | The hopper uses the times the job keeps: created for queued, started for running, the wait or park time for waiting, finished for the rest. A held job counts from when it was created. |
| Two issues are not linked | The graph shows only the links the hopper knows: issues a job filed, and sub-issues, "blocked by" links and closing pull requests from the issue graph. The hopper reads an issue's links when it syncs that issue, so a new link shows after the next sync. An older GitHub Enterprise has no "blocked by" links. |
| Two pull requests are not stacked | The hopper learns a pull request's branches when it follows it. A pull request that no job here opened is not followed, so the graph cannot stack it. |
| An old finished job is missing | The view shows ended jobs for 24 hours, unless their pull request is still open. Open the job from its issue, or from **Events**. |

See also: [Pull requests](pull-requests.md), [Questions and deciders](questions.md), [Lanes](lanes.md).
