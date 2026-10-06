# hopper as a container (docs/deploy.md, compose.yaml). Everything the daemon keeps is in its
# database (HOPPER_DATABASE_URL); its secrets are environment variables; nothing in the image
# depends on the machine it runs on. The container is not a machine (issue #141): jobs run on attached
# machines only, in their herdr sessions (HOPPER_LOCAL_MACHINE=false).

# ---- the UI bundle (the one built part) --------------------------------------------------------
FROM node:26-bookworm-slim AS ui
WORKDIR /build
COPY package.json package-lock.json ./
# The UI build needs no native module.
RUN npm ci --no-audit --no-fund --ignore-scripts
COPY ui ./ui
COPY site/hopper-logo.svg ./site/hopper-logo.svg
COPY src ./src
RUN npm run build:ui && test -s ui/dist/index.html

# ---- production node_modules: node-pty (the herdr terminal's pseudo-terminal) is built here --------
FROM node:26-bookworm-slim AS deps
RUN apt-get update && apt-get install -y --no-install-recommends make g++ python3 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && test -f node_modules/node-pty/build/Release/pty.node

# ---- the daemon --------------------------------------------------------------------------------
FROM node:26-bookworm-slim
# git: self-update's mirror and Jev; openssh-client: attached machines; python3 + PyYAML: the Jev
# shim; gh: the github-gh job source, and git's GitHub sign-in for jobs; ca-certificates: TLS to GitHub
# and the identity providers; curl: herdr's installer; nano: `hopper config edit` (EDITOR).
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl git nano openssh-client python3 python3-yaml gh \
 && rm -rf /var/lib/apt/lists/* \
 && git config --system credential.https://github.com.helper '!gh auth git-credential'
# herdr's CLI (herdr.dev; the installer checks the release's SHA-256): the herdr-claude executor
# detects it before it runs jobs on attached machines, and the herdr terminal's root herdr runs here.
RUN curl -fsSL https://herdr.dev/install.sh | HERDR_INSTALL_DIR=/usr/local/bin sh && herdr --version
# The claude CLI, for the escalation levels, the usage reading and Jev's Haiku gates. It signs
# in from the environment (CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY). INSTALL_CLAUDE=false skips it.
ARG INSTALL_CLAUDE=true
RUN if [ "$INSTALL_CLAUDE" = true ]; then npm install -g --no-audit --no-fund @anthropic-ai/claude-code && npm cache clean --force; fi
# A job's Claude Code starts without its first-run screens: onboarding, and the prompt that confirms
# --dangerously-skip-permissions (herdr-claude's default args). Seeds the home volume on first start.
RUN install -d -o node -g node /home/node/.claude \
 && printf '{"hasCompletedOnboarding":true}\n' > /home/node/.claude.json \
 && printf '{"skipDangerousModePermissionPrompt":true}\n' > /home/node/.claude/settings.json \
 && chown node:node /home/node/.claude.json /home/node/.claude/settings.json

WORKDIR /app
COPY package.json package-lock.json ./
COPY --from=deps /app/node_modules ./node_modules
COPY src ./src
COPY scripts ./scripts
COPY WHATS-NEW.md ./
COPY --from=ui /build/ui/dist ./ui/dist
RUN chmod 755 src/cli.ts && ln -s /app/src/cli.ts /usr/local/bin/hopper

USER node
ENV NODE_ENV=production \
    EDITOR=nano \
    HOPPER_LOCAL_MACHINE=false \
    HOPPER_PORT=4790 \
    HOPPER_WORK_DIR=/tmp/hopper
EXPOSE 4790
# Loopback inside the container, on the daemon's port: a local request, no session needed.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.HOPPER_PORT || 4790) + '/api/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
CMD ["node", "src/main.ts"]
