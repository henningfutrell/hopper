# Research reports and proposals

A job can write a document in place of the work. A **research report** looks into a question and reports back. A **proposal** says what the job would do, and how. You read it and decide.

## Research reports

### Ask for research

- Give the issue the label `hopper:research`, or
- put a `## Research` heading in the issue body (any heading level; the word alone in the text does not count), or
- select **Research** on a job in the Queue that has not started yet, and confirm. The job then shows *research report asked*.

An issue with both a Research and a Proposal heading (or both labels) is researched first, then proposed, in one job and one session.

### The report

The agent writes six parts: **Question**, **Findings**, **Sources and evidence**, **Confidence**, **Open threads** and **Next step**. Its message ends with a line `HOPPER_RESEARCH_REPORT`. A part it left out shows as *Left out* on the card. The report comes to the **Research** view. While it waits, the job holds no lane and keeps its agent session. You can park it.

### What you can do with a report

| Button | Note | Then |
|---|---|---|
| **Accept** | optional | See "After Accept". |
| **Dig deeper** | optional | The job writes the next version. Tick open threads under *Dig deeper on* to name them. None ticked means the whole report. |
| **Steer** | required: the new direction | The job writes the next version, in the direction you gave. |

There is no Reject for research. Each round is a new version in the same job and session. Earlier versions are kept, folded under *earlier versions*. The *Review trail* lists every decision.

### After Accept

- **A job that was asked for research** (label, heading or the Research button) ends as finished. If it was asked for a proposal too, it writes the proposal next, in the same session.
- **A job that researched as part of a bigger task** (its issue asked for research along the way) does not end. It goes back in the queue in the same session. It is told that the report was accepted, with your notes. It goes on with the rest of the task, or finishes if nothing more is asked.
- **A job you switched into research** from a question: you pick what it does next (see "Phase shifts").

### Review before you see it

By default a report comes straight to you. An admin can have escalation levels review it first, the same way as proposals: **Research settings**, at the bottom of the Research view. "Reviewer levels and escalation" tells what the settings do.

> **Not built yet:** research run as an orchestrated loop — a workhorse model that keeps a task list, worker subagents that do the tasks, and a frontier model that adds tasks or signs off before the report reaches you. Today the job's own agent session researches and writes each report. The reviewer levels are the only review before you.

## Proposals

### Ask for a proposal

- Give the issue the label `hopper:proposal`, or
- put a `## Proposal` heading in the issue body, or
- select **Propose** on a job in the Queue that has not started yet, and confirm. The job then shows *proposal asked*.

The agent writes a **TL;DR**, the **Problem**, one or more paths (each with **Summary**, **Security**, **Effort**, **Risk**, **Friction** and **Creates**), the **Recommended** path, and **Context** (what it read and relied on). Its message ends with a line `HOPPER_PROPOSAL`. While it waits, the job holds no lane, keeps its session, and can be parked.

### Reviewer levels and escalation

An admin sets these in **Proposals settings**, at the bottom of the Proposals view. They apply at once.

- **Reviewer levels**: which of your escalation levels review, lowest first. Each level uses the model it has in **Settings → Question gates**. None (the default): a person reviews.
- **Who may accept**: only a person (default), or the top reviewer level too.
- **Times the levels may send one back**: 0 to 5, default 1.

Each level approves (it goes up to the next level), asks for changes (it goes back to the job with the level's notes), or escalates. A level that fails, times out or answers wrongly escalates. It never decides. When the levels sent it back as often as allowed, it comes to you. Every verdict and its notes stay on the review trail.

### What you can do with a proposal

| Button | Note | Then |
|---|---|---|
| **Continue with selected** | optional, one per path | Signed off: who, when, which version. Each selected path continues as its own follow-on job. |
| **Ask for more paths** | optional | The job writes the next version with more paths. It is reviewed from the first level again. |
| **Steer** | required: what to change | The job writes the next version. It is reviewed from the first level again. |
| **Reject all** | required: why | Asks you to confirm. The job ends. |

You can decide at any stage, also while a reviewer level still has it. A viewer sees the card but cannot decide. An operator or an admin can.

### What an accepted proposal leads to

The proposal stays linked to its job and issue, and the job ends. Each path you select continues as its own follow-on job, with the parent's spec and your note. The exception is a job you switched into a proposal from a question: it goes on as you picked at Accept, and a rejected proposal sends it back to its work (see "Phase shifts").

## Where proposals and research show

Proposals and research are sections of their own, beside questions. The menu lists them in this order: **Questions**, **Proposals**, **Research**, **Logins**, **Failures**.

- Each badge counts the items that wait on a person, seen or not, until they are decided. A ⇈ mark on a badge means that one of them is high priority. Those are listed first.
- Below the open items: *Earlier proposals* or *Earlier research reports*, then, for an admin, the section's settings.
- A card says where it came from when a question started it: *Forked from a question of …* or *Its job switched from its question to write this*.
- An open item whose job ended or was cancelled is cancelled with it.
- Webhooks get `proposal.*` and `research.*` events.

### Parked items

- **Park** on a card sets the item aside. It leaves its section and waits under **Parked**, with who parked it and why. It gets no review and no decision until you pick it up.
- **Pick up** puts it back where it was, at the same version and stage.
- A running job can also park an item, or pick it up, with the `park` skill. A job parks only an item whose job waits on it. It never takes a decision. It picks up only an item a job parked: an item you parked stays parked until you pick it up.

## Phase shifts

Sometimes a job's question cannot be answered until someone looks into it. A phase shift sends that part to research or a proposal. A job's **phase** is work, research or proposal. When it is not work, a small tag beside the job's title says `research`, `proposal`, or `fork: research` for a forked one.

### From a question card

Select **Research this** or **Propose this**. Give an optional note that names the aspect, choose *How*, then select **Research** or **Propose**:

| How | What happens |
|---|---|
| **Fork** | A separate job does the research or the proposal. The first job waits on its question (it holds no lane, with no time-out), or is parked, as the settings say. An accepted result answers the question. A rejected one opens the question again for a person. The fork has no issue of its own and takes its parent's priority. |
| **Switch** | This job, in its own session, does the research or the proposal first. At Accept you pick: it *goes back to the work, with it as context* (the default), it *ends here*, or, for research, it *writes a proposal next, in the same session*. |

A job can suggest research first itself (a line `Suggest: research — <the aspect>` before its question). An escalation level can suggest it too. The card then shows *the job suggests research first*, with a one-click button such as **Research (fork)**.

### Phase shift settings

An admin sets these in **Phase shifts**, at the bottom of the Questions view:

- The default mode of Research this and Propose this: Fork (default) or Switch.
- While its fork runs, the job waits on its question (default), or is parked where its executor can park.
- Which escalation levels may shift a job themselves when they suggest it. None (default): only a person.

A shift works only on an open question whose job still waits on it, and only where the job's executor can do research and proposals. Otherwise the card says why not.
