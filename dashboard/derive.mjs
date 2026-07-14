// WHAT THIS FILE IS:
// The dashboard's data layer — PURE functions that turn the pipeline's real
// artifacts (runlog.jsonl + events.jsonl, plus per-ticket titles/branches the
// browser fetches) into the exact view model the UI renders. No DOM, no fetch,
// so it is unit-testable in Node against the real files (see _selftest below).
//
// Two sources, by design:
//   runlog.jsonl — durable, one row per FINISHED stage attempt (approved,
//                  gateKind, gateSource, attempt, branch, mode). No timestamps.
//   events.jsonl — timestamped, fine-grained lifecycle: run/stage_started,
//                  agent_started{kb.offered}, agent_tool_use, kb_read,
//                  gate_result, belt_route, awaiting_approval, stage_finished,
//                  run_finished. This is what makes "running/waiting/live" and
//                  the KB view real; runlog is the fallback for historical
//                  tickets that predate events.jsonl.

export const CAP = 3; // MAX_IMPLEMENT_ATTEMPTS / MAX_QA_ATTEMPTS in the pipeline

// The pipeline's writing flow is 6 stages; Deploy is a planned future step, not
// a real stage — rendered dimmed. gate: 'hard' = deterministic gate, 'soft' =
// human approve pause, 'auto' = runs through.
export const STAGES = [
  { key: "parse", label: "Parse", gate: "auto" },
  { key: "spec", label: "Spec", gate: "soft" },
  { key: "implement", label: "Implement", gate: "auto" },
  { key: "review", label: "Review", gate: "soft" },
  { key: "test", label: "Test", gate: "auto" },
  { key: "qa", label: "QA Gate", gate: "hard" },
  { key: "deploy", label: "Deploy", gate: "hard", planned: true },
];
const STAGE_KEYS = new Set(STAGES.map((s) => s.key));

export const COLORS = {
  done: "#34d399", running: "#22d3ee", waiting: "#f5b83d", failed: "#fb7185",
  blocked: "#c084fc", todo: "#4b5563", planned: "#3a4552", skipped: "#5c6773",
};

// ---------- formatting ----------
export function fmtDur(ms) {
  if (ms == null) return "—";
  if (ms < 1000) return ms + "ms";
  if (ms < 60000) return (ms / 1000).toFixed(1) + "s";
  const m = Math.floor(ms / 60000), s = Math.round((ms % 60000) / 1000);
  return m + "m " + (s < 10 ? "0" : "") + s + "s";
}
export function fmtAgo(ms) {
  if (ms == null || !isFinite(ms)) return "";
  const min = ms / 60000;
  if (min < 1) return "now";
  if (min < 60) return Math.round(min) + "m ago";
  if (min < 1440) return Math.round(min / 60) + "h ago";
  return Math.round(min / 1440) + "d ago";
}
export function fmtCost(n) { return n == null ? "—" : "$" + Number(n).toFixed(2); }

// ---------- parsing ----------
export function parseNdjson(text) {
  if (!text) return [];
  const out = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try { out.push(JSON.parse(t)); } catch { /* skip partial/garbage line */ }
  }
  return out;
}

function tsMs(ev) {
  if (!ev || !ev.ts) return null;
  const n = Date.parse(ev.ts);
  return isNaN(n) ? null : n;
}

