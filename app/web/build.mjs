// ChatGit web build: a single esbuild process (no worker pool, no heap overrides).
// Run through the protected root entry: `npm run build`.
import * as esbuild from "esbuild";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, "dist");
/** Served by the LibreChat Express server under /canvas/. */
const BASE = "/canvas/";
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

const result = await esbuild.build({
  entryPoints: [path.join(here, "src/main.tsx")],
  bundle: true,
  outdir: path.join(out, "assets"),
  entryNames: "[name]-[hash]",
  format: "esm",
  jsx: "automatic",
  target: "es2022",
  minify: true,
  sourcemap: "linked",
  metafile: true,
  logLevel: "info",
  alias: { "@/components/arc": path.join(here, "src/components/arc") },
  loader: { ".woff2": "file", ".png": "file", ".svg": "file", ".jpg": "file" },
  define: { "process.env.NODE_ENV": '"production"' },
});

// Point index.html at the hashed bundle names.
const outputs = Object.keys(result.metafile.outputs).map((p) => path.relative(out, path.resolve(p)));
const js = outputs.find((p) => p.endsWith(".js") && p.includes("main-"));
const css = outputs.find((p) => p.endsWith(".css") && p.includes("main-"));
const html = fs.readFileSync(path.join(here, "src/index.html"), "utf8")
  .replace("%CSS%", css ? `${BASE}${css}` : "")
  .replace("%JS%", `${BASE}${js}`);
fs.writeFileSync(path.join(out, "index.html"), html);
console.log(`[web] ${js} ${css ?? ""}`);
