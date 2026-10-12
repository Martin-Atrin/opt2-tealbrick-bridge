/**
 * C83 G10 poll mode (STEP-B-DESIGN §2.3 R1–R7 as unit tests; R8 at the unit level). A fake Evolution implements the
 * three ops with the server rules that matter here: claim is atomic per occurrence, reports are idempotent per key.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { McpToolResult } from "@opt2-tealbrick/bridge";
import { reportSummary, routinePrompt, type ServeConfig, type ServeDeps, type ServeState, serveLoop, validateServeConfig } from "../src/serve.ts";

const OCC = (n: number) => `${"a".repeat(62)}${String(n).padStart(2, "0")}`;
const IDEM = "tealbrick/idempotencyKey";

interface Job {
  occurrence: string;
  workflowId: string;
  version: number;
  dueAt: string;
  title: string;
}

class FakeEvolution {
  jobs: Job[] = [];
  claims = new Map<string, string>();
  claimCalls: { runner: string; occ: string; key: unknown }[] = [];
  reports: { occ: string; status: string; summary?: string; key: unknown }[] = [];
  reportKeys = new Set<string>();
  /** the next N report calls throw (network) */
  failReports = 0;
  /** the claim is recorded but its answer is lost */
  loseClaimAnswer = false;
  dueRefused: string | null = null;
  /** Evolution 0.2: the Kanban issue it opened for the claimed run (null = Kanban down or absent) */
  kanbanIssueId: string | null = "iss_01HRUNISSUE";
  dueCalls = 0;

  async call(runner: string, name: string, args: Record<string, unknown>, meta?: Record<string, unknown>): Promise<McpToolResult> {
    if (name === "evolution__routines_due") {
      this.dueCalls += 1;
      if (this.dueRefused) return { isError: true, structuredContent: { error: { code: this.dueRefused } } };
      return { structuredContent: { jobs: this.jobs.filter((j) => !this.claims.has(j.occurrence)) } };
    }
    if (name === "evolution__routine_claim") {
      const occ = String(args.occurrence);
      this.claimCalls.push({ runner, occ, key: meta?.[IDEM] });
      const job = this.jobs.find((j) => j.occurrence === occ);
      if (!job) return { structuredContent: { claimed: false, reason: "not_due" } };
      if (this.claims.has(occ)) return { structuredContent: { claimed: false, reason: "already_claimed" } };
      this.claims.set(occ, runner);
      if (this.loseClaimAnswer) throw new Error("connection reset");
      return { structuredContent: { claimed: true, job: { occurrence: occ, workflowId: job.workflowId, version: job.version, instruction: "Do the weekly report.", steps: ["read", "write"], allowed: ["kanban__issue_comment"], deadline: "2026-10-12T12:00:00Z", kanbanIssueId: this.kanbanIssueId } } };
    }
    if (name === "evolution__routine_report") {
      if (this.failReports > 0) {
        this.failReports -= 1;
        throw new Error("bridge_unreachable");
      }
      const key = String(meta?.[IDEM]);
      if (this.reportKeys.has(key)) return { structuredContent: { ok: true, repeated: true } };
      this.reportKeys.add(key);
      this.reports.push({ occ: String(args.occurrence), status: String(args.status), ...(typeof args.summary === "string" ? { summary: args.summary } : {}), key: meta?.[IDEM] });
      return { structuredContent: { ok: true } };
    }
    if (name === "evolution__tb_hold_status") return { structuredContent: { status: "approved" } };
    return { isError: true, structuredContent: { error: { code: "unknown_tool" } } };
  }
}

const cfg: ServeConfig = validateServeConfig({
  format: "tealbrick.agent-serve/1",
  harness: { kind: "command", command: ["true"] },
  routines: [{ due: "evolution__routines_due", claim: "evolution__routine_claim", report: "evolution__routine_report" }],
  pollSeconds: 5,
});

