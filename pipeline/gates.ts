// WHAT THIS FILE IS:
// Deterministic pass/fail checks the orchestrator runs after the implement
// stage. No model involved, just an exit code. This is the actual
// quality guarantee: the implement agent's own claim that it succeeded is
// never trusted on its own.

import { execFile, exec } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";

export type GateResult = { passed: boolean; output: string };

// Returns not just pass/fail but the actual command output, so a failure
// can be fed back into a follow-up agent call verbatim. The implement
// agent's own Bash access is unreliable (Claude Code's Bash sandbox can
// block it independently of --allowedTools scoping — see runStageImplement
// in run.ts), so this is the only place that reliably captures what the
// compiler actually said.
function runNpmScript(script: string): Promise<GateResult> {
  return new Promise((resolve) => {
    const onDone = (err: unknown, stdout: string, stderr: string) => {
      resolve({ passed: !err, output: (stdout + stderr).trim() });
    };
    // Same Windows quirk as the agent invocation in run.ts: npm is a
    // .cmd shim on Windows, which requires the .cmd suffix and shell: true.
    //
    // On Windows this uses exec() with one pre-built command string
    // instead of execFile() + an args array + shell: true — Node
    // deprecates (DEP0190) the latter combination because it has to join
    // the array into a shell command line itself without escaping it.
    // `script` here is always one of our own hardcoded stage names
    // (never external input), so building the string ourselves is safe.
    if (process.platform === "win32") {
      exec(`npm.cmd run ${script}`, onDone);
    } else {
      execFile("npm", ["run", script], onDone);
    }
  });
}

export function runBuild(): Promise<GateResult> {
  return runNpmScript("build");
}

export function runTests(): Promise<GateResult> {
  return runNpmScript("test");
}

// The QA agent (a model) writes the verdict; this function (a dumb script)
// reads it. Determinism at the boundary: a model may produce the judgment,
// but a script decides whether the pipeline proceeds, and it reads a file
// the model was not allowed to write.
export function checkQaVerdict(ticketId: string): GateResult {
  const path = `qa/${ticketId}.md`;
  if (!existsSync(path)) {
    return { passed: false, output: `No QA report at ${path}` };
  }
  const md = readFileSync(path, "utf8");
  const hasFail = /\|\s*FAIL\s*\|/i.test(md); // any FAIL row in the criteria table
  const saysShip = /Verdict:\s*SHIP/i.test(md); // explicit SHIP verdict
  return {
    passed: saysShip && !hasFail,
    output: !saysShip ? "No SHIP verdict found" : hasFail ? "QA report has FAIL rows" : "SHIP",
  };
}
