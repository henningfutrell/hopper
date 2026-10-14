// The built-in plugins. A new built-in lives at src/plugins/<role>/<id>/index.ts and is listed here.
import anthropicApi from './escalation-level/anthropic-api/index.ts';
import claudeCli from './escalation-level/claude-cli/index.ts';
import claude from './executor/claude/index.ts';
import codex from './executor/codex/index.ts';
import command from './executor/command/index.ts';
import cursorAgent from './executor/cursor-agent/index.ts';
import herdrClaude from './executor/herdr-claude/index.ts';
import omp from './executor/omp/index.ts';
import opencode from './executor/opencode/index.ts';
import testExecutor from './executor/test/index.ts';
import githubAccount from './job-source/github-account/index.ts';
import githubApp from './job-source/github-app/index.ts';
import client from './machine-source/client/index.ts';
import docker from './machine-source/docker/index.ts';
import local from './machine-source/local/index.ts';
import ssh from './machine-source/ssh/index.ts';
import newestFirst from './queue-sorter/newest-first/index.ts';
import oldestFirst from './queue-sorter/oldest-first/index.ts';
import priority from './queue-sorter/priority/index.ts';
import grokbotRoutine from './notifier/grokbot-routine/index.ts';
import gateRouter from './router/gate-router/index.ts';
import passThrough from './router/pass-through/index.ts';
import claudePlan from './usage-source/claude-plan/index.ts';
import commandUsage from './usage-source/command-usage/index.ts';
import bitwarden from './vault-backend/bitwarden/index.ts';
import hashicorpVault from './vault-backend/hashicorp-vault/index.ts';
import onePassword from './vault-backend/1password/index.ts';
import type { PluginDefinition } from './sdk.ts';

export const BUILTIN_PLUGINS: readonly PluginDefinition[] = [
  gateRouter, passThrough, priority, oldestFirst, newestFirst, claudeCli, anthropicApi, herdrClaude, cursorAgent, codex, opencode, omp, claude, testExecutor, command, githubAccount, githubApp, local, ssh, docker, client, claudePlan, commandUsage, grokbotRoutine,
  hashicorpVault, onePassword, bitwarden,
];