interface RunOpts {
  /** stop after this many polls of routines_due */
  polls: number;
  state?: ServeState;
  onTurn?: (n: number, ev: { onHeld: (h: never) => void }, snapshot: () => ServeState) => void;
  turnOk?: boolean;
  summary?: string;
}

function runner(id: string, srv: FakeEvolution, o: RunOpts) {
  const abort = new AbortController();
  let state: ServeState = o.state ? structuredClone(o.state) : { cursors: {}, seen: {}, primed: {} };
  let clock = 1_000_000;
  let polls = 0;
  const prompts: string[] = [];
  const logs: { e: string; f?: Record<string, unknown> }[] = [];
  const deps: ServeDeps = {
    mcp: {
      async callTool(name, args, meta) {
        if (name === "evolution__routines_due") {
          polls += 1;
          if (polls > o.polls) {
            abort.abort();
            return { structuredContent: { jobs: [] } };
          }
        }
        return srv.call(id, name, args, meta);
      },
    },
    async runTurn(prompt, events) {
      prompts.push(prompt);
      o.onTurn?.(prompts.length, events as never, () => structuredClone(state));
      await new Promise((r) => setTimeout(r, 2));
      return { ok: o.turnOk ?? true, ...(o.summary ? { summary: o.summary } : {}) };
    },
    loadState: async () => structuredClone(state),
    saveState: async (s) => {
      state = structuredClone(s);
    },
    log: (e, f) => logs.push({ e, ...(f ? { f } : {}) }),
    sleep: async (ms) => {
      clock += ms;
      await new Promise((r) => setTimeout(r, 1));
    },
    now: () => clock,
  };
  const done = serveLoop(cfg, deps, abort.signal);
  return { done, prompts, logs, state: () => state, abort };
}

const job = (n: number, due = `2026-10-12T10:0${n}:00Z`): Job => ({ occurrence: OCC(n), workflowId: "wfl_01HWEEKLY", version: 3, dueAt: due, title: "Weekly report" });
const statuses = (srv: FakeEvolution, occ: string) => srv.reports.filter((r) => r.occ === occ).map((r) => r.status);

