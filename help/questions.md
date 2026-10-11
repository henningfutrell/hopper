# Questions and deciders

When a job asks a question, the hopper tries to answer it without you: first from fixed facts, then up the escalation levels. Each answer a level gives is checked for risk. Only what they must not or cannot decide comes to you, in the Questions view.

## What it is

### How a job asks

A job asks a question in one of these ways:

- Its agent ends a message with a line `HOPPER_QUESTION`. The question says what it needs, then the context, with the options as a numbered list.
- Its agent shows a screen that needs an answer, for example a permission dialog when the executor's `yolo` option is off, or a screen the hopper does not know.

While a job waits on a question, its status is `waiting_answer`. It holds no lane. Its pane and its agent session stay open.

A job that only waits for something outside (a review, a release) does not ask a question. It ends with `HOPPER_WAITING` and shows as on its own wait.

### The escalation ladder

Each question goes through the **question gates**, in this order:

| Step | Who | What it does |
|---|---|---|
| 1 | Fixed answers | Answers with no model: **Yes** to an allowed dialog (edit, create, write or read a file inside the job's work tree), or the answer a person gave before to the same question on the same issue. |
| 2 | Escalation levels, lowest first | Each level answers or escalates to the next level up. A level that fails, times out or replies in the wrong form escalates. It never answers by mistake. |
| 3 | Risk check and guards | Run on every answer. The Decider's risk call checks the answer when it is active, else the risk rules do. A risk, or a guard, sends the question to the owner, whatever level answered. |
| 4 | Owner | You. Above the top level. |

A new hopper has one escalation level, `level-1`. It runs the `claude` CLI on this machine with the model `fable`. You can add, remove, reorder and tune levels in **Settings → Question gates**. A level runs either:

- `claude-cli`: the `claude` CLI on a machine (its `machine` option, or the default escalation machine), or
- `anthropic-api`: the Claude API, with a key from the runtime (`ANTHROPIC_API_KEY` by default).

With no levels, every question goes straight to you.

### Auto-answer

A level's answer goes into the job with no person only when all of these are true:

- Auto-answer is on (the default).
- The level does not escalate.
- The level's confidence meets the threshold (`high` by default).
- The risk check finds no risk in the question and the answer (see "The risk check" below).
- No guard matches: deleting, deploying or publishing, spending money, sending a message, a change of permissions, or work on a machine the blast-radius gate keeps.
- The job is not high priority, or **Hold high-priority questions for me** is off (the default).

When a lower level is below the threshold, the question climbs to the next level. When the top level is below it, the question comes to you.

**Settings → Question gates** shows the confidence each level gave with the answers it did not escalate, over the last 30 days. When most of a level's answers fall below the threshold, the page flags that level: its answers seldom go into a job by themselves.

### The risk check

Each answer a level gives without escalating gets one risk check:

- **The Decider's risk call**, when its decision point "The risk in a question and its answer" is active in **Settings → Decider**. Jev reads the question, the answer and the job's goal. It says how risky they are (none, low or real), of which kinds (credentials, destructive, publish, pay, permissions, CI, data, other), and how sure it is. A real risk, a check below the point's confidence, or a check that fails sends the question to you.
- **The risk rules**, when the risk call is off, in shadow (the default), or the TypeSafe API key is not set. The card then says "Risk checked by keyword rules". In shadow, the Decider's check is recorded next to the rules, and **Settings → Decider** shows where the two disagree.

The guards always hold, whatever the Decider says.

### Risk rules

Risk rules are code, not settings. Nobody can weaken them. A plain negation ("uses no secrets", "secret-free") is no match. They match:

| Rule | Catches |
|---|---|
| `delete` | deleting, removing, dropping, truncating or wiping things |
| `deploy` | deploying, publishing, rolling out or releasing to production |
| `force-push` | force-pushing or hard-resetting git history |
| `spend` | spending money: purchases, payments, billing |
| `credentials` | credentials, secrets, passwords, keys or tokens |
| `send-message` | sending a message, email or post to people outside |

### Jev and the Decider

Jev makes small, bounded choices first, before a model or a person. These are **decider calls**. Each one has a **decision point**:

| Decision point | Jev picks |
|---|---|
| The risk in a question and its answer | how risky a level's answer is, and of which kinds (see "The risk check") |
| A failed job no rule explains | run it again, or hand it to a person |
| How many lanes a machine runs | the lanes, from those the lane rules allow (an admin still applies them) |
| The machine a waiting job goes to | the machine, when more than one can take the job |

Each point has a mode in **Settings → Decider**:

- **Off**: Jev is not asked.
- **Shadow** (the default): Jev's pick is only recorded, next to what was decided.
- **Active**: a pick at or above the point's confidence (85% by default) is applied.

Jev never decides a consequential choice: one that deletes, deploys or publishes, force-pushes, spends money, touches credentials, sends a message, changes permissions, or runs on a gated machine. Its pick is recorded as consequential and not applied. Jev never answers a question: it only checks the risk of a level's answer.

Jev needs your TypeSafe API key. Set it in **Settings → Decider**, or with `hopper typesafe-key set` (it reads the key from standard input). Without a key, Jev is off and every decision is made as before.

## How to use it

### Answer a question

1. Open **Questions**. A question for you shows **For you**. The top line says why it came to you.
2. Read the **Escalation trail**: each level's reply, and its answer if it gave one.
3. Do one of these:
   - Type your answer and select **Send answer**.
   - Select **Use <level>'s answer** to send a level's recommended answer.
   - Select **Close**: the job goes on with its own judgement, or fails.
   - Select **Dismiss**: nothing is typed into the job, and a job still waiting on it is cancelled.

You can also type the answer straight into the job's pane. The hopper sees the agent work again and records the question as answered.

From a terminal:

```sh
hopper question list [--reason <reason>]
hopper question answer <question-id> <text>
hopper question close <question-id>
hopper question dismiss <question-id>
```

### Why a question came to you

| Filter | Sentence on the card |
|---|---|
| Guard | The risk check (the Decider or a risk rule) or a guard held the answer back. |
| Not confident | The top level was not confident enough. |
| No answer | No level gave an answer. |
| Sent up | The top level sent it up to a person. |
| High priority | Its job is high priority. A person answers. |
| Auto-answer off | The levels only recommend. |
| Fork | A fork works on it. Answer now, or wait for its result. |

### Correct an auto-answer

1. Open **Settings → Question history**.
2. Find the auto-answered question and select **Correct**.
3. Type the right answer and select **Send correction**.

The job gets the correction ahead of its next answer. Corrections count in the agreement numbers under **Auto-answer** in **Settings → Question gates**. Use them to tune the threshold.

### Tune the gates

In **Settings → Question gates**:

- **Standing rules**: text given to every escalation level with every question.
- **Escalation levels**: add, remove, reorder, pick each level's model and machine.
- **Default escalation machine**: where a `claude-cli` level with no machine runs when the job's machine cannot run `claude`.
- **Auto-answer**: on or off, and the threshold.

### Research this and Propose this

Some questions need research or a proposal first. On a question card, select **Research this** or **Propose this**, give an optional note, and pick a mode:

- **Fork**: a separate job does the research or the proposal. The first job waits on its question, or is parked. The accepted result answers the question.
- **Switch**: the same job, in its own session, does the research or the proposal first. At **Accept**, you pick what it does next.

A job or an escalation level can suggest a shift. The card then offers it as one click. An admin sets the default mode and which levels may shift a job in the **Phase shifts** settings at the bottom of the Questions view.

### Research reports and proposals

A job can write a document in place of the work:

- A **research report** ends with `HOPPER_RESEARCH_REPORT`. It has Question, Findings, Sources and evidence, Confidence, Open threads and Next step. It shows in **Research**: **Accept**, **Dig deeper** or **Steer**.
- A **proposal** ends with `HOPPER_PROPOSAL`. It has a TL;DR, a Problem, one or more paths, the recommended path, and Context. It shows in **Proposals**: **Continue with selected**, **Ask for more paths**, **Steer** or **Reject all**. Each selected path continues as its own follow-on job.

Ask for one with the label `hopper:research` or `hopper:proposal`, a `Research` or `Proposal` heading in the issue body, or **Research** or **Propose** on a job in the Queue that has not started. An admin can have escalation levels review these before you, in the settings at the bottom of each view.

## What the hopper does for you

- It tells you of a question that reaches you, through your notifiers and webhooks, and again every 15 minutes while it waits (`HOPPER_HUMAN_RENOTIFY_MS`).
- It parks the job when its question waits on you too long (30 minutes by default, **Settings → Auto-park**). The lane is free again. A question a risk rule or the guard sent to you never parks its job.
- It reuses your answer when the same question comes again on the same issue.
- It keeps every handled question in **Settings → Question history**, in its own database. It never sends them to GitHub.

## Limits and troubleshooting

| Symptom | Cause and fix |
|---|---|
| The job failed with `question unanswered` | Nobody answered within 24 hours (`HOPPER_HUMAN_TIMEOUT_MS`). Run it again. A parked job's question never expires. |
| A question shows `lapsed` | A dialog's countdown ran out, and Claude denied it by itself. The job went on. |
| Every question comes to you | Auto-answer is off, there are no levels, or the levels cannot run. Check **Settings → Question gates**. |
| A level never answers | Its `claude` is not signed in on its machine, or its API key is not set. The level escalates. |
| Jev applies nothing | The decision point is in shadow, the TypeSafe key is not set, or the pick is below the threshold. |
| You cannot save the TypeSafe key | OpenFGA is not reachable. Save needs Access. |

A failed job that the hopper stopped trying to fix shows in **Failures → Needs a person**. That is a hand-off, not a question.

See also: [Intake](intake.md), [Pull requests](pull-requests.md), [Lanes](lanes.md), [CLI and API](cli-and-api.md).
