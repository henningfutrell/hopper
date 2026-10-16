#!/usr/bin/env bash
# A compose install moved onto Kubernetes (issue #1373, docs/kubernetes.md): a cluster on this host, the data moved into
# the Helm chart's release, and the cutover. Every image carries this file. Save it beside compose.yaml and master-key.sh,
# then run it in that folder:
#
#   podman run --rm <image> hopper cluster script > hopper-cluster.sh
#   bash hopper-cluster.sh bootstrap [--use-existing]
#                         a small cluster on this host: k3s, rootless, under the user unit hopper-k3s.service. It has its
#                         own container store: no Podman container, image or volume is touched. Prints the kubeconfig. A
#                         cluster there is already stops it, unless --use-existing: then it prints that cluster's kubeconfig
#   bash hopper-cluster.sh migrate [--namespace NS] [--release NAME] [--chart DIR] [--master-key-secret NAME]
#                         [--external-secret-store NAME --external-secret-key KEY [--external-secret-kind KIND]]
#                         [--set key=value]...
#                         the compose install into the chart's release, then the cutover: see migrate() below
#   bash hopper-cluster.sh rollback
#                         the cluster's hopper scaled to 0, the compose stack started again. Nothing is deleted
#
# The master key is never written to a file here: it is read from the install's launch source (the key sealed to this
# host, the hopper container's launch environment, HOPPER_MASTER_KEY, else asked on the terminal), held in this process,
# and handed on a pipe to the chart's Secret. With --master-key-secret, the person made that Secret in the namespace
# (key master-key), and with --external-secret-store their own store holds it (the External Secrets Operator fills the
# Secret): then this script never reads the key, from the launch source or from the Secret. A pod of the hopper's image,
# with the Secret mounted, works its fingerprint out in the cluster. Every way, the fingerprint must match the running
# hopper's before anything stops.
#
#   HOPPER_CLUSTER_DIR   where bootstrap keeps the cluster (bin/, data/, kubeconfig.yaml) and migrate its state
#                        (default: ${XDG_DATA_HOME:-~/.local/share}/hopper/cluster)
#   HOPPER_K3S_VERSION, HOPPER_HELM_VERSION   the versions bootstrap installs
#   HOPPER_CLUSTER_WAIT  seconds bootstrap waits for the node (default: 300)
#
# Everything is in main(), called on the last line, so a download cut short runs nothing.
set -euo pipefail

PROJECT=hopper
UNIT=hopper-k3s.service
SERVICE=hopper-compose.service
CHECK=hopper-compose-check.timer

main() {
  local command="${1:-}"
  [ $# -eq 0 ] || shift
  DIR="${HOPPER_CLUSTER_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/hopper/cluster}"
  BIN="$DIR/bin"
  PATH="$BIN:$PATH"
  case "$command" in
    bootstrap) bootstrap "$@" ;;
    migrate) migrate "$@" ;;
    rollback) [ $# -eq 0 ] || usage; rollback_from_state ;;
    *) usage ;;
  esac
}

usage() { fail 'usage: bash hopper-cluster.sh bootstrap [--use-existing] | migrate [--namespace NS] [--release NAME] [--chart DIR] [--master-key-secret NAME] [--external-secret-store NAME --external-secret-key KEY [--external-secret-kind KIND]] [--set key=value]... | rollback'; }

# ---- bootstrap ----

K3S_VERSION_DEFAULT='v1.33.1+k3s1'
HELM_VERSION_DEFAULT='v3.19.0'

bootstrap() {
  local use_existing=
  while [ $# -gt 0 ]; do
    case "$1" in
      --use-existing) use_existing=1 ;;
      *) usage ;;
    esac
    shift
  done
  local kube="$DIR/kubeconfig.yaml"
  local existing; existing="$(existing_cluster)"
  if [ -n "$existing" ]; then
    [ -n "$use_existing" ] || fail "a cluster is already there ($existing): nothing changed. Use it: bash hopper-cluster.sh bootstrap --use-existing"
    say "uses the cluster that is there: $existing"
    printf '%s\n' "${existing#*: }"
    return
  fi
  prerequisites
  local arch; arch="$(arch_name)"
  install_k3s "$arch"
  install_helm "$arch"
  mkdir -p "$DIR/data" "$(unit_dir)"
  write_unit "$kube"
  linger
  systemctl --user daemon-reload
  systemctl --user enable --now "$UNIT" >/dev/null 2>&1 || fail "systemctl --user enable --now $UNIT failed: see journalctl --user -u $UNIT -n 50"
  wait_for_node "$kube"
  say "the cluster runs under $UNIT, with its own container store: Podman's containers, images and volumes are untouched"
  say "use it: export KUBECONFIG=$kube PATH=$BIN:\$PATH; then: bash hopper-cluster.sh migrate"
  printf '%s\n' "$kube"
}

# A cluster this host already has, as "<what>: <its kubeconfig>", or nothing.
existing_cluster() {
  local kube="$DIR/kubeconfig.yaml"
  if [ -f "$(unit_dir)/$UNIT" ] || [ -f "$kube" ]; then printf 'bootstrapped here: %s' "$kube"; return; fi
  if [ -f /etc/rancher/k3s/k3s.yaml ] || systemctl is-active --quiet k3s 2>/dev/null; then printf 'k3s on this host: %s' /etc/rancher/k3s/k3s.yaml; return; fi
  local config="${KUBECONFIG:-$HOME/.kube/config}"
  if command -v kubectl >/dev/null && [ -f "${config%%:*}" ] && kubectl version --request-timeout=5s >/dev/null 2>&1; then
    printf 'the current kubectl context: %s' "$config"
  fi
}

