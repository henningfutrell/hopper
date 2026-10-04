// The built-in plugins. A new built-in lives at src/plugins/<role>/<id>/index.ts and is listed here.
import claudeCli from './answerer/claude-cli/index.ts';
import alwaysEscalate from './assessor/always-escalate/index.ts';
import claudeCliAssessor from './assessor/claude-cli-assessor/index.ts';
import command from './executor/command/index.ts';
import herdrClaude from './executor/herdr-claude/index.ts';
import testExecutor from './executor/test/index.ts';
import githubApp from './job-source/github-app/index.ts';
import githubGh from './job-source/github-gh/index.ts';
import local from './machine-source/local/index.ts';
import newestFirst from './queue-sorter/newest-first/index.ts';
import oldestFirst from './queue-sorter/oldest-first/index.ts';
import priority from './queue-sorter/priority/index.ts';
import grokbotRoutine from './notifier/grokbot-routine/index.ts';
import jevRouter from './router/jev-router/index.ts';
import passThrough from './router/pass-through/index.ts';
import claudePlan from './usage-source/claude-plan/index.ts';
import type { PluginDefinition } from './sdk.ts';

export const BUILTIN_PLUGINS: readonly PluginDefinition[] = [
  jevRouter, passThrough, priority, oldestFirst, newestFirst, claudeCli, claudeCliAssessor, alwaysEscalate, herdrClaude, testExecutor, command, githubGh, githubApp, local, claudePlan, grokbotRoutine,
];
