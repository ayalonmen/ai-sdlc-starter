// WHAT THIS FILE IS:
// The orchestrator. The small program that ties everything together for
// Session 1: read the config, read the ticket, call the parse agent
// (Claude Code, headless), show you the result, wait for your y/n, and
// save. Every run appends one line to runlog.jsonl so there's a record.
//
// Usage:
//   npm run sdlc run 001

import { readFileSync, appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { runBuild } from "./gates";

type StageMode = "manual" | "approve" | "auto";
type Config = { stages: Record<string, { mode: StageMode; maxTurns?: number }> };
type RetryContext = { priorAttempt: string; feedback: string };

// Bounded retry for the implement stage's automated fix loop (agent ->
// gate -> feed error back -> retry). Unlike the human reject loop for
// parse/spec, nothing here is asking a person each time, so it needs a
// hard ceiling or a persistently broken spec could retry forever.
const MAX_IMPLEMENT_ATTEMPTS = 3;

// The pipeline's fixed stage sequence. Both the auto-resume logic and the
// default run order in main() walk this same list, so adding a stage
// later (QA, deploy) means adding it here once.
const STAGE_ORDER = ["parse", "spec", "implement", "review", "test"] as const;
type Stage = (typeof STAGE_ORDER)[number];

function readConfig(): Config {
  return JSON.parse(readFileSync("sdlc.config.json", "utf8"));
}

function readTicket(id: string): string {
  const path = `tickets/${id}.md`;
  if (!existsSync(path)) {
    throw new Error(`No ticket found at ${path}`);
  }
  return readFileSync(path, "utf8");
}

function readSpec(id: string): string {
  const path = `specs/${id}.md`;
  if (!existsSync(path)) {
    throw new Error(`No spec found at ${path}. Run the spec stage first.`);
  }
  return readFileSync(path, "utf8");
}

// Creates (or, on a rerun, switches to) an isolated feature branch before
// the implement stage runs, so an agent with Write/Edit/Bash access never
// touches main directly.
function ensureBranch(ticketId: string): string {
  const branch = `feature/${ticketId}`;
  const alreadyExists =
    spawnSync("git", ["rev-parse", "--verify", branch], { encoding: "utf8" }).status === 0;
  const result = spawnSync("git", alreadyExists ? ["checkout", branch] : ["checkout", "-b", branch], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`Failed to switch to branch ${branch}: ${result.stderr}`);
  }
  return branch;
}

// Builds the prompt a stage agent sees: shared project context, its role
// description (from roleFile), the input it's working on, and — if a
// prior attempt was rejected — the rejected output plus the reviewer's
// feedback, so the agent revises instead of starting over blind.
//
// The trailing directive matters: without it, a headless Claude Code
// session sometimes treats this whole blob as passive background context
// (it auto-loads repo/git state regardless) and responds with a chatty
// "here's what I see in your repo, what would you like me to do?" instead
// of just doing the stage's job. An explicit "produce your output now, no
// questions, no preamble" instruction reliably prevents that.
function buildPrompt(roleFile: string, input: string, retry?: RetryContext): string {
  const projectContext = readFileSync("CLAUDE.md", "utf8");
  const roleDescription = readFileSync(roleFile, "utf8");
  const sections = [projectContext, roleDescription, "## Input", input];

  if (retry) {
    sections.push(
      [
        "## Your previous attempt was rejected",
        `Reviewer feedback: ${retry.feedback}`,
        "",
        "Previous output:",
        retry.priorAttempt,
        "",
        "Produce a revised version addressing the feedback.",
      ].join("\n")
    );
  }

  sections.push(
    "Now produce your output for the Input above, per the role instructions. " +
      "Respond with ONLY the required markdown deliverable — no questions, " +
      "no summary of repository state, no preamble."
  );

  return sections.join("\n\n---\n\n");
}

// Quotes each part and joins them into one command-line string, for
// platforms that need shell: true. Node deprecates (DEP0190) passing an
// args array alongside shell: true, because it has to join them into one
// string itself without escaping — a real injection risk if any part
// came from untrusted input. Doing the join explicitly here, ourselves,
// avoids that: spawnSync gets one pre-built string and no args array, so
// there's nothing left for it to (mis)join.
function quoteCommandLine(parts: string[]): string {
  return parts.map((part) => `"${part.replace(/"/g, '\\"')}"`).join(" ");
}