# Rootless k3s needs what rootless Podman needs, and cgroup v2 with cpu, memory and pids delegated to this user.
prerequisites() {
  command -v systemctl >/dev/null && systemctl --user show-environment >/dev/null 2>&1 \
    || fail 'needs systemd running for this user (systemctl --user fails). In WSL: [boot] systemd=true in /etc/wsl.conf, then wsl --shutdown'
  local missing=() t
  for t in curl sha256sum newuidmap newgidmap; do command -v "$t" >/dev/null || missing+=("$t"); done
  command -v slirp4netns >/dev/null || missing+=(slirp4netns)
  [ ${#missing[@]} -eq 0 ] || fail "needs ${missing[*]} on PATH (Debian/Ubuntu: sudo apt install curl coreutils uidmap slirp4netns; Fedora: sudo dnf install curl coreutils shadow-utils slirp4netns). Nothing changed"
  local user; user="$(id -un)"
  grep -q "^$user:" /etc/subuid 2>/dev/null || fail "no subordinate user ids for $user in /etc/subuid: sudo usermod --add-subuids 100000-165535 --add-subgids 100000-165535 $user. Nothing changed"
  local cgroups="${HOPPER_CGROUP_ROOT:-/sys/fs/cgroup}"
  [ -f "$cgroups/cgroup.controllers" ] || fail 'needs cgroup v2 (the unified hierarchy). Nothing changed'
  local delegated="$cgroups/user.slice/user-$(id -u).slice/user@$(id -u).service/cgroup.controllers" c
  for c in cpu memory pids; do
    grep -qw "$c" "$delegated" 2>/dev/null || fail "the cgroup controller $c is not delegated to $user: sudo mkdir -p /etc/systemd/system/user@.service.d && printf '[Service]\nDelegate=cpu cpuset io memory pids\n' | sudo tee /etc/systemd/system/user@.service.d/delegate.conf && sudo systemctl daemon-reload, then log in again. Nothing changed"
  done
}

arch_name() {
  case "$(uname -m)" in
    x86_64 | amd64) printf amd64 ;;
    aarch64 | arm64) printf arm64 ;;
    *) fail "no k3s for $(uname -m): amd64 or arm64" ;;
  esac
}

# Downloads $1 to $2, checked against the sha256 $3 names.
download() {
  local url=$1 out=$2 sum=$3
  curl -fsSL --retry 3 -o "$out.next" "$url" || { rm -f "$out.next"; fail "the download of $url failed. Nothing changed"; }
  printf '%s  %s\n' "$sum" "$out.next" | sha256sum -c --quiet - >/dev/null 2>&1 || { rm -f "$out.next"; fail "$url does not match its checksum. Nothing changed"; }
  mv "$out.next" "$out"
}

install_k3s() {
  local arch=$1 version="${HOPPER_K3S_VERSION:-$K3S_VERSION_DEFAULT}"
  local base="https://github.com/k3s-io/k3s/releases/download/${version//+/%2B}" file=k3s
  [ "$arch" = amd64 ] || file="k3s-$arch"
  mkdir -p "$BIN"
  local sum; sum="$(curl -fsSL --retry 3 "$base/sha256sum-$arch.txt" | awk -v f="$file" '$2 == f { print $1 }')" || true
  [ -n "$sum" ] || fail "no checksum of $file in $base/sha256sum-$arch.txt. Nothing changed"
  say "install k3s $version: $BIN/k3s"
  download "$base/$file" "$BIN/k3s" "$sum"
  chmod 755 "$BIN/k3s"
  # k3s answers as kubectl when called so.
  ln -sf k3s "$BIN/kubectl"
}

install_helm() {
  local arch=$1 version="${HOPPER_HELM_VERSION:-$HELM_VERSION_DEFAULT}"
  local name="helm-$version-linux-$arch.tar.gz"
  local sum; sum="$(curl -fsSL --retry 3 "https://get.helm.sh/$name.sha256sum" | awk '{ print $1 }')" || true
  [ -n "$sum" ] || fail "no checksum for https://get.helm.sh/$name. Nothing changed"
  say "install helm $version: $BIN/helm"
  download "https://get.helm.sh/$name" "$DIR/$name" "$sum"
  tar -xzf "$DIR/$name" -C "$BIN" --strip-components=1 "linux-$arch/helm"
  rm -f "$DIR/$name"
  chmod 755 "$BIN/helm"
}

unit_dir() { printf '%s/systemd/user' "${XDG_CONFIG_HOME:-$HOME/.config}"; }

write_unit() {
  local kube=$1 units; units="$(unit_dir)"
  # k3s's own rootless unit (docs.k3s.io "Rootless"), with its data, its kubeconfig and its binaries here. No traefik:
  # nothing here needs an ingress, and it would take ports 80 and 443. The service load balancer stays: a LoadBalancer
  # Service gets a port on this host.
  cat >"$units/$UNIT.next" <<EOF
# Made by hopper-cluster.sh bootstrap (issue #1373): the hopper's cluster, k3s rootless. Its data: $DIR/data.
[Unit]
Description=hopper: the local Kubernetes cluster (k3s, rootless)
Wants=network-online.target
After=network-online.target

[Service]
Type=simple
Environment="PATH=$BIN:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
ExecStart="$BIN/k3s" server --rootless --data-dir "$DIR/data" --write-kubeconfig "$kube" --write-kubeconfig-mode 600 --disable traefik
ExecReload=/bin/kill -s HUP \$MAINPID
TimeoutSec=0
RestartSec=2
Restart=always
StartLimitBurst=3
StartLimitInterval=60s
LimitNOFILE=infinity
LimitNPROC=infinity
LimitCORE=infinity
TasksMax=infinity
Delegate=yes
KillMode=mixed

[Install]
WantedBy=default.target
EOF
  mv "$units/$UNIT.next" "$units/$UNIT"
  say "wrote $units/$UNIT"
}

