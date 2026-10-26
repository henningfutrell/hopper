// The public bug reports setting (issue #2818, design.md "Report a bug"), apart from settings.ts for its size: a user's
// key-value setting, off when never set — nothing is posted on the hopper's public tracker until an admin turns it on.

export function publicBugReportSettings(read: (key: string) => string | undefined, write: (key: string, value: string) => void): {
  getPublicBugReports(): boolean;
  setPublicBugReports(on: boolean): void;
} {
  return {
    getPublicBugReports: () => read('publicBugReports') === 'true',
    setPublicBugReports: (on) => write('publicBugReports', on ? 'true' : 'false'),
  };
}
