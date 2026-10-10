# hopper as a container (docs/deploy.md, compose.yaml). Everything the daemon keeps is in its
# database (HOPPER_DATABASE_URL); its secrets are environment variables; nothing in the image
# depends on the machine it runs on. The container is not a machine (issue #141): jobs run on attached
# machines only, in their herdr sessions (HOPPER_LOCAL_MACHINE=false).

# ---- the UI bundle (the one built part) --------------------------------------------------------
FROM node:26-bookworm-slim AS ui
WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY ui ./ui
COPY site/hopper-logo.svg ./site/hopper-logo.svg
COPY src ./src
COPY scripts/check-ui-bundle.ts ./scripts/check-ui-bundle.ts
COPY scripts/copy-artifact-libs.ts ./scripts/copy-artifact-libs.ts
RUN npm run build:ui && test -s ui/dist/index.html

# ---- the daemon --------------------------------------------------------------------------------
FROM node:26-bookworm-slim
# What an upgrade prunes when this image is replaced (docs/deploy.md "Upgrade"); the published image carries it too.
LABEL org.opencontainers.image.title=hopper
# git: self-update's mirror and Jev; openssh-client: attached machines; python3 + PyYAML: the Jev
# shim; pip: typesafe-sdk below; ca-certificates: TLS to GitHub and the identity providers; curl: herdr's
# installer. No gh: GitHub is read through the signed-in user's connected account (issue #359), and jobs
# run on attached machines.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl git openssh-client python3 python3-yaml python3-pip \
 && rm -rf /var/lib/apt/lists/*
# typesafe-sdk: Jev through TypeSafe, for the decider calls and the gate router's Jev gates. Used only once a
# TypeSafe API key is set on the Jev page; without it nothing calls TypeSafe.
RUN pip3 install --no-cache-dir --break-system-packages typesafe-sdk==0.7.4 && python3 -c 'import typesafe_sdk'
# herdr's CLI (herdr.dev; the installer checks the release's SHA-256): the herdr-claude executor
# detects it before it runs jobs on attached machines.
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
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY src ./src
COPY scripts/check-ui-bundle.ts ./scripts/check-ui-bundle.ts
COPY scripts ./scripts
COPY WHATS-NEW.md ./
COPY --from=ui /build/ui/dist ./ui/dist
RUN chmod 755 src/cli.ts && ln -s /app/src/cli.ts /usr/local/bin/hopper
# What this image is built from (issue #409): install.json, as an install has, and the OCI labels — so Settings →
# Version history and the update check work as for an install. scripts/build-image.sh passes them from a checkout,
# .github/workflows/image.yml from GitHub. A build given none knows the repository and branch, and says it lacks
# its commit. Last, so a new commit rebuilds only this layer.
ARG HOPPER_REPO=https://github.com/henningfutrell/hopper.git
ARG HOPPER_BRANCH=stable
ARG HOPPER_COMMIT=
LABEL org.opencontainers.image.source=$HOPPER_REPO \
      org.opencontainers.image.revision=$HOPPER_COMMIT
RUN node scripts/write-install-json.ts /app/install.json image "$HOPPER_REPO" "$HOPPER_BRANCH" "$HOPPER_COMMIT"

USER node
ENV NODE_ENV=production \
    HOPPER_LOCAL_MACHINE=false \
    HOPPER_PORT=4790 \
    HOPPER_WORK_DIR=/tmp/hopper
EXPOSE 4790
# Loopback inside the container, on the daemon's port: a local request, no session needed.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.HOPPER_PORT || 4790) + '/api/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
CMD ["node", "src/main.ts"]
