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
- **Never edit compose.yaml.** The next update replaces it whole. The update writes the install's own settings into it as
  the defaults of its variables. Put your own services, mounts and the settings it does not name in
  \`compose.override.yaml\`.
- **Never write a .env file, and never put a secret in a file** (issue #894). Compose reads no \`.env\`. The hopper keeps
  its settings and secrets itself, set in the UI. The master key (\`HOPPER_MASTER_KEY\`) is given at launch, in the
  environment of the compose command: \`read -rs HOPPER_MASTER_KEY && export HOPPER_MASTER_KEY\`.
- **Never show the master key.** Do not print it, an old \`.env\` or its backups. The script reads the key; it does not
  show it.

## Steps

1. Go to the folder that holds the hopper's \`compose.yaml\`.
2. Find the image to update to: \`${PUBLISHED_IMAGE}:<channel>\`, where the channel is \`dev\`, \`beta\` or \`stable\`
   (the update notice names it; \`HOPPER_IMAGE\` in compose.yaml names the one now). Ask the person when you do not know.
3. Check for running jobs. The update notice says how many a recreate would lose. Wait until none.
4. Make the update script from that image. Podman: \`${makeScriptCommand('podman', `${PUBLISHED_IMAGE}:<channel>`)}\`.
   podman-compose: \`hopper update podman-compose\`. Docker: \`${makeScriptCommand('docker', `${PUBLISHED_IMAGE}:<channel>`)}\`.
5. Read \`${UPDATE_SCRIPT_FILE}\`. Then run it: \`sh ${UPDATE_SCRIPT_FILE}\`.
6. When it stops, read its last line. Fix that cause, then run the script again. When the new stack did not start or
   did not answer, the script put the old stack back by itself: the line says so.
7. Check the result: \`podman compose ps\` (or \`docker compose ps\`) shows postgres, openfga, tunnel, solr and hopper running;
   the UI opens; Settings → Version names the new commit; and \`GET /api/update/drift\` answers no gaps (the UI shows
   no "stack differs" banner). A gap names what is still missing; the fix is this script again, never a hand edit.
8. When the script says an old \`.env\` was removed, tell the person: its backup \`.env.bak-<commit>\` holds the master
   key. They save the key in a password manager, then delete the backup.

## What the script does

1. Reads the launch settings: the master key and the other secrets, from its own environment, an old \`.env\` (once,
   to move it), or the running hopper. When the running hopper made its master key at this start and none of them
   gives it, it stops: a recreate would lose the key.
2. Backs up the database (\`hopper-backup-<time>.dump\`, \`pg_dump -Fc\`), \`compose.yaml\`, \`compose.override.yaml\`
   and an old \`.env\`.
3. Pulls the image.
4. Makes the new compose.yaml: the one the image ships with, with the install's own settings (the bind address, the
   port, \`HOPPER_*\` settings, \`COMPOSE_PROFILES\`) as the defaults of its variables, and \`HOPPER_IMAGE\` the image.
   What it cannot name moves to \`compose.override.yaml\` (a service of the install's own with its volumes, a host folder
   mounted into a service, a key the hopper never sets, a setting it does not name, the install's own project name);
   nothing that file has is replaced. A secret goes in no file: only its name, given at launch. It shows both changes.
5. Pulls the images of the whole stack.
6. Stops the old stack.
7. Puts the new files in, removes the old \`.env\`, and starts the whole stack. A service new in the release is made,
   not recreated.
8. Checks that the hopper and OpenFGA answer. When step 7 or 8 fails, it stops the new stack, puts the old files back
   and starts the old stack again.

## Go back by hand

\`podman compose down\`, then \`cp compose.yaml.bak-<commit> compose.yaml\`, the same for \`compose.override.yaml\` when
the script wrote one (remove it when it made a new one) and for \`.env\` when it moved one, then give the master key at
launch and run \`podman compose up -d\`.
A store migration that ran keeps the database usable by the build before it. To restore the database itself:
\`podman compose exec -T postgres pg_restore -U hopper -d hopper --clean < hopper-backup-<time>.dump\`.
`;
