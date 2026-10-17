// File an issue (issue #471, design.md "File an issue"). Its drafter (`claude.ts`, the `claude` CLI) is composed by the
// user runtime, not exported here: what files an issue imports nothing of the plugins.
export { createIssueDrafts, IssueDraftRefused, type FileRequest, type IssueDrafter, type IssueDrafts, type IssueGitHub } from './service.ts';
