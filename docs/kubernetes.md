# Move a compose install onto Kubernetes

Issue #1373. This page tells how to move a hopper that runs in containers with Podman (or Docker) compose onto a
Kubernetes cluster: make a small cluster on the same host, move the data into the Helm chart's release, and cut over.
To roll back, start compose again. No step deletes data, a container, an image or a volume of the compose install.

The chart itself, and a fresh install on a cluster, are in `docs/deploy.md` "On Kubernetes, with Helm".

One script does the work: `scripts/hopper-cluster.sh`. Every image carries it. Save it beside `compose.yaml` and
`master-key.sh`, and run it in that folder:

```sh
podman run --rm ghcr.io/henningfutrell/hopper:latest hopper cluster script > hopper-cluster.sh
```

| step | command | what it changes |
|---|---|---|
| 1. Bootstrap | `bash hopper-cluster.sh bootstrap` | installs k3s and helm for your user, and starts the cluster under a user unit |
| 2. Migrate and cut over | `bash hopper-cluster.sh migrate` | installs the chart, moves the database, starts the cluster hopper, stops the compose stack |
| Rollback | `bash hopper-cluster.sh rollback` | stops the cluster hopper, starts the compose stack again |

## 1. Bootstrap: a cluster on this host

```sh
bash hopper-cluster.sh bootstrap                  # prints the kubeconfig path
export KUBECONFIG=~/.local/share/hopper/cluster/kubeconfig.yaml PATH=~/.local/share/hopper/cluster/bin:$PATH
```