// ---------- per-ticket derivation ----------
function deriveTicket(id, runlog, events, meta, now) {
  // runlog.jsonl is append-only across ALL pipeline invocations, so re-running
  // a stage appends another row with the SAME attempt number. Collapse to the
  // last occurrence per (stage, attempt), ordered by that last position — this
  // removes re-run noise while PRESERVING genuine belt loops, which carry
  // distinct increasing attempt numbers. (runlog has no run-id, so cross-run
  // reconciliation is necessarily heuristic.)
  const seen = new Map();
  runlog.forEach((e, i) => {
    if (String(e.ticket) !== id) return;
    seen.set(e.stage + "#" + (e.attempt || 1), { e, i });
  });
  const rl = [...seen.values()].sort((a, b) => a.i - b.i).map((x) => x.e);
  const ev = events.filter((e) => String(e.ticket) === id);
  const m = (meta && meta[id]) || {};

  // Per-stage state. Prefer the events lifecycle (has ordering + running/
  // waiting); fall back to runlog for tickets that predate events.jsonl.
  const stages = {};
  for (const st of STAGES) {
    const rlFor = rl.filter((e) => e.stage === st.key);
    const evFor = ev.filter((e) => e.stage === st.key);
    const lastRl = rlFor[rlFor.length - 1] || null;

    let state = "todo";
    let durationMs = lastRl ? lastRl.durationMs ?? null : null;
    let attempts = rlFor.length;

    if (evFor.length) {
      // Find the latest lifecycle marker.
      let lastStarted = -1, lastFinished = -1, lastAwait = -1, finishedEv = null;
      evFor.forEach((e, i) => {
        if (e.type === "stage_started") lastStarted = i;
        else if (e.type === "awaiting_approval") lastAwait = i;
        else if (e.type === "stage_finished") { lastFinished = i; finishedEv = e; }
      });
      const startedAttempts = evFor.filter((e) => e.type === "stage_started").length;
      attempts = Math.max(attempts, startedAttempts);
      if (lastStarted > lastFinished) {
        // In progress: waiting for a human if awaiting_approval came after start.
        state = lastAwait > lastStarted ? "waiting" : "running";
      } else if (finishedEv) {
        state = finishedEv.approved === true ? "done" : "failed";
        if (finishedEv.durationMs != null) durationMs = finishedEv.durationMs;
      }
    } else if (lastRl) {
      state = lastRl.approved === true ? "done" : "failed";
    }
    // A stage turned off via sdlc.config.json (enabled:false), or one the
    // orchestrator emitted a stage_skipped event for, that never actually ran is
    // shown as "skipped" rather than "not reached" — the pipeline is bypassing
    // it on purpose. Real run history (a stage that ran before being disabled)
    // still wins: we only relabel the untouched "todo".
    const skipped = evFor.some((e) => e.type === "stage_skipped") || stageDisabled(st.key, m.config);
    if (skipped && state === "todo") state = "skipped";
    if (st.planned) state = "planned"; // Deploy is never real yet

    // Gate detail for this stage (implement=syntax, qa=verdict/e2e/coverage).
    let gateKind = null, gateSource = null;
    if (lastRl && (st.key === "implement" || st.key === "qa")) {
      gateKind = lastRl.gateKind ?? null;
      gateSource = lastRl.gateSource ?? (st.key === "implement" ? "checks" : null);
    }

    stages[st.key] = {
      key: st.key, label: st.label, gate: st.gate, planned: !!st.planned,
      mode: (lastRl && lastRl.mode) || stageMode(st.key, m.config),
      state, attempts, durationMs, gateKind, gateSource,
      // What a running/waiting stage is doing right now (its latest event), so
      // the UI shows live progress instead of looking frozen — especially
      // during the silent E2E/coverage gate phase after the agent finishes.
      activeDetail: state === "running" || state === "waiting" ? activeDetailOf(evFor[evFor.length - 1]) : "",
    };
  }

  const implAttempts = stages.implement.attempts || 0;
  const beltLoops = Math.max(0, implAttempts - 1);
  const infraRetries = rl.filter((e) => e.stage === "qa" && e.gateKind === "infra-failure").length;

  // The stages that will actually run for this ticket: real (non-planned) minus
  // any turned off via config (skipped). "Done" is judged against these, so a
  // disabled trailing stage (e.g. qa) doesn't leave a finished ticket stuck
  // "in-progress" forever.
  const activeStages = STAGES.filter((s) => !s.planned && stages[s.key].state !== "skipped");
  const lastActive = activeStages[activeStages.length - 1] || null;

  // ticket status
  const anyRunning = STAGES.some((s) => stages[s.key].state === "running");
  const anyWaiting = STAGES.some((s) => stages[s.key].state === "waiting");
  const qaDone = stages.qa.state === "done";
  const qaFailed = stages.qa.state === "failed";
  const blocked = qaFailed && implAttempts >= CAP;
  // Terminal success = every active stage has passed. With qa enabled that means
  // "qa passed"; with qa disabled it means "the last enabled stage passed".
  const finalDone = activeStages.length > 0 && activeStages.every((s) => stages[s.key].state === "done");
  let status = "in-progress";
  if (anyRunning) status = "running";
  else if (anyWaiting) status = "waiting";
  else if (blocked) status = "blocked";
  else if (finalDone) status = "done"; // last enabled stage passed = terminal success (no deploy yet)

  // current stage
  let current = "parse";
  if (status === "running") current = STAGES.find((s) => stages[s.key].state === "running").key;
  else if (status === "waiting") current = STAGES.find((s) => stages[s.key].state === "waiting").key;
  else if (blocked) current = "qa";
  else if (status === "done") current = lastActive ? lastActive.key : "qa";
  else {
    const todo = STAGES.find((s) => !s.planned && stages[s.key].state === "todo");
    current = todo ? todo.key : (lastActive ? lastActive.key : "qa");
  }

  const doneCount = activeStages.filter((s) => stages[s.key].state === "done").length;

  // KB consultation per stage (from events), for the Ticket Detail KB section.
  const kbByStage = {};
  for (const e of ev) {
    if (e.type === "agent_started" && e.kb) {
      kbByStage[e.stage] = kbByStage[e.stage] || { offered: false, reads: [] };
      if (e.kb.offered) kbByStage[e.stage].offered = true;
    } else if (e.type === "kb_read") {
      kbByStage[e.stage] = kbByStage[e.stage] || { offered: true, reads: [] };
      if (!kbByStage[e.stage].reads.includes(e.file)) kbByStage[e.stage].reads.push(e.file);
    }
  }

  // Timeline: one row per runlog stage attempt (the writing-flow stages only),
  // in chronological (append) order, enriched with gate breakdown + feedback.
  const timeline = rl
    .filter((e) => STAGE_KEYS.has(e.stage) && e.stage !== "deploy")
    .map((e) => {
      let state = "done", stateLabel = "PASSED";
      if (e.approved === true) { state = "done"; stateLabel = "PASSED"; }
      else { state = "failed"; stateLabel = e.gateKind === "infra-failure" ? "INFRA" : "FAILED"; }
      return {
        stage: e.stage,
        label: STAGES.find((s) => s.key === e.stage).label,
        mode: e.mode || "auto",
        attempt: e.attempt || 1,
        state, stateLabel,
        durationMs: e.durationMs ?? null,
        feedback: e.feedback || "",
        loopBack: e.stage === "implement" && e.attempt > 1 ? "#" + (e.attempt - 1) + " → " + e.attempt : "",
        gateChecks: gateChecks(e),
      };
    });

  const lastTs = ev.reduce((a, e) => Math.max(a, tsMs(e) || 0), 0) || null;

  const outcome = outcomeOf(status);
  return {
    id, title: m.title || "Ticket " + id, branch: m.branch || "feature/" + id, product: m.product || "",
    stages, status, current, implAttempts, beltLoops, infraRetries, doneCount, activeStageCount: activeStages.length,
    kbByStage, timeline, lastTs, outcome, ents: rl,
  };
}

