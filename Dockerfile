# job-hopper as a container (docs/deploy.md). Everything the daemon keeps is in its database
# (JOB_HOPPER_DATABASE_URL); its secrets are environment variables; nothing in the image depends on
# the machine it runs on. Jobs run in herdr panes on attached machines, reached over ssh: the
# container has no herdr of its own.

# ---- the UI bundle (the one built part) --------------------------------------------------------
FROM node:26-bookworm-slim AS ui
WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY ui ./ui
COPY src ./src
RUN npm run build:ui && test -s ui/dist/index.html

# ---- the daemon --------------------------------------------------------------------------------
FROM node:26-bookworm-slim
# git: self-update's mirror and Jev; openssh-client: attached machines; python3 + PyYAML: the Jev
# shim; gh: the github-gh job source; ca-certificates: TLS to GitHub and the identity providers.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates git openssh-client python3 python3-yaml gh \
 && rm -rf /var/lib/apt/lists/*
# The claude CLI, for the answerer, the assessor, the usage reading and Jev's Haiku gates. It signs
# in from the environment (CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY). INSTALL_CLAUDE=false skips it.
ARG INSTALL_CLAUDE=true
RUN if [ "$INSTALL_CLAUDE" = true ]; then npm install -g --no-audit --no-fund @anthropic-ai/claude-code && npm cache clean --force; fi

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY src ./src
COPY scripts ./scripts
COPY --from=ui /build/ui/dist ./ui/dist
RUN chmod 755 src/cli.ts && ln -s /app/src/cli.ts /usr/local/bin/job-hopper

USER node
ENV NODE_ENV=production \
    JOB_HOPPER_PORT=4790 \
    JOB_HOPPER_WORK_DIR=/tmp/job-hopper
EXPOSE 4790
# Loopback inside the container: a local request, no session needed.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:4790/api/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
CMD ["node", "src/main.ts"]
