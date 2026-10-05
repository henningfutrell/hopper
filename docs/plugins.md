# Writing a hopper plugin

Short guide for authors. The contract is `docs/design.md` "Plugin contract"; the words are
`docs/glossary.md`; the types are `src/plugins/sdk.ts` (`hopper/plugin`).

## Where it lives

- One directory per plugin under the **plugin dir**, `$HOPPER_PLUGIN_DIR/<id>/`, holding `index.ts` (run by Node's type stripping) or `index.js`.
- The plugin dir has no default. Set `HOPPER_PLUGIN_DIR` (in `daemon.env` on the host install;
  e.g. `/srv/hopper/plugins`) to use custom plugins; unset, there are none.
- Loaded at daemon start. A broken plugin is refused with its error in `/api/plugins`; the daemon
  still starts. A custom id equal to a built-in id is refused.
- It runs only once `plugins.yaml` names it. `plugins.yaml` is a config document in the database:
  edit it from the UI, or by hand with `hopper config edit plugins.yaml`. Command-bearing
  options are set only the second way. The entry is `{ name: <instance>, plugin: <id>, options: { … } }`
  in the role's section (`router`, `queueSorter`, `answerer`, `assessor`, `executors`, `jobSources`, `machines`,
  `usageSources`, `notifiers`). Executors, sources and notifiers apply at the next restart.

## From the plugin store

With `HOPPER_PLUGIN_STORE` set to a git repository holding `plugin-store.yaml` (design.md "Plugin
store"), the UI's Plugins view lists what that plugin store offers and installs it:
Install, Update (the store's directory changed), Remove (refused while plugins.yaml names it). An
installed plugin is a custom plugin like any other; it runs once plugins.yaml names it. It needs no
plugin dir: what is installed is kept in the database and its code is unpacked into the work dir,
restored from the plugin store at start, so an ephemeral container keeps its plugins. A plugin in the
plugin dir is never replaced or removed from the UI.

This repository is a plugin store: its `plugin-store.yaml` lists `examples/plugins/`. To publish your
own, list each plugin in a repository's `plugin-store.yaml`:

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

- Default export: `{ id, role, describe, options?, detect, create } satisfies PluginDefinition<'<role>', Options>`.
  Give the options type (second parameter) so `options` is typed in `create`.
- Import from hopper **type-only**: `import type { … } from 'hopper/plugin'` (erased at
  runtime). Otherwise only `node:` builtins, unless the directory ships its own `node_modules`.
- Erasable TypeScript only (no enums, namespaces, parameter properties); relative imports carry `.ts`.
- `options: (z) => z.object({ … })` uses the `z` passed in (zod 4). Give **every option a default**:
  the catalogue and `plugin:check` parse `{}`.
- `create(ctx, options)`: `ctx` has `clock`, `logger`, `env(name)`, `dataDir`, `scratchDir`, `instanceName`, plus
  the role's own fields (a job source's `knownKeys`/`rerunnable`, a machine source's `executors()` and
  `target(machine)` — the hopper's own way to reach an attached machine (issue #74) —
  the router's `routerMode()`). A usage source's `poll` must answer at once from what it already has (every Decision polls it); it may add `state()` (when it last read, why it has no readings, its account) and `stop()`. A job source and a machine source must call themselves
  `ctx.instanceName`.
- A **queue sorter** (`examples/plugins/queue-sorter/word-first/`) gets every waiting job with its
  effective priority and returns job ids, synchronously, once per Decision. Ids it leaves out run
  after the ones it names, in the decider's own order. It orders; it never admits or holds a job.
  A throw, or anything but distinct ids of the jobs it was given, falls back to the built-in
  `priority` for that call (shown in `/api/plugins` `queueSorter.fallback`).

## Secrets

A plugin reads a secret from the runtime: `ctx.env(name)` in `create` (call it at each use, not once,
so a rotated secret applies), `sys.env(name)` in `detect`. It answers the variable `name`, or the
mounted file the variable `<name>_FILE` names (design.md "Secrets"); it throws when both are set or
the file cannot be read. Name the variable with a command-bearing option (a UI session then cannot
redirect a credential). Never read a secret file of your own, and never store a secret.

## Command-bearing options

Mark every option that names a program, its arguments, a working directory, an interpreter, a
sourced file, or where a credential is read or sent, with `.meta({ commandBearing: true })`.
The UI shows those read-only; they are edited only with `hopper config edit plugins.yaml` (design.md "UI and mutation").

## Detection

`detect(sys, options)` → `available` | `unavailable` + reason | `needs-setup` + reason + the command
to run. Use the kit (`which`, `version`, `succeeds`, `exists`, `readable`, `pythonImports`, `env`).
Cheap: never a paid model call, never a GUI program (`which` only). Only a job source or a notifier
that needs setup still runs; any other role's must be `available`.

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
