# Artifacts

An artifact is a live page that a job makes to show its work: a flowchart you can click, a chart you can filter, or another view of the result. This page tells you how to find, change, share and stop sharing artifacts, and what the hopper does to keep them safe.

## What an artifact is

A running job puts a file on the hopper. The hopper keeps it as an **artifact** of the job's user, with its job and issue.

- Each artifact has a **title** and a one-line **summary**. Lists, the job card and share previews show them.
- Every change makes a new **revision**. The artifact's id and links stay the same and show the latest revision. Older revisions stay readable.
- The **owner** is the user whose job made it. Nobody else sees it until the owner shares it.

| Kind | Files | How it shows |
|---|---|---|
| html | `.html`, `.htm` | A page in a sandbox. Its own scripts run. |
| svg | `.svg` | A drawing, in the same sandbox as HTML. |
| image | `.png`, `.jpg`, `.jpeg`, `.gif`, `.webp` | The image. |
| pdf | `.pdf` | The browser's PDF viewer. |
| csv | `.csv` | A table. |
| markdown | `.md`, `.markdown` | Formatted text. Nothing in it runs. |
| json, text | `.json`, `.txt`, `.log` | Plain text. |
| file | any other | A download only. |

## Find your artifacts

- **Artifacts** in the menu lists your artifacts, newest first, and below them **Shared with you**. Select one to open it.
- A job's card shows a link to each artifact the job made.
- A proposal or a research report that names an artifact's URL on a line shows the artifact in place.
- The link of an artifact is `<hopper address>/#artifacts/<id>`. Add `/<n>` for revision `n`.

In an open artifact:

| Button | What it does |
|---|---|
| **Open** | Opens the content in a new tab. |
| **Download** | Saves the file. |
| **Copy its URL** | Copies the artifact's link. |
| **Copy a link to revision N** | Copies the link to the revision you have open. |
| **Remove** | Removes the artifact, every revision and every share. You confirm first. |

## Revisions

Under **Revisions**, each revision shows its number, time, who made it, size and note.

- **Restore** makes an old revision the latest, as a new revision. Nothing is overwritten.
- The pin icon **pins** a revision. The retention keeps a pinned revision, and its artifact.
- The link icon copies a link to that revision.

When a job puts a file that looks like one of your artifacts (the same file name, the same title start, or the same issue reference), the hopper keeps it and tells the job to add a revision instead. So one piece of work stays one artifact.

### Merge artifacts

1. Open the artifact you want to keep.
2. Under **Merge into this**, pick another of your artifacts.
3. Select **Merge**.

The revisions of the other artifact are added, oldest first. Then the other artifact is removed.

## Share an artifact

You see your own artifacts. To let someone else see one, share it. Under **Shared with**:

- **Share with a user of this hopper**: type the user's name and select **Share**. The artifact shows under **Shared with you** for them.
- **Make a public link**: optionally type the hours, then select **Make a public link**. Anybody with the link sees the artifact until the link expires or you revoke it. Copy the link at once: the hopper shows it only one time and keeps only its hash.
- **Revoke** ends a share. The user stops seeing the artifact, or the link stops working, at once.

A public link opens a page that fits a phone, with the title and summary on top and the content below. The link follows the latest revision. A link that ends in `?revision=N` stays on that revision.

The access service (OpenFGA) decides each view by another user or a public link. When it does not run, only the owner sees the artifact. A banner on every page says when the access service is missing.

## Settings → Artifacts

An admin sets these per user in **Settings → Artifacts**:

| Setting | Default |
|---|---|
| **One artifact, at most** | 10 MB |
| **All of this user's, at most** | 500 MB, all revisions together |
| **Kept for** | 30 days. Older revisions go first. A pinned revision stays. |
| **Public links work** | On. Off stops every public link at once and makes no new one. |
| **A public link works for** | 24 hours, unless its maker says |
| **A public link works at most** | 168 hours (7 days) |
| **Link base** | Empty |

**Link base** is the address that the links a job reports, and notifications, point to. It must be an address this hopper answers to. Empty means: the hopper's public URL, else a LAN name that is an IP address or ends in `.local`. In the UI, links use the address you opened the hopper at.

## What the hopper does for you

