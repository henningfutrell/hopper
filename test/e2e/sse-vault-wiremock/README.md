# sse-vault-wiremock (hopper e2e)

End-to-end check that an agent in a hopper **sandbox box** (#308) gets an API credential from hopper's
**dynamic vault** (#583, through the skill broker #582), is **woken over the job stream** (SSE, #613) when a
person gives it, fetches it **just in time with `hopper-secret`** (#558), and calls a **WireMock** "widgets"
service that returns preset data only for `Authorization: Bearer <that key>` (401 otherwise).

`hopper-skill --wait` asks once (`POST /job/skill`), then subscribes to `GET /job/stream` and is pushed
`skill.waiting` -> `skill.loaded`. After a hopper restart it reconnects with `Last-Event-ID` and goes on.

## Run (rootless podman)

```sh
npm run test:e2e:sse-vault    # the same as ./run.sh from the repo root
./run.sh                      # hopper from dev
REF=<sha|branch> ./run.sh     # any other build (it must have the job stream, src/http/job-stream.ts)
KEEP=1 ./run.sh; ./run.sh clean   # keep containers for poking, then remove them
```

Not part of `npm test` or CI: it needs rootless podman and network access to pull images.

Exits 0 only when every check passes. Needs: podman (rootless), git, curl, jq. Uses loopback ports 4799
(hopper), 4798 (driver control), 4796 (WireMock admin). Never touches a live stack (`hopper_*` containers,
port 4790, its volumes). Artifacts: `/tmp/hopper-sse-e2e/run/` (`summary.txt`, `s1.out`, `s2.out`,
`hopper.log`, `events.json`, `calls.json`, `wiremock-requests.json`, `s1-stream.json`).
Knobs: `MAX_WOKEN_MS` (default 1500), `FGA=fake` (the repo's OpenFGA double), `E2E_ROOT` (the work dir,
default `/tmp/hopper-sse-e2e`), image overrides (`BOX_IMAGE`, `WIREMOCK_IMAGE`, `NODE_IMAGE`, `PG_IMAGE`,
`FGA_IMAGE`).

## What it builds (all throwaway, all removed on exit)

`hsse-net` podman network with:
- `pg` Postgres 17 on tmpfs; `openfga` OpenFGA v1.22 (memory store, preshared key) — real authorization
- `widgets` WireMock with `wiremock/widgets.tmpl.json` (two random dummy keys substituted)
- `hopper` — `driver.ts` in a node:24 container over a checkout of `REF`: the **real composition root**
  (`src/main.ts` via `test/support/app.ts`) on :4799, a counting proxy for `/job/*` on :4797 (the job's
  `HOPPER_URL`), and a control API on :4798
- the sandbox box `ghcr.io/henningfutrell/hopper:box-claude-dev`, run locked down (cap-drop all,
  no-new-privileges, read-only root, tmpfs /tmp, its own home volume), joined with the template's join line

`driver.ts` is mounted into the checkout as `/src/e2e-driver.ts`, so its imports are relative to the repo root.
For that reason `tsconfig.json` and `eslint.config.js` leave this folder out.

## Steps

1. Template `widgets-box` saved and approved in the throwaway's vault; join line made for it.
2. Box joins (1 lane). A job is placed on its lane (the scripted executor holds it at work — no Claude
   login needed); the job's proxy token and the build's `hopper-skill` are written to the job's
   credentials dir in the box, exactly as hopper does for a pane.
3. **S1:** `agent.sh` runs in the box with the pane's env, asks `hopper-skill widgets --credential … --wait`,
   gets "waiting". The person gives the dummy key through hopper's UI vault API (`give-credential`).
   The agent is woken over the job stream, reads the key with `"$HOPPER_SECRET" get widgets` inside the
   curl, gets the widgets.
4. **S2:** same for `widgets-r`, but hopper is stopped for 6 s and restarted mid-wait; then the key is given.

## Checks

- S1: agent got the preset data; exactly one `POST /job/skill` (no polling); stream events
  `skill.waiting,skill.loaded`; woken under `MAX_WOKEN_MS` after the give.
- WireMock logged an authorized 200.
- No key leak: not in the box's process env, the box's disk, hopper/box logs, hopper events, the job
  stream, the agent output, or plaintext in a dump of hopper's database.
- S2: the agent survived the restart, got the preset data, and the stream reconnected with `Last-Event-ID`.

Result 2026-10-09: dev adc0587b passes all checks (woken 601 ms after the give;
8 stream reconnects with `Last-Event-ID` across the restart).

## Notes
- The test is SSE only. It has no polling mode.
- WireMock's stub file holds the dummy keys by design (it is the service that checks them); it is excluded
  from leak checks. The keys are random per run, never real, kept in a 0600 file in the run dir.
- The job is simulated (scripted executor + its real proxy token) rather than a Claude Code pane; everything
  the agent calls — `hopper-skill`, the job stream, `hopper-secret`, the client's vault socket — is real.