describe("agent serve: routines poll mode (C83 G10)", () => {
  it("R1: one due job → exactly one claim, one dispatched report, ONE turn, one terminal report", async () => {
    const srv = new FakeEvolution();
    srv.jobs.push(job(1));
    const r = runner("m1", srv, { polls: 3, summary: "Report written to Kanban issue KAN-7." });
    await r.done;
    assert.equal(srv.claimCalls.length, 1);
    assert.equal(srv.claimCalls[0]?.key, `claim:${OCC(1)}`, "claim carries its idempotency key");
    assert.equal(r.prompts.length, 1);
    assert.deepEqual(statuses(srv, OCC(1)), ["dispatched", "completed"]);
    assert.equal(srv.reports.at(-1)?.summary, "Report written to Kanban issue KAN-7.");
    assert.match(r.prompts[0] as string, /evolution__workflow_get \{"id": "wfl_01HWEEKLY"\}/);
    assert.match(r.prompts[0] as string, /kanban__issue_comment/);
    assert.equal(r.state().routineRuns?.[OCC(1)]?.s, "reported");
  });

  it("Evolution 0.2: the prompt names the run's own Kanban issue; with kanbanIssueId null it says nothing about Kanban", async () => {
    const srv = new FakeEvolution();
    srv.jobs.push(job(1), job(2));
    const r = runner("m1", srv, { polls: 2 });
    srv.call = ((orig) => async (runner: string, name: string, args: Record<string, unknown>, meta?: Record<string, unknown>) => {
      if (name === "evolution__routine_claim" && args.occurrence === OCC(2)) srv.kanbanIssueId = null;
      return orig(runner, name, args, meta);
    })(srv.call.bind(srv));
    await r.done;
    assert.equal(r.prompts.length, 2);
    assert.match(r.prompts[0] as string, /already has Kanban issue iss_01HRUNISSUE assigned to you; add comments there; do not create another issue\./);
    // the runner's own text says nothing about Kanban (the job's allowed-op list may still name kanban ops)
    const head = (r.prompts[1] as string).split("\n{")[0] as string;
    assert.doesNotMatch(head, /kanban/i, "no Kanban text when Evolution opened no issue");
  });

  it("R2: two runners for the same agent → one claims, the other gets already_claimed; one turn in total", async () => {
    const srv = new FakeEvolution();
    // the due list is read by both before either claims
    const due = job(1);
    srv.jobs.push(due);
    const origCall = srv.call.bind(srv);
    srv.call = async (runner, name, args, meta) => {
      if (name === "evolution__routines_due" && !srv.dueRefused) return { structuredContent: { jobs: [due] } };
      return origCall(runner, name, args, meta);
    };
    const a = runner("m1", srv, { polls: 2 });
    const b = runner("m2", srv, { polls: 2 });
    await Promise.all([a.done, b.done]);
    assert.equal(a.prompts.length + b.prompts.length, 1, "one turn across both machines");
    const loser = a.prompts.length ? b : a;
    assert.ok(loser.logs.some((l) => l.e === "serve.routine.not_claimed" && l.f?.reason === "already_claimed"));
    assert.equal(loser.state().routineRuns?.[OCC(1)]?.s, "not_claimed");
    assert.deepEqual(statuses(srv, OCC(1)), ["dispatched", "completed"]);
  });

  it("R3: the claim answer is lost → no turn, and the occurrence is never claimed again (also after a restart)", async () => {
    const srv = new FakeEvolution();
    srv.jobs.push(job(1));
    srv.loseClaimAnswer = true;
    const r = runner("m1", srv, { polls: 2 });
    await r.done;
    assert.equal(r.prompts.length, 0);
    assert.equal(r.state().routineRuns?.[OCC(1)]?.s, "claiming");
    // restart from the saved state while the server still offers it (e.g. before its sweep)
    srv.loseClaimAnswer = false;
    srv.claims.clear();
    const r2 = runner("m1", srv, { polls: 2, state: r.state() });
    await r2.done;
    assert.equal(r2.prompts.length, 0);
    assert.equal(srv.claimCalls.length, 1, "never a second claim");
    assert.deepEqual(statuses(srv, OCC(1)), [], "the server sweeps it to uncertain; the runner reports nothing");
  });

  it("R4: stopped during the turn → restart reports `uncertain` once and never re-runs", async () => {
    const srv = new FakeEvolution();
    srv.jobs.push(job(1));
    let during: ServeState | undefined;
    const r = runner("m1", srv, { polls: 2, onTurn: (_n, _ev, snap) => (during = snap()) });
    await r.done;
    assert.equal(during?.routineRuns?.[OCC(1)]?.s, "started", "saved before the turn started");
    // the process died inside the turn: restart from the state as it was on disk at that moment
    srv.reports = srv.reports.filter((x) => x.status === "dispatched");
    const r2 = runner("m1", srv, { polls: 2, state: during as ServeState });
    await r2.done;
    assert.equal(r2.prompts.length, 0, "no second turn");
    assert.deepEqual(statuses(srv, OCC(1)), ["dispatched", "uncertain"]);
    assert.match(srv.reports.at(-1)?.summary ?? "", /restarted/);
    const r3 = runner("m1", srv, { polls: 1, state: r2.state() });
    await r3.done;
    assert.deepEqual(statuses(srv, OCC(1)), ["dispatched", "uncertain"], "uncertain is reported once");
  });

  it("R5: a terminal report that fails is re-sent on a later poll with the same key; no second turn", async () => {
    const srv = new FakeEvolution();
    srv.jobs.push(job(1));
    let turns = 0;
    const r = runner("m1", srv, {
      polls: 8,
      onTurn: () => {
        turns += 1;
        srv.failReports = 1; // the completed report after this turn fails once
      },
    });
    await r.done;
    assert.equal(turns, 1);
    assert.deepEqual(statuses(srv, OCC(1)), ["dispatched", "completed"]);
    assert.equal(srv.reports.at(-1)?.key, `report:${OCC(1)}:completed`);
    assert.equal(r.state().pendingReports?.length, 0);
    assert.ok(r.logs.some((l) => l.e === "serve.routine.report_failed"));
  });

  it("R6: an occurrence offered on several polls (runner offline, periods collapsed) gives ONE turn; jobs run in dueAt order", async () => {
    const srv = new FakeEvolution();
    srv.jobs.push(job(2, "2026-10-12T10:10:00Z"), job(1, "2026-10-12T10:00:00Z"));
    const origCall = srv.call.bind(srv);
    srv.call = async (runner, name, args, meta) => (name === "evolution__routines_due" ? { structuredContent: { jobs: srv.jobs } } : origCall(runner, name, args, meta)); // a server that keeps offering
    const r = runner("m1", srv, { polls: 4 });
    await r.done;
    assert.equal(r.prompts.length, 2);
    assert.match(r.prompts[0] as string, new RegExp(OCC(1)));
    assert.equal(srv.claimCalls.length, 2);
  });

  it("R7: a held call inside the routine turn → follow-up turn on the decision; the run is reported once", async () => {
    const srv = new FakeEvolution();
    srv.jobs.push(job(1));
    const r = runner("m1", srv, {
      polls: 6,
      onTurn: (n, ev) => {
        if (n === 1) ev.onHeld({ status: "held", holdId: "hld_1", expiresAt: new Date(2_000_000_000_000).toISOString(), checkWith: "evolution__tb_hold_status", tool: "kanban__issue_create" } as never);
      },
    });
    await r.done;
    assert.equal(r.prompts.length, 2);
    assert.match(r.prompts[1] as string, /APPROVED.*kanban__issue_create/s);
    assert.deepEqual(statuses(srv, OCC(1)), ["dispatched", "completed"]);
    assert.match(srv.reports.at(-1)?.summary ?? "", /held: 1/);
  });

  it("R8 (unit): routines_due refused at the bridge (agent paused) → no claim, no turn, back-off", async () => {
    const srv = new FakeEvolution();
    srv.jobs.push(job(1));
    srv.dueRefused = "paused";
    const r = runner("m1", srv, { polls: 3 });
    await r.done;
    assert.equal(srv.claimCalls.length, 0);
    assert.equal(r.prompts.length, 0);
    assert.ok(r.logs.filter((l) => l.e === "serve.error").length >= 2, "backs off instead of spinning");
    assert.ok(r.logs.some((l) => l.e === "serve.routine.refused" && l.f?.code === "paused"));
  });

  it("a failed turn is reported `failed`; claimed:false reasons are kept locally", async () => {
    const srv = new FakeEvolution();
    srv.jobs.push(job(1));
    const r = runner("m1", srv, { polls: 2, turnOk: false });
    await r.done;
    assert.deepEqual(statuses(srv, OCC(1)), ["dispatched", "failed"]);
  });

  it("config: routines only is valid; tool names checked; summaries bounded and masked", () => {
    assert.equal(cfg.inboxes.length, 0);
    assert.throws(() => validateServeConfig({ format: "tealbrick.agent-serve/1", harness: { kind: "claude" } }), /at least one/);
    assert.throws(() => validateServeConfig({ format: "tealbrick.agent-serve/1", harness: { kind: "claude" }, routines: [{ due: "routines_due", claim: "evolution__routine_claim", report: "evolution__routine_report" }] }));
    const s = reportSummary(`done ${"x".repeat(900)} with tbs_abcdefghijklmnop`, 2);
    assert.ok(s.length <= 500);
    assert.doesNotMatch(reportSummary("token tbs_abcdefghijklmnop sk-abcdefghijkl", 0), /tbs_abc|sk-abc/);
    assert.ok(routinePrompt(cfg.routines?.[0] as never, { instruction: "x".repeat(100_000) }, "T").length <= 64_100);
  });
});
