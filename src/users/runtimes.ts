// The runtimes of every user (issue #158, design.md "Users: one hopper, separate users"): one per
// user, created at boot and for a user added while the daemon runs — from the UI, by sign-in, or with
// `hopper user add` (noticed by the watch). The instance's events go to every user's event log; a
// store install makes every user's plugin host rescan.
import type { DomainEvent, EventType, NewEvent, PluginsEditOutcome, PluginsEdit, PluginsReport, User } from '../domain/types.ts';
import type { EventLog, InstanceStore, PluginsView } from '../domain/ports.ts';
import { createUserRuntime, type UserRuntime, type UserRuntimeOptions } from './runtime.ts';

export interface Runtimes {
  /** The running user's runtime, or undefined. */
  get(id: string): UserRuntime | undefined;
  all(): UserRuntime[];
  /** The default admin account's. */
  admin(): UserRuntime;
  /** The user's runtime, created (and started, once the instance started) when it has none. */
  ensure(user: User): Promise<UserRuntime>;
  /** Create a runtime for every user that has none: at boot, and on every watch tick. */
  sync(): Promise<void>;
  /** From now on every runtime's loops run: the ones there, and every one created later. */
  start(): Promise<void>;
  /** Check the users table every `intervalMs` for users added outside this process (the CLI). */
  watch(intervalMs: number): void;
  /** The instance's events, appended to every user's event log; the newest read from admin's. */
  events: Pick<EventLog, 'append' | 'recent'>;
  /** What the plugin store reads and drives: admin's report; a rescan of every user's host. */
  plugins: Pick<PluginsView, 'report' | 'edit'>;
  stop(): Promise<void>;
}

/** `options(user)`: everything a user runtime is given but its store, which this opens. */
export function createRuntimes(o: {
  instance: InstanceStore;
  options(user: User): Omit<UserRuntimeOptions, 'user' | 'store'>;
  logger: { warn(line: string): void };
}): Runtimes {
  const running = new Map<string, UserRuntime>();
  const pending = new Map<string, Promise<UserRuntime>>();
  let started = false;
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;

  const ensure = (user: User): Promise<UserRuntime> => {
    const there = pending.get(user.id);
    if (there) return there;
    const made = (async () => {
      if (stopped) throw new Error('the hopper is stopping');
      const store = o.instance.userStore(user);
      let rt: UserRuntime;
      try {
        rt = await createUserRuntime({ ...o.options(user), user, store });
      } catch (e) {
        store.close();
        throw e;
      }
      running.set(user.id, rt);
      if (started) await rt.start();
      return rt;
    })();
    pending.set(user.id, made);
    made.catch(() => pending.delete(user.id));
    return made;
  };
  const admin = (): UserRuntime => {
    const rt = running.get(o.instance.users.admin().id);
    if (!rt) throw new Error('the admin account\'s runtime is not running');
    return rt;
  };
  const sync = async (): Promise<void> => {
    for (const user of o.instance.users.list()) await ensure(user);
  };

  return {
    get: (id) => running.get(id),
    all: () => [...running.values()],
    admin,
    ensure,
    sync,
    async start() {
      started = true;
      for (const rt of running.values()) await rt.start();
    },
    watch(intervalMs) {
      const tick = (): void => {
        sync().catch((e: unknown) => o.logger.warn(`hopper: starting a new user's runtime failed: ${e instanceof Error ? e.message : String(e)}`))
          .finally(() => { if (!stopped) timer = setTimeout(tick, intervalMs); });
      };
      timer = setTimeout(tick, intervalMs);
    },
    events: {
      append(event: NewEvent): DomainEvent {
        let first: DomainEvent | undefined;
        for (const rt of running.values()) {
          const e = rt.store.events.append(event);
          first ??= e;
        }
        if (!first) throw new Error('no user runtime to record the event in');
        return first;
      },
      recent: (limit?: number, types?: EventType[]) => admin().store.events.recent(limit, types),
    },
    plugins: {
      report: (): PluginsReport => admin().plugins.report(),
      async edit(e: PluginsEdit): Promise<PluginsEditOutcome> {
        const outcomes = await Promise.all([...running.values()].map((rt) => rt.plugins.edit(e)));
        return outcomes[0] ?? admin().plugins.edit(e);
      },
    },
    async stop() {
      stopped = true;
      clearTimeout(timer);
      await Promise.allSettled([...pending.values()]);
      for (const rt of running.values()) await rt.stop();
    },
  };
}
