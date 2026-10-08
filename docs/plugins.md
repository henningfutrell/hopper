# Writing a hopper plugin

Short guide for authors. The contract is `docs/design.md` "Plugin contract"; the words are
`docs/glossary.md`; the types are `src/plugins/sdk.ts` (`hopper/plugin`).

## Where it lives

- One directory per plugin under the **plugin dir**, `$HOPPER_PLUGIN_DIR/<id>/`, holding `index.ts` (run by Node's type stripping) or `index.js`.
- The plugin dir has no default. Set `HOPPER_PLUGIN_DIR` (in `daemon.env` on the host install;
  e.g. `/srv/hopper/plugins`) to use custom plugins; unset, there are none.
- Loaded at daemon start. A broken plugin is refused with its error in `/api/plugins`; the daemon
  still starts. A custom id equal to a built-in id is refused.
- It runs only once the plugins config names it. The plugins config is a config record in the
  database, edited in the UI: Settings → Plugins → the role → **Add** an instance of it (a list role)
  or select it (a one-instance role), then set its options in the instance form. Every option is
  edited there, command-bearing ones too. An instance is `{ "name": <instance>, "plugin": <id>,
  "options": { … } }` in the role's section (`router`, `queueSorter`, `escalationLevels`,
  `executors`, `jobSources`, `machines`, `usageSources`, `notifiers`). Every change applies when it is
  saved, without a restart; the escalation levels are a list in order, lowest first.

## From the plugin store

