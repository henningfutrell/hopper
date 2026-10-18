// The screen-drift check (issue #1958): a screen the herdr fakes record (src/executors/herdr/fake-screens.ts) must still
// be on the screen the real Claude Code TUI renders. Each recorded line must be in the real screen with all whitespace
// removed, so the real pane's own width, wrapping (a long path breaks mid-word) and indent do not count, as
// screen.ts's isTrustDialog reads a path; a rule line (only `─`) is the pane's
// width and is passed over. The real screen may show more than the recording: the hopper reads few of its lines.

const compact = (s: string): string => s.replace(/\s+/g, '');
const RULE = /^\s*─+\s*$/;

/** The first recorded line that is not on the real screen, or undefined when every one is. */
export function screenDrift(recorded: readonly string[], real: string): string | undefined {
  const shown = compact(real);
  return recorded.find((line) => {
    const want = compact(line);
    return want !== '' && !RULE.test(line) && !shown.includes(want);
  });
}
