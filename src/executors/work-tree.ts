// The job's repository in its work tree (issue #361, design.md "Per-machine work trees"): the hopper
// fetches a checkout the work tree already holds, or clones one, on the job's machine, before the agent
// starts. Run with `sh -c` so it means the same in whatever shell the job's pane runs.
import { shellQuote } from './ssh.ts';

/**
 * `$1` the repository (`owner/name`), `$2` its clone URL. A checkout is the work tree itself or a
 * directory named after the repository up to three levels down whose `origin` is that repository: it is
 * fetched (a fetch that fails is said, not fatal: the checkout is still there). None: cloned into
 * `<name>`. With `GH_TOKEN` in the environment (the job's connection, issue #214) git asks it alone for
 * credentials, by name: the token is never on a command line. Git never prompts.
 */
export const CHECKOUT_SCRIPT = [
  'r=$1; url=$2; n=${r##*/}',
  'export GIT_TERMINAL_PROMPT=0',
  'if [ -n "$GH_TOKEN" ]; then set -- -c credential.helper= -c \'credential.helper=!f() { echo username=x-access-token; echo "password=$GH_TOKEN"; }; f\'; else set --; fi',
  'for c in . "$n" */"$n" */*/"$n" */*/*/"$n"; do',
  '  [ -e "$c/.git" ] || continue',
  '  case "$(git -C "$c" remote get-url origin 2>/dev/null)" in',
  '    *[:/]"$r"|*[:/]"$r".git|*[:/]"$r"/) git "$@" -C "$c" fetch -q origin || echo "hopper: could not fetch $r in $c" >&2; exit 0;;',
  '  esac',
  'done',
  'exec git "$@" clone -q "$url" "$n"',
].join('\n');

/** The checkout step for a GitHub repository `owner/name`, as one shell command. */
export const checkoutCommand = (repo: string): string =>
  `sh -c ${shellQuote(CHECKOUT_SCRIPT)} hopper-checkout ${shellQuote(repo)} ${shellQuote(`https://github.com/${repo}.git`)}`;
