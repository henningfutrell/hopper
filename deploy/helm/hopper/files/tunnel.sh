until [ -s /run/hopper-tunnel/key ]; do sleep 1; done
key=$(cat /run/hopper-tunnel/key)
a="http://hopper:${HOPPER_PORT}/tunnel/agent"
p=/var/lib/ngrok/hopper-policy.yml
cat > $p <<'EOF'
on_http_request:
  - actions:
      - type: remove-headers
        config:
          headers:
            - x-hopper-caller
      - type: add-headers
        config:
          headers:
            x-hopper-caller: "${conn.client_ip}"
  - expressions:
      - "!(req.url.path.startsWith('/api/') || req.url.path.startsWith('/ui/api/') || req.url.path == '/ui/auth/api-token' || req.url.path == '/ui/auth/token/refresh') || req.url.path.startsWith('/api/events/stream')"
    actions:
      - type: custom-response
        config:
          status_code: 404
          body: not found
  - expressions:
      - "req.url.path == '/ui/auth/api-token' || req.url.path == '/ui/auth/token/refresh'"
    actions:
      - type: rate-limit
        config:
          name: api-token exchanges and refreshes per caller
          algorithm: sliding_window
          capacity: 5
          rate: 60s
          bucket_key:
            - conn.client_ip
  - actions:
      - type: rate-limit
        config:
          name: requests per caller
          algorithm: sliding_window
          capacity: 120
          rate: 60s
          bucket_key:
            - conn.client_ip
EOF
out=/tmp/ngrok.out; err=/tmp/ngrok.err
rm -f $out; mkfifo $out
pid=; last=; report=stopped
stop() { if [ -n "$pid" ]; then kill "$pid" 2>/dev/null || true; wait "$pid" 2>/dev/null || true; fi; pid=; }
trap 'stop; exit 0' TERM INT
while :; do
  # ngrok stopped. With an error code (a refused authtoken, a domain not reserved), it starts again only with
  # new settings; with none, at the next ask.
  if [ -n "$pid" ] && ! kill -0 "$pid" 2>/dev/null; then
    wait "$pid" 2>/dev/null || true; pid=
    report=$(grep -o 'ERR_NGROK_[0-9]*' $err 2>/dev/null | tail -n 1 || true); report=${report:-exited}
    if [ "$report" = exited ]; then last=; fi
  elif [ -n "$pid" ]; then report=running; fi
  if conf=$(wget -q -T 5 -O - --header "authorization: Bearer $key" "$a?ngrok=$report" 2>/dev/null); then
    if [ "$conf" != "$last" ]; then
      stop; last=$conf; rm -f $err; report=stopped
      url=$(printf '%s\n' "$conf" | sed -n 's/^url=//p'); tok=$(printf '%s\n' "$conf" | sed -n 's/^authtoken=//p')
      if [ -n "$url" ] && [ -n "$tok" ]; then
        echo "tunnel: starting ngrok at $url"
        T=$tok awk '{ gsub(ENVIRON["T"], "[authtoken]"); print; fflush(); if ($0 ~ /lvl=(eror|crit)|ERR_NGROK_/) { print >> "/tmp/ngrok.err"; fflush("/tmp/ngrok.err") } }' < $out &
        NGROK_AUTHTOKEN=$tok ngrok --config=/var/lib/ngrok/ngrok.yml http "http://hopper:${HOPPER_PORT}" --url "$url" --traffic-policy-file $p --log stdout > $out 2>&1 &
        pid=$!; report=running
      else
        echo "tunnel: remote access is off"
      fi
      unset tok
    fi
  fi
  sleep 10 & wait $! || true
done
