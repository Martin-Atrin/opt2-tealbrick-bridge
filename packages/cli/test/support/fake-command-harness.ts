/**
 * Test double of a `command` serve harness (BRG-04). argv: <record file>. It reads the prompt from stdin and appends
 * one JSON line per event to the record file:
 *   a prompt containing HANG — records its pid, ignores SIGTERM (records that it saw it) and never ends, so the runner
 *                              must escalate to SIGKILL
 *   any other prompt         — records its pid and exits 0 at once
 */
import { appendFileSync, readFileSync } from "node:fs";

const recordPath = process.argv[2] as string;
const prompt = readFileSync(0, "utf8");
const rec = (o: Record<string, unknown>) => appendFileSync(recordPath, `${JSON.stringify({ pid: process.pid, ...o })}\n`);

if (prompt.includes("HANG")) {
  process.on("SIGTERM", () => rec({ event: "sigterm" }));
  rec({ event: "hang" });
  setInterval(() => undefined, 1_000);
} else {
  process.on("SIGTERM", () => rec({ event: "sigterm" }));
  rec({ event: "fast" });
  process.exit(0);
}
