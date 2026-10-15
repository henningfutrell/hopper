// The node:http fake GitHub, for tests of the REST and GraphQL calls the connected account's adapter makes.

export { createFakeGitHubServer } from './fake-server.ts';
export type { FakeGitHubOptions, FakeGitHubServer } from './fake-server.ts';
export { endPull } from './fake-pull-end.ts';
