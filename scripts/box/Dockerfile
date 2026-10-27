# A sandbox box (design.md "Joining a machine", issue #308): a machine with one agent CLI in it — claude, codex,
# cursor, omp or opencode (build argument AGENT, issue #865; src/sandbox/box-image.ts BOX_AGENTS) — that joins
# a hopper with the line Add machine shows and dials in — no sshd, no published port, nothing of the
# computer it runs on. Published as ghcr.io/henningfutrell/hopper:box-<agent> by .github/workflows/image.yml;
# built from the repo root (it carries the hopper client, src/client):
#
#   docker build -f scripts/box/Dockerfile --build-arg AGENT=claude -t localhost/hopper:box-claude .
#
# The line runs it locked down: every capability dropped, no new privileges, a read-only root, /tmp a
# tmpfs, its home the volume hopper-sandbox-<agent>-home — where its link key, the agent's sign-in and the
# jobs' work trees live, so a rebuilt or recreated box is the same machine.
# Node pinned to a patched version (issue #2479: 24.22.1 or later on line 24); Dependabot bumps it in its line.
FROM node:24.22.1-bookworm-slim

ARG AGENT=claude

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl git less procps \
 && rm -rf /var/lib/apt/lists/* \
 && groupmod -n agent node && usermod -l agent -d /home/agent -m -s /bin/bash node

# The agent CLI, outside the home: the home volume never hides it. One per box; its executor drives it on a client
# target (herdr-claude, or the print-mode executors: design.md "Print-mode agent executors").
RUN set -eu; case "$AGENT" in \
    claude) npm install -g --no-audit --no-fund @anthropic-ai/claude-code ;; \
    codex) npm install -g --no-audit --no-fund @openai/codex ;; \
    opencode) npm install -g --no-audit --no-fund @opencode/cli ;; \
    omp) npm install -g --no-audit --no-fund bun && BUN_INSTALL=/usr/local bun install -g @oh-my-pi/pi-coding-agent ;; \
    cursor) HOME=/opt/cursor sh -c 'curl -fsS https://cursor.com/install | bash' \
      && chmod -R a+rX /opt/cursor && ln -s "$(readlink -f /opt/cursor/.local/bin/cursor-agent)" /usr/local/bin/cursor-agent ;; \
    *) echo "AGENT must be claude, codex, cursor, omp or opencode, not '$AGENT'" >&2; exit 1 ;; \
  esac; npm cache clean --force >/dev/null 2>&1 || true

# herdr's CLI (herdr.dev; the installer checks the release's SHA-256): the box's jobs run in its session.
RUN curl -fsSL https://herdr.dev/install.sh | HERDR_INSTALL_DIR=/usr/local/bin sh && herdr --version

# The hopper client: its release as this commit has it. The hopper loads its own onto the box when they differ.
COPY src/client/ /usr/local/lib/hopper-client/
# No box on unpatched Node (issue #2479): fails the build below the floor.
RUN node /usr/local/lib/hopper-client/node-floor.ts
COPY scripts/box/entrypoint.sh /usr/local/bin/hopper-box

# A job's Claude Code starts without its first-run screens: onboarding, and the prompt that confirms
# --dangerously-skip-permissions (herdr-claude's default args). Seeds the home volume on its first start. Harmless
# in a box of another agent.
RUN chmod 755 /usr/local/bin/hopper-box \
 && install -d -o agent -g agent /home/agent/.claude \
 && printf '{"hasCompletedOnboarding":true}\n' > /home/agent/.claude.json \
 && printf '{"skipDangerousModePermissionPrompt":true}\n' > /home/agent/.claude/settings.json \
 && chown agent:agent /home/agent/.claude.json /home/agent/.claude/settings.json

USER agent
WORKDIR /home/agent
# The root is read-only: the agent CLI must not try to update itself in place.
ENV DISABLE_AUTOUPDATER=1
LABEL org.opencontainers.image.title="hopper sandbox box" hopper.box="$AGENT"
ENTRYPOINT ["/usr/local/bin/hopper-box"]
