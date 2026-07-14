// WHAT THIS FILE IS:
// A tiny read-only static server for the live dashboard. The dashboard is a
// browser page, and a browser cannot read local files directly, so this serves
// two roots over http:
//   /            -> dashboard/ app assets (index.html, derive.mjs)
//   /data/<path> -> the pipeline repo root (events.jsonl, runlog.jsonl,
//                   tickets/, specs/, reviews/, qa/, retros/, sdlc.config.json)
// The dashboard POLLS those files; there is no transformation/bridge — it just
// hands over the raw artifacts the pipeline already writes. Read-only, bound to
// localhost, extension-whitelisted, path-traversal-guarded.
//
// Run:  npm run dashboard   (then open http://localhost:4300)

import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, extname } from "node:path";

const ROOT = resolve(process.cwd()); // pipeline repo root — the data
const APP = resolve(ROOT, "dashboard"); // the dashboard app assets
const PORT = Number(process.env.DASHBOARD_PORT ?? 4300);

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".jsonl": "application/x-ndjson; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
};

// Resolve urlPath under baseDir, refusing anything that escapes it.
function safeResolve(baseDir: string, urlPath: string): string | null {
  const abs = resolve(baseDir, urlPath.replace(/^\/+/, ""));
  return abs === baseDir || abs.startsWith(baseDir) ? abs : null;
}

const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  const send = (code: number, type: string, body: string | Buffer) => {
    res.writeHead(code, { "content-type": type, "cache-control": "no-store" });
    res.end(body);
  };
  try {
    const urlPath = decodeURIComponent((req.url ?? "/").split("?")[0]);
    let abs: string | null;
    if (urlPath === "/" || urlPath === "/index.html") {
      abs = resolve(APP, "index.html");
    } else if (urlPath.startsWith("/data/")) {
      abs = safeResolve(ROOT, urlPath.slice("/data".length)); // /data/events.jsonl -> ROOT/events.jsonl
    } else {
      abs = safeResolve(APP, urlPath); // dashboard assets (derive.mjs, etc.)
    }
    if (!abs) return send(403, "text/plain; charset=utf-8", "forbidden");
    const type = TYPES[extname(abs)];
    if (!type) return send(415, "text/plain; charset=utf-8", "unsupported type");
    try {
      const data = await readFile(abs);
      send(200, type, data);
    } catch {
      // A not-yet-produced artifact (e.g. qa/007.md before QA runs) is a normal
      // 404 the dashboard renders as "not produced yet".
      send(404, "text/plain; charset=utf-8", "not found");
    }
  } catch {
    send(500, "text/plain; charset=utf-8", "error");
  }
});

// Fail fast, and loudly, when the port is already taken — otherwise a second
// `npm run dashboard` used to leak a half-started process (and left the user
// wondering which of several instances they were looking at). A clear message
// with the fix beats a stack trace and a zombie.
server.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE") {
    console.error(
      `\n  Port ${PORT} is already in use — a dashboard is probably already running.\n` +
        `  Just open http://localhost:${PORT}, or stop the other instance, or pick a free port:\n` +
        `      DASHBOARD_PORT=4301 npm run dashboard\n`
    );
  } else {
    console.error(`\n  Dashboard server error: ${err.message}\n`);
  }
  process.exit(1);
});

// Close the listener on Ctrl+C / kill so the port is released immediately
// instead of lingering in a process that keeps it bound. The unref'd timer is a
// backstop: if a keep-alive connection stalls server.close(), don't hang.
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    console.log(`\n  ${sig} — shutting down dashboard.`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1000).unref();
  });
}

server.listen(PORT, "127.0.0.1", () => {
  console.log(`\n  SDLC dashboard  ->  http://localhost:${PORT}`);
  console.log(`  data root: ${ROOT}`);
  console.log(`  (read-only, localhost only) — Ctrl+C to stop\n`);
});
