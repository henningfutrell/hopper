// The storage prune (issue #2494, design.md "Hopper's own disk use" → "Part 8"), run for real: the survey lists the exited
// containers of each container runtime, and the prune removes the old ones the hopper chose, the anonymous volumes no
// container uses, and the images no container uses, with a fake runtime first on PATH that keeps its state in files.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readSurvey, surveyArgv } from '../../src/client/reap.ts';
import { pruneArgv, pruneArgvOf, readPrune } from '../../src/client/prune.ts';

const hex = (c: string): string => c.repeat(64);
const OLD = hex('a'), STACK = hex('b'), RUNNING = hex('c'), BOX = hex('d');
const ANON = hex('1'), NAMED = 'seat-home', JOBVOL = hex('2'), USED = hex('3');

// $FAKE/containers: `<id> <status> <finished> <size> <label keys, comma>`; $FAKE/volumes: `<name> <anonymous> <label keys,
// comma> <dangling>`; $FAKE/images: `<id> <size>` and $FAKE/pruned the ids its image prune removes. Each call goes to $FAKE/calls.
const FAKE_RUNTIME = `#!/bin/sh
echo "$*" >> "$FAKE/calls"
row() { awk -v i="$2" '$1 == i' "$FAKE/$1"; }
keys() { [ "$1" = - ] || printf "%s" "$1" | tr "," " "; }
case "$1 $2" in
  "ps -aq") case "$*" in *status=exited*) awk '$2 == "exited" { print substr($1, 1, 12) }' "$FAKE/containers";; esac;;
  "container inspect")
    case "$*" in
      *SizeRw*) row containers "$6" | awk '{ print $4 }';;
      *State.Status*) set -- $(row containers "$5"); [ -n "$1" ] && printf "%s|%s \\n" "$2" "$(keys "$5")";;
      *FinishedAt*) shift 4; for s in "$@"; do awk -v s="$s" 'index($1, s) == 1' "$FAKE/containers" | while read -r i st f z k; do printf "%s|%s|%s \\n" "$i" "$f" "$(keys "$k")"; done; done;;
    esac;;
  "rm -v") grep -v "^$3 " "$FAKE/containers" > "$FAKE/c.next"; mv "$FAKE/c.next" "$FAKE/containers";;
  "volume ls") case "$*" in *dangling=true*) awk '$4 == "yes" { print $1 }' "$FAKE/volumes";; esac;;
  "volume inspect") set -- $(row volumes "$5"); [ -n "$1" ] && printf "%s|%s |%s\\n" "$2" "$(keys "$3")" "$FAKE/mnt/$1";;
  "volume rm") grep -v "^$3 " "$FAKE/volumes" > "$FAKE/v.next"; mv "$FAKE/v.next" "$FAKE/volumes";;
  "image ls") awk '{ print "sha256:" $1 "|" $2 }' "$FAKE/images";;
  "image prune") while read -r i; do echo "untagged: x:latest"; echo "deleted: sha256:$i"; done < "$FAKE/pruned";;
esac
exit 0
`;

