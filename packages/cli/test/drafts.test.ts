import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { RecordedRequest } from "./fixtures.ts";
import { apiError, Harness } from "./fixtures.ts";

/** In-memory drafts on the fake Portal (create / get / update / validate / submit). */
function installDrafts(h: Harness, opts: { ws?: string; agents?: string[] } = {}) {
  const ws = opts.ws ?? "ws_1";
  const state = { draft: null as any, revisionConflict: false };
  const view = () => ({ ...state.draft, steps: state.draft.steps.map((s: any, n: number) => ({ n, opId: s.opId, input: s.input, summary: `do ${s.opId}`, effect: "write", confirm: false, status: "pending" })) });
  h.portal.on("GET", "/me", () => ({ body: { account: { id: "acc_1" }, person: { id: "p", email: "e" }, currentWorkspaceId: ws, workspaceCount: 1, firstSignIn: false } }));
  h.portal.on("POST", "/drafts", (req: RecordedRequest) => {
    state.draft = { id: "drf_1", ws: req.body.ws, title: req.body.title, revision: 1, state: "open", steps: req.body.steps, confirmCount: 0, requiresPurchase: false };
    return { status: 201, body: view() };
  });
  h.portal.on("GET", "/drafts/{drf}", () => ({ body: view() }));
  h.portal.on("PUT", "/drafts/{drf}", (req) => {
    if (state.revisionConflict || req.body.revision !== state.draft.revision) return apiError(409, "revision_conflict");
    state.draft = { ...state.draft, steps: req.body.steps ?? state.draft.steps, revision: state.draft.revision + 1 };
    return { body: view() };
  });
  h.portal.on("POST", "/drafts/{drf}/validate", () => ({ body: { valid: true, revision: state.draft.revision, issues: [] } }));
  h.portal.on("POST", "/drafts/{drf}/submit", () => ({ body: { id: "drf_1", state: "submitted", reviewUrl: `${h.portal.origin}/review/drf_1` } }));
  h.portal.on("GET", "/workspaces/{ws}/agents", () => ({ body: { items: (opts.agents ?? []).map((name, i) => ({ id: `agt_${i}`, name })), nextCursor: null } }));
  return state;
}

