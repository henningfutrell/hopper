// install.sh's sources.yaml step: node scripts/migrate-sources-yaml.ts <path>
// - no file: write the phase-4 starter (github enabled auto + githubApp), mode 600
// - the exact phase-3 starter line `enabled: true # false: pull nothing from GitHub` → auto, once
// - any other github.enabled value: kept, with a warning naming the file and the line
// - no top-level `githubApp:` key: append the commented block, once
// Text edits only, so the owner's comments and layout survive. Node built-ins only.
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';

const STARTER_LINE = '  enabled: true              # false: pull nothing from GitHub';
const AUTO_LINE = '  enabled: auto               # auto: on only while no GitHub App is configured';

const GITHUB_BLOCK = `# job-hopper job sources. The hopper PULLS jobs; nothing posts them. Read at daemon start:
# after editing, run: systemctl --user restart job-hopper
version: 1
github:                      # the gh source: acts as the owner through the gh CLI
${AUTO_LINE}
  pollSeconds: 60            # how often to sync (discover issues, check jobs, retry reports)
  owners: []                 # discover across repos owned by these; empty -> the \`gh\` user
  repos: []                  # allowlist owner/repo; when non-empty ONLY these repos are acted on
  authors: [owner]  # only issues and replies by these authors are ever acted on
  label: hopper              # an open issue with this label becomes a job
  priorityLabels: { "hopper:p0": 100, "hopper:p1": 75, "hopper:p2": 50, "hopper:p3": 25 }
  defaultPriority: 50        # priority when no project value and no priority label applies
  repoPaths: {}              # owner/repo -> local path, the job's working directory
  defaultCwd: ~/workbench/app-workflows   # cwd for repos not in repoPaths
  executor: herdr-claude     # executor for issue jobs
  model: null                # optional claude model for issue jobs
  progressCommentSeconds: 300  # at most one progress-comment edit per job per this many seconds
  recentComments: 10         # allowlisted comments passed into the job's context
  projects: {}               # optional GitHub Projects (v2) priority per repo; the project wins over labels
  # projects:                # needs the read:project scope: gh auth refresh -s read:project
  #   owner/job-hopper-sandbox:
  #     owner: owner
  #     number: 3
  #     mode: field          # field | rank
  #     field: Priority      # field mode: single-select or number field name
  #     map: { P0: 100, P1: 75, P2: 50, P3: 25 }   # single-select option -> priority
`;

const APP_BLOCK = `
# The GitHub App source: posts as the app's bot; the repos the app is installed on are the
# allowlist. Create the app once: bash ~/.local/lib/job-hopper/scripts/create-github-app.sh
githubApp:
  enabled: true              # still needs the app file below; until then this source waits (no restart needed)
  appFile: ~/.config/job-hopper/github-app.json
  pollSeconds: 60
  repos: []                  # optional extra restriction inside the app's installations
  authors: [owner]  # never the app's bot
  label: hopper
  priorityLabels: { "hopper:p0": 100, "hopper:p1": 75, "hopper:p2": 50, "hopper:p3": 25 }
  defaultPriority: 50
  repoPaths: {}              # owner/repo -> local path, the job's working directory
  defaultCwd: ~/workbench/app-workflows
  executor: herdr-claude
  model: null
  progressCommentSeconds: 300
  recentComments: 10
  projects: {}               # organization-owned Projects (v2) only: an app cannot read user-owned projects
`;

/** Index of the `enabled:` line inside the top-level `github:` block, or -1. */
function githubEnabledLine(lines: string[]): number {
  const start = lines.findIndex((l) => /^github:/.test(l));
  if (start < 0) return -1;
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i]!;
    if (/^\S/.test(l) && !l.startsWith('#')) return -1;
    if (/^\s+enabled:/.test(l)) return i;
  }
  return -1;
}

function migrate(path: string): void {
  if (!existsSync(path)) {
    writeFileSync(path, GITHUB_BLOCK + APP_BLOCK, { mode: 0o600 });
    console.log(`wrote starter sources file ${path} (github enabled: auto, githubApp block)`);
    return;
  }
  const lines = readFileSync(path, 'utf8').split('\n');
  let changed = false;
  const at = githubEnabledLine(lines);
  if (at >= 0 && lines[at] === STARTER_LINE) {
    lines[at] = AUTO_LINE;
    changed = true;
    console.log(`rewrote ${path} line ${at + 1}: ${AUTO_LINE.trim()}`);
  } else if (at >= 0 && !/^\s+enabled:\s*auto\b/.test(lines[at]!)) {
    console.error(`WARNING: ${path} line ${at + 1} kept as is: ${lines[at]!.trim()}`);
    console.error('  With enabled: auto the gh source stops pulling once the GitHub App is configured.');
  }
  let text = lines.join('\n');
  if (!/^githubApp:/m.test(text)) {
    text = `${text.replace(/\n*$/, '\n')}${APP_BLOCK}`;
    changed = true;
    console.log(`appended a githubApp: block to ${path}`);
  }
  if (changed) writeFileSync(path, text);
  chmodSync(path, 0o600);
}

const path = process.argv[2];
if (!path) {
  console.error('usage: node scripts/migrate-sources-yaml.ts <sources.yaml>');
  process.exit(2);
}
migrate(path);
