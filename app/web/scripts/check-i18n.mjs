// Every t("…") key in src/ must have English and Traditional Chinese text in src/locales.ts.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const src = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src");
const files = fs.readdirSync(src).filter((f) => /\.(ts|tsx)$/.test(f));
const keys = new Set();
for (const f of files) {
  for (const m of fs.readFileSync(path.join(src, f), "utf8").matchAll(/\bt\("((?:[^"\\]|\\.)+)"/g)) keys.add(JSON.parse(`"${m[1]}"`));
}
const locales = fs.readFileSync(path.join(src, "locales.ts"), "utf8");
const blocks = { en: locales.slice(locales.indexOf("en: {"), locales.indexOf('"zh-Hant": {')), "zh-Hant": locales.slice(locales.indexOf('"zh-Hant": {')) };
let missing = 0;
for (const [lang, block] of Object.entries(blocks)) {
  for (const key of keys) {
    if (!block.includes(`${JSON.stringify(key)}:`)) { console.error(`[i18n] ${lang} missing: ${key}`); missing++; }
  }
}
console.log(`[i18n] ${keys.size} keys checked`);
process.exit(missing ? 1 : 0);
