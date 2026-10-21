# The Jobs view

The Jobs view shows where every job stands, and how the jobs, their issues and their pull requests connect. Open it from **Jobs** in the navigation. The Dashboard tells you if the hopper is healthy. The Jobs view tells you where each piece of work is.

## What it is

### Stages

Each job is in one stage. The counts at the top show how many jobs are in each stage. Select a count to show only the jobs of that stage. Select it again to show all.

| Stage | What it means |
|---|---|
| Queued | The job waits for a lane. A held job is queued too. |
| Building it | An agent works on the job now. |
| Waiting | The job waits on a person or on the outside world: a question, an operator, a parked job, or its own wait. |
| Ready for review | The job is finished and its pull request is open. |
| Part shipped | The job shipped part of its issue. The rest runs when its pull request merges. |
| Done | The job is finished. Its pull request merged, or it had none. |
| Failed | The job failed. |
| Cancelled | The job was cancelled, or the queue gate turned it away. |
| Superseded | The job failed or was cancelled, but other work took its place: a later job of its issue, the close of its issue as completed, or the merge of the pull request it worked on. A failed job you dismissed shows here too, as **Dismissed**. It does not count as failed. |

An issue that no job works on yet shows as **Not started**. An issue that GitHub closed as completed shows as **Done**. A pull request that merged shows as **Merged** on every job that worked on it.

Each node and each card also says in plain words where it stands. For example:

- **Plan** or **Research**: the job writes a plan or a research report.
- **Building it (attempt 2 of 3)**: the job runs again after a failed run. The second number is the retries the failure settings allow, plus one.
- **Waiting on you: answer a question**, **approve the plan**, **accept the research**, or **take it over**.
- **Checks failed**, **Has merge conflicts** or **Draft**: the job is finished, and its pull request needs this first.
- **Merged**: the job's pull request merged.

### In flight

The badge at the top of every page shows how many jobs are **in flight**. A job is in flight when an agent works on it now, or when its pull request is open and its checks run, its checks are being fixed, or it waits on the merge. A draft or a pull request with merge conflicts is not in flight. The count updates by itself when a job moves.

Select the badge to open the Jobs view with only the jobs in flight. **In flight** at the top of the view is on. Select it again to show all jobs.

### The graph

Select **Graph** for the graph. It shows each group of connected work as one **job tree**, named by its root. The root is usually the first issue.

- A node is a job, an issue, a pull request, an open question or an open hand-off. It shows its title first. Under the title, in small type, it shows its repository and number, and its kind. Under that, it shows where it stands in plain words. Its colour is its stage. A question or a hand-off is a pill shape: it waits on you. A job node shows its task count as `x/y` when the job keeps a task list.
- A line between two nodes reads as a sentence, from the first node to the second. Hover a line to read it.

| Line | Read it as |
|---|---|
| has the sub-issue | An issue has a sub-issue: a GitHub sub-issue, or a required issue a job filed. |
| led to the follow-up | An issue led to a follow-up issue that a job filed. |
| is being worked on by | An issue is being worked on by a job. |
| continues in | A partly done job continues in the job that runs the rest of its issue. |
| is being redone as | A job is being redone as the job that runs its issue again. |
| branched off into | A job branched off into a separate research or proposal job, made from one of its questions. |
| planned the work of | A proposal's job planned the work of the job that carries out the path a person picked. |
| produced | A job produced its pull request. |
| is waiting on the merge of | A partly done job is waiting on the merge of its pull request. Then the rest of the issue runs. |
| closes | A pull request closes the issue when it merges. |
| needs this first: | An issue needs another issue first: GitHub's "blocked by" link. Only this line says that something blocks. |
| goes in after | A pull request goes in after the open pull request whose branch it is based on. |
| is waiting on your answer to | A job is waiting on your answer to its open question. |
| is waiting on you to take over: | A failed job is waiting on you to take over its hand-off in **Needs a person**. |

**The summary line.** Each tree's header says in one line how its pieces stand. For example: "3 of 4 pieces shipped, 1 being redone, nothing waiting on you." A piece is an issue of the tree. A piece is being redone when a new job runs it again after a failed run.

**Not settled yet.** A node that is not done yet, and every node on the way from the root to it, has a dashed red ring. The lines to it are bold and red. A tree with no such node starts folded when there are other trees. Select its header to open or fold it.

Select a node to read its details: its stage, status, task count, lane, time in stage, pull request and checks, and its lines to other nodes. Select the job's name to open its job page. For a question or a hand-off, the name opens the page of its job.

### The job page

Select a job's name to open its page. The page shows, from the top:

