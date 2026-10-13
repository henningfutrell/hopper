// The agent update skill (issues #697, #970): what an agent asked to update a container hopper follows, served at
// GET /api/update/skill and printed by `hopper update skill`. Agents tended to pull and recreate the hopper service alone,
// on the old compose file; this says plainly not to, and gives the plain compose commands the update notice gives.
import { PODMAN_PROVIDER_HINT, PUBLISHED_IMAGE, updateCommands } from './update-commands.ts';

const podman = updateCommands('podman', `${PUBLISHED_IMAGE}:<channel>`);
const docker = updateCommands('docker', `${PUBLISHED_IMAGE}:<channel>`);

export const UPDATE_SKILL = `# Update a container hopper

Follow these steps when you update a hopper that runs in containers (its compose.yaml, with Podman or Docker).
Do them in order. Do not do the update another way.

## Rules

- **Always use the compose file of the image you update to.** Every hopper image carries the compose.yaml of its
  commit. \`hopper update carry\` makes it, with the install's own settings as the defaults of its variables.
- **Never recreate only the hopper service for an update** (\`compose pull hopper\`, \`compose up -d --no-deps hopper\`).
  A new version can add required services (OpenFGA, the vault) and settings.
  An in-place swap keeps the old compose file, so they never arrive and features fail.
- **Never edit compose.yaml.** The next update replaces it whole. Put your own services, mounts and the settings it does
  not name in \`compose.override.yaml\`.
- **Put no setting and no secret in another file** (issues #894, #970). Compose reads only its compose files. The hopper
  keeps its settings and secrets itself, set in the UI.
- **The master key is required.** Give \`HOPPER_MASTER_KEY\` at launch, in the environment of the compose command:
  \`${podman.give}\`. The last command stops before compose runs when it is not given: a hopper recreated without it
  starts limited. When the person does not have the key, stop and ask them: the UI shows it until it is saved.
- **An update with no person** (issue #1013): when \`HOPPER_MASTER_KEY\` is already in the environment of the compose
  command (a secret manager gave it, for example \`export HOPPER_MASTER_KEY="$(pass show hopper/master-key)"\`),
  skip the step that gives it. No other step waits for a person. The update reads the key from nowhere else:
  never from the running container, and never from a file (issue #970).
- **Never show the master key.** Do not print it or write it to a file.

## Steps

1. Go to the folder that holds the hopper's \`compose.yaml\`.
2. Find the image to update to: \`${PUBLISHED_IMAGE}:<channel>\`, where the channel is \`dev\`, \`beta\` or \`stable\`
   (the update notice names it; \`HOPPER_IMAGE\` in compose.yaml names the one now). Ask the person when you do not know.
3. Check for running jobs. The update notice says how many a recreate would lose. Wait until none.
4. Run these commands, one at a time (Podman; for Docker, \`docker\` in place of \`podman\`; for podman-compose,
   \`podman-compose\` in place of \`podman compose\`):
   - Give the master key: \`${podman.give}\`.
   - Back up the database: \`${podman.backup}\`.
   - Make the new compose.yaml: \`${podman.carry}\`.
     Read what it says: a part of the old compose.yaml the new one cannot hold goes in \`compose.override.yaml\`.
   - Read the change: \`${podman.diff}\`.
   - Put it in: \`${podman.swap}\`.
   - Pull and start the whole stack: \`${podman.up}\`.
   - Docker: \`${docker.up}\`.
5. Podman: when \`podman compose ps\` shows no hopper, but \`podman-compose ps\` does, give \`${PODMAN_PROVIDER_HINT}\`
   and run the last command again.
6. Check the result: \`podman compose ps\` (or \`docker compose ps\`) shows postgres, openfga, tunnel, cloudflared, solr and hopper running;
   the UI opens; Settings → Version names the new commit; and \`podman compose exec hopper hopper update drift\` exits 0
   with no gaps (exit 3: a gap is open; the UI shows the same in a "stack differs" banner). A gap names what is still missing; the fix is these commands again, never a hand edit.
7. Optional: remove the image the update replaced: \`${podman.prune}\`.

## Go back by hand

\`podman compose down\`, then \`cp compose.yaml.bak compose.yaml\`, then give the master key at launch and run
\`podman compose up -d\`.
A store migration that ran keeps the database usable by the build before it. To restore the database itself:
\`podman compose exec -T postgres pg_restore -U hopper -d hopper --clean < hopper-backup.dump\`.
`;
