#!/usr/bin/env bash
# Install or upgrade job-hopper as systemd --user services: the daemon (job-hopper) and its
# own headless herdr session (job-hopper-herdr). Re-running upgrades in place. Config starters
# (rules.md, sources.yaml, webhooks.yaml) are written only when absent — never overwritten.
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="$HOME/.local/lib/job-hopper"
UNIT_DIR="$HOME/.config/systemd/user"
URL="http://127.0.0.1:4790"
CONFIG_DIR="$HOME/.config/job-hopper"
RULES="$CONFIG_DIR/rules.md"
SOURCES="$CONFIG_DIR/sources.yaml"
WEBHOOKS="$CONFIG_DIR/webhooks.yaml"

step() { printf '==> %s\n' "$*"; }

step "copy src/, scripts/, package.json, package-lock.json to $DEST (replacing old src/ and scripts/; node_modules kept for npm ci)"
mkdir -p "$DEST"
rm -rf "$DEST/src" "$DEST/scripts"
cp -r "$APP_DIR/src" "$DEST/src"
cp -r "$APP_DIR/scripts" "$DEST/scripts"
cp "$APP_DIR/package.json" "$APP_DIR/package-lock.json" "$DEST/"

step "npm ci --omit=dev --prefix $DEST"
npm ci --omit=dev --prefix "$DEST"

step "install units to $UNIT_DIR: job-hopper.service, job-hopper-herdr.service"
mkdir -p "$UNIT_DIR"
install -m 0644 "$APP_DIR/systemd/job-hopper.service" "$UNIT_DIR/job-hopper.service"
install -m 0644 "$APP_DIR/systemd/job-hopper-herdr.service" "$UNIT_DIR/job-hopper-herdr.service"

if [ -e "$RULES" ]; then
  step "keep existing rules file $RULES"
else
  step "write starter rules file $RULES (edit it: every answer tier reads it on each question)"
  mkdir -p "$(dirname "$RULES")"
  cat > "$RULES" <<'RULES_EOF'
# Standing rules for job-hopper's answer tiers (starter — edit me)

Every model tier answering a question from an unattended job reads this file.

- Never push or force-push.
- Never delete files outside the job's working directory.
- Never deploy or publish anything.
- Never spend money or buy anything.
- Never send messages, emails or posts to anyone.
- Prefer the smallest change that does the job.
- When unsure, say you are not confident, so a human is asked.
RULES_EOF
fi

if [ -e "$SOURCES" ]; then
  step "keep existing sources file $SOURCES"
else
  step "write starter sources file $SOURCES (mode 600; edit it, the daemon reads it at start)"
  mkdir -p "$CONFIG_DIR"
  (umask 077; cat > "$SOURCES" <<'SOURCES_EOF'
# job-hopper job sources. The hopper PULLS jobs; nothing posts them. Read at daemon start:
# after editing, run: systemctl --user restart job-hopper
version: 1
github:
  enabled: true              # false: pull nothing from GitHub
  pollSeconds: 60            # how often to sync (discover issues, check jobs, retry reports)
  owners: []                 # discover across repos owned by these; empty -> the `gh` user
  repos: []                  # allowlist owner/repo; when non-empty ONLY these repos are acted on
  authors: [owner]  # only issues and replies by these authors are ever acted on
  label: hopper              # an open issue with this label becomes a job
  priorityLabels: { "hopper:p0": 100, "hopper:p1": 75, "hopper:p2": 50, "hopper:p3": 25 }
  defaultPriority: 50        # priority when no project value and no priority label applies
  repoPaths: {}              # owner/repo -> local path, the job's working directory
  defaultCwd: ~/workbench/workflow-personal-app-management   # cwd for repos not in repoPaths
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
SOURCES_EOF
  )
fi

if [ -e "$WEBHOOKS" ]; then
  step "keep existing webhooks file $WEBHOOKS"
else
  step "write starter webhooks file $WEBHOOKS (mode 600; re-read within 5 s of every change)"
  mkdir -p "$CONFIG_DIR"
  (umask 077; cat > "$WEBHOOKS" <<'WEBHOOKS_EOF'
# job-hopper outbound webhooks: every event, signed with HMAC-SHA256 (docs/events.md).
version: 1
webhooks: []
# webhooks:
#   - name: grok-bot                     # unique; the reconcile key
#     url: http://127.0.0.1:4795/hook
#     events: ["question.escalated", "job.finished", "job.failed"]   # or ["*"]
#     secret: "<hex>"                    # or secretFile: ~/.config/job-hopper/grok-bot.secret
#     active: true
WEBHOOKS_EOF
  )
fi
chmod 600 "$SOURCES" "$WEBHOOKS"

step "systemctl --user daemon-reload"
systemctl --user daemon-reload

step "systemctl --user enable job-hopper-herdr job-hopper"
systemctl --user enable job-hopper-herdr job-hopper

if systemctl --user is-active --quiet job-hopper-herdr; then
  step "job-hopper-herdr is active: NOT restarted (restarting it would kill every parked pane and its Claude job)"
else
  step "systemctl --user start job-hopper-herdr"
  systemctl --user start job-hopper-herdr
fi

step "systemctl --user restart job-hopper (starts it, or restarts onto the new code)"
systemctl --user restart job-hopper

step "wait for $URL/api/health (20 tries, 0.5 s apart)"
for i in $(seq 1 20); do
  if health="$(curl -fsS "$URL/api/health" 2>/dev/null)"; then
    printf 'health (try %s): %s\n' "$i" "$health"
    printf 'executors: %s\n' "$(printf '%s' "$health" | node -e 'let s="";process.stdin.on("data",(c)=>s+=c).on("end",()=>console.log((JSON.parse(s).executors??[]).join(", ")))')"
    printf 'UI: %s/ (read-only until you log in)\n' "$URL"
    echo 'open the UI: bash ~/.local/lib/job-hopper/scripts/open-ui.sh'
    exit 0
  fi
  printf '  try %s/20: not up yet\n' "$i"
  sleep 0.5
done

echo "job-hopper did not answer /api/health in 10 s. Inspect: journalctl --user -u job-hopper -n 50" >&2
exit 1
