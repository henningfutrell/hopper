// The agent update skill (issue #697): what an agent asked to update a container hopper follows, served at
// GET /api/update/skill and printed by `hopper update skill`. Agents tended to pull and recreate the hopper service alone,
// on the old compose file; this says plainly not to, and gives the one update the update notice gives.
import { makeScriptCommand, PUBLISHED_IMAGE, UPDATE_SCRIPT_FILE } from './update-script.ts';

export const UPDATE_SKILL = `# Update a container hopper

Follow these steps when you update a hopper that runs in containers (its compose.yaml, with Podman or Docker).
Do them in order. Do not do the update another way.

## Rules

- **Always use the compose file of the image you update to.** Every hopper image carries the compose.yaml of its
  commit. \`hopper update\` puts it in and keeps the old one as \`compose.yaml.bak-<commit>\`.
- **Never recreate only the hopper service for an update** (\`compose pull hopper\`, \`compose up -d --no-deps hopper\`).
  A new version can add required services (OpenFGA, the vault) and settings.
  An in-place swap keeps the old compose file, so they never arrive and features fail.
- **Never edit compose.yaml.** Install settings go in \`.env\` (\`HOPPER_IMAGE\`, \`HOPPER_MASTER_KEY\`, \`HOPPER_BIND\`,
  \`HOPPER_PORT\`, \`HOPPER_LAN_NAMES\`, \`HOPPER_PUBLIC_URL\` and the other \`HOPPER_*\` settings) or in
  \`compose.override.yaml\`. The next update replaces compose.yaml whole.
- **Never show the master key.** Do not print \`.env\` or the key. The script reads them; it does not show them.

## Steps

1. Go to the folder that holds the hopper's \`compose.yaml\` and \`.env\`.
2. Find the image to update to: \`${PUBLISHED_IMAGE}:<channel>\`, where the channel is \`dev\`, \`beta\` or \`stable\`
   (the update notice names it; \`HOPPER_IMAGE\` in \`.env\` names the one now). Ask the person when you do not know.
3. Check for running jobs. The update notice says how many a recreate would lose. Wait until none.
4. Make the update script from that image. Podman: \`${makeScriptCommand('podman', `${PUBLISHED_IMAGE}:<channel>`)}\`.
   podman-compose: \`hopper update podman-compose\`. Docker: \`${makeScriptCommand('docker', `${PUBLISHED_IMAGE}:<channel>`)}\`.
5. Read \`${UPDATE_SCRIPT_FILE}\`. Then run it: \`sh ${UPDATE_SCRIPT_FILE}\`.
6. When it stops, read its last line. Fix that cause, then run the script again. The line tells how to go back.
7. Check the result: \`podman compose ps\` (or \`docker compose ps\`) shows postgres, openfga and hopper running;
   the UI opens; Settings → Version names the new commit; and \`GET /api/update/drift\` answers no gaps (the UI shows
   no "stack differs" banner). A gap names what is still missing; the fix is this script again, never a hand edit.

## What the script does

1. Checks \`.env\`: when the running hopper made its master key at this start and \`.env\` lacks \`HOPPER_MASTER_KEY\`, it
   stops: a recreate would lose the key.
2. Backs up the database (\`hopper-backup-<time>.dump\`, \`pg_dump -Fc\`), \`compose.yaml\` and \`.env\`.
3. Pulls the image.
4. Moves the install's own settings from the old compose.yaml to \`.env\`: the bind address, the port, and \`HOPPER_*\`
   settings set in the file. It sets \`HOPPER_IMAGE\` to the image. What \`.env\` cannot hold moves to
   \`compose.override.yaml\` (a service of the install's own with its volumes, a host folder mounted into a service, a key
   the hopper never sets); an existing one is kept as \`compose.override.yaml.bak-<commit>\`, and nothing it has is replaced.
5. Puts in the compose.yaml the image ships with, and shows the change.
6. Pulls the images of the whole stack, and recreates the whole stack.
7. Checks that the hopper and OpenFGA answer.

## Go back

\`cp compose.yaml.bak-<commit> compose.yaml\`, \`cp .env.bak-<commit> .env\`, the same for \`compose.override.yaml\` when
the script wrote one (remove it when it made a new one), then \`podman compose up -d --force-recreate\`.
A store migration that ran keeps the database usable by the build before it. To restore the database itself:
\`podman compose exec -T postgres pg_restore -U hopper -d hopper --clean < hopper-backup-<time>.dump\`.
`;
