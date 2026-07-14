# ai-sdlc-starter

An **AI-driven SDLC pipeline** you fork per project. An orchestrator
(`pipeline/run.ts`) drives a feature ticket through the stages of a normal
software lifecycle — `parse → spec → implement → review → test → qa` — where
each stage is a separate, narrowly-scoped Claude Code agent, and a
deterministic gate stands between the model and the pipeline proceeding.

This repo contains **zero product code** and hardcodes no toolchain. You point
it at a product by setting two paths in `sdlc.config.json`:

- `project.productPath` — the product repo the pipeline operates on. Agents
  that touch code (`implement`, `test`) run with their cwd here, on an isolated
  `feature/<ticketId>` branch, never on the product's `main`.
- `project.knowledgePath` — a knowledge repo the optional learning loop proposes
  durable facts into.

The product describes how *it* builds and tests via its own
`.sdlc/product.json` (per-component `check` commands, an `e2e.run` command, and
`e2e.testDir`). The pipeline reads that descriptor and never assumes a stack.

## Why an AI-SDLC pipeline

Instead of one long chat where an AI writes a whole app in one shot, the work
is broken into stages that mirror a real software lifecycle. Each stage is a
separate agent invocation with a single job. You control, **per stage**, whether
the agent runs on its own (`auto`), pauses for your sign-off (`approve`), or is
left entirely to you (`manual`). That dial lives in `sdlc.config.json`.

Two principles hold the design together:

- **Files are the handoff protocol.** An agent reads files, writes output, and
  the next stage picks it up from disk. Every step is inspectable and auditable
  instead of buried in chat history. Process artifacts (`tickets/`, `specs/`,
  `reviews/`, `qa/`) live in *this* repo; code and tests live in the product
  repo, on the feature branch.
- **Model proposes, script decides.** Agents never gate themselves. The
  orchestrator runs the checks in `pipeline/gates.ts`, reading files the model
  was not allowed to write. A gate is a real exit code, not the agent's word
  for it.

## How it works

```
you write tickets/001.md (a fuzzy feature request)
        │
        ▼
npm run sdlc run 001
        │
        ▼
pipeline/run.ts (the orchestrator) walks STAGE_ORDER, running each
enabled stage in order and applying its gate before moving on
```

The text-producing stages (`parse`, `spec`, `review`) follow the same generic
loop via a shared `runStage()` helper: the orchestrator assembles a prompt
(`CLAUDE.md` + `agents/<stage>.md` + this stage's input, plus a KB index when
relevant), calls the `claude` CLI headlessly, and — in `approve` mode — pauses
for your `y`/`n`. On reject it asks what should change, logs the feedback to
`runlog.jsonl`, and re-runs the agent with the rejected output and your
feedback threaded in.

## Stages

Order and the auto-resume logic both walk `STAGE_ORDER` in `run.ts`. Each
stage's role prompt lives in `agents/<stage>.md`; each carries the stable
`AC-N` acceptance-criteria IDs forward.

- **parse** — turns a fuzzy request into tasks + acceptance criteria, each with
  a stable `AC-N` ID. Appends to `tickets/<id>.md`.
- **spec** — turns the criteria into a technical spec (types, signatures, edge
  cases, file layout), carrying the `AC-N` IDs forward. Writes `specs/<id>.md`.
- **implement** — writes real code in the *product* repo on `feature/<id>`.
  Gated by the product's deterministic `check` (syntax only); self-corrects
  against syntax up to a cap. No human pause even in `auto` — the check is the
  gate.
- **review** — reads the spec + code, writes findings to `reviews/<id>.md`. A
  hard gate: `checkReview` scans for `[BLOCKER]` bullets; any blocker belts back
  to `implement` (bounded), then to a human.
- **test** — writes E2E scenarios in the product repo, each tagged
  `// COVERS: AC-N`.
- **qa** — the authoritative gate, fully deterministic (no agent). The
  orchestrator writes a `qa/<id>.md` summary, then `runQaGate` runs the full E2E
  suite, plus `checkCoverage` (every `AC-N` needs a live covering test) *only
  when the `test` stage is enabled*. With `test` off, QA gates on E2E alone.

