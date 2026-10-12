/**
 * C96 §8 liveness for `tealbrick agent serve`: its own pidfile (one loop per connection), a heartbeat file that
 * `agent status` reads ("last poll"), a watchdog that exits a stalled loop, and `--supervise` (restart after a crash
 * or a watchdog exit, with backoff). L20: this module only ever signals the child it spawned itself; it never looks
 * up or kills other processes by name.
 */
import { spawn } from "node:child_process";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface Heartbeat {
  pid: number;
  /** F38: the supervisor that started this loop (its pidfile holder), when supervised */
  supervisorPid?: number;
  /** last completed poll (ISO) */
  lastPollAt: string | null;
  /** "poll" between turns, "turn" while a harness turn runs */
  phase: "poll" | "turn";
  since: string;
}

export const pidPath = (configDir: string, con: string) => join(configDir, `agent-serve-${con}.pid`);
export const heartbeatPath = (configDir: string, con: string) => join(configDir, `agent-serve-${con}.heartbeat.json`);

/** exit code of a loop the watchdog stopped (EX_TEMPFAIL): the supervisor restarts it */
export const EXIT_STALLED = 75;

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0); // signal 0 = existence check only
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
};

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp-${process.pid}`;
  await writeFile(tmp, JSON.stringify(value), { mode: 0o600 });
  await rename(tmp, path);
}

export async function readPid(path: string): Promise<{ pid: number; role: string; startedAt: string } | null> {
  try {
    const v = JSON.parse(await readFile(path, "utf8")) as { pid?: unknown; role?: unknown; startedAt?: unknown };
    return typeof v.pid === "number" ? { pid: v.pid, role: String(v.role ?? "serve"), startedAt: String(v.startedAt ?? "") } : null;
  } catch {
    return null;
  }
}

/** Takes the connection's pidfile, or refuses when a LIVE process holds it (a stale file is replaced). */
export async function acquirePidfile(path: string, role: "serve" | "supervisor"): Promise<() => Promise<void>> {
  const held = await readPid(path);
  if (held && held.pid !== process.pid && alive(held.pid)) {
    throw new Error(`agent serve already runs for this connection (${held.role} pid ${held.pid}); stop it first`);
  }
  await writeJson(path, { pid: process.pid, role, startedAt: new Date().toISOString() });
  return async () => {
    const now = await readPid(path);
    if (now?.pid === process.pid) await rm(path, { force: true });
  };
}

export async function readHeartbeat(path: string): Promise<Heartbeat | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as Heartbeat;
  } catch {
    return null;
  }
}

/**
 * Heartbeat + watchdog for one serve loop. `beat("poll")` after every poll, `beat("turn")` when a turn starts.
 * The watchdog fires `onStall` when nothing moved for longer than the limit of the current phase.
 */
export function liveness(o: { path: string; pollMs: number; turnLimitMs: number; onStall: () => void; nowMs?: () => number; checkEveryMs?: number; supervisorPid?: number }) {
  const now = o.nowMs ?? (() => Date.now());
  let last = now();
  let phase: Heartbeat["phase"] = "poll";
  let lastPollAt: string | null = null;
  const pollLimit = Math.max(3 * o.pollMs, 300_000);
  const timer = setInterval(() => {
    const limit = phase === "turn" ? o.turnLimitMs + 300_000 : pollLimit;
    if (now() - last > limit) o.onStall();
  }, o.checkEveryMs ?? 30_000);
  timer.unref?.();
  return {
    async beat(p: Heartbeat["phase"]): Promise<void> {
      last = now();
      phase = p;
      if (p === "poll") lastPollAt = new Date(last).toISOString();
      await writeJson(o.path, { pid: process.pid, ...(o.supervisorPid ? { supervisorPid: o.supervisorPid } : {}), lastPollAt, phase, since: new Date(last).toISOString() } satisfies Heartbeat).catch(() => undefined);
    },
    stop(): void {
      clearInterval(timer);
    },
  };
}

/**
 * `--supervise`: runs `argv` (the same serve command, marked as the supervised child) and restarts it when it exits
 * for any reason other than a clean stop, with backoff 1 s → 60 s (reset after 10 min of uptime). SIGINT/SIGTERM stop
 * the child (SIGTERM to OUR child only) and the supervisor.
 */
/** F56: SIGTERM → child SIGTERM; SIGKILL after this grace; the supervisor is gone within STOP_BOUND_MS */
export const STOP_GRACE_MS = 3_500;
export const STOP_BOUND_MS = 5_000;

export async function supervise(o: {
  command: string;
  args: string[];
  pidfile: string;
  log: (event: string, fields?: Record<string, unknown>) => void;
  /** test hooks */
  sleep?: (ms: number) => Promise<void>;
  maxRestarts?: number;
  /** F56: a child that has not exited this long after SIGTERM gets SIGKILL (own child only) */
  stopGraceMs?: number;
}): Promise<void> {
  const release = await acquirePidfile(o.pidfile, "supervisor");
  let stopping = false;
  let child: ReturnType<typeof spawn> | undefined;
  let wake: (() => void) | undefined;
  const stop = () => {
    stopping = true;
    wake?.(); // F56: a backoff wait ends at once
    const c = child;
    if (!c || c.exitCode !== null || c.signalCode !== null) return;
    c.kill("SIGTERM");
    // F56: the whole stop is bounded (STOP_BOUND_MS): an idle or stuck child is killed after the grace
    setTimeout(() => {
      if (c.exitCode === null && c.signalCode === null) c.kill("SIGKILL");
    }, o.stopGraceMs ?? STOP_GRACE_MS).unref();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  const sleep =
    o.sleep ??
    ((ms: number) =>
      new Promise<void>((r) => {
        const t = setTimeout(r, ms);
        wake = () => {
          clearTimeout(t);
          r();
        };
      }));
  let backoff = 1_000;
  let restarts = 0;
  try {
    while (!stopping) {
      const started = Date.now();
      child = spawn(o.command, o.args, { stdio: ["ignore", "inherit", "inherit"] });
      o.log("serve.supervisor.started", { child: child.pid ?? null });
      const code = await new Promise<number | null>((r) => child?.once("exit", (c) => r(c)));
      if (stopping) break;
      if (Date.now() - started > 600_000) backoff = 1_000;
      restarts += 1;
      o.log("serve.supervisor.restart", { exitCode: code, inMs: backoff, stalled: code === EXIT_STALLED });
      if (o.maxRestarts !== undefined && restarts > o.maxRestarts) break;
      await sleep(backoff);
      backoff = Math.min(backoff * 2, 60_000);
    }
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    await release();
  }
}

/** true while `pid` exists (signal 0: existence check only) */
export function isAlive(pid: number): boolean {
  return alive(pid);
}

/**
 * F38: stops the loop that holds a connection's pidfile — the holder itself, confirmed by a recent heartbeat that names
 * it (plain serve: heartbeat.pid; supervised: heartbeat.supervisorPid). Waits for the exit; the pidfile and heartbeat
 * are removed ONLY when the process is gone (never delete a pidfile whose process still runs).
 */
export async function stopLoop(o: { pidfile: string; heartbeat: string; nowMs: number; waitMs?: number }): Promise<{ stopped: number | null; left: string | null }> {
  const holder = await readPid(o.pidfile);
  if (!holder) return { stopped: null, left: null };
  if (!alive(holder.pid)) {
    await rm(o.pidfile, { force: true });
    await rm(o.heartbeat, { force: true });
    return { stopped: null, left: null };
  }
  const hb = await readHeartbeat(o.heartbeat);
  const recent = !!hb && Date.parse(hb.since) > o.nowMs - 15 * 60_000;
  const confirmed = recent && (hb?.pid === holder.pid || hb?.supervisorPid === holder.pid);
  if (!confirmed) return { stopped: null, left: `agent serve (${holder.role} pid ${holder.pid}) is not confirmed by this connection's heartbeat; stop it yourself` };
  process.kill(holder.pid, "SIGTERM"); // the supervisor stops its own child
  const until = Date.now() + (o.waitMs ?? 10_000);
  while (alive(holder.pid) && Date.now() < until) await new Promise((r) => setTimeout(r, 100));
  if (alive(holder.pid)) return { stopped: null, left: `agent serve (${holder.role} pid ${holder.pid}) did not stop within ${Math.round((o.waitMs ?? 10_000) / 1000)} s; its pidfile is kept` };
  await rm(o.pidfile, { force: true });
  await rm(o.heartbeat, { force: true });
  return { stopped: holder.pid, left: null };
}