// Invokes Claude Code headlessly and returns its text output.
//
// The prompt travels over stdin rather than as a CLI argument: on Windows,
// npm installs "claude" as a .cmd shim, and cmd.exe re-parses argv, which
// mangles long/multiline text. Stdin sidesteps that and works the same on
// every platform. Windows also requires shell: true to launch .cmd files
// at all (Node refuses without it) — see quoteCommandLine above for why
// that's paired with a pre-built command string rather than an args array.
//
// allowedTools scopes what the agent can touch — e.g. the spec stage is
// read-only, so it's invoked with allowedTools: ["Read"], matching the
// "read-only agent" permission scoping described for parse/spec/review.
//
// maxTurns is accepted for forward compatibility with sdlc.config.json's
// implement.maxTurns, but this CLI version (checked via `claude --help`)
// has no turn-limiting flag, only --max-budget-usd (a dollar cap, not a
// turn cap). It is intentionally NOT enforced here rather than silently
// mapped to a different unit. The build gate is today's real safety net
// for an unattended implement run, not a turn limit.
function callAgent(prompt: string, opts?: { allowedTools?: string[]; maxTurns?: number }): string {
  const claudeCommand = process.platform === "win32" ? "claude.cmd" : "claude";
  const args = opts?.allowedTools
    ? ["--allowedTools", opts.allowedTools.join(","), "-p"]
    : ["-p"];
  const spawnOptions = { input: prompt, encoding: "utf8" as const, maxBuffer: 10 * 1024 * 1024 };
  const result =
    process.platform === "win32"
      ? spawnSync(quoteCommandLine([claudeCommand, ...args]), { ...spawnOptions, shell: true })
      : spawnSync(claudeCommand, args, spawnOptions);
  if (result.error) {
    throw new Error(`Failed to invoke claude CLI: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`claude CLI exited with code ${result.status}: ${result.stderr}`);
  }
  return result.stdout.trim();
}

async function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`${question} (y/n) `);
  rl.close();
  return answer.trim().toLowerCase().startsWith("y");
}

async function promptText(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`${question} `);
  rl.close();
  return answer.trim();
}

function logRun(entry: Record<string, unknown>): void {
  appendFileSync("runlog.jsonl", JSON.stringify(entry) + "\n");
}

function readRunlog(): Array<{ stage?: string; ticket?: string; approved?: boolean }> {
  if (!existsSync("runlog.jsonl")) return [];
  const raw = readFileSync("runlog.jsonl", "utf8").trim();
  if (!raw) return [];
  return raw.split("\n").map((line) => JSON.parse(line));
}

// Resumes a ticket from wherever it last left off, instead of always
// restarting at parse. runlog.jsonl is already a durable, append-only
// record of every stage attempt (see logRun), so it doubles as pipeline
// state — no separate state file to invent or keep in sync.
//
// "Last completed" means the highest-index stage in STAGE_ORDER that has
// a logged approved:true entry for this ticket. Rejected attempts
// (approved:false) don't count, so a stage that was rejected and later
// approved still resolves correctly; a stage that failed its gate (also
// approved:false, e.g. implement's build check) resumes AT that stage to
// retry it, not past it.
function resolveStartStage(ticketId: string): Stage {
  const log = readRunlog();
  let lastCompletedIndex = -1;

  for (const entry of log) {
    if (entry.ticket !== ticketId || entry.approved !== true) continue;
    const index = STAGE_ORDER.indexOf(entry.stage as Stage);
    if (index > lastCompletedIndex) lastCompletedIndex = index;
  }

  const nextIndex = lastCompletedIndex + 1;
  if (nextIndex >= STAGE_ORDER.length) {
    console.log(
      `Ticket ${ticketId} has already completed every configured stage (${STAGE_ORDER.join(" -> ")}).`
    );
    console.log("Use --stage <name> to force a re-run of a specific stage.");
    process.exit(0);
  }

  return STAGE_ORDER[nextIndex];
}

type StageOptions = {
  stage: string;
  ticketId: string;
  mode: StageMode;
  roleFile: string;
  getInput: () => string;
  onApprove: (output: string) => void;
  allowedTools?: string[];
};

// Generic stage runner: build the prompt, call the agent, show the
// output, and (in "approve" mode) wait for a human decision. On approval,
// hands the output to the stage's onApprove callback to save wherever
// that stage's artifact belongs. On rejection, asks what should change,
// logs the rejection with that feedback, then re-runs this same stage
// with the rejected output and the feedback folded into the prompt so
// the agent revises instead of guessing again from scratch. Keeps
// looping until the human approves. "auto" mode skips the pause entirely
// since there's no human to ask.
async function runStage(opts: StageOptions, retry?: RetryContext): Promise<void> {
  const startedAt = Date.now();
  const input = opts.getInput();
  const prompt = buildPrompt(opts.roleFile, input, retry);

  console.log(`\nRunning ${opts.stage} agent on ticket ${opts.ticketId}...\n`);
  const output = callAgent(prompt, { allowedTools: opts.allowedTools });

  console.log(`----- ${opts.stage} agent output -----\n`);
  console.log(output);
  console.log("\n-------------------------------\n");

  const save = () => {
    opts.onApprove(output);
    console.log(`Saved (${opts.stage}).`);
    logRun({
      stage: opts.stage,
      ticket: opts.ticketId,
      mode: opts.mode,
      durationMs: Date.now() - startedAt,
      approved: true,
    });
  };

  if (opts.mode !== "approve") {
    save();
    return;
  }

  const approved = await confirm("Approve this output?");
  if (approved) {
    save();
    return;
  }

  const feedback = await promptText("What should change?");
  logRun({
    stage: opts.stage,
    ticket: opts.ticketId,
    mode: opts.mode,
    durationMs: Date.now() - startedAt,
    approved: false,
    feedback,
  });

  console.log(`\nRe-running ${opts.stage} agent with your feedback...\n`);
  await runStage(opts, { priorAttempt: output, feedback });
}

function runStageParse(ticketId: string, mode: StageMode): Promise<void> {
  return runStage({
    stage: "parse",
    ticketId,
    mode,
    roleFile: "agents/parse.md",
    getInput: () => readTicket(ticketId),
    onApprove: (output) => appendFileSync(`tickets/${ticketId}.md`, "\n" + output + "\n"),
  });
}

function writeSpec(ticketId: string, output: string): void {
  mkdirSync("specs", { recursive: true });
  writeFileSync(`specs/${ticketId}.md`, output);
}

function runStageSpec(ticketId: string, mode: StageMode): Promise<void> {
  return runStage({
    stage: "spec",
    ticketId,
    mode,
    roleFile: "agents/spec.md",
    // The ticket now includes the parse stage's approved criteria, which
    // is exactly what the spec agent needs to work from.
    getInput: () => readTicket(ticketId),
    allowedTools: ["Read"],
    onApprove: (output) => writeSpec(ticketId, output),
  });
}

// The implement stage doesn't fit runStage()'s shape: the agent writes
// files itself (it gets Read/Edit/Write), rather than returning text for
// the orchestrator to save, and what gates it isn't a human y/n but a
// deterministic build check. So it's its own function:
//   1. switch to an isolated feature branch — never touch main directly
//   2. run the implement agent against the approved spec
//   3. run the build gate from the orchestrator's own process, not the
//      agent's — the agent has no Bash access at all, because Claude
//      Code's own Bash sandbox can silently block a tool call
//      independently of --allowedTools scoping, which once left a real
//      run with the agent unable to verify itself for reasons it
//      couldn't even diagnose. Only the orchestrator's check is trusted.
//   4. on failure, feed the exact compiler output back to a fresh agent
//      call and retry, up to MAX_IMPLEMENT_ATTEMPTS, before giving up
//      and handing the branch to a human
async function runStageImplement(ticketId: string, mode: StageMode, maxTurns?: number): Promise<void> {
  const startedAt = Date.now();
  const branch = ensureBranch(ticketId);
  const spec = readSpec(ticketId);

  let retry: RetryContext | undefined;
  let lastBuildOutput = "";

  for (let attempt = 1; attempt <= MAX_IMPLEMENT_ATTEMPTS; attempt++) {
    const prompt = buildPrompt("agents/implement.md", spec, retry);

    console.log(
      `\nRunning implement agent on ticket ${ticketId} (branch ${branch}, attempt ${attempt}/${MAX_IMPLEMENT_ATTEMPTS})...\n`
    );
    const report = callAgent(prompt, {
      allowedTools: ["Read", "Edit", "Write"],
      maxTurns,
    });

    console.log("----- implement agent report -----\n");
    console.log(report);
    console.log("\n-------------------------------\n");

    console.log("Checking build gate (npm run build)...");
    const { passed, output } = await runBuild();
    lastBuildOutput = output;

    logRun({
      stage: "implement",
      ticket: ticketId,
      mode,
      branch,
      attempt,
      durationMs: Date.now() - startedAt,
      approved: passed,
    });

    if (passed) {
      console.log(`Build gate passed on branch ${branch} (attempt ${attempt}/${MAX_IMPLEMENT_ATTEMPTS}).`);
      return;
    }

    console.log(`Build gate failed on attempt ${attempt}/${MAX_IMPLEMENT_ATTEMPTS}.`);
    retry = { priorAttempt: report, feedback: `\`npm run build\` failed with:\n${output}` };
  }

  throw new Error(
    `Build gate failed for ticket ${ticketId} on branch ${branch} after ${MAX_IMPLEMENT_ATTEMPTS} attempts.\n` +
      `Last build output:\n${lastBuildOutput}\n` +
      "Inspect the branch — the pipeline does not retry further."
  );
}