describe("drafts", () => {
  let h: Harness;
  beforeEach(async () => {
    h = new Harness();
    await h.setup();
    await h.signIn();
  });
  afterEach(async () => {
    await h.teardown();
  });

  it("draft new / add (with $ref) / show / validate / submit", async () => {
    const state = installDrafts(h);
    const created = await h.run(["draft", "new", "--title", "Set up", "--json"]);
    assert.equal(created.code, 0);
    assert.equal(created.json.id, "drf_1");
    assert.deepEqual(h.portal.calls("POST", "/drafts")[0]?.body, { ws: "ws_1", title: "Set up", steps: [] });
    assert.ok(h.portal.calls("POST", "/drafts")[0]?.headers["idempotency-key"], "drafts.create is idempotent: header required");

    const a1 = await h.run(["draft", "add", "agents.create", "--input", '{"name":"A","purpose":"p","harnessOptionId":"claude"}', "--json"]);
    assert.equal(a1.code, 0, a1.err);
    // ws is filled from the draft
    assert.equal(state.draft.steps[0].input.ws, "ws_1");

    const inputFile = join(h.cwd, "edge.json");
    await writeFile(inputFile, JSON.stringify({ agt: { $ref: "#/steps/0/output/id" }, product: "notes", crud: ["read"] }));
    const a2 = await h.run(["draft", "add", "edges.create", "--input", `@${inputFile}`, "--json"]);
    assert.equal(a2.code, 0, a2.err);
    const upd = h.portal.calls("PUT", "/drafts/drf_1");
    assert.equal(upd.length, 2);
    assert.equal(upd[1]?.body.revision, 2);
    assert.equal(upd[1]?.body.steps.length, 2);
    assert.deepEqual(upd[1]?.body.steps[1].input.agt, { $ref: "#/steps/0/output/id" });
    assert.equal(upd[1]?.body.drf, undefined, "path params are not sent in the body");

    const show = await h.run(["draft", "show"]);
    assert.match(show.out, /agents\.create/);

    const v = await h.run(["draft", "validate", "--json"]);
    assert.equal(v.code, 0);
    assert.equal(v.json.valid, true);

    const s = await h.run(["draft", "submit", "--json"]);
    assert.equal(s.code, 0);
    assert.equal(s.json.reviewUrl, `${h.portal.origin}/review/drf_1`);
    assert.match(s.err, /browser/);
  });

  it("local validation: not draftable (5), bad ref (8), forward ref (8), foreign ws (8), secret field (8)", async () => {
    installDrafts(h);
    await h.run(["draft", "new", "--title", "t", "--json"]);
    const add = (op: string, input: unknown) => h.run(["draft", "add", op, "--input", JSON.stringify(input), "--json"]);

    const notDraftable = await add("agents.list", { ws: "ws_1" });
    assert.equal(notDraftable.code, 5);
    assert.equal(notDraftable.json.error.code, "draft_op_not_draftable");

    const unknown = await add("nope.nothing", {});
    assert.equal(unknown.code, 8);

    const malformed = await add("edges.create", { agt: { $ref: "steps/0/output/id" }, product: "p", crud: ["read"] });
    assert.equal(malformed.code, 8);
    assert.equal(malformed.json.error.code, "draft_ref_invalid");

    const forward = await add("edges.create", { agt: { $ref: "#/steps/0/output/id" }, product: "p", crud: ["read"] });
    assert.equal(forward.code, 8, "step 0 does not exist yet: a ref must point to an earlier step");
    assert.equal(forward.json.error.code, "draft_ref_invalid");

    const extra = await add("edges.create", { agt: { $ref: "#/steps/0/output/id", x: 1 }, product: "p", crud: ["read"] });
    assert.equal(extra.code, 8);

    const wrongWs = await add("agents.create", { ws: "ws_other", name: "A", purpose: "p", harnessOptionId: "h" });
    assert.equal(wrongWs.code, 8);
    assert.match(wrongWs.json.error.message, /ws_other/);

    const secret = await add("agents.create", { name: "A", purpose: "p", harnessOptionId: "h", token: "x" });
    assert.equal(secret.code, 8);

    const badJson = await h.run(["draft", "add", "agents.create", "--input", "{nope", "--json"]);
    assert.equal(badJson.code, 8);

    assert.equal(h.portal.calls("PUT", "/drafts/drf_1").length, 0, "nothing invalid reached the Portal");
  });

  it("revision conflict exits 7; non-open draft exits 7", async () => {
    const state = installDrafts(h);
    await h.run(["draft", "new", "--title", "t", "--json"]);
    state.revisionConflict = true;
    const r = await h.run(["draft", "add", "agents.create", "--input", '{"name":"A","purpose":"p","harnessOptionId":"h"}', "--json"]);
    assert.equal(r.code, 7);
    assert.equal(r.json.error.code, "revision_conflict");
    state.revisionConflict = false;
    state.draft.state = "submitted";
    const r2 = await h.run(["draft", "add", "agents.create", "--input", '{"name":"A","purpose":"p","harnessOptionId":"h"}', "--json"]);
    assert.equal(r2.code, 7);
    assert.equal(r2.json.error.code, "draft_state");
  });

  it("draft rm / move renumber $refs and refuse dangling or backwards refs", async () => {
    const state = installDrafts(h);
    await h.run(["draft", "new", "--title", "t", "--json"]);
    state.draft.steps = [
      { opId: "agents.create", input: { ws: "ws_1", name: "A", purpose: "p", harnessOptionId: "h" } },
      { opId: "agents.create", input: { ws: "ws_1", name: "B", purpose: "p", harnessOptionId: "h" } },
      { opId: "edges.create", input: { ws: "ws_1", agt: { $ref: "#/steps/1/output/id" }, product: "p", crud: ["read"] } },
    ];
    const dangling = await h.run(["draft", "rm", "1", "--json"]);
    assert.equal(dangling.code, 8);
    assert.equal(dangling.json.error.code, "draft_ref_invalid");

    const rm0 = await h.run(["draft", "rm", "0", "--json"]);
    assert.equal(rm0.code, 0, rm0.err);
    assert.deepEqual(state.draft.steps[1].input.agt, { $ref: "#/steps/0/output/id" });

    const back = await h.run(["draft", "move", "1", "0", "--json"]);
    assert.equal(back.code, 8, "moving the edge before its agent breaks the ref");

    const ok = await h.run(["draft", "move", "0", "1", "--json"]);
    assert.equal(ok.code, 8, "moving the agent after the edge also breaks it");

    const range = await h.run(["draft", "rm", "9", "--json"]);
    assert.equal(range.code, 2);
  });

  it("draft validate: local issues and Core issues give exit 8 with the issues listed", async () => {
    const state = installDrafts(h);
    await h.run(["draft", "new", "--title", "t", "--json"]);
    h.portal.on("POST", "/drafts/{drf}/validate", () => ({ body: { valid: false, revision: 1, issues: [{ n: 0, code: "draft_invalid", message: "name taken", pointer: "/input/name" }] } }));
    const r = await h.run(["draft", "validate", "--json"]);
    assert.equal(r.code, 8);
    assert.equal(r.json.error.details.issues[0].message, "name taken");

    state.draft.steps = [{ opId: "agents.list", input: {} }];
    const local = await h.run(["draft", "validate", "--json"]);
    assert.equal(local.code, 5);
    assert.equal(h.portal.calls("POST", "/drafts/drf_1/validate").length, 1, "Core is not called when the local check fails");
  });

  it("recipe export writes a file; import creates a draft", async () => {
    installDrafts(h);
    h.portal.on("GET", "/drafts/{drf}/recipe", () => ({ body: { format: "tealbrick.recipe/1", title: "R", description: null, steps: [{ opId: "agents.create", input: { name: "A", purpose: "p", harnessOptionId: "h" } }] } }));
    const out = join(h.cwd, "r.json");
    const ex = await h.run(["recipe", "export", "drf_1", "-o", out, "--json"]);
    assert.equal(ex.code, 0, ex.err);
    const file = JSON.parse(await (await import("node:fs/promises")).readFile(out, "utf8"));
    assert.equal(file.format, "tealbrick.recipe/1");

    h.portal.on("POST", "/recipes/import", (req) => ({ status: 201, body: { id: "drf_2", ws: "ws_1", title: req.body.recipe.title, revision: 1, state: "open", steps: req.body.recipe.steps } }));
    const im = await h.run(["recipe", "import", out, "--json"]);
    assert.equal(im.code, 0, im.err);
    assert.equal(im.json.id, "drf_2");
    assert.ok(h.portal.calls("POST", "/recipes/import")[0]?.headers["idempotency-key"]);

    await writeFile(join(h.cwd, "bad.json"), JSON.stringify({ format: "other" }));
    const bad = await h.run(["recipe", "import", join(h.cwd, "bad.json"), "--json"]);
    assert.equal(bad.code, 8);
  });
});

