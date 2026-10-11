// Contribution in the UI (issue #429), pure: the panel's summary and its note.
import type { ContributionSettings } from './wire.ts';

export const CONTRIBUTION_NOTE = 'With Contribution on, a job of a repository your user cannot push to asks the hopper to fork it into your GitHub account. '
  + 'The job reads the repository\'s contributing rules and follows them, pushes its branch to the fork, and opens its pull request on the repository from the fork. '
  + 'When the repository takes no issues, the job files its issue on the fork. The fork, the pull request and the issue go out under your GitHub account, '
  + 'and the maintainers of that repository see them. The hopper never merges such a pull request: the maintainers do.';

export const contributionSummary = (s: ContributionSettings): string => (s.on
  ? 'On: a job of a repository your user cannot push to forks it into your account and opens its pull request there from the fork.'
  : 'Off: a job of a repository your user cannot push to gets no fork, and its push is refused.');