- **A sandbox for every page.** An HTML or SVG artifact runs with no access to the hopper, your session or your cookies. It can call no address and load nothing from the internet, so it cannot send your data out. It can load only what is in the file, and the libraries the hopper serves: Mermaid, Chart.js and D3.
- **Short-lived content links.** The content loads from a signed address that works for one hour, for one viewer. The hopper checks it, and the share, at each load. The signing key is kept in the vault, so open links keep working after a restart.
- **Secrets masked.** Before it keeps a text artifact, the hopper masks every GitHub token in it.
- **A notice for each new artifact.** The Grok Bot routine notifier, when you set it up, sends one notice with the artifact's link. A webhook can subscribe to the `artifact.created` event.
- **Clean-up.** Each hour the hopper removes revisions and artifacts older than the retention, except pinned ones.

## An issue whose result is an artifact

Some work has no code change: a report, a diagram, a study. Put this line in the issue body:

```text
Deliverable: artifact
```

The job then makes the artifact and posts its link on the issue as a comment. The job is done when an artifact it made is linked to the issue and that comment is there. No pull request is needed.

## How a job makes an artifact

A job uses the `hopper-artifact` helper, `sh "$HOPPER_ARTIFACT"`. It reads the full help when it loads the `artifacts` skill.

| Command | What it does |
|---|---|
| `put FILE --title T --summary S` | Keep FILE as a new artifact. Prints its id and URL. |
| `put FILE --to ID --note TEXT` | Keep FILE as the next revision of artifact ID. |
| `put FILE --new` | Keep it as a new artifact, also when it looks like an old one. |
| `list [--all] [--markdown]` | This job's artifacts; `--all`: every job's of the user. |
| `get ID [--out FILE]` | Its details, or its content into FILE. |
| `revisions ID`, `restore ID N` | List revisions; make revision N the latest. |
| `share ID --owner` | Post the artifact's link on the job's issue. |
| `share ID --user NAME` | Share with another user. |
| `share ID --public [--hours N]` | Make a public link, when the user allows them. |
| `share ID --revoke SHARE` | End a share. |
| `rm ID` | Remove it. |

Add `--json` for JSON. The exit code is 0 for done, 1 for a refusal with the reason, 2 for a bad call, and 3 when the hopper cannot be reached. A job can use the helper only while it runs.

## Artifacts from the command line

The operator command line works on the same artifacts. Each command prints JSON. See [Command line and API](cli-and-api.md).

| Command | What it does |
|---|---|
| `hopper artifact list` | Your artifacts, newest first, with shares and links. |
| `hopper artifact get <id>` | One artifact. |
| `hopper artifact share <id> --with <name>` | Share with another user. |
| `hopper artifact share <id> --public [--hours <n>]` | Make a public link. It is printed one time. |
| `hopper artifact revoke <id> <share>` | End a share. |
| `hopper artifact revisions <id>` | Its revisions, newest first. |
| `hopper artifact restore <id> <n>` | Make revision n the latest. |
| `hopper artifact revise <id> --file <f> [--note <text>]` | Add a revision from a file. |
| `hopper artifact revise <id> --from <id2> [--note <text>]` | Add a revision with the latest content of another artifact. |
| `hopper artifact merge <into> <from>...` | Merge artifacts into one. |
| `hopper artifact rm <id>` | Remove it. |

## Limits and troubleshooting

| You see | Why, and what to do |
|---|---|
| A put is refused as too large | The file is past **One artifact, at most**, or the user's artifacts are past **All of this user's, at most**. Remove old artifacts, or ask an admin to raise the limit. |
| `public links are turned off for this user` | An admin turns them on in **Settings → Artifacts**. |
| The public link says it does not work | It expired, it was revoked, public links were turned off, or the access service does not run. |
| A shared artifact does not show for the other user | The access service (OpenFGA) must run. Check the banner on the hopper's pages. |
| `this content URL does not work` | The signed address is older than one hour. Open the artifact again. |
| An HTML artifact shows nothing, or a chart is empty | The page tried to load something from outside. Put every script, style, image and font in the file, or use a library the hopper serves. |
| A job is told the artifact `has no visual` | An HTML artifact with no `<svg>`, `<canvas>`, `<img>` or `<script>` is kept with a warning. Put prose in the issue comment. |
| An old revision is gone | The retention removed it. Pin a revision to keep it. |

Only an operator or an admin shares, revokes, restores, pins, merges or removes artifacts. A viewer only reads them.