describe("register agents", () => {
  let h: Harness;
  beforeEach(async () => {
    h = new Harness();
    await h.setup();
    await h.signIn();
  });
  afterEach(async () => {
    await h.teardown();
  });

  async function file(content: unknown): Promise<string> {
    const p = join(h.cwd, "agents.json");
    await writeFile(p, JSON.stringify(content));
    return p;
  }

  it("builds agents.create + edges.create steps with $ref and creates a draft", async () => {
    installDrafts(h, { agents: ["Existing"] });
    const p = await file({
      format: "tealbrick.agents/1",
      agents: [
        { name: "Agent 01", purpose: "one", harness: "claude-code", endpointLabel: "laptop", edges: [{ product: "notes", crud: ["read", "create"] }, { product: "mail", crud: ["read"] }] },
        { name: "Agent 02", purpose: "two", harness: "codex", endpointLabel: null, edges: [] },
        { name: "Agent 03", purpose: "three", harness: "codex", edges: [{ product: "notes", crud: ["read"] }] },
      ],
    });
    const r = await h.run(["register", "agents", "--file", p, "--json"]);
    assert.equal(r.code, 0, r.err);
    const body = h.portal.calls("POST", "/drafts")[0]?.body;
    assert.equal(body.ws, "ws_1");
    const steps = body.steps;
    assert.equal(steps.length, 3 + 3);
    assert.deepEqual(steps[0], { opId: "agents.create", input: { ws: "ws_1", name: "Agent 01", purpose: "one", harnessOptionId: "claude-code", endpointLabel: "laptop" } });
    assert.deepEqual(steps[1], { opId: "edges.create", input: { ws: "ws_1", agt: { $ref: "#/steps/0/output/id" }, product: "notes", crud: ["read", "create"] } });
    assert.deepEqual(steps[2].input.agt, { $ref: "#/steps/0/output/id" });
    assert.equal(steps[3].opId, "agents.create");
    assert.equal("endpointLabel" in steps[3].input, false);
    assert.deepEqual(steps[5].input.agt, { $ref: "#/steps/4/output/id" });
    assert.equal(r.json.agents, 3);
    // never creates agents directly
    assert.equal(h.portal.calls("POST", "/workspaces/ws_1/agents").length, 0);
  });

  it("appends to an existing draft with correct step offsets", async () => {
    const state = installDrafts(h);
    await h.run(["draft", "new", "--title", "t", "--json"]);
    state.draft.steps = [{ opId: "workspaces.update", input: { ws: "ws_1", name: "N" } }];
    const p = await file({ format: "tealbrick.agents/1", agents: [{ name: "A", purpose: "p", harness: "h", edges: [{ product: "notes", crud: ["read"] }] }] });
    const r = await h.run(["register", "agents", "--file", p, "--draft", "drf_1", "--json"]);
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(state.draft.steps[2].input.agt, { $ref: "#/steps/1/output/id" });
  });

  it("rejects: duplicate names, names already in the workspace, >64 agents, >8 edges, bad crud (exit 8)", async () => {
    installDrafts(h, { agents: ["Taken"] });
    const agent = (name: string, edges: unknown[] = []) => ({ name, purpose: "p", harness: "h", edges });
    const run = async (agents: unknown[]) => h.run(["register", "agents", "--file", await file({ format: "tealbrick.agents/1", agents }), "--json"]);

    assert.equal((await run([agent("A"), agent("A")])).code, 8);
    const taken = await run([agent("Taken")]);
    assert.equal(taken.code, 8);
    assert.match(taken.json.error.message, /already exists/);
    assert.equal((await run(Array.from({ length: 65 }, (_v, i) => agent(`n${i}`)))).code, 8);
    assert.equal((await run([agent("A", Array.from({ length: 9 }, () => ({ product: "p", crud: ["read"] })))])).code, 8);
    assert.equal((await run([agent("A", [{ product: "p", crud: ["fly"] }])])).code, 8);
    assert.equal(h.portal.calls("POST", "/drafts").length, 0);

    const ok64 = await run(Array.from({ length: 64 }, (_v, i) => agent(`n${i}`)));
    assert.equal(ok64.code, 0, ok64.err);
  });
});