- **What it installs.** k3s (`HOPPER_K3S_VERSION`, default `v1.33.1+k3s1`) and helm (`HOPPER_HELM_VERSION`, default
  `v3.19.0`), downloaded from their releases and checked against the checksums those releases publish. A download that
  does not match is removed, and nothing changes. `kubectl` is k3s itself. All of it goes in
  `${HOPPER_CLUSTER_DIR:-~/.local/share/hopper/cluster}`: `bin/`, `data/` (the cluster's state and its images) and
  `kubeconfig.yaml` (mode 600).
- **Rootless.** k3s runs as your user (`k3s server --rootless`), under the user unit `hopper-k3s.service`, with linger,
  so it starts at boot. Traefik is off: nothing here needs an ingress, and it would take ports 80 and 443.
- **Next to Podman.** k3s has its own container store, in its `data/` folder. It does not use Podman, and it touches no
  Podman container, image or volume. The compose stack runs on as before.
- **What it needs.** systemd for your user, `curl`, `newuidmap` and `newgidmap` (the `uidmap` package), `slirp4netns`,
  subordinate ids for your user in `/etc/subuid`, and cgroup v2 with the controllers `cpu`, `memory` and `pids`
  delegated to your user. Rootless Podman needs most of these too. When one is missing, bootstrap stops before it
  changes anything, and gives the command that adds it. The commands that need root, you run yourself; bootstrap runs
  none.
- **A cluster that is there already.** Bootstrap stops when it finds one: its own from before, k3s on the host
  (`/etc/rancher/k3s/k3s.yaml`), or a cluster the current `kubectl` context reaches. To use that cluster:
  `bash hopper-cluster.sh bootstrap --use-existing` prints its kubeconfig, and installs nothing.
- **Remove it.** `systemctl --user disable --now hopper-k3s.service`, then remove
  `~/.config/systemd/user/hopper-k3s.service` and the cluster folder. This deletes the cluster and its data: do it
  only after a rollback, or before a migration.

Any other cluster works too: give its kubeconfig in `KUBECONFIG`, and put `kubectl` and `helm` on `PATH`.

## 2. Migrate and cut over

Start it when no job runs: the cutover stops the compose hopper, and a job at work loses its session as at a restart.

```sh
bash hopper-cluster.sh migrate                    # in the folder of compose.yaml and master-key.sh
```

Options: `--namespace` (default `hopper`), `--release` (default `hopper`), `--chart <dir>` (default: the chart in the
compose hopper's image), `--set key=value` (more chart values, as `helm install --set`), and the outside store options
below.

What it does, in order:

1. **Checks, while compose runs.** `kubectl` and `helm`; the cluster answers; the release is not there yet; the compose
   stack runs; the image is one the cluster can pull (a `localhost/` image needs `--set image.repository=… --set
   image.tag=…`); the local KMS is off. Then the master key: from `HOPPER_MASTER_KEY` given here, else the key sealed to
   this host (`master-key.sh`), else the compose hopper's launch environment, else asked on the terminal. Its
   fingerprint must be the running hopper's (`hopper master-key status`). If one check fails, nothing changes.
2. **The master key and the settings.** The key goes into the Secret `hopper-master-key` on a pipe. The chart mounts it
   as a file. The hopper's own launch settings go to the chart (see "What is carried" below).
3. **The release, with the hopper at 0.** `helm install` with `replicas=0`. Its Postgres, OpenFGA and Solr start empty.
   The compose hopper still runs.
4. **The cutover starts.** The user service's port check (`hopper-compose-check.timer`) stops, and the user service no
   longer starts the stack at boot. The compose hopper stops: nothing writes its database now.
5. **The data.** `pg_dump` of compose's Postgres goes on a pipe into `pg_restore` in the chart's Postgres, into a new,
   empty database. That database holds OpenFGA's store too (the schema `openfga`). Both sides must then hold the same
   number of tables. Solr is not moved: the hopper builds its index again from the database.
6. **The cluster hopper starts.** OpenFGA's migration runs again (it only adds what its schema lacks), then
   `helm upgrade --set replicas=1`.
7. **Checks in the cluster.** The hopper's health is ok; it runs on the master key of the same fingerprint; it reaches
   GitHub (`https://api.github.com/`). Then the compose hopper's home (`/home/node`: the claude sign-in, git's identity)
   is copied into the cluster hopper's home volume.
8. **The compose stack stops.** `podman stop` of each container: they are not removed, and their images and volumes
   stay.

If a step from 4 to 7 fails, or you stop the script (Ctrl-C), it rolls back by itself (below), and says which step
stopped. The cluster's release stays, with its hopper at 0.

### The master key: a Secret, or an outside store

The master key never goes to a file, a log or a command line here. The script holds it in memory, and gives it to the
next command on a pipe. You choose where the cluster keeps it:

- **A Secret (the default).** The script puts the key in the Secret `<release>-master-key`, under `master-key`. The
  chart mounts it as a file (`masterKey.existingSecret`). The key is then in the cluster's store (etcd). k3s keeps it in
  its `data/` folder, readable only by you. Choose this for a cluster on this host.
- **An outside store.** Put the key in your store first, under a key of your choice. The External Secrets Operator must
  run in the cluster, with a `ClusterSecretStore` (or `SecretStore`) for your store. Then:

  ```sh
  bash hopper-cluster.sh migrate --external-secret-store <store name> --external-secret-key <remote key> \
    [--external-secret-kind SecretStore]
  ```

  The chart makes the `ExternalSecret` (`masterKey.externalSecret.*`). The script waits up to 5 minutes for the
  operator to fill the Secret, and checks its fingerprint before the compose hopper stops. The script writes nothing to
  your store. Choose this when the cluster is shared, or when a store is where your keys are kept already.

AWS KMS (`kms.aws.*`) wraps only the vault's data key, not the master key ("AWS KMS for the vault" in
`docs/deploy.md`): give it with `--set` if you want it. The local KMS of compose (profile `kms`) cannot move: its keys
are in the compose volume `kms`. Turn it off before you migrate (`docs/deploy.md` "The local KMS").

### What is carried

