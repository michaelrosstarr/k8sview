// Copies Monaco's AMD build into public/ so the editor loads from the app
// bundle instead of a CDN (the desktop app must work offline).
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";

const src = new URL("../node_modules/monaco-editor/", import.meta.url);
const dest = new URL("../public/monaco/", import.meta.url);
const stamp = new URL("version", dest);

const { version } = JSON.parse(readFileSync(new URL("package.json", src), "utf8"));
if (existsSync(stamp) && readFileSync(stamp, "utf8") === version) process.exit(0);

rmSync(dest, { recursive: true, force: true });
cpSync(new URL("min/vs/", src), new URL("vs/", dest), { recursive: true });
writeFileSync(stamp, version);
console.log(`copied monaco-editor ${version} to public/monaco`);
