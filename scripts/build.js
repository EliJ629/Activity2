// Bundles src/ (React 18 + shared validation + libraries) into public/app.js
import { build } from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const buildOptions = (dev = false) => ({
  entryPoints: [path.join(ROOT, "src/main.jsx")],
  outfile: path.join(ROOT, "public/app.js"),
  bundle: true,
  format: "iife",
  jsx: "automatic",
  target: ["es2020", "chrome100", "safari15", "firefox100"],
  minify: !dev,
  sourcemap: dev ? "inline" : false,
  legalComments: "none",
  define: { "process.env.NODE_ENV": dev ? '"development"' : '"production"' },
  logLevel: "info",
});

if (process.argv[1] === fileURLToPath(import.meta.url)) await build(buildOptions(false));