// A short human label for what a stage is doing right now, from its latest
// event. gate_started makes the otherwise-silent E2E/coverage phase visible.
function activeDetailOf(e) {
  if (!e) return "";
  if (e.type === "gate_started") return e.source === "e2e" ? "E2E gate…" : e.source === "coverage" ? "coverage check…" : "gate…";
  if (e.type === "agent_tool_use") {
    const tgt = e.target ? String(e.target).split(/[\\/]/).pop() : "";
    return e.tool + (tgt ? " · " + tgt : "");
  }
  if (e.type === "kb_read") return "KB · " + (e.file || "");
  if (e.type === "agent_started") return "agent starting…";
  if (e.type === "stage_started") return "starting…";
  if (e.type === "awaiting_approval") return "awaiting approval";
  return "";
}

function stageMode(key, config) {
  if (config && config.stages && config.stages[key] && config.stages[key].mode) return config.stages[key].mode;
  // sensible default matching the template's shipped config
  return key === "parse" || key === "spec" ? "approve" : "auto";
}

// A stage is disabled only when config explicitly says enabled:false. Absent
// config (a historical ticket, or config not yet fetched) is NOT disabled — the
// stage_skipped event is the other signal that a stage was bypassed.
function stageDisabled(key, config) {
  return !!(config && config.stages && config.stages[key] && config.stages[key].enabled === false);
}

