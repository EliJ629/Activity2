// Development: rebuild the front-end on every change and restart the server on server changes.
import { context } from "esbuild";
import { spawn } from "node:child_process";
import { buildOptions, ROOT } from "./build.js";

const ctx = await context(buildOptions(true));
await ctx.watch();
console.log("Watching src/ and shared/ for changes...");

const server = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "--watch-path=server", "--watch-path=shared", "--watch-path=schema.sql", "server/index.js"], {
  cwd: ROOT,
  stdio: "inherit",
  env: { ...process.env, ...(process.argv.includes("--https") ? { DEV_HTTPS: "1" } : {}) },
});
const stop = () => { server.kill(); ctx.dispose().then(() => process.exit(0)); };
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
server.on("exit", (code) => { ctx.dispose(); process.exit(code ?? 0); });
