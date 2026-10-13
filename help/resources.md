# Resources

**Resources** is a page in the main menu, in the group Sources & machines. It shows what each part of the hopper's own stack uses now, and how its database and OpenFGA do. Only the hopper's admin can read it.

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

## OpenFGA

The hopper reads OpenFGA's own metrics, on port 2112 of the OpenFGA host:

- **Check latency**: the mean time of a check, as OpenFGA measures it. OpenFGA counts whole milliseconds, so fast checks give a mean below 1 ms.
- **Errors**: how many checks failed, and their share of all checks.

Both count since OpenFGA started. Without OpenFGA, or when its metrics do not answer, the page says why.

## Stack resources over time

The graph at the bottom of the page shows each part's use over the last day, 3 days, week or 30 days. The hopper keeps a sample every minute, and keeps samples for 30 days. Each line is a share:

| Line | What it is |
|---|---|
| CPU | A container's CPU, of its CPU limit. With no limit, of the CPU cores it sees. |
| memory | A container's memory, of its memory limit. With no limit, of the computer's memory. |
| connections | Postgres's connections, of the most it allows. |
| failed checks | The share of OpenFGA's checks that failed in that minute. |

Each part has its own colour. Each line shows the highest value in its step. A gap means that the hopper could not read that part then, or the container did not run. The lines of sandbox boxes are hidden at first: click one in the legend to show it. Zoom as in the usage graph.

## Through the API

`GET /api/resources` gives the same readings as JSON. Each container has its service as its label. `GET /api/resources/history` gives the graph. See the API reference at `/docs/`.
