# CLAUDE.md

<!--
WHAT THIS FILE IS:
The sticky note every agent reads first. Claude Code auto-loads this file
from the repo root into context for every stage agent (parse, spec,
implement, review, test, QA...). It carries the static facts that never
change between tickets, so we don't have to repeat them in every prompt.
-->

## Project

Expense Splitter: a single-page web application for splitting shared
expenses within a group. A group consists of members and shared expenses,
where each expense records who paid, the amount, and which members share
the cost. The application tracks running balances, determines who owes whom
to settle up, and persists all data locally in the browser. No backend, no
accounts, no real payments — this is an SDLC practice sandbox with a
genuinely rich domain (even splits, net balances, minimal settle-up
transactions, currency conversion).

## Stack

- TypeScript
- React (single-page, functional components)
- localStorage for persistence (in-memory state, hydrated from and flushed
  to localStorage)
- Runs entirely locally, no backend

## Conventions

- Pure functions for anything that touches money math (share splitting, net
  balances, settle-up transactions) so they stay trivially testable, and
  kept separate from React components.
- Balances must sum to zero within rounding tolerance; never let rounding
  corrupt state.
- All user input is validated at the boundary; invalid input shows an
  inline message and never corrupts state.
- Files are the handoff protocol between pipeline stages. Agents read and
  write plain files under `tickets/`, `specs/` (`reviews/`, `qa/` arrive as
  the stages that use them come online).

## Pipeline

This repo is built by its own AI-SDLC pipeline (`pipeline/run.ts`). Each
feature ticket moves through stages (parse, spec, implement, review, test,
QA, deploy). Stage behavior (auto / approve / manual) is controlled by
`sdlc.config.json`. See `agents/*.md` for each stage's role prompt.

The implement stage writes real code, so it runs on an isolated
`feature/<ticketId>` branch (never main) and is gated by a deterministic
check afterward — `npm run build` passing, via `pipeline/gates.ts` — not
by the agent's own claim that it succeeded.