1. **Where it stands**: what was asked, where it stands, and what is next, in plain words, with a one-line summary. Under it, everything that waits on you is pinned, with a link to where you act on it.
2. **Notes**: the notes people sent the job, and **Add note**. See [Send a note to a job](#send-a-note-to-a-job).
3. **Its parts**: the job's own graph. The job is at the left. Each group of parts comes next, and each part is a node in its group. Select a part to open its page.
4. **Timeline**: everything that happened to the job, newest first.
5. **Parts list**: every part as a table. Filter it by group, by status, or by words in the part.

The parts list is everything the job touched or made:

| Group | Parts |
|---|---|
| What was asked | The issue, the follow-up issues the job filed, and rework a person asked for. |
| Work | Each run, the task list, the lane, the time it took, its usage, and the jobs that ran it again or ran its next part. The usage part shows the share of each usage limit its runs used, and how much CPU and memory they used on the machine. It shows after a run ends. |
| Code | The pull request, its checks, its branch, its commits, the number of files it changes, each push of the job, and its merge. While the pull request waits, its place in the merge order: the pull request it goes in after, and why. Before the hopper reads the pull request's commits, the commits of the latest checkpoint show. |
| Outputs | Its artifacts and each revision, its plan or research report, and the help pages and What's new lines its pull request changes. |
| Infra | Its infra plans and their approvals, each credential minted for it with what it may do, drift it found, and a vault grant it asked for. |
| Decisions | Each question and who answered it (a person, or a level such as rules or a model), overrides, and its hand-off. |
| Machines and sandboxes | Each machine it ran on, each checkpoint the hopper took of it, and each Windows sandbox step. When the job ends, also each test database and other container its tests started: its name, image and machine, when it started, and how long it ran. The hopper learns of them only when it removes them at the end of the job. |

Each part shows its status: waiting on you, running, open, done, failed, cancelled, or recorded (a fact, such as a branch or a lane). The page reads the parts again each time the job has a new event, so running parts stay live.

### Send a note to a job

You can give a job more information while it works or waits. For example, give it the address of a server it cannot find.

1. Open the job's page.
2. In **Notes**, write the note.
3. Select **Add note**.

The hopper keeps the note on the job and gives it to the job's agent:

- **A running job** gets the note when its agent ends its turn. The hopper never types into the agent while it works, and never over a dialog. When the turn ends on a question or a plan for you, the note goes in with your answer.
- **A job that waits** (on a question, on its own wait, held, or parked) keeps the note. The job gets it when it goes on. A note does not end the wait.
- **A job that has not started** gets the note in its task.
- **A failed job** gives its notes to the new job when its issue runs again.

Each note shows who sent it, and its state: **queued**, **delivered**, or **carried** to a new job. The timeline shows each step. You need the operator role. A job that ended (finished, cancelled or rejected) takes no note.

### The list

The list is the default mode. It is a table with a row per job, the latest stage change first. A row shows:

- Its stage, its issue, the job's goal, which links to its job page, and its task count.
- Its lane and machine, and how long it is in its stage.
- Its pull request, with its state and checks (for example `open · checks failing`).
- For a partly done job: the pull request that blocks the rest, and what runs after it merges.
- Its last event, on a wide screen only.

Select a row to see its **run graph** under it: the job tree of the job, as the graph shows it. Select a node in it to read its details. Select the row again to close it.

The view keeps your choice of **List** or **Graph** in this browser.

## How to use it

- To see what blocks a big piece of work, open its tree in the graph and follow the red lines from the root.
- To find the work that waits on you, read each tree's summary line, or look for the nodes that say **Waiting on you**. Then open the **Questions** or **Needs a person** section, or the job's page.
- To see one repository only, select it in **Repository**. The counts then show that repository only.
- To check partly done work, select the **Part shipped** count and open each pull request it names.
- To see everything one job did, open its page and read its parts list.

The view updates live. A job that changes stage moves with no reload.

## Which jobs it shows

- Every job in the queue: waiting, running, waiting on a person, parked, and the jobs that ended in the last 24 hours.
- Every finished job whose pull request is still open, also when it ended earlier.
- The jobs that these came from: the run before, the job a fork came from, the proposal a job carries out.
- Every job with an open question or an open hand-off, also when it ended earlier.
- The issues that jobs filed, and the sub-issues, the blocking issues and the closing pull requests the hopper read for the issue graph.

## For agents: the API

`GET /api/jobs/graph` gives the same data as the view: `nodes` (each with its `label`, its `stageText` in plain words, and `waitsOnYou`), typed `edges`, `trees` (each with its `root`, its `summary` line, and the nodes not settled yet, `blocking`) and `stages` (how many jobs are in each stage). `GET /api/jobs/<id>/notes` gives a job's notes, and `POST /ui/api/jobs/<id>/notes` with `{ "text": "..." }` sends one (the scope `jobs:notes`, and a box token). `GET /api/jobs/<id>/bom` gives a job's page: its `header`, `summary`, `parts` (each with its `group`, `status`, and its page `href` or GitHub `url`) and `events`, newest first. An API token needs the scope `jobs:read`. See [The operator CLI and the API](cli-and-api.md) and [API tokens and grants](api-tokens.md).

## Limits and troubleshooting

| Symptom | Cause and fix |
|---|---|
| A job has no `x/y` | The job has not reported a task list yet. |
| A note stays queued | The job waits, or its turn has not ended yet. The note goes in when the job goes on. A job that runs with another executor than herdr-claude or cursor-agent never gets notes. |
| Time in stage starts at the wrong moment | The hopper uses the times the job keeps: created for queued, started for running, the wait or park time for waiting, finished for the rest. A held job counts from when it was created. |
| Two issues are not linked | The graph shows only the links the hopper knows: issues a job filed, and sub-issues, "blocked by" links and closing pull requests from the issue graph. The hopper reads an issue's links when it syncs that issue, so a new link shows after the next sync. An older GitHub Enterprise has no "blocked by" links. |
| Two pull requests are not stacked | The hopper learns a pull request's branches when it follows it. A pull request that no job here opened is not followed, so the graph cannot stack it. |
| An old finished job is missing | The view shows ended jobs for 24 hours, unless their pull request is still open. Open the job from its issue, or from **Events**. |

See also: [Pull requests](pull-requests.md), [Questions and deciders](questions.md), [Lanes](lanes.md).
