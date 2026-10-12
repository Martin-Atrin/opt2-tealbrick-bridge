#!/usr/bin/env node
// `bridge serve` loads only the relay (small process, CLI.md §5); everything else loads the full CLI.
const argv = process.argv.slice(2);
if (argv[0] === "bridge" && argv[1] === "serve" && !argv.includes("--json") && !argv.includes("--help")) {
  const { relayMain } = await import("./relay-main.ts");
  process.exitCode = await relayMain(argv);
} else {
  const { run } = await import("./cli.ts");
  process.exitCode = await run(argv, { stdout: process.stdout, stderr: process.stderr, stdin: process.stdin, env: process.env, fetch: globalThis.fetch });
}
