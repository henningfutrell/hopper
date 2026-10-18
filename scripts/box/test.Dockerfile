# The test image of the sandbox boxes (issue #1875, design.md "The test image"): the claude box image (Dockerfile here)
# with what an end-to-end test against a web app needs, prebuilt, so a box step behind the egress proxy downloads no
# package: Python 3 (Debian bookworm's, 3.11) in a venv, Playwright for Python with Chromium's headless shell, the
# browser's system libraries, fonts, and requests and pytest. Non-root: it runs as the box image's user, agent.
# Published as ghcr.io/henningfutrell/hopper:box-test by .github/workflows/image.yml `box-test`, on the box image of the
# same commit (BASE). A template request names it `--image test` (src/sandbox/box-image.ts TEST_IMAGE).
#
#   docker build -f scripts/box/test.Dockerfile --build-arg BASE=localhost/hopper:box-claude -t localhost/hopper:box-test .
ARG BASE=ghcr.io/henningfutrell/hopper:box-claude
FROM ${BASE}

USER root

# The browsers outside the home: a box's home is a fresh volume that would hide them.
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/playwright VIRTUAL_ENV=/opt/venv PATH=/opt/venv/bin:$PATH

RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-venv \
      fonts-dejavu-core fonts-liberation fonts-noto-color-emoji \
 && python3 -m venv /opt/venv \
 && pip install --no-cache-dir playwright requests pytest \
 && playwright install --with-deps --only-shell chromium \
 && rm -rf /var/lib/apt/lists/* \
 && chmod -R a+rX /opt/venv /opt/playwright \
 && python3 --version && playwright --version

USER agent
LABEL org.opencontainers.image.title="hopper sandbox box: tests" hopper.box="test"
