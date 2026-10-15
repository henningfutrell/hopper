until [ -s /run/hopper-tunnel/key ]; do sleep 1; done
key=$(cat /run/hopper-tunnel/key)
a="http://hopper:${HOPPER_PORT}/tunnel/agent"
pid=; last=; report=stopped
stop() { if [ -n "$pid" ]; then kill "$pid" 2>/dev/null || true; wait "$pid" 2>/dev/null || true; fi; pid=; }
trap 'stop; exit 0' TERM INT
while :; do
  # cloudflared stopped: it starts again at the next ask.
  if [ -n "$pid" ] && ! kill -0 "$pid" 2>/dev/null; then
    wait "$pid" 2>/dev/null || true; pid=; report=exited; last=
  elif [ -n "$pid" ]; then report=running; fi
  if conf=$(curl -fsS -m 5 -H "authorization: Bearer $key" "$a?cloudflared=$report" 2>/dev/null); then
    if [ "$conf" != "$last" ]; then
      stop; last=$conf; report=stopped
      tok=$(printf '%s\n' "$conf" | sed -n 's/^token=//p')
      if [ -n "$tok" ]; then
        echo "cloudflared: starting the tunnel"
        TUNNEL_TOKEN=$tok cloudflared tunnel --no-autoupdate --metrics 0.0.0.0:2000 run &
        pid=$!; report=running
      else
        echo "cloudflared: remote access is off, or runs through ngrok"
      fi
      unset tok
    fi
  fi
  sleep 10 & wait $! || true
done