- **The database**: every user, job, setting, secret (sealed under the master key), machine link and OpenFGA tuple.
- **The image and the update channel**: the image compose ran (`image.repository`, `image.tag`).
- **The port**: compose's `HOPPER_PORT` (`port`).
- **The vault container**: the profile `hopper-vault` turns on `hopperVault.enabled`.
- **The names machines reach the hopper by** (`lanNames`): compose's `HOPPER_LAN_NAMES`, this host's names, and its
  tailnet name when Tailscale runs.
- **The hopper's own launch settings**: each variable the compose hopper was started with that its image does not set and
  that is not compose's own plumbing (the database, OpenFGA, Solr, the vault, the tunnel, the socket). For example
  `HOPPER_PUBLIC_URL`, `GIT_AUTHOR_NAME`, `CLAUDE_CODE_OAUTH_TOKEN`. They go in `extraEnv`. A name with `KEY`, `TOKEN`,
  `SECRET`, `PASSWORD` or `CREDENTIAL` goes in the Secret `<release>-carried-env`, and `extraEnv` names it.
- **The home**: `/home/node` of the compose hopper.

Not carried: Solr's index (built again), the database password and the preshared keys (the chart makes its own), and
the compose files.

### Machines after the cutover

Each machine keeps its link: its link key is in the database. A machine dials in to the address it joined, and the
cluster hopper must answer there.

- **On a cluster bootstrap made**, the hopper's Service is a `LoadBalancer` on its port (`service.type`). k3s's load
  balancer takes that port on this host, as compose did. So a machine that joined `http://<this host>:4790` dials in to
  the cluster hopper, and no lane is lost. The names it dialled are in `lanNames`.
- **On another cluster**, the Service stays `ClusterIP`. Give the hopper an address machines reach, with
  `--set ingress.enabled=true --set ingress.host=<name>`, or `--set service.type=LoadBalancer`. A machine that joined
  another address must join again (Add machine).

Lane pods and sandbox boxes are the cluster's own: turn them on with `--set lanes.replicas=<n>` and
`--set sandbox.enabled=true` ("Lane pods on Kubernetes" and "Sandbox boxes on Kubernetes" in `docs/deploy.md`). A
sandbox box runs as a pod for one job only. It is never shown as a machine or a lane.

## Rollback

```sh
bash hopper-cluster.sh rollback
```

It scales the cluster hopper to 0, then starts the compose stack again: through `hopper-compose.service` when it is
installed (and turns on its port check and its start at boot again), else with `podman start` (Postgres first). The
compose stack starts on its own data, as it was at the cutover. Nothing is deleted: the cluster's release stays, with
its hopper at 0.

Data a person changed in the cluster hopper after the cutover is not in compose's database. To keep it, migrate again
later, from the cluster to a new compose install: there is no command for that.

## Start again

To run the migration again after a rollback, remove the release first. This deletes the cluster's copy of the data;
compose's data stays:

```sh
helm uninstall hopper --namespace hopper
kubectl --namespace hopper delete pvc --all
kubectl --namespace hopper delete secret hopper-runtime hopper-lane-pool hopper-master-key hopper-carried-env
```

## Check it on kind

`scripts/kind-migrate-check.ts` checks the migration end to end on a throwaway kind cluster. It starts a compose
install with Docker (or Podman) from `compose.yaml`, seeds it (a user, and a master key given at launch), migrates it
with `hopper-cluster.sh migrate --chart deploy/helm/hopper`, and checks: the cluster hopper is healthy; it runs on the
same key; it holds the seeded user; and the compose stack's containers, images and volumes are the same as before the
migration. Then a rollback must bring the compose hopper back, healthy. At the end it deletes the cluster and the
compose stack it made.

```sh
node scripts/kind-migrate-check.ts --tag dev      # --keep keeps both
```

It needs `kind`, `helm`, `kubectl` and Docker (or Podman with `KIND_EXPERIMENTAL_PROVIDER=podman`). A job run needs a
GitHub sign-in, which no check has: with `--keep`, sign in to the cluster hopper and queue a job on a test repository.
