/** Shared helpers for the CLI fuzz/property tests (AUDIT-BRIDGE-SECURITY §5). Fixed seeds; FUZZ_SEED overrides. */
import fc from "fast-check";

export { fc };

export function check<T>(name: string, property: fc.IProperty<T>, o: { seed: number; numRuns: number }): void {
  const env = process.env.FUZZ_SEED;
  const seed = env !== undefined && /^-?\d+$/.test(env) ? Number(env) ^ name.length : o.seed;
  try {
    fc.assert(property, { seed, numRuns: o.numRuns });
  } catch (e) {
    console.error(`[fuzz] FAILED ${name}: seed=${seed}`);
    throw e;
  }
}
