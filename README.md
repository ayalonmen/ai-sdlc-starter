# Swing Trading App

A paper-trading / backtest engine for a swing trading strategy, built
using its own AI-driven SDLC pipeline.

Two things live in this repo:

1. **The product** — a swing trading backtest engine. It will simulate a
   moving-average-crossover strategy against historical daily price bars,
   with risk-based position sizing, stop-losses, and a P&L summary. No
   live broker connection, no real money, no financial advice — this is
   a simulation sandbox.
2. **The factory that builds it** — a small multi-agent pipeline that
   takes a feature request from a rough idea through to a reviewed,
   tested, deployed change, with configurable human-in-the-loop approval
   at each stage.

So far the pipeline wires up three stages: a ticket moves through `parse`,
`spec`, and `implement`. The first two are independent agents with their
own approval pause and reject-with-feedback retry loop; `implement`
writes real code on an isolated branch and is gated by a passing build
instead of a human sign-off.

## Why an AI-SDLC pipeline

Instead of one long chat where an AI writes the whole app in one shot,
the work is broken into stages that mirror a normal software lifecycle:
parse the request, write a spec, implement, review, test, QA, deploy.
Each stage is a separate, narrowly-scoped agent invocation. You control,
per stage, whether the agent runs on its own (`auto`), pauses for your
sign-off (`approve`), or is left entirely to you (`manual`). That dial
lives in `sdlc.config.json`.

Files are the handoff between stages — an agent reads files, writes
output, and the next stage picks it up from disk. That keeps every step
inspectable and auditable instead of buried in chat history.

## How it works

```
you write tickets/001.md (a fuzzy feature request)
        │
        ▼
npm run sdlc run 001
        │
        ▼
pipeline/run.ts (the orchestrator) runs each configured stage in order
```

Every stage (`parse`, `spec`, ...) follows the same generic loop, via a
shared `runStage()` helper in `pipeline/run.ts`:

```
reads sdlc.config.json to check this stage's mode
reads CLAUDE.md + agents/<stage>.md + this stage's input
calls `claude -p` headlessly with that combined prompt
        │
        ▼
agent responds with its stage-specific output
        │
        ▼
orchestrator prints the result and asks: "Approve this output? (y/n)"
        │
        ├─ y → saved wherever this stage's output belongs, logged to runlog.jsonl
        │
        └─ n → asks "What should change?"
                 │
                 ▼
               logs the rejection + your feedback to runlog.jsonl
                 │
                 ▼
               re-runs the same agent, this time including the
               rejected output and your feedback in its prompt
                 │
                 ▼
               (loops back to "Approve this output?" until you say y)
```

Stages wired up so far:

- **parse** — input: the raw ticket. Output: Tasks / Acceptance Criteria /
  Decisions, appended to `tickets/<id>.md`.
- **spec** — input: the ticket (now including parse's approved criteria).
  Read-only (`allowedTools: ["Read"]`). Output: a concrete implementation
  spec (types, function signatures, edge cases, file layout), written to
  `specs/<id>.md`.
- **implement** — input: the approved spec. Runs on its own function,
  not the shared `runStage()` loop, because it doesn't fit that shape:

  ```
  ensureBranch(id)          → creates/switches to feature/<id>, never main
        │
        ▼
  callAgent(...)            → agent gets Read/Edit/Write/Bash access,
                               writes real files in src/ itself
        │
        ▼
  buildPasses()              → pipeline/gates.ts runs `npm run build`
        │                      (a real exit code, not the agent's word for it)
        ├─ pass → logged, pipeline continues
        └─ fail → logged, pipeline throws and stops — inspect the branch
  ```

  There's no approve/reject pause here even though `sdlc.config.json` has
  `implement` set to `"auto"` — the build gate is what stands in for human
  review at this stage.

Later sessions add `review`, `test`, `QA`, and `deploy`, each with its own
agent prompt under `agents/` and its own entry in `sdlc.config.json`. QA
and deploy will always be hard gates — never configurable to `auto`.

**Known gap:** `sdlc.config.json`'s `implement.maxTurns` isn't enforced.
The installed `claude` CLI has no turn-limiting flag (only
`--max-budget-usd`, a dollar cap), so `maxTurns` is accepted by the code
for forward compatibility but does nothing yet — the build gate is
currently the only safety net for an unattended implement run.

## File structure

```
Swing Trading App/
├── README.md            this file
├── CLAUDE.md             shared context every agent reads first (stack, conventions, pipeline overview)
├── sdlc.config.json      the autonomy dial — which stages are manual / approve / auto
├── package.json          npm scripts, incl. `sdlc` which runs the orchestrator
├── tsconfig.json         TypeScript config for the pipeline code
├── agents/
│   ├── parse.md          the parse agent's role prompt (read-only; turns a fuzzy request into tasks + acceptance criteria)
│   ├── spec.md           the spec agent's role prompt (read-only; turns approved criteria into types, function signatures, edge cases, file layout)
│   └── implement.md      the implement agent's role prompt (Read/Edit/Write/Bash; writes the spec as working code in src/)
├── tickets/
│   └── 001.md            a feature request, written by hand, with parse agent output appended below the divider
├── specs/
│   └── 001.md            the spec agent's output for this ticket (created once the spec stage runs)
├── src/                  written by the implement agent, on branch feature/<id>
├── pipeline/
│   ├── run.ts            the orchestrator: a generic runStage() helper for parse/spec, plus a standalone runStageImplement() (branch, agent, build gate)
│   └── gates.ts          deterministic pass/fail checks (currently just `npm run build`) — no model involved
└── runlog.jsonl          one JSON line appended per pipeline run (stage, ticket, mode, duration, approved, and feedback when rejected)
```

## Prerequisites

- Node.js
- Git (the implement stage creates and switches branches)
- The `claude` CLI (Claude Code) installed and on your `PATH` — the
  orchestrator shells out to `claude -p` to invoke agents headlessly

## Usage

Install dependencies (already done if `node_modules` exists):

```bash
npm install
```

Run the pipeline on a ticket:

```bash
npm run sdlc run 001
```

This runs `parse`, then (once approved) `spec`, then `implement` — which
switches to `feature/001`, lets the agent write real code, and stops the
pipeline if `npm run build` doesn't pass afterward. `parse` and `spec`
pause for your approval; every run, approved or rejected, is recorded in
`runlog.jsonl`.

To try a new feature request, create a new ticket file (e.g.
`tickets/002.md`) with your own rough description, then run
`npm run sdlc run 002`.

## Configuring the autonomy dial

`sdlc.config.json` controls how much each stage runs unattended:

```json
{
  "stages": {
    "parse": { "mode": "approve" },
    "spec": { "mode": "approve" },
    "implement": { "mode": "auto", "maxTurns": 30 }
  }
}
```

`implement.maxTurns` is not currently enforced (see the known gap above)
— it's read from config but not passed to the CLI as a limit.

- `"manual"` — you do the stage yourself; the pipeline doesn't touch it.
- `"approve"` — the agent produces output, the pipeline pauses and asks
  for your `y`/`n` before saving.
- `"auto"` — the agent runs and the pipeline continues without asking.

As more stages come online, they get their own entry here. QA and
deploy are hard gates by design and will never accept `"auto"`.
