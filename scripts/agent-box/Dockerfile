# An agent box (design.md "Agent boxes", issue #295): a throwaway machine for testing the hopper with one
# agent CLI — claude, codex, cursor, omp or opencode (build argument AGENT) — reached over ssh like any
# ssh target. It runs sshd and its own herdr session (`hopper`); its login user `agent` keeps the agent's
# sign-in in its home, a volume of its own; it has no password (`*`: none, yet not locked — sshd refuses a
# locked account) and logs in with a key only. Built and run by scripts/agent-boxes.sh, which puts this
# machine's herdr binary (`herdr`) and `entrypoint.sh` beside this file in the build context.
FROM node:24-bookworm-slim

ARG AGENT

RUN apt-get update \
 && apt-get install -y --no-install-recommends openssh-server ca-certificates curl git less procps \
 && rm -rf /var/lib/apt/lists/* \
 && groupmod -n agent node && usermod -l agent -d /home/agent -m -s /bin/bash -p "*" node \
 && printf '%s\n' 'PasswordAuthentication no' 'KbdInteractiveAuthentication no' 'PermitRootLogin no' \
      'AllowUsers agent' 'UsePAM no' > /etc/ssh/sshd_config.d/agent-box.conf \
 && rm -f /etc/ssh/ssh_host_*

# The agent CLI, outside the home: a volume over the home never hides it. One per box.
RUN set -eu; case "$AGENT" in \
    claude) npm install -g @anthropic-ai/claude-code ;; \
    codex) npm install -g @openai/codex ;; \
    opencode) npm install -g opencode-ai ;; \
    omp) npm install -g bun && BUN_INSTALL=/usr/local bun install -g @oh-my-pi/pi-coding-agent ;; \
    cursor) HOME=/opt/cursor sh -c 'curl -fsS https://cursor.com/install | bash' \
      && chmod -R a+rX /opt/cursor && ln -s "$(readlink -f /opt/cursor/.local/bin/cursor-agent)" /usr/local/bin/cursor-agent ;; \
    *) echo "AGENT must be claude, codex, cursor, omp or opencode, not '$AGENT'" >&2; exit 1 ;; \
  esac; npm cache clean --force >/dev/null 2>&1 || true

COPY herdr /usr/local/bin/herdr
COPY entrypoint.sh /usr/local/sbin/agent-box
# The pickup protocol's box side (design.md "Pickups on agent boxes"): run by the box's node, no install.
COPY pickup.ts /usr/local/lib/hopper/pickup.ts
RUN chmod 755 /usr/local/bin/herdr /usr/local/sbin/agent-box \
 && printf '#!/bin/sh\nexec node /usr/local/lib/hopper/pickup.ts "$@"\n' > /usr/local/bin/hopper-pickup \
 && chmod 755 /usr/local/bin/hopper-pickup

LABEL org.opencontainers.image.title="hopper agent box" hopper.agent-box="$AGENT"
EXPOSE 22
ENTRYPOINT ["/usr/local/sbin/agent-box"]