function writeReview(ticketId: string, output: string): void {
  mkdirSync("reviews", { recursive: true });
  writeFileSync(`reviews/${ticketId}.md`, output);
}

function runStageReview(ticketId: string, mode: StageMode): Promise<void> {
  return runStage({
    stage: "review",
    ticketId,
    mode,
    roleFile: "agents/review.md",
    getInput: () => readSpec(ticketId),
    allowedTools: ["Read"],
    onApprove: (output) => writeReview(ticketId, output),
  });
}

// The test agent writes test/*.test.ts itself (it gets Read/Edit/Write),
// so there's nothing for the orchestrator to save on approval — same
// reason implement's agent call has no onApprove-driven save either, just
// without implement's build-gate loop, since a failing test suite here
// isn't the test agent's fault to fix (that's a review/implement problem).
function runStageTest(ticketId: string, mode: StageMode): Promise<void> {
  return runStage({
    stage: "test",
    ticketId,
    mode,
    roleFile: "agents/test.md",
    getInput: () => readSpec(ticketId),
    allowedTools: ["Read", "Edit", "Write"],
    onApprove: () => {},
  });
}

// Runs one named stage if it's configured in sdlc.config.json, skipping
// it (with a note) otherwise — same behavior main() already had per
// stage, just centralized so main() can loop over STAGE_ORDER instead of
// repeating this if-block three times.
async function runNamedStage(stage: Stage, ticketId: string, config: Config): Promise<void> {
  const stageConfig = config.stages[stage];
  if (!stageConfig) {
    console.log(`Skipping ${stage} (not configured in sdlc.config.json).`);
    return;
  }

  switch (stage) {
    case "parse":
      return runStageParse(ticketId, stageConfig.mode);
    case "spec":
      return runStageSpec(ticketId, stageConfig.mode);
    case "implement":
      return runStageImplement(ticketId, stageConfig.mode, stageConfig.maxTurns);
    case "review":
      return runStageReview(ticketId, stageConfig.mode);
    case "test":
      return runStageTest(ticketId, stageConfig.mode);
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  // The stage override is a plain positional argument, not a --flag:
  // "npm run <script> --flag" is unreliable, since npm intercepts any
  // "--"-prefixed argument it doesn't recognize as its own CLI config
  // (silently dropping it, with only a warning) unless the caller
  // remembers to add a "--" separator first. A bare positional arg has
  // no such gotcha — it always reaches process.argv unmodified.
  const [command, ticketId, overrideStage, ...rest] = args;

  if (command !== "run" || !ticketId) {
    console.error("Usage: npm run sdlc run <ticketId> [stageName]");
    process.exit(1);
  }

  if (rest.length > 0) {
    console.error(`Unrecognized extra argument(s): ${rest.join(" ")}`);
    process.exit(1);
  }

  if (overrideStage && !STAGE_ORDER.includes(overrideStage as Stage)) {
    console.error(`Unknown stage "${overrideStage}". Valid stages: ${STAGE_ORDER.join(", ")}`);
    process.exit(1);
  }

  const config = readConfig();
  if (!config.stages.parse) {
    throw new Error("sdlc.config.json is missing a 'parse' stage entry");
  }

  const startStage = (overrideStage as Stage) ?? resolveStartStage(ticketId);
  if (overrideStage) {
    console.log(`Forcing ticket ${ticketId} to start at stage "${startStage}" (explicit override).`);
  } else {
    console.log(`Resuming ticket ${ticketId} from stage "${startStage}" (per runlog.jsonl).`);
  }

  const startIndex = STAGE_ORDER.indexOf(startStage);
  for (let i = startIndex; i < STAGE_ORDER.length; i++) {
    await runNamedStage(STAGE_ORDER[i], ticketId, config);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
