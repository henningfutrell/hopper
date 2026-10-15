// A stand-in podman first on PATH (issue #1295), for a test that runs a print-agent turn: the turn sets up the job's
// container runtime and starts its socket, and the machine's real podman would make its storage in the run's temp dir,
// with files the run cannot remove. Its socket service runs until it is stopped, so a socket a turn left shows.
import { mkdirSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';

const STAND_IN = '#!/bin/sh\ncase "$*" in *"system service"*) while :; do sleep 1; done;; esac\nexit 0\n';

/** Writes the stand-in to `<dir>/bin/podman` and puts that dir first on this process's PATH. */
export function useStandInPodman(dir: string): void {
  mkdirSync(join(dir, 'bin'), { recursive: true });
  writeFileSync(join(dir, 'bin', 'podman'), STAND_IN, { mode: 0o755 });
  process.env.PATH = `${join(dir, 'bin')}${delimiter}${process.env.PATH ?? ''}`;
}