# Linger: the cluster starts at boot and stays after the last logout.
linger() {
  local user="${USER:-$(id -un)}"
  [ "$(loginctl show-user "$user" -p Linger --value 2>/dev/null || true)" != yes ] || return 0
  loginctl enable-linger "$user" >/dev/null 2>&1 \
    || say "linger is off, and this user cannot turn it on: the cluster starts only once $user logs in. Turn it on: sudo loginctl enable-linger $user"
}

wait_for_node() {
  local kube=$1 waited=0 limit="${HOPPER_CLUSTER_WAIT:-300}"
  say 'wait for the node to be ready'
  until [ -f "$kube" ] && KUBECONFIG="$kube" kubectl wait --for=condition=Ready node --all --timeout=10s >/dev/null 2>&1; do
    [ "$waited" -lt "$limit" ] || fail "the node is not ready after ${limit}s: see journalctl --user -u $UNIT -n 50. To remove it: systemctl --user disable --now $UNIT; rm -rf $DIR"
    sleep 5
    waited=$((waited + 5))
  done
}

# ---- migrate ----

# migrate, step by step. Until step 5 the compose hopper runs on, and a failure changes nothing of it. From step 5, a
# failure rolls back by itself: the cluster's hopper goes to 0, and the compose stack starts again.
#   1. checks: kubectl, helm, the cluster, the release not there yet, the compose stack, its image, no local KMS; the master
#      key from the launch source, and its fingerprint against the running hopper's
#   2. the namespace; the master key Secret (unless an outside store fills it); the carried runtime settings
#   3. helm install, the hopper at 0 replicas: its Postgres, OpenFGA and Solr come up empty
#   4. with the person's own Secret or an outside store: that Secret, checked against the fingerprint in a pod
#   5. the compose watchdog off, and the compose hopper stopped: nothing writes its database any more
#   6. the database (and with it OpenFGA's store, schema openfga) dumped from compose's Postgres into the chart's. Solr
#      builds its index again from it
#   7. OpenFGA's migration again; the hopper scaled to 1
#   8. the cluster's hopper: healthy, the same fingerprint, GitHub reachable; then its home (the claude sign-in) copied in
#   9. the compose stack stopped, never removed: its containers, images and volumes stay
migrate() {
  local namespace=hopper release=hopper chart='' given='' store='' store_key='' store_kind=ClusterSecretStore sets=()
  while [ $# -gt 0 ]; do
    case "$1" in
      --namespace) namespace="${2:?--namespace NS}"; shift ;;
      --release) release="${2:?--release NAME}"; shift ;;
      --chart) chart="${2:?--chart DIR}"; shift ;;
      --master-key-secret) given="${2:?--master-key-secret NAME}"; shift ;;
      --external-secret-store) store="${2:?--external-secret-store NAME}"; shift ;;
      --external-secret-key) store_key="${2:?--external-secret-key KEY}"; shift ;;
      --external-secret-kind) store_kind="${2:?--external-secret-kind KIND}"; shift ;;
      --set) sets+=(--set "${2:?--set key=value}"); shift ;;
      *) usage ;;
    esac
    shift
  done
  [ -z "$store" ] || [ -n "$store_key" ] || fail '--external-secret-store needs --external-secret-key: the remote key of the master key'
  NS=$namespace
  RELEASE=$release
  FULL="$(fullname "$release")"
  [ -n "${KUBECONFIG:-}" ] || [ ! -f "$DIR/kubeconfig.yaml" ] || export KUBECONFIG="$DIR/kubeconfig.yaml"

  # 1. Checks.
  local t
  for t in kubectl helm; do command -v "$t" >/dev/null || fail "needs $t on PATH (bootstrap installs both in $BIN). Nothing changed"; done
  kubectl version --request-timeout=10s >/dev/null 2>&1 || fail "no cluster answers (KUBECONFIG=${KUBECONFIG:-~/.kube/config}): make one with bash hopper-cluster.sh bootstrap. Nothing changed"
  ! helm status "$release" --namespace "$namespace" >/dev/null 2>&1 \
    || fail "the release $release is already in the namespace $namespace: nothing changed. Name another (--release, --namespace), or remove it: helm uninstall $release --namespace $namespace, and its kept volumes and Secrets (docs/kubernetes.md \"Start again\")"
  find_stack
  local env; env="$(container_env "$HOPPER_ID")"
  local image; image="$("$RUNTIME" inspect --format '{{.Config.Image}}' "$HOPPER_ID")"
  local profiles; profiles="$(value_of COMPOSE_PROFILES "$env")"
  [[ ",$profiles," != *,kms,* ]] && [ -z "$(value_of HOPPER_KMS_URL "$env")" ] \
    || fail 'this install runs the local KMS (profile kms): the keys of its data key are in the compose volume kms, and the chart'"'"'s local KMS starts with none. Turn the KMS off first (docs/deploy.md "The local KMS"). Nothing changed'
  local repository="${image%:*}" tag="${image##*:}"
  [[ "$image" == *:* && "$tag" != */* ]] || { repository=$image; tag=latest; }
  if [[ "$repository" == localhost/* ]] && ! printf '%s\n' "${sets[@]}" | grep -q '^image\.repository='; then
    fail "the compose hopper runs $image, an image of this host only: the cluster cannot pull it. Name one it can: --set image.repository=<registry/name> --set image.tag=<tag>. Nothing changed"
  fi
  [ -n "$chart" ] || chart="$(chart_from_image "$image")"
  [ -f "$chart/Chart.yaml" ] || fail "no Helm chart at $chart. Nothing changed"
  local port; port="$(value_of HOPPER_PORT "$env")"; port="${port:-4790}"
  local want; want="$(compose_fingerprint)"
  local secret="${given:-$FULL-master-key}" key=''
  if [ -z "$given" ] && [ -z "$store" ]; then
    master_key
    key=$MASTER_KEY
    MASTER_KEY=''
    local have; have="$(fingerprint_of "$key")"
    [ "$have" = "$want" ] || fail "the master key from $KEY_SOURCE has the fingerprint $have, the running hopper $want: give the right one (HOPPER_MASTER_KEY, or bash master-key.sh seal). Nothing changed"
    say "the master key from $KEY_SOURCE matches the running hopper (fingerprint $want)"
  fi
  if [ -n "$given" ] && [ -z "$store" ]; then
    secret_has_key "$secret" \
      || fail "no Secret $secret with a master-key in the namespace $namespace: make it first (docs/kubernetes.md \"The master key\"). Nothing changed"
  fi

  # 2. The namespace, the master key Secret and the carried settings.
  kubectl get namespace "$namespace" >/dev/null 2>&1 || kubectl create namespace "$namespace" >/dev/null
  if [ -n "$key" ]; then
    put_master_key "$secret" "$key"
  fi
  key=''
  local carried="$FULL-carried-env"
  local values; values="$(helm_values "$env" "$repository" "$tag" "$port" "$profiles" "$secret" "$store" "$store_key" "$store_kind" "$carried")"
  put_carried "$carried" "$env"

  # 3. The release, the hopper at 0.
  say "helm install $release (namespace $namespace), the hopper at 0 replicas"
  # Not helm's --wait: it waits for the hopper's home volume too, which a WaitForFirstConsumer StorageClass (kind's, k3s's
  # local-path) binds only once a hopper pod takes it, and the hopper is at 0. So the parts are waited for here.
  printf '%s' "$values" | helm install "$release" "$chart" --namespace "$namespace" -f - "${sets[@]}" --timeout 15m >&2 \
    || fail "helm install failed (above). The compose stack runs on as before. Remove the release: helm uninstall $release --namespace $namespace"
  wait_release "$namespace" "$release" \
    || fail "the release did not come up (above). The compose stack runs on as before. Remove the release: helm uninstall $release --namespace $namespace"

  # 4. The person's own Secret, or the one an outside store filled, checked in the cluster: this script never reads it.
  if [ -n "$given" ] || [ -n "$store" ]; then
    [ -z "$store" ] || wait_filled "$secret" "$store"
    local found; found="$(secret_fingerprint "$secret")" \
      || fail "the key check pod did not run (above): the Secret $secret is not checked. The compose stack runs on as before. Remove the release: helm uninstall $release --namespace $namespace"
    [ "$found" = "$want" ] \
      || fail "the Secret $secret holds the master key of fingerprint ${found:-none}, the running hopper $want. The compose stack runs on as before. Put the right key in it, then: helm uninstall $release --namespace $namespace, and migrate again"
    say "the Secret $secret${store:+ from $store} holds the running hopper's master key (fingerprint $want)"
  fi

  # 5-8. The cutover. Each step says why it stopped; any of them rolls back.
  write_state
  trap 'rollback "interrupted"' INT TERM
  cutover "$chart" "$want" || rollback 'the cutover stopped (above)'
  trap - INT TERM

  # 9. The compose stack stops; nothing of it is removed.
  local running; running="$("$RUNTIME" ps -q --filter "label=com.docker.compose.project=$PROJECT")"
  # shellcheck disable=SC2086
  [ -z "$running" ] || "$RUNTIME" stop $running >/dev/null
  say "done: the hopper runs in the cluster (namespace $namespace, release $release). The compose stack is stopped, not removed: its containers, images and volumes stay"
  say "machines dial in again at the address they joined: the cluster hopper answers on port $port$( [ "$(service_type)" = LoadBalancer ] && printf ' of this host' || printf ' only through its Service: see docs/kubernetes.md "Machines after the cutover"')"
  say "roll back: bash hopper-cluster.sh rollback"
}

# The release's StatefulSets and Deployments rolled out, and OpenFGA's migration Job complete.
wait_release() {
  local ns=$1 release=$2 part parts
  parts="$(kubectl --namespace "$ns" get statefulset,deployment -l "app.kubernetes.io/instance=$release" -o name)" || return 1
  for part in $parts; do
    kubectl --namespace "$ns" rollout status "$part" --timeout=15m >&2 || return 1
  done
  kubectl --namespace "$ns" wait --for=condition=complete job -l "app.kubernetes.io/instance=$release,app.kubernetes.io/component=openfga-migrate" --timeout=15m >&2
}

# Steps 5 to 8. Called in a list, so errexit is off here: every command answers for itself.
cutover() {
  local chart=$1 want=$2
  quiet_watchdog
  say 'stop the compose hopper: nothing writes its database any more'
  "$RUNTIME" stop "$HOPPER_ID" ${VAULT_ID:+"$VAULT_ID"} >/dev/null || return 1
  move_database || return 1
  kubectl --namespace "$NS" delete job -l "app.kubernetes.io/instance=$RELEASE,app.kubernetes.io/component=openfga-migrate" --ignore-not-found >/dev/null || return 1
  kubectl --namespace "$NS" rollout restart "deployment/$FULL-openfga" >/dev/null || return 1
  say 'start the cluster hopper on the moved data'
  helm upgrade "$RELEASE" "$chart" --namespace "$NS" --reuse-values --set replicas=1 --wait --wait-for-jobs --timeout 15m >&2 \
    || { say 'helm upgrade did not bring the cluster hopper up'; return 1; }
  verify "$want" || return 1
  copy_home || return 1
}

# The chart's fullname: the release, or <release>-hopper when it does not name hopper (the chart's _helpers.tpl).
fullname() {
  local r=$1 n
  if [[ "$r" == *hopper* ]]; then n=$r; else n="$r-hopper"; fi
  n="${n:0:50}"
  printf '%s' "${n%-}"
}

# The runtime the stack runs in, and its hopper, postgres and hopper-vault containers. Sets RUNTIME, HOPPER_ID, PG_ID,
# VAULT_ID, UNIT_THERE.
find_stack() {
  local r
  RUNTIME=
  for r in podman docker; do
    command -v "$r" >/dev/null || continue
    [ -n "$("$r" ps -aq --filter "label=com.docker.compose.project=$PROJECT" 2>/dev/null || true)" ] && { RUNTIME=$r; break; }
  done
  [ -n "$RUNTIME" ] || fail "no compose stack $PROJECT here (podman or docker). Nothing changed"
  HOPPER_ID="$(service_id hopper)"
  PG_ID="$(service_id postgres)"
  VAULT_ID="$(service_id hopper-vault)"
  [ -n "$HOPPER_ID" ] || fail 'the compose hopper does not run: start it (systemctl --user start hopper-compose.service), so its key can be checked. Nothing changed'
  [ -n "$PG_ID" ] || fail 'the compose stack'"'"'s postgres does not run. Nothing changed'
  UNIT_THERE=
  if systemctl --user cat "$SERVICE" >/dev/null 2>&1; then UNIT_THERE=1; fi
}

service_id() {
  "$RUNTIME" ps -q --filter "label=com.docker.compose.project=$PROJECT" --filter "label=com.docker.compose.service=$1" 2>/dev/null | head -n 1 || true
}

# A container's launch environment, one NAME=value a line, without the master key: it is read apart (master_key).
container_env() {
  "$RUNTIME" inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$1" | grep -v '^HOPPER_MASTER_KEY' || true
}

# The value of $1 in the environment lines $2.
value_of() {
  local line
  while IFS= read -r line; do
    [ "${line%%=*}" != "$1" ] || { printf '%s' "${line#*=}"; return; }
  done <<<"$2"
}

# The chart of the hopper's image, unpacked to the state folder (the image carries it from issue #1373 on).
chart_from_image() {
  local image=$1 out="$DIR/chart"
  rm -rf "$out"
  mkdir -p "$out"
  "$RUNTIME" run --rm --network none --entrypoint tar "$image" -C /app/deploy/helm -cf - hopper 2>/dev/null | tar -xf - -C "$out" 2>/dev/null \
    || fail "the image $image carries no Helm chart: update the compose install first, or give the chart: --chart <a checkout>/deploy/helm/hopper. Nothing changed"
  printf '%s' "$out/hopper"
}

# The master key, from the install's launch source, in this order: HOPPER_MASTER_KEY given here; the key sealed to this
# host (master-key.sh in this folder); the hopper container's launch environment; the terminal. Sets MASTER_KEY and
# KEY_SOURCE. The key moves only on pipes and in variables: no here-string, which an older bash writes to a file.
master_key() {
  MASTER_KEY="${HOPPER_MASTER_KEY:-}"
  KEY_SOURCE='HOPPER_MASTER_KEY'
  [ -z "$MASTER_KEY" ] || return 0
  if [ -f master-key.sh ] && { [ -f hopper-master-key.cred ] || [ -f hopper-master-key.enc ]; }; then
    MASTER_KEY="$(bash master-key.sh unseal)" || fail 'the master key sealed here does not unseal (above). Nothing changed'
    KEY_SOURCE='the key sealed to this host'
    return 0
  fi
  MASTER_KEY="$("$RUNTIME" inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$HOPPER_ID" | sed -n 's/^HOPPER_MASTER_KEY=//p' | head -n 1)"
  KEY_SOURCE="the compose hopper's launch environment"
  [ -z "$MASTER_KEY" ] || return 0
  local tty="${HOPPER_KEY_TTY:-/dev/tty}"
  { : <"$tty"; } 2>/dev/null || fail 'no master key: the hopper was started with none, and none is sealed here. Give it as HOPPER_MASTER_KEY, or run this in a terminal. Nothing changed'
  printf 'hopper-cluster: paste the master key from your password manager (nothing is shown): ' >&2
  IFS= read -rs MASTER_KEY <"$tty" || true
  printf '\n' >&2
  KEY_SOURCE='the terminal'
}

# The short fingerprint of a key, as the hopper shows it (src/secrets/master-key.ts fingerprintOf, token-box.ts decodeKey):
# HMAC-SHA256 under the key of a fixed label, its first 16 hex digits. Worked out by node in the compose hopper, any
# version of it, from the key on stdin (FINGERPRINT_JS), or in a pod from the mounted Secret's file (FINGERPRINT_FILE_JS):
# never an argument.
FINGERPRINT_OF='(t)=>{const k=t.trim();const b=/^[0-9a-fA-F]{64}$/.test(k)?Buffer.from(k,"hex"):/^[A-Za-z0-9+/_-]+={0,2}$/.test(k)?Buffer.from(k,k.includes("-")||k.includes("_")?"base64url":"base64"):undefined;if(!b||b.length!==32)process.exit(2);process.stdout.write(require("node:crypto").createHmac("sha256",b).update("hopper master key fingerprint v1").digest("hex").slice(0,16))}'
FINGERPRINT_JS="let t=\"\";process.stdin.on(\"data\",(d)=>t+=d).on(\"end\",()=>($FINGERPRINT_OF)(t))"
FINGERPRINT_FILE_JS="($FINGERPRINT_OF)(require(\"node:fs\").readFileSync(\"/run/hopper-master-key/master-key\",\"utf8\"))"

fingerprint_of() {
  printf '%s' "$1" | "$RUNTIME" exec -i "$HOPPER_ID" node -e "$FINGERPRINT_JS" 2>/dev/null || printf 'none (no master key)'
}

compose_fingerprint() {
  local status
  status="$("$RUNTIME" exec "$HOPPER_ID" hopper master-key status </dev/null)" || fail 'hopper master-key status failed in the compose hopper (above). Nothing changed'
  printf '%s' "$status" | sed -n 's/.*"fingerprint": *"\([0-9a-f]*\)".*/\1/p' | head -n 1
}

# The master key Secret, from the key on a pipe. One there already must hold the same key.
put_master_key() {
  local name=$1 key=$2
  local there; there="$(kubectl --namespace "$NS" get secret "$name" -o 'jsonpath={.data.master-key}' 2>/dev/null || true)"
  if [ -n "$there" ]; then
    [ "$(printf '%s' "$there" | base64 -d)" = "$key" ] || fail "the Secret $name holds another master key: nothing changed. Remove it, or migrate into another namespace"
    say "the Secret $name holds this master key already"
    return
  fi
  printf '%s' "$key" | kubectl --namespace "$NS" create secret generic "$name" --from-file=master-key=/dev/stdin >/dev/null
  say "put the master key in the Secret $name (from a pipe: no file holds it)"
}

# Whether the Secret $1 has a master-key: only that it is there is answered, never its value.
secret_has_key() {
  [ "$(kubectl --namespace "$NS" get secret "$1" -o 'go-template={{if index .data "master-key"}}yes{{end}}' 2>/dev/null)" = yes ]
}

# The Secret an outside store fills, waited for up to 5 minutes.
wait_filled() {
  local name=$1 store=$2 waited=0
  until secret_has_key "$name"; do
    [ "$waited" -lt 300 ] || fail "the External Secrets Operator did not fill the Secret $name from $store in 5 minutes: see kubectl --namespace $NS describe externalsecret. The compose stack runs on as before"
    sleep 5
    waited=$((waited + 5))
  done
}

# The fingerprint of the master key in the Secret $1, worked out in a one-off pod of the release's hopper image with the
# Secret mounted as the chart mounts it. Only the fingerprint comes out; the pod is removed after.
secret_fingerprint() {
  local name=$1 image pod="$FULL-key-check"
  image="$(kubectl --namespace "$NS" get "deployment/$FULL" -o 'jsonpath={.spec.template.spec.containers[?(@.name=="hopper")].image}')" || return 1
  local spec
  spec="{\"apiVersion\":\"v1\",\"spec\":{\"automountServiceAccountToken\":false,\"enableServiceLinks\":false,\"securityContext\":{\"runAsNonRoot\":true,\"runAsUser\":1000,\"runAsGroup\":1000,\"fsGroup\":1000},"
  spec+="\"containers\":[{\"name\":$(json "$pod"),\"image\":$(json "$image"),\"command\":[\"node\",\"-e\",$(json "$FINGERPRINT_FILE_JS")],"
  spec+="\"securityContext\":{\"allowPrivilegeEscalation\":false,\"capabilities\":{\"drop\":[\"ALL\"]},\"seccompProfile\":{\"type\":\"RuntimeDefault\"}},"
  spec+="\"volumeMounts\":[{\"name\":\"master-key\",\"mountPath\":\"/run/hopper-master-key\",\"readOnly\":true}]}],"
  spec+="\"volumes\":[{\"name\":\"master-key\",\"secret\":{\"secretName\":$(json "$name"),\"defaultMode\":288}}]}}"
  kubectl --namespace "$NS" run "$pod" --rm --attach --quiet --restart=Never --pod-running-timeout=5m --image "$image" --overrides "$spec" </dev/null
}

# The names this script never carries: the chart and compose set them for their own parts.
PLUMBING='^(PATH|HOME|HOSTNAME|TERM|container|NODE_VERSION|YARN_VERSION|HOPPER_DATABASE_URL.*|HOPPER_MASTER_KEY.*|HOPPER_TOKEN_KEY.*|HOPPER_OPENFGA_.*|HOPPER_SOLR_URL|HOPPER_VAULT_URL|HOPPER_VAULT_KEY.*|HOPPER_KMS_.*|HOPPER_TUNNEL_.*|HOPPER_CLOUDFLARED_API|VAULT_TOKEN_FILE|HOPPER_PORT|HOPPER_LAN_NAMES|HOPPER_LAN_PEERS|HOPPER_PODMAN_SOCKET.*|HOPPER_DOCKER_SOCKET.*|HOPPER_IMAGE|COMPOSE_PROFILES|HOPPER_LOCAL_MACHINE|HOPPER_SANDBOX_RUNTIME)$'
SECRET_NAME='KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL'

# The hopper container's own settings: set at launch, not by the image, not plumbing. One NAME=value a line.
carried_settings() {
  local env=$1 image line name
  image="$("$RUNTIME" image inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$("$RUNTIME" inspect --format '{{.Image}}' "$HOPPER_ID")" 2>/dev/null || true)"
  while IFS= read -r line; do
    [ -n "$line" ] && [[ "$line" == *=* ]] || continue
    name="${line%%=*}"
    [ -n "${line#*=}" ] || continue
    [[ "$name" =~ $PLUMBING ]] && continue
    grep -qxF -- "$line" <<<"$image" && continue
    printf '%s\n' "$line"
  done <<<"$env"
}