function outcomeOf(status) {
  switch (status) {
    case "done": return { text: "Done · QA passed", kind: "done" };
    case "blocked": return { text: "Blocked — human needed", kind: "blocked" };
    case "running": return { text: "In progress", kind: "running" };
    case "waiting": return { text: "Paused for approval", kind: "waiting" };
    default: return { text: "In progress", kind: "todo" };
  }
}

// Build the Verdict/E2E/Coverage (qa) or Syntax (implement) check breakdown for
// a runlog gate entry, INFERRING the sequence from the single deciding source:
// the QA gate runs verdict -> e2e -> coverage and stops at the first failure, so
// the deciding source tells us which earlier checks implicitly passed.
function gateChecks(e) {
  if (e.stage === "implement") {
    const ok = e.approved === true;
    return [{ label: "Syntax", value: ok ? "PASS" : "FAIL", kind: ok ? "pass" : "fail" }];
  }
  if (e.stage !== "qa") return null;
  const order = ["verdict", "e2e", "coverage"];
  const src = e.gateSource;
  const passed = e.approved === true;
  const infra = e.gateKind === "infra-failure";
  const labels = { verdict: "Verdict", e2e: "E2E", coverage: "Coverage" };
  const stopAt = passed ? order.length : Math.max(0, order.indexOf(src));
  return order.map((k, i) => {
    let value, kind;
    if (passed) { value = k === "verdict" ? "SHIP" : "PASS"; kind = "pass"; }
    else if (i < stopAt) { value = k === "verdict" ? "SHIP" : "PASS"; kind = "pass"; }
    else if (i === stopAt) {
      if (k === "verdict") { value = "NO-SHIP"; kind = "fail"; }
      else if (k === "e2e") { value = infra ? "INFRA" : "FAIL"; kind = infra ? "infra" : "fail"; }
      else { value = "GAP"; kind = "fail"; }
    } else { value = "n/a"; kind = "na"; }
    return { label: labels[k], value, kind };
  });
}

