# Resources

**Resources** is a page in the main menu, in the group Sources & machines. It shows what each part of the hopper's own stack uses now. Only the hopper's admin can read it.

The page reads again every 10 seconds while it is open.

## Containers

One row for each container of the hopper's compose stack: the hopper, Postgres, OpenFGA, the tunnel, and each optional service you turned on (hopper-vault, kms, vault). Each row has the service's name, its state and health, how long it runs, and how often it restarted. Then:

| Reading | What it is |
|---|---|
| CPU | The CPU cores it used since the read before, against its CPU limit when it has one. The first read says *measuring*. |
| Memory | The memory it uses, less the cache it could drop, against its memory limit. A bar shows the share. *No limit* means it can use the computer's memory. |
| Network | The bytes in and out since it started. |
| Disk | The bytes read and written since it started, and the size of its own writable layer. |
| Volumes | Each named volume it mounts, with its size. |

Sandbox boxes that this hopper started show under **Sandbox boxes**, with the same readings.

The hopper reads the containers through the container runtime's socket. It is the same socket it starts sandbox boxes through. Without it, the page says so, and shows only Postgres. To give the hopper the socket, see [Sandbox boxes](sandboxes.md).

Volume and layer sizes come from the runtime's disk use. The hopper reads it at most every 10 minutes. On a runtime with many images, the first read can show no sizes. They show on a later read.

## Postgres

The hopper reads its Postgres directly:

- **Connections**: all connections, against the most Postgres allows, and how many run a statement now.
- **Database size**.
- **Cache hits**: the share of block reads that Postgres served from its cache, since its statistics were reset.
- **Locks**: lock requests that wait now.
- **Transactions**: how many are open longer than 5 minutes, and how long the oldest open one is open.
- **Statement latency**: the mean time of a statement, from `pg_stat_statements`. The compose file loads it. Another Postgres shows why there is none.

## Through the API

`GET /api/resources` gives the same readings as JSON. Each container has its service as its label. See the API reference at `/docs/`.
