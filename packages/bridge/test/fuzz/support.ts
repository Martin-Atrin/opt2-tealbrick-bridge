/**
 * Shared helpers for the fuzz/property tests (AUDIT-BRIDGE-SECURITY §5).
 * Seeds are fixed so a CI failure replays; set FUZZ_SEED to explore other seeds. On failure fast-check
 * prints the seed, the path and the counterexample; `check` repeats the seed on stderr.
 */
import { request } from "node:http";
import fc from "fast-check";

export { fc };

export function seedFor(name: string, fixed: number): number {
  const env = process.env.FUZZ_SEED;
  if (env !== undefined && /^-?\d+$/.test(env)) return Number(env) ^ name.length;
  return fixed;
}

export interface CheckOptions {
  seed: number;
  numRuns: number;
  /** wall-clock cap for async HTTP properties (a run past it counts as a failure, never a silent pass) */
  timeMs?: number;
}

export async function check<T>(name: string, property: fc.IAsyncProperty<T> | fc.IProperty<T>, o: CheckOptions): Promise<void> {
  const seed = seedFor(name, o.seed);
  try {
    await fc.assert(property, {
      seed,
      numRuns: o.numRuns,
      maxSkipsPerRun: 20,
      ...(o.timeMs ? { interruptAfterTimeLimit: o.timeMs, markInterruptAsFailure: true } : {}),
    });
  } catch (e) {
    console.error(`[fuzz] FAILED ${name}: seed=${seed} (replay with the same code; FUZZ_SEED overrides)`);
    throw e;
  }
}

let counter = 0;
/** A fresh client address per request: the bridge buckets rate limits by the rightmost X-Forwarded-For entry. */
export const freshIp = (): string => `10.${(counter >> 16) & 255}.${(counter >> 8) & 255}.${counter++ & 255}`;

export interface Raw {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

/** Sends the request line exactly as given (fetch would normalise dot segments before sending). */
export function rawRequest(base: string, path: string, init: { method?: string; headers?: Record<string, string>; body?: string | Buffer } = {}): Promise<Raw> {
  const u = new URL(base);
  return new Promise((resolve, reject) => {
    const req = request(
      { host: u.hostname, port: u.port, path, method: init.method ?? "GET", headers: { "x-forwarded-for": freshIp(), ...init.headers }, agent: false },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
      },
    );
    req.on("error", reject);
    req.end(init.body);
  });
}

export function tryJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
