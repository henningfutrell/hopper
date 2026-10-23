// The trim (issue #2494, design.md "Hopper's own disk use" → "Part 9"): fstrim on the filesystem the machine's home is on,
// so a thin disk (an EBS volume, a WSL distro's virtual disk) learns which blocks the cleanups freed. A fixed POSIX sh
// script with no argument, run through the machine's own connection (this machine, ssh, or a client target's `/trim`), as
// the reap and the prune are (reap.ts, prune.ts). Imports nothing of hopper but its own directory.

import type { Trimmed, TrimOutcome } from '../domain/disk-trim.ts';

/** How long a trim may take: fstrim is cut off at 240 s where `timeout` is. */
export const TRIM_TIMEOUT_MS = 300000;
export const TRIM_DONE = 'hopper-trim-done';

// fstrim -v on the home's mount point; when only root may, by sudo with no password (`-n`: it never waits on one), by
// fstrim's full path, as sudo's own PATH may not hold it. It prints `hopper-trim|<mount>|<outcome>|<bytes or what it said>`,
// and `hopper-trim-wsl` in a WSL distro.
const TRIM_SCRIPT = [
  'to=; command -v timeout >/dev/null 2>&1 && to="timeout 240";',
  `mp=$(df -P "$HOME" 2>/dev/null | awk 'NR == 2 { $1 = $2 = $3 = $4 = $5 = ""; sub(/^ +/, ""); print }'); [ -n "$mp" ] || mp=/;`,
  '{ [ -n "$WSL_DISTRO_NAME" ] || grep -qi microsoft /proc/version 2>/dev/null; } && echo hopper-trim-wsl;',
  'f=$(command -v fstrim 2>/dev/null);',
  'if [ -z "$f" ]; then printf "hopper-trim|%s|unsupported|no fstrim\\n" "$mp"; else',
  '  out=$($to "$f" -v "$mp" 2>&1); rc=$?;',
  '  case $out in *"not permitted"*|*"ermission denied"*) if [ "$(id -u)" != 0 ] && command -v sudo >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1; then out=$($to sudo -n "$f" -v "$mp" 2>&1); rc=$?; fi;; esac;',
  '  said=$(printf "%s" "$out" | tr "\\n|" "  " | cut -c 1-300);',
  '  if [ $rc -eq 0 ]; then printf "hopper-trim|%s|trimmed|%s\\n" "$mp" "$(printf "%s\\n" "$out" | sed -n "s/.*(\\([0-9][0-9]*\\) bytes) trimmed.*/\\1/p" | head -n 1)";',
  '  else case $out in *"not permitted"*|*"ermission denied"*) k=refused;; *"not supported"*) k=unsupported;; *) k=failed;; esac; printf "hopper-trim|%s|%s|%s\\n" "$mp" "$k" "$said"; fi;',
  'fi;',
  `printf "%s\\n" ${TRIM_DONE}`,
].map((l) => l.trim()).join(' ');

/** The argv that trims the filesystem the machine's home is on. */
export const trimArgv = (): string[] => ['sh', '-c', TRIM_SCRIPT, 'sh'];

const OUTCOMES: readonly TrimOutcome[] = ['trimmed', 'refused', 'unsupported', 'failed'];

/** What a finished trim said. Undefined when it did not finish, or said no outcome. */
export function readTrim(stdout: string): Trimmed | undefined {
  const lines = stdout.split('\n').map((l) => l.trimEnd());
  if (!lines.includes(TRIM_DONE)) return undefined;
  const wsl = lines.includes('hopper-trim-wsl') ? { wsl: true } : {};
  for (const l of lines) {
    const [mark, mount, outcome, ...rest] = l.split('|');
    if (mark !== 'hopper-trim' || !mount?.startsWith('/') || !OUTCOMES.includes(outcome as TrimOutcome)) continue;
    const said = rest.join('|').trim();
    if (outcome === 'trimmed') return { mount, outcome, ...(/^\d+$/.test(said) ? { bytes: Number(said) } : {}), ...wsl };
    return { mount, outcome: outcome as TrimOutcome, ...(said ? { said } : {}), ...wsl };
  }
  return undefined;
}