let fake: string;
beforeEach(() => {
  fake = mkdtempSync(join(tmpdir(), 'hopper-prune-'));
  writeFileSync(join(fake, 'podman'), FAKE_RUNTIME, { mode: 0o755 });
  // A second runtime that answers nothing, so a real docker on this machine is never asked.
  writeFileSync(join(fake, 'docker'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  writeFileSync(join(fake, 'calls'), '');
  writeFileSync(join(fake, 'containers'), [
    `${OLD} exited 2026-09-01T00:00:00Z 4096 -`,
    `${STACK} exited 2026-09-01T00:00:00Z 10 com.docker.compose.project`,
    `${RUNNING} running 0001-01-01T00:00:00Z 10 -`,
    `${BOX} exited 2026-09-01T00:00:00Z 10 io.hopper.box,other`,
  ].join('\n') + '\n');
  writeFileSync(join(fake, 'volumes'), [`${ANON} true - yes`, `${NAMED} false - yes`, `${JOBVOL} true hopper.job yes`, `${USED} true - no`].join('\n') + '\n');
  mkdirSync(join(fake, 'mnt', ANON), { recursive: true });
  writeFileSync(join(fake, 'mnt', ANON, 'blob'), Buffer.alloc(64 * 1024, 1));
  writeFileSync(join(fake, 'images'), `${hex('e')} 1.5GB\n${hex('f')} 20MB\n`);
  writeFileSync(join(fake, 'pruned'), `${hex('e')}\n`);
});
afterEach(() => rmSync(fake, { recursive: true, force: true }));

const env = (): NodeJS.ProcessEnv => ({ ...process.env, FAKE: fake, HOME: fake, XDG_RUNTIME_DIR: fake, PATH: `${fake}${delimiter}${process.env.PATH ?? ''}` });
const run = (argv: string[]): string => {
  const [file, ...args] = argv;
  return execFileSync(file!, args, { encoding: 'utf8', env: env(), timeout: 30000 });
};
const lines = (f: string): string[] => readFileSync(join(fake, f), 'utf8').split('\n').filter(Boolean);

describe('the survey lists the exited containers (issue #2494)', () => {
  it('names each exited container of each runtime, with when it stopped and its label keys', () => {
    expect(readSurvey(run(surveyArgv([])))?.exited).toEqual([
      { runtime: 'podman', id: OLD, finishedAt: '2026-09-01T00:00:00Z', labels: [] },
      { runtime: 'podman', id: STACK, finishedAt: '2026-09-01T00:00:00Z', labels: ['com.docker.compose.project'] },
      { runtime: 'podman', id: BOX, finishedAt: '2026-09-01T00:00:00Z', labels: ['io.hopper.box', 'other'] },
    ]);
  });
});

describe('the prune (issue #2494)', () => {
  it('removes the containers it is given that exited and carry no label it keeps, with their size', () => {
    const said = readPrune(run(pruneArgv(30, [`podman:${OLD}`, `podman:${STACK}`, `podman:${RUNNING}`, `podman:${BOX}`])));
    expect(said?.removed.filter((r) => r.kind === 'container')).toEqual([{ runtime: 'podman', kind: 'container', id: OLD, bytes: 4096 }]);
    expect(lines('containers').map((l) => l.split(' ')[0])).toEqual([STACK, RUNNING, BOX]);
    // Never forced: a container that runs stays whatever the runtime says.
    expect(lines('calls').filter((l) => l.startsWith('rm '))).toEqual([`rm -v ${OLD}`]);
  });

  it('removes only the anonymous volumes no container uses, never a named one or a job\'s, with their size', () => {
    // Its size is what du says of its mount point: the file, and on some filesystems (ext4) the directory's own block too.
    const bytes = Number(execFileSync('du', ['-sk', join(fake, 'mnt', ANON)], { encoding: 'utf8' }).split('\t')[0]) * 1024;
    expect(bytes).toBeGreaterThanOrEqual(64 * 1024);
    const said = readPrune(run(pruneArgv(30, [])));
    expect(said?.removed.filter((r) => r.kind === 'volume')).toEqual([{ runtime: 'podman', kind: 'volume', id: ANON, bytes }]);
    expect(lines('volumes').map((l) => l.split(' ')[0])).toEqual([NAMED, JOBVOL, USED]);
    expect(lines('calls').filter((l) => l.startsWith('volume rm'))).toEqual([`volume rm ${ANON}`]);
  });

  it('prunes the images no container uses that are older than the age, never the hopper\'s own, with their size', () => {
    const said = readPrune(run(pruneArgv(30, [])));
    expect(said?.removed.filter((r) => r.kind === 'image')).toEqual([{ runtime: 'podman', kind: 'image', id: hex('e'), bytes: 1.5e9 }]);
    expect(lines('calls')).toContain('image prune -a -f --filter until=720h --filter label!=org.opencontainers.image.title=hopper');
  });

  it('says it finished with nothing removed where no runtime answers', () => {
    writeFileSync(join(fake, 'podman'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    expect(readPrune(run(pruneArgv(7, [`podman:${OLD}`])))).toEqual({ removed: [] });
  });
});

describe('a /prune body (issue #2494)', () => {
  it('takes an age in days and containers of a runtime by their hex id only', () => {
    expect(pruneArgvOf({ days: 30, containers: [`podman:${OLD}`] })).toEqual(pruneArgv(30, [`podman:${OLD}`]));
    expect(pruneArgvOf({ days: 0, containers: [] })).toMatch(/days/);
    expect(pruneArgvOf({ days: 1.5, containers: [] })).toMatch(/days/);
    expect(pruneArgvOf({ days: 30, containers: ['podman:-rf'] })).toMatch(/containers/);
    expect(pruneArgvOf({ days: 30, containers: [`sh:${OLD}`] })).toMatch(/containers/);
    expect(pruneArgvOf({ days: 30 })).toMatch(/containers/);
  });
});
