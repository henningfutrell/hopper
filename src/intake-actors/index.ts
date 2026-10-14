// The trusted actor picker (issue #930, design.md "Trusted origin and request cards").
export { accountFrom, ActorsGitHubError, createActorsGitHub, RECENT_ISSUES, type ActorsGitHub } from './github.ts';
export {
  actorCandidates, CANDIDATE_REPOS, IntakeActorsRefused, isPerson, resolveActors,
} from './service.ts';
