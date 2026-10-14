// Claude Code's own config, seeded where the machine has none (issue #533, design.md "Startup screens"): a fresh
// container, or any home Claude never ran in, starts Claude with no first-run screen — onboarding done, a theme, no
// auto-update, the work tree trusted and its CLAUDE.md imports allowed (with `trustWorkdir`), the machine's API key
// approved. A config that exists is the user's and is never written: its screens get their defaults on screen.
import { shellQuote } from '../ssh.ts';

/** What the seed command prints, followed by its outcome. */
export const CLAUDE_CONFIG_MARK = 'hopper-claude-config-';

/** seeded: written; kept: a config was there, left as it is; unwritable: none was there and none could be written. */
export type ClaudeConfigOutcome = 'seeded' | 'kept' | 'unwritable';

/**
 * The seed, run by `sh` in the pane's shell, in the directory Claude starts in. Its config file is Claude's own:
 * `$CLAUDE_CONFIG_DIR/.claude.json`, else `~/.claude.json`. Written only when absent, with noclobber, mode 600.
 * Trust and imports go to the work tree, the directory Claude starts in and its git top (Claude keys the imports
 * approval by the repository's top, trust by the directory or one above it), each by its real path and only when
 * it is the work tree or inside it; a path with a quote or backslash is left out rather than written wrong. The API key's last 20 characters are how Claude
 * records it approved. Printed as two words, so the command's own echo never reads as its outcome.
 */
const SEED = [
  'say() { printf "hopper-%s-%s\\n" claude-config "$1"; }',
  'f="${CLAUDE_CONFIG_DIR:-$HOME}/.claude.json"',
  'if [ -e "$f" ]; then say kept; exit 0; fi',
  'c="\\"hasCompletedOnboarding\\":true,\\"theme\\":\\"dark\\",\\"autoUpdates\\":false"',
  'if [ "$3" = 1 ]; then c="$c,\\"bypassPermissionsModeAccepted\\":true"; fi',
  'k=$(printf %s "${ANTHROPIC_API_KEY:-}" | tail -c 20)',
  'case "$k" in "" | *[!A-Za-z0-9_-]*) ;; *) c="$c,\\"customApiKeyResponses\\":{\\"approved\\":[\\"$k\\"],\\"rejected\\":[]}" ;; esac',
  'if [ "$2" = 1 ]; then'
    + ' e="{\\"hasTrustDialogAccepted\\":true,\\"hasClaudeMdExternalIncludesApproved\\":true,\\"hasClaudeMdExternalIncludesWarningShown\\":true}";'
    + ' here=$(pwd -P); tree=$(cd "$1" 2>/dev/null && pwd -P); top=$(git rev-parse --show-toplevel 2>/dev/null); p=""; seen="";'
    + ' for d in "$tree" "$here" "$top"; do'
    + ' case "$d" in "" | *\\"* | *\\\\*) continue ;; esac;'
    + ' case "$d" in "$tree" | "$tree"/*) ;; *) continue ;; esac;'
    + ' case "$seen" in *"|$d|"*) continue ;; esac;'
    + ' seen="$seen|$d|"; p="$p${p:+,}\\"$d\\":$e";'
    + ' done; c="$c,\\"projects\\":{$p}"; fi',
  'mkdir -p "$(dirname "$f")" 2>/dev/null',
  'if (umask 077; set -C; printf "{%s}\\n" "$c" > "$f") 2>/dev/null; then say seeded; else say unwritable; fi',
].join('; ');

/** The seed as one line for the pane: the work tree, and whether it is trusted and yolo, as its arguments. */
export function seedClaudeConfigCommand(workTree: string, trust: boolean, yolo: boolean): string {
  return `sh -c ${shellQuote(SEED)} hopper-claude-config ${shellQuote(workTree)} ${trust ? 1 : 0} ${yolo ? 1 : 0}`;
}

/** The seed's outcome on the pane's screen, else undefined. */
export function claudeConfigOutcome(screen: string): ClaudeConfigOutcome | undefined {
  const m = /^\s*hopper-claude-config-(seeded|kept|unwritable)\s*$/m.exec(screen);
  return m ? m[1] as ClaudeConfigOutcome : undefined;
}