// ---------- global model ----------
export function deriveModel({ runlog = [], events = [], meta = {}, now = null } = {}) {
  const ids = [...new Set([...runlog, ...events].map((e) => e && e.ticket).filter(Boolean).map(String))];
  const nowMs = now != null ? now : events.reduce((a, e) => Math.max(a, tsMs(e) || 0), 0) || Date.now();

  const tickets = ids.map((id) => deriveTicket(id, runlog, events, meta, nowMs))
    .sort((a, b) => (b.lastTs || 0) - (a.lastTs || 0));

  const allEnts = tickets.flatMap((t) => t.ents); // deduped, across tickets
  const count = (s) => tickets.filter((t) => t.status === s).length;
  const qaReached = tickets.filter((t) => t.stages.qa.attempts > 0);
  const qaFirst = qaReached.filter((t) => {
    const firstQa = t.ents.find((e) => e.stage === "qa");
    return firstQa && firstQa.approved === true;
  }).length;
  const qaRate = qaReached.length ? Math.round((qaFirst / qaReached.length) * 100) : 0;

  const topStats = {
    running: count("running"), waiting: count("waiting"),
    blocked: count("blocked"), done: count("done"), qaRate,
  };

  // Recent activity — from events (they carry timestamps). Human-readable.
  const activity = events
    .filter((e) => ["stage_finished", "stage_skipped", "gate_result", "belt_route", "run_finished", "awaiting_approval"].includes(e.type))
    .slice(-40).reverse()
    .map((e) => activityLine(e, nowMs))
    .filter(Boolean)
    .slice(0, 12);

  // Gate results (QA attempts). Derived from runlog qa entries (deploy planned).
  const gateResults = [];
  for (const t of tickets) {
    t.ents.filter((e) => e.stage === "qa").forEach((e) => {
      gateResults.push({
        ticket: t.id, title: t.title, gate: "QA",
        attempt: e.attempt || 1,
        verdict: e.approved === true ? "SHIP" : "NO-SHIP",
        passed: e.approved === true,
        checks: gateChecks(e),
        feedback: e.feedback || "",
      });
    });
  }

  // Observability aggregates.
  const totalLoops = tickets.reduce((a, t) => a + t.beltLoops, 0);
  const totalInfra = tickets.reduce((a, t) => a + t.infraRetries, 0);
  const stageAgg = STAGES.filter((s) => !s.planned).map((st) => {
    const se = allEnts.filter((e) => e.stage === st.key);
    const reached = tickets.filter((t) => t.stages[st.key].attempts > 0);
    const firstPass = reached.filter((t) => {
      const first = t.ents.find((e) => e.stage === st.key);
      return first && first.approved === true;
    }).length;
    const rate = reached.length ? Math.round((firstPass / reached.length) * 100) : 0;
    const durs = se.filter((e) => e.durationMs != null).map((e) => e.durationMs);
    const avg = durs.length ? Math.round(durs.reduce((a, b) => a + b, 0) / durs.length) : null;
    return { key: st.key, label: st.label, gate: st.gate, rate, runs: se.length, avg, spend: null };
  });
  const qaRealFails = allEnts.filter((e) => e.stage === "qa" && e.approved === false && e.gateKind !== "infra-failure").length;
  const beltHot = [
    { label: "QA Gate — real failures", count: qaRealFails, kind: "failed", sub: `caused ${totalLoops} implement re-runs` },
    { label: "QA Gate — infra retries", count: totalInfra, kind: "waiting", sub: "gate re-run only — no belt loop" },
    { label: "Deploy Gate", count: 0, kind: "todo", sub: "not implemented yet" },
  ];
  const obs = {
    tiles: [
      { label: "Done", value: String(topStats.done), kind: "done", sub: "QA passed" },
      { label: "Blocked", value: String(topStats.blocked), kind: "blocked", sub: "hit retry cap" },
      { label: "Belt loops", value: String(totalLoops), kind: "blocked", sub: "implement re-runs" },
      { label: "Infra retries", value: String(totalInfra), kind: "waiting", sub: "not product defects" },
      { label: "Total spend", value: "—", kind: "todo", sub: "cost — later" },
    ],
    stageAgg, beltHot,
  };

  return { now: nowMs, tickets, topStats, activity, gateResults, obs };
}

function activityLine(e, nowMs) {
  const label = (STAGES.find((s) => s.key === e.stage) || {}).label || e.stage || "";
  const ago = fmtAgo(nowMs - (tsMs(e) || nowMs));
  if (e.type === "stage_finished") {
    if (e.approved === true) return { ticket: e.ticket, state: "done", text: `${label} passed` + (e.attempt > 1 ? ` (attempt ${e.attempt})` : ""), ago, feedback: "" };
    if (e.reason === "infra-failure") return { ticket: e.ticket, state: "waiting", text: `${label} infra error`, ago, feedback: "" };
    return { ticket: e.ticket, state: "failed", text: `${label} rejected` + (e.attempt ? ` (attempt ${e.attempt})` : ""), ago, feedback: "" };
  }
  if (e.type === "stage_skipped") return { ticket: e.ticket, state: "skipped", text: `${label} skipped (disabled)`, ago, feedback: "" };
  if (e.type === "awaiting_approval") return { ticket: e.ticket, state: "waiting", text: `${label} awaiting approval`, ago, feedback: "" };
  if (e.type === "belt_route") return { ticket: e.ticket, state: "blocked", text: `belt → ${e.to} (${e.reason})`, ago, feedback: "" };
  if (e.type === "gate_result" && e.passed === false) return { ticket: e.ticket, state: "failed", text: `${label} gate: ${e.source} ${e.kind}`, ago, feedback: "" };
  if (e.type === "run_finished") return { ticket: e.ticket, state: e.outcome === "complete" ? "done" : "failed", text: `run ${e.outcome}`, ago, feedback: e.error || "" };
  return null;
}