**Gate failures route to the stage that owns the fix.** A failing E2E test or a
`[BLOCKER]` finding → `implement`. A coverage gap → `test`. An infra failure
(harness didn't come up) retries the gate, never an agent, then escalates to a
human. Each belt is bounded; a belt to a disabled stage stops for a human.

### Learning loop (optional)

When `learning.enabled` is set, a post-ticket loop runs *after* the pipeline
finishes (even for a belted/aborted ticket) and is not part of `STAGE_ORDER`:

- **retrospector** (`agents/retrospector.md`) — aggregates one ticket's run
  (runlog, ticket, spec, review, QA, optional diff) into a single factual
  summary at `retros/<id>.md`. It reports; it does not judge.
- **curator** (`agents/curator.md`) — the sole writer to the knowledge repo. It
  is deliberately picky, proposes concept files (never writes directly), and its
  proposals pass `pipeline/kb-conformance.ts` — a deterministic *shape* gate
  (frontmatter, type vocabulary, source citation, folder placement) — before a
  human merges them. A run summary is written to `curator/<id>.md`.

## Dashboard

```bash
npm run dashboard
```

`dashboard/serve.ts` serves a UI (`dashboard/index.html`) that tails
`runlog.jsonl` and the per-stage artifacts (`derive.mjs` derives the state), so
you can watch stages, gate results, belt routing, and the Curator's proposals as
a ticket moves through.

## File structure

```
ai-sdlc-starter/            this repo — the pipeline (a template you fork per project)
├── README.md               this file
├── CLAUDE.md               shared context every agent reads first (what the repo is, stack, stages, conventions)
├── sdlc.config.json        the control panel: product/knowledge paths, per-stage autonomy dial, learning toggle
├── package.json            npm scripts: `sdlc` (orchestrator), `dashboard`, `build`
├── tsconfig.json           TypeScript config for the pipeline code
├── .claude/
│   └── settings.json       Claude Code settings for the headless agent runs
├── agents/                 one role prompt per agent — all generic, no product specifics
│   ├── parse.md            fuzzy request → tasks + acceptance criteria (AC-N)
│   ├── spec.md             criteria → technical spec (carries AC-N forward)
│   ├── implement.md        spec → real code in the product repo, on feature/<id>
│   ├── review.md           spec + code → findings ([BLOCKER] bullets gate the pipeline)
│   ├── test.md             E2E scenarios in the product repo, tagged // COVERS: AC-N
│   ├── retrospector.md     learning loop: aggregates one run into a factual summary
│   └── curator.md          learning loop: proposes durable facts to the knowledge repo
├── pipeline/
│   ├── run.ts              the orchestrator — walks STAGE_ORDER, runs agents, applies gates, auto-resumes
│   ├── gates.ts            deterministic checks (runChecks, runE2E, checkReview, checkCoverage)
│   └── kb-conformance.ts   deterministic shape gate for the Curator's knowledge-base proposals
├── dashboard/
│   ├── serve.ts            `npm run dashboard` server
│   ├── derive.mjs          derives dashboard state from runlog.jsonl + artifacts
│   └── index.html          the dashboard UI
├── tickets/                INPUT: one <id>.md per feature request; parse output appended below the divider
│   └── .gitkeep
├── specs/                  written by spec       — specs/<id>.md
├── reviews/                written by review     — reviews/<id>.md
├── qa/                     written by the QA gate (deterministic) — qa/<id>.md
├── retros/                 written by retrospector (learning loop) — retros/<id>.md
├── curator/                curator run summary   (learning loop) — curator/<id>.md
└── runlog.jsonl            one JSON line per stage attempt (stage, ticket, mode, gate result, belt routing, feedback)

# outside this repo, set via sdlc.config.json:
../<product>/               project.productPath  — the product repo; code + tests land here on feature/<id>
                            (describes its own build/test via .sdlc/product.json)
../<knowledge>/             project.knowledgePath — the knowledge repo the Curator proposes durable facts into
```

The artifact folders `specs/`, `reviews/`, `qa/`, `retros/`, and `curator/` are
created on demand the first time their stage runs; only `tickets/` (holding your
input) is checked in.

## Prerequisites

- Node.js
- Git (the `implement`/`test` stages create and switch branches in the product repo)
- The `claude` CLI (Claude Code) installed and on your `PATH` — the orchestrator
  shells out to it to invoke agents headlessly

## Usage

Install dependencies (already done if `node_modules` exists):

```bash
npm install
```

Point the pipeline at your product and knowledge repos in `sdlc.config.json`
(`project.productPath` / `project.knowledgePath`), then write a ticket
(`tickets/001.md`) describing a feature in your own words. Run the pipeline:

```bash
npm run sdlc run 001
```

You can also run a single stage: `npm run sdlc run 001 spec`. Re-running a
ticket auto-resumes from the stage after the last one completed (tracked in
`runlog.jsonl`). To watch it live, start the dashboard in another terminal with
`npm run dashboard`.

## Configuring the autonomy dial

`sdlc.config.json` controls how much each stage runs unattended. Each stage
takes a `mode` and an optional `enabled` flag (defaults to `true`):

```json
{
  "project": {
    "productPath": "../Homebase",
    "knowledgePath": "../OKF"
  },
  "stages": {
    "parse":     { "enabled": true, "mode": "approve" },
    "spec":      { "enabled": true, "mode": "approve" },
    "implement": { "enabled": true, "mode": "auto", "maxTurns": 30 },
    "review":    { "enabled": true, "mode": "auto" },
    "test":      { "enabled": false, "mode": "auto" },
    "qa":        { "enabled": true, "mode": "auto" }
  },
  "learning": { "enabled": true }
}
```

- `"manual"` — you do the stage yourself; the pipeline doesn't touch it.
- `"approve"` — the agent produces output, the pipeline pauses for your `y`/`n`
  before saving; on reject it re-runs with your feedback.
- `"auto"` — the agent runs and the pipeline continues without a human pause.

`mode` only governs the *human* pause. The gated stages run their deterministic
check regardless: `implement` is gated by the product's syntax check, and `qa`
by the E2E suite + `AC-N` coverage. **QA is a hard gate that `mode` cannot
disable** — `auto` there only means "don't pause for a human before the gate
runs".

`"enabled": false` skips a stage entirely (no agent, no gate; the dashboard
shows it as *skipped*). Skipping is literal, not smart: disable a stage whose
artifact a later stage consumes (e.g. `spec`) and that later stage will fail
when the artifact is missing. Disabling `qa` removes the authoritative ship
gate.

**Known gap:** `implement.maxTurns` isn't enforced — the installed `claude` CLI
has no turn-limiting flag, so it's accepted for forward compatibility but does
nothing yet. The syntax check is currently the only safety net for an
unattended `implement` run.
