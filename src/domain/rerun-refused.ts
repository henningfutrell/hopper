// Run again refused by the job's source (issue #527, design.md "Run again").

/**
 * A source that will not give an ended job's item back, because the new job would not run (issue #527): on
 * GitHub, an issue no longer assigned to the connected account, whose new job was cancelled `unassigned` at
 * once. Run again answers it as a conflict, its message the reason.
 */
export class RerunRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RerunRefused';
  }
}
