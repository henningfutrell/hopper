// The agent update skill (issues #697, #970, #1104): what an agent asked to update a container hopper follows, served at
// GET /api/update/skill and printed by `hopper update skill`. Agents tended to pull and recreate the hopper service alone,
// on the old compose file; this says plainly not to, and gives the one update command the update notice gives.
// A cluster install (issue #1285) has its own skill: `helm upgrade` of its release, with no compose step.
import type { ClusterInstall } from '../domain/types.ts';
import { DEFAULT_RELEASE, HELM_CHART, helmUpgradeCommand } from './cluster.ts';
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
   health check, has its master key, OpenFGA's tables are up to date, and the stack has no drift. Else it says what
   failed and exits 1. A part of the old compose.yaml the new one cannot hold is said too: it goes in
   \`compose.override.yaml\`. A drift is fixed by the update again, never by a hand edit.
   A line \`hopper update: conflict: <file>: services.<service>.<key>: …\` means \`compose.override.yaml\` conflicts with the
   new compose.yaml (issue #1246). The update stopped before it changed anything. When the override entry only repeats what
   compose.yaml gives, run the update again with \`HOPPER_UPDATE_FIX_OVERRIDE=1\`: it removes the entry and keeps a backup.
   Else fix the override as the line says, or ask the person.
6. Optional: remove the image the update replaced: \`${pruneCommand('podman')}\`.

## Go back

Run the update with the image you ran before (\`${PUBLISHED_IMAGE}:sha-<commit>\`; compose.yaml.bak names it). It puts in
that image's compose.yaml.
A store migration that ran keeps the database usable by the build before it. To restore the database itself:
\`podman compose -p hopper exec -T postgres pg_restore -U hopper -d hopper --clean < hopper-backup.dump\`.
`;

const cluster = { release: DEFAULT_RELEASE, namespace: '<namespace>', chart: HELM_CHART };

/** The agent update skill of a cluster install (issue #1285): `helm upgrade` of the release, nothing else. */
export const CLUSTER_UPDATE_SKILL = `# Update a hopper on Kubernetes

Follow these steps when you update a hopper that runs on Kubernetes, as a Helm release (a cluster install).
Do not do the update another way.

## Rules

- **Use \`helm upgrade\` of the release.** It sets the image tag of the release and keeps every other value
  (\`--reuse-values\`). Kubernetes then rolls out the new image.
- **Set a pinned tag**: \`sha-<commit>\`, the build of the update. A channel tag (\`dev\`, \`beta\`, \`stable\`) does not
  change between two builds, so the release does not roll out.
- **Never edit the hopper's Deployment, Pods or Secrets by hand** (\`kubectl edit\`, \`kubectl set image\`). Helm then no
  longer knows what runs, and the next upgrade undoes the change.
- **Put no setting and no secret in a values file.** The hopper keeps its settings and secrets itself, set in the UI.
  The master key comes from the Secret the release names, never from a value.
- **Never show the master key.** Do not print it or write it to a file.

## Steps

1. Find the release and its namespace: \`helm list --all-namespaces\`. The release is \`${DEFAULT_RELEASE}\` unless
   \`HOPPER_HELM_RELEASE\` names another.
2. Find the commit to update to. The update notice names it, and it gives the whole command. Ask the person when you do
   not know.
3. Check for running jobs. The update notice says how many a restart would lose. Wait until none.
4. Run the update:
   \`${helmUpgradeCommand(cluster, 'sha-<commit>')}\`
5. Wait for the rollout: \`kubectl rollout status deployment/${DEFAULT_RELEASE} --namespace <namespace>\`.
6. Check the result: the update notice says "Up to date", and no drift banner shows.

## Go back

Run \`helm rollback ${DEFAULT_RELEASE} --namespace <namespace>\`. A store migration that ran keeps the database usable by
the build before it.
`;

/** The agent update skill of this hopper: the cluster one for a cluster install, else the compose one. */
export const updateSkill = (c: ClusterInstall | undefined): string => (c ? CLUSTER_UPDATE_SKILL : UPDATE_SKILL);