A new hopper reads the default plugin store, which the hopper's Pages site publishes
(`https://henningfutrell.github.io/hopper/plugin-store.git`: the example plugins of this repository). An
admin of the hopper names another git repository holding `plugin-store.yaml`, goes back to the default,
or sets none, on the **Plugin store** card (Plugins view). The change is kept in the database and applies
at once, without a restart (design.md "Plugin store"). The card lists what the plugin store offers and installs it:
Install, Update (the store's directory changed), Remove (refused while the plugins config names it).
An installed plugin is a custom plugin like any other; it runs once the plugins config names it. It needs no
plugin dir: what is installed is kept in the database and its code is unpacked into the work dir,
restored from the plugin store at start, so an ephemeral container keeps its plugins. A plugin in the
plugin dir is never replaced or removed from the UI.

This repository is a plugin store: its `plugin-store.yaml` lists `examples/plugins/`. To publish your
own, list each plugin in a repository's `plugin-store.yaml`, then name the repository on the card:

```yaml
version: 1
plugins:
  - { id: my-plugin, role: executor, describe: What it does, path: plugins/my-plugin }
```

`path` is the plugin's directory (with its `index.ts` or `index.js`); its module must declare the same
`id` and `role`. No `npm install` runs: a store plugin imports `node:` builtins and its own files, or
ships its `node_modules`.

## How to write one

Start from `examples/plugins/<role>/<id>/index.ts` — one minimal runnable plugin per role. Copy
the directory into the plugin dir and change it.

- Default export: `{ id, role, describe, options?, detect, choices?, create } satisfies PluginDefinition<'<role>', Options>`.
  Give the options type (second parameter) so `options` is typed in `create`.
- Import from hopper **type-only**: `import type { … } from 'hopper/plugin'` (erased at
  runtime). Otherwise only `node:` builtins, unless the directory ships its own `node_modules`.
- Erasable TypeScript only (no enums, namespaces, parameter properties); relative imports carry `.ts`.
- `options: (z) => z.object({ … })` uses the `z` passed in (zod 4). Give **every option a default**:
  the catalogue and `plugin:check` parse `{}`.
- `create(ctx, options)`: `ctx` has `clock`, `logger`, `env(name)`, `dataDir`, `scratchDir`, `instanceName`, plus
  the role's own fields (a job source's `knownKeys`/`rerunnable`/`rejections`, a machine source's `executors()` and
  `target(machine)` — the hopper's own way to reach an attached machine (issue #74)). The router
  gets nothing more: its advice is always applied (issue #211). A usage source's `poll` must answer at once from what it already has (every Decision polls it); it may add `state()` (when it last read, why it has no readings, its account) and `stop()`. A reading limits every job unless it names `executors`: the executor instances whose jobs its budget limits — one agent framework's, so another framework's jobs run on. A job source and a machine source must call themselves
  `ctx.instanceName`.
- A **queue sorter** (`examples/plugins/queue-sorter/word-first/`) gets every waiting job with its
  effective priority and returns job ids, synchronously, once per Decision. Ids it leaves out run
  after the ones it names, in the decider's own order. It never holds a job.
  A throw, or anything but distinct ids of the jobs it was given, falls back to the built-in
  `priority` for that call (shown in `/api/plugins` `queueSorter.fallback`). It is also the
  **pre-sort** of the queue gate: given the jobs not yet accepted, its order is the Pre-sorted column,
  and an optional `reject(entries)` returns `{ jobId, reason }[]` — the jobs it turns away. The gate
  auto-accepting applies them as jobs arrive; in review they are shown, and Accept pre-sort applies
  them. A throw, or anything but `{ jobId, reason }` of the given jobs, rejects nothing for that call.
  `word-first` shows both.

## Secrets

A plugin reads a secret from the runtime: `ctx.env(name)` in `create` (call it at each use, not once,
so a rotated secret applies), `sys.env(name)` in `detect`. It answers the variable `name`, or the
mounted file the variable `<name>_FILE` names (design.md "Secrets"); it throws when both are set or
the file cannot be read. Name the variable with a command-bearing option, so the UI marks it and
only an admin changes it. Never read a secret file of your own, and never store a secret.

## Command-bearing options

Mark every option that names a program, its arguments, a working directory, an interpreter, a
sourced file, or where a credential is read or sent, with `.meta({ commandBearing: true })`. The
UI edits it like any option, admin only, and marks it "runs a command" (design.md "UI and
mutation").

## Machine options

An option that names the machine a part runs on is marked `.meta({ machine: true })` and has no
default. The UI picks it from the configured machines (this one is the `local` machine in that list,
never an implicit default), and an edit or an added instance naming no configured machine is refused.
Find the machine with the context's `machine(id)`; one with no `ssh`, `docker` or `client` is this
machine (issue #174). A config stored before a machine was picked may lack it: the context's
`machines()` lists every machine, so the part can pick one as it runs, and say which (issue #442). An
escalation level also gets `escalationMachine()`, the default escalation machine, and the request's
`jobMachine`; a level that picked its machine returns it on its reply as `machine: { id, why }`. A usage
source and an escalation level also get `client(machine)`, how to reach a client target's client (issues #366, #482).

## Detection

`detect(sys, options)` → `available` | `unavailable` + reason | `needs-setup` + reason + the command
to run. Use the kit (`which`, `version`, `succeeds`, `output`, `exists`, `readable`, `pythonImports`, `env`).
Cheap: never a paid model call, never a GUI program (`which` only). Only a job source or a notifier
that needs setup still runs; any other role's must be `available`.

## Option choices

`choices(sys)` → `{ [option]: { value, label?, description? }[] }`, optional: the values an option
may take, read from the system with the same kit (the models a CLI offers). The UI then offers them
as a select instead of a typed value. Run at start and on rescan; the same limits as `detect`.
Leave it out, return `{}` or throw, and the option is typed.

## Check it

From a hopper checkout (it needs the dev dependencies):

```sh
npm run plugin:check $HOPPER_PLUGIN_DIR      # or one plugin's directory
```

It type-checks with `hopper/plugin` mapped to the checkout's `src/plugins/sdk.ts`, then runs the
real loader, parses the options from `{}` and runs `detect`: one line per plugin, exit 1 on any
failure. `unavailable` / `needs-setup` are reported, not failures. For an editor, `install.sh` writes
`$HOPPER_PLUGIN_DIR/tsconfig.json` mapping `hopper/plugin` to the installed SDK, only when
`HOPPER_PLUGIN_DIR` is set in `daemon.env`.
