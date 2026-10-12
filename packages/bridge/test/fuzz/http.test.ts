/**
 * C62 fuzz/property tests that need the running bridge (AUDIT-BRIDGE-SECURITY §5). One shared world: starting a
 * bridge costs about 12 s of process exit time, so the four HTTP surfaces run against the same instance.
 */
import { after, before, describe } from "node:test";
import { makeWorld, type World } from "../support/world.ts";
import { jwsMutations } from "./jws.ts";
import { mcpRobustness } from "./mcp.ts";
import { pathContainment } from "./path.ts";
import { redirectMatching } from "./redirect.ts";

describe("bridge HTTP fuzz (C62)", () => {
  let w: World;
  before(async () => {
    w = await makeWorld({ real: true });
  });
  after(async () => {
    await w.close();
  });
  const world = () => w;
  pathContainment(world);
  redirectMatching(world);
  mcpRobustness(world);
  jwsMutations(world);
});
