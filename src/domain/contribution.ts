// Contribution (issue #429, design.md "The contribution flow"): whether a job of a repository its user cannot push to may
// work through a fork — the hopper forks the repository into the user's account, the job pushes its branch there and
// opens its pull request on the repository it came from. Off unless an admin turns it on: a pull request on somebody
// else's repository goes out under the user's account. Kept in the user's settings, read at each request, so a change
// applies without a restart. Pure.

export interface ContributionSettings {
  /** Jobs may fork a repository their user cannot push to, push to that fork and open pull requests from it. */
  on: boolean;
}

export const DEFAULT_CONTRIBUTION: ContributionSettings = { on: false };
