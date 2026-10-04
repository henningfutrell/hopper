// The built-in plugins. A new built-in lives at src/plugins/<role>/<id>/index.ts and is listed here.
import claudeCli from './answerer/claude-cli/index.ts';
import alwaysEscalate from './assessor/always-escalate/index.ts';
import claudeCliAssessor from './assessor/claude-cli-assessor/index.ts';
import herdrClaude from './executor/herdr-claude/index.ts';
import testExecutor from './executor/test/index.ts';
import githubApp from './job-source/github-app/index.ts';
import githubGh from './job-source/github-gh/index.ts';
import local from './machine-source/local/index.ts';
import grokbotRoutine from './notifier/grokbot-routine/index.ts';
import jevRouter from './router/jev-router/index.ts';
import passThrough from './router/pass-through/index.ts';
import type { PluginDefinition } from './sdk.ts';

export const BUILTIN_PLUGINS: readonly PluginDefinition[] = [
  jevRouter, passThrough, claudeCli, claudeCliAssessor, alwaysEscalate, herdrClaude, testExecutor, githubGh, githubApp, local, grokbotRoutine,
];
