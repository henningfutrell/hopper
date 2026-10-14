// The agent update skill (issues #697, #970, #1104): what an agent asked to update a container hopper follows, served at
// GET /api/update/skill and printed by `hopper update skill`. Agents tended to pull and recreate the hopper service alone,
// on the old compose file; this says plainly not to, and gives the one update command the update notice gives.
import { PUBLISHED_IMAGE, pruneCommand, updateCommand } from './update-commands.ts';

const image = `${PUBLISHED_IMAGE}:<channel>`;

export const UPDATE_SKILL = `# Update a container hopper

Follow these steps when you update a hopper that runs in containers (its compose.yaml, with Podman or Docker).
Do not do the update another way.

## Rules

- **Use the one update command.** It runs \`scripts/update.sh\` from the image you update to. It finds the compose tool
  and the compose project (\`hopper\`) that started the stack, backs up the database, puts in the compose.yaml of that
  image with the install's own settings, pulls, recreates every container on the new image, and checks the result.
- **Never recreate only the hopper service for an update** (\`compose pull hopper\`, \`compose up -d --no-deps hopper\`).
  A new version can add required services (OpenFGA, the vault) and settings.
  An in-place swap keeps the old compose file, so they never arrive and features fail.
- **Never edit compose.yaml.** The update replaces it whole. Put your own services, mounts and the settings it does
  not name in \`compose.override.yaml\`.
- **Put no setting and no secret in another file** (issues #894, #970). Compose reads only its compose files. The hopper
  keeps its settings and secrets itself, set in the UI.
- **The master key is required.** The update takes \`HOPPER_MASTER_KEY\` from its environment, or asks for it on the
  terminal. Without it, the update stops before it changes anything: a hopper recreated without it starts limited.
  When the person does not have the key, stop and ask them: the UI shows it until it is saved.
- **An update with no person** (issue #1013): give \`HOPPER_MASTER_KEY\` in the environment of the update command,
  from a secret manager, for example \`export HOPPER_MASTER_KEY="$(pass show hopper/master-key)"\`. Then no step waits
  for a person. The update reads the key from nowhere else: never from the running container, and never from a file.
- **Never show the master key.** Do not print it or write it to a file.
- **Never start the stack with another compose tool** (issue #1063). podman-compose and docker-compose each see only
  the stack they started; the other starts a second stack on the same volumes. The update uses the tool that started
  the stack, and stops when that tool does not see it. Never go around that stop.

## Steps

1. Go to the folder that holds the hopper's \`compose.yaml\`.
2. Find the image to update to: \`${image}\`, where the channel is \`dev\`, \`beta\` or \`stable\`
   (the update notice names it; \`HOPPER_IMAGE\` in compose.yaml names the one now). Ask the person when you do not know.
3. Check for running jobs. The update notice says how many a recreate would lose. Wait until none.
4. Run the update (Docker: \`docker\` in place of \`podman\`):
   \`${updateCommand('podman', image)}\`
5. Read what it says. It ends with \`hopper update: done: …\` and exit 0 when the hopper runs the new image, answers its
   health check, has its master key, and the stack has no drift. Else it says what failed and exits 1. A part of the old
   compose.yaml the new one cannot hold is said too: it goes in \`compose.override.yaml\`. A drift is fixed by the update
   again, never by a hand edit.
6. Optional: remove the image the update replaced: \`${pruneCommand('podman')}\`.

## Go back

Run the update with the image you ran before (\`${PUBLISHED_IMAGE}:sha-<commit>\`; compose.yaml.bak names it). It puts in
that image's compose.yaml.
A store migration that ran keeps the database usable by the build before it. To restore the database itself:
\`podman compose -p hopper exec -T postgres pg_restore -U hopper -d hopper --clean < hopper-backup.dump\`.
`;
