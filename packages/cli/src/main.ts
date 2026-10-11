#!/usr/bin/env node
import { run } from "./cli.ts";

const code = await run(process.argv.slice(2), {
  stdout: process.stdout,
  stderr: process.stderr,
  stdin: process.stdin,
  env: process.env,
  fetch: globalThis.fetch,
});
process.exitCode = code;