# A JSON string of $1.
json() {
  local s=$1
  s="${s//\\/\\\\}"; s="${s//\"/\\\"}"; s="${s//$'\t'/\\t}"; s="${s//$'\r'/\\r}"; s="${s//$'\n'/\\n}"
  printf '"%s"' "$s"
}

# The release's values, as JSON (YAML reads it): from compose's image, port, profiles, names and settings.
helm_values() {
  local env=$1 repository=$2 tag=$3 port=$4 profiles=$5 secret=$6 store=$7 store_key=$8 store_kind=$9 carried=${10}
  local names; names="$(lan_names "$env")"
  local extra='' line name sep=''
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    name="${line%%=*}"
    if [[ "$name" =~ $SECRET_NAME ]]; then
      extra+="$sep{\"name\":$(json "$name"),\"valueFrom\":{\"secretKeyRef\":{\"name\":$(json "$carried"),\"key\":$(json "$name")}}}"
    else
      extra+="$sep{\"name\":$(json "$name"),\"value\":$(json "${line#*=}")}"
    fi
    sep=,
  done <<<"$(carried_settings "$env")"
  local key
  if [ -n "$store" ]; then
    key="\"masterKey\":{\"existingSecret\":$(json "$secret"),\"externalSecret\":{\"enabled\":true,\"secretStoreRef\":{\"name\":$(json "$store"),\"kind\":$(json "$store_kind")},\"masterKey\":{\"key\":$(json "$store_key")}}}"
  else
    key="\"masterKey\":{\"existingSecret\":$(json "$secret")}"
  fi
  local vault=false
  [[ ",$profiles," != *,hopper-vault,* ]] || vault=true
  printf '{"replicas":0,"port":%s,"service":{"type":%s},"image":{"repository":%s,"tag":%s},%s,"lanNames":%s,"hopperVault":{"enabled":%s},"extraEnv":[%s]}' \
    "$port" "$(json "$(service_type)")" "$(json "$repository")" "$(json "$tag")" "$key" "$(json "$names")" "$vault" "$extra"
}

# LoadBalancer on the cluster bootstrap made (its load balancer takes this host's port), else ClusterIP.
service_type() {
  if [ "${KUBECONFIG:-}" = "$DIR/kubeconfig.yaml" ]; then printf LoadBalancer; else printf ClusterIP; fi
}

# The names machines reach the hopper by: compose's own (but `hopper`, its compose network name), this host's names, and
# its tailnet name when Tailscale runs.
lan_names() {
  local names=() n
  IFS=, read -ra names <<<"$(value_of HOPPER_LAN_NAMES "$1")"
  names+=("$(hostname 2>/dev/null || true)" "$(hostname -f 2>/dev/null || true)")
  if command -v tailscale >/dev/null; then
    n="$(tailscale status --json 2>/dev/null | sed -n 's/.*"DNSName": *"\([^"]*\)\.".*/\1/p' | head -n 1 || true)"
    names+=("$n")
  fi
  local out='' seen=','
  for n in "${names[@]}"; do
    n="${n// /}"
    [ -n "$n" ] && [ "$n" != hopper ] && [[ "$seen" != *",$n,"* ]] || continue
    out+="${out:+,}$n"
    seen+="$n,"
  done
  printf '%s' "$out"
}

# The carried settings whose names say secret, in a Secret of their own, from a pipe. A value on more than one line is
# left out, and said.
put_carried() {
  local name=$1 env=$2 line lines=''
  while IFS= read -r line; do
    [ -n "$line" ] && [[ "${line%%=*}" =~ $SECRET_NAME ]] || continue
    lines+="$line"$'\n'
  done <<<"$(carried_settings "$env")"
  printf '%s' "$lines" | kubectl --namespace "$NS" create secret generic "$name" --from-env-file=/dev/stdin --dry-run=client -o yaml \
    | kubectl --namespace "$NS" apply -f - >/dev/null
  say "carried the hopper's own settings: $(carried_settings "$env" | sed 's/=.*//' | paste -sd, - || true)"
}

# What rollback needs, without a secret: the cluster's names and how compose ran.
write_state() {
  mkdir -p "$DIR"
  (
    umask 077
    printf 'NS=%q\nRELEASE=%q\nFULL=%q\nRUNTIME=%q\nUNIT_THERE=%q\nKUBECONFIG=%q\n' "$NS" "$RELEASE" "$FULL" "$RUNTIME" "$UNIT_THERE" "${KUBECONFIG:-}" >"$DIR/migration.env"
  )
}

# The user service's watchdog would start the compose hopper again: turned off, and the stack kept from starting at boot.
quiet_watchdog() {
  [ -n "$UNIT_THERE" ] || return 0
  systemctl --user disable "$SERVICE" "$CHECK" >/dev/null 2>&1 || true
  systemctl --user stop "$CHECK" >/dev/null 2>&1 || true
}

# The chart's database made new, then compose's database dumped into it on a pipe. Both are checked to hold the same tables.
move_database() {
  local pod="$FULL-postgres-0"
  say "move the database: compose's postgres into $pod"
  kubectl --namespace "$NS" exec "$pod" -c postgres -- psql -q -v ON_ERROR_STOP=1 -U hopper -d postgres \
    -c 'DROP DATABASE IF EXISTS hopper WITH (FORCE)' -c 'CREATE DATABASE hopper OWNER hopper' >&2 \
    || { say "the chart's database could not be made new"; return 1; }
  "$RUNTIME" exec "$PG_ID" pg_dump -U hopper -d hopper -Fc </dev/null \
    | kubectl --namespace "$NS" exec -i "$pod" -c postgres -- pg_restore -U hopper -d hopper --no-owner --exit-on-error --single-transaction \
    || { say 'the dump into the chart'"'"'s database failed'; return 1; }
  local count="SELECT count(*) FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog', 'information_schema')"
  local from to
  from="$("$RUNTIME" exec "$PG_ID" psql -tA -U hopper -d hopper -c "$count" </dev/null)" || return 1
  to="$(kubectl --namespace "$NS" exec "$pod" -c postgres -- psql -tA -U hopper -d hopper -c "$count")" || return 1
  [ "$from" = "$to" ] || { say "the moved database has $to tables, compose's $from"; return 1; }
  say "moved: $to tables"
}

in_hopper() { kubectl --namespace "$NS" exec "deployment/$FULL" -c hopper -- "$@"; }

verify() {
  local want=$1 port health status fingerprint
  port="$(kubectl --namespace "$NS" get "deployment/$FULL" -o 'jsonpath={.spec.template.spec.containers[?(@.name=="hopper")].ports[0].containerPort}')" || return 1
  health="$(in_hopper node -e "fetch('http://127.0.0.1:$port/api/health').then(async (r) => { process.stdout.write(await r.text()); process.exit(r.ok ? 0 : 1); }, () => process.exit(1))")" \
    || { say "the cluster hopper is not healthy: $health"; return 1; }
  say "health: $health"
  # The chart names the previous-keys file, which a Secret with no previous key does not hold. The daemon reads that as no
  # previous key; the CLI of an image built before issue #1373 stops on it. So the name goes when the file is not there.
  # shellcheck disable=SC2016 # expanded in the pod
  status="$(in_hopper sh -c '[ -e "$HOPPER_MASTER_KEY_PREVIOUS_FILE" ] || unset HOPPER_MASTER_KEY_PREVIOUS_FILE; exec hopper master-key status' </dev/null)" \
    || { say 'hopper master-key status failed in the cluster hopper'; return 1; }
  fingerprint="$(printf '%s' "$status" | sed -n 's/.*"fingerprint": *"\([0-9a-f]*\)".*/\1/p' | head -n 1)"
  [ "$fingerprint" = "$want" ] || { say "the cluster hopper runs on the key of fingerprint ${fingerprint:-none}, not $want"; return 1; }
  say "the cluster hopper runs on the same master key (fingerprint $fingerprint)"
  in_hopper node -e "fetch('https://api.github.com/', { method: 'HEAD' }).then((r) => process.exit(r.status < 500 ? 0 : 1), () => process.exit(1))" \
    || { say 'the cluster hopper does not reach GitHub (https://api.github.com/)'; return 1; }
  say 'the cluster hopper reaches GitHub'
}

# The compose hopper's home (the claude sign-in, git's identity), from the stopped container, into the pod's home volume.
copy_home() {
  "$RUNTIME" cp "$HOPPER_ID:/home/node" - \
    | kubectl --namespace "$NS" exec -i "deployment/$FULL" -c hopper -- tar -xf - -C /home/node --strip-components=1 --no-same-owner \
    || { say "the compose hopper's home did not copy"; return 1; }
  say "copied the compose hopper's home (/home/node) into the cluster hopper's"
}

# Back to compose: the cluster hopper to 0, the compose stack started again. Nothing is deleted.
rollback() {
  trap - INT TERM
  say "$1: roll back"
  kubectl --namespace "$NS" scale "deployment/$FULL" --replicas=0 >/dev/null 2>&1 || true
  start_compose
  fail "rolled back: the compose stack runs again, on its own data. The cluster's release stays, its hopper at 0: remove it with helm uninstall $RELEASE --namespace $NS"
}

start_compose() {
  if [ -n "$UNIT_THERE" ]; then
    systemctl --user enable "$SERVICE" "$CHECK" >/dev/null 2>&1 || true
    systemctl --user restart "$SERVICE" || fail "the start of $SERVICE failed: see journalctl --user -u $SERVICE -n 50"
    systemctl --user restart "$CHECK" >/dev/null 2>&1 || true
  else
    local stopped
    stopped="$("$RUNTIME" ps -aq --filter "label=com.docker.compose.project=$PROJECT" --filter status=exited)"
    for id in $(service_ids_in_order "$stopped"); do "$RUNTIME" start "$id" >/dev/null; done
  fi
}

# Postgres first: every other service waits for it.
service_ids_in_order() {
  local id service rest=()
  for id in $1; do
    service="$("$RUNTIME" inspect --format '{{index .Config.Labels "com.docker.compose.service"}}' "$id")"
    [ "$service" != openfga-migrate ] || continue
    if [ "$service" = postgres ]; then printf '%s\n' "$id"; else rest+=("$id"); fi
  done
  [ ${#rest[@]} -eq 0 ] || printf '%s\n' "${rest[@]}"
}

rollback_from_state() {
  [ -f "$DIR/migration.env" ] || fail "no migration here to roll back ($DIR/migration.env)"
  # shellcheck disable=SC1091
  . "$DIR/migration.env"
  [ -z "$KUBECONFIG" ] || export KUBECONFIG
  say "scale the cluster hopper to 0 (namespace $NS)"
  kubectl --namespace "$NS" scale "deployment/$FULL" --replicas=0 >/dev/null 2>&1 || say "no deployment/$FULL in $NS to scale"
  start_compose
  say "rolled back: the compose stack runs again, on its own data, as before the migration. The cluster's release stays, its hopper at 0"
}

say() { printf 'hopper-cluster: %s\n' "$*" >&2; }
fail() { say "$*"; exit 1; }

main "$@"
