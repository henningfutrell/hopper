#!/bin/sh
# An agent box's main process (scripts/agent-box/Dockerfile): host keys on its first start, sshd, then the
# box's herdr session `hopper` as its user — the container ends when that session does, and docker
# starts it again.
set -eu
ssh-keygen -A >/dev/null
mkdir -p /run/sshd
/usr/sbin/sshd -e
exec runuser -u agent -- env -i HOME=/home/agent USER=agent LOGNAME=agent SHELL=/bin/bash TERM=xterm-256color \
  PATH=/home/agent/.local/bin:/usr/local/bin:/usr/bin:/bin /usr/local/bin/herdr --session hopper server
