// A job's containers and volumes (issue #1120, design.md "Hopper's own disk use" → "Part 3"), run for real: the reap and
// the survey a machine runs, with a fake container runtime first on PATH. What a job started there carries the label
// `hopper.job=<its id>`: the reap removes it, and the survey names the jobs that still have one.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { JOB_LABEL, readReap, readSurvey, reapArgv, surveyArgv } from '../../src/client/reap.ts';

const JOB = 'job-1120-abcdef';
const OTHER = 'job-1120-other';

// The fake runtime: containers and volumes as lines `<id> <job id>` in $FAKE/containers and $FAKE/volumes, each call
// logged to $FAKE/calls. It answers only what the scripts ask: the lists by label, the label read, and the removals.
const FAKE_RUNTIME = `#!/bin/sh
echo "$*" >> "$FAKE/calls"
list() { f=$1; l=$2; case $l in label=${JOB_LABEL}) cut -d " " -f 1 "$FAKE/$f";; label=${JOB_LABEL}=*) awk -v j="\${l#label=${JOB_LABEL}=}" '$2 == j { print $1 }' "$FAKE/$f";; esac; }
label() { f=$1; shift; for i in "$@"; do awk -v i="$i" '$1 == i { print $2 }' "$FAKE/$f"; done; }
# What the reap asks of a container for the parts list (issue #975): docker's own answer, its name after a slash.
details() { case $1 in c0ffee01) echo '/db-1 docker.io/library/postgres:16 "2026-10-01T00:05:00.123456789Z" "2026-10-01T00:20:00Z"';; c0ffee02) echo '/cache-1 redis:7 "2026-10-01T00:06:00Z" "0001-01-01T00:00:00Z"';; esac; }
case "$1 $2" in
  "ps -aq") list containers "$4";;
  "inspect --format") case $3 in *Config.Image*) shift 3; for i in "$@"; do details "$i"; done;; *) shift 3; label containers "$@";; esac;;
  "rm -f") shift 3; for i in "$@"; do grep -v "^$i " "$FAKE/containers" > "$FAKE/c.next"; mv "$FAKE/c.next" "$FAKE/containers"; done;;
  "volume ls") list volumes "$5";;
  "volume inspect") shift 4; label volumes "$@";;
  "volume rm") shift 3; for i in "$@"; do grep -v "^$i " "$FAKE/volumes" > "$FAKE/v.next"; mv "$FAKE/v.next" "$FAKE/volumes"; done;;
esac
`;

let fake: string;
beforeEach(() => {
  fake = mkdtempSync(join(tmpdir(), 'hopper-containers-'));
  writeFileSync(join(fake, 'docker'), FAKE_RUNTIME, { mode: 0o755 });
  // A second runtime that answers nothing, so a real podman on this machine is never asked.
  writeFileSync(join(fake, 'podman'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  writeFileSync(join(fake, 'calls'), '');
  writeFileSync(join(fake, 'containers'), `c0ffee01 ${JOB}\nc0ffee02 ${JOB}\nbeef0001 ${OTHER}\n`);
  writeFileSync(join(fake, 'volumes'), `vol-db ${JOB}\nvol-other ${OTHER}\n`);
});
afterEach(() => rmSync(fake, { recursive: true, force: true }));

// The user's runtime dir is the fake's too, so the job runtimes other tests make in this machine's (issue #1295) are not found.
const env = (): NodeJS.ProcessEnv => ({ ...process.env, FAKE: fake, XDG_RUNTIME_DIR: fake, PATH: `${fake}${delimiter}${process.env.PATH ?? ''}` });
const run = (argv: string[], e = env()): string => {
  const [file, ...args] = argv;
  return execFileSync(file!, args, { encoding: 'utf8', env: e, timeout: 30000 });
};
const lines = (f: string): string[] => readFileSync(join(fake, f), 'utf8').split('\n').filter(Boolean);

describe('the reap removes a job\'s containers and volumes (issue #1120)', () => {
  it('removes each container and volume labelled with the job, a container with its anonymous volumes; never another job\'s', () => {
    const said = readReap(run(reapArgv(JOB)));
    expect(said?.removed).toMatchObject({ containers: ['c0ffee01', 'c0ffee02'], volumes: ['vol-db'] });
    expect(lines('containers')).toEqual([`beef0001 ${OTHER}`]);
    expect(lines('volumes')).toEqual([`vol-other ${OTHER}`]);
    expect(lines('calls')).toContain('rm -f -v c0ffee01');
  });

  it('says each container\'s name, image, and when it started and stopped (issue #975); one still running has no stop', () => {
    expect(readReap(run(reapArgv(JOB)))?.removed?.details).toEqual([
      { id: 'c0ffee01', name: 'db-1', image: 'docker.io/library/postgres:16', startedAt: '2026-10-01T00:05:00.123Z', stoppedAt: '2026-10-01T00:20:00.000Z' },
      { id: 'c0ffee02', name: 'cache-1', image: 'redis:7', startedAt: '2026-10-01T00:06:00.000Z' },
    ]);
  });

  it('a timed-out job\'s reap (keep) removes none: it may go on there', () => {
    const scratch = join(fake, '.worktrees', '@scratch', JOB);
    const said = readReap(run(reapArgv(JOB, scratch, true)));
    expect(said?.removed).toBeUndefined();
    expect(lines('containers')).toHaveLength(3);
  });

  it('a job with none: nothing removed, nothing said', () => {
    expect(readReap(run(reapArgv('job-1120-none')))?.removed).toBeUndefined();
  });

  it('a machine with no container runtime: the reap still finishes', () => {
    rmSync(join(fake, 'docker'));
    rmSync(join(fake, 'podman'));
    const said = readReap(run(reapArgv(JOB), { ...env(), PATH: `${fake}${delimiter}/usr/bin${delimiter}/bin` }));
    expect(said).toEqual({ kept: [] });
  });
});

describe('the survey names the jobs that still have a container or a volume (issue #1120)', () => {
  it('each job once, from its containers and its volumes', () => {
    writeFileSync(join(fake, 'volumes'), `vol-db ${JOB}\nvol-left job-1120-volume-only\n`);
    expect(readSurvey(run(surveyArgv([])))?.containers).toEqual([JOB, OTHER, 'job-1120-volume-only']);
  });

  it('none: an empty list', () => {
    writeFileSync(join(fake, 'containers'), '');
    writeFileSync(join(fake, 'volumes'), '');
    expect(readSurvey(run(surveyArgv([])))?.containers).toEqual([]);
  });
});
