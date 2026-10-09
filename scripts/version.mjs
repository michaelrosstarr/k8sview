// Versions are <year>.<month>.<day>.<random>, e.g. 2026.10.9.4821.
//
// Cargo, Tauri and the updater need semver, so the files store it as build
// metadata: 2026.10.9+4821. The Windows (NSIS) installer turns that back into
// 2026.10.9.4821, and the app displays it that way everywhere.
//
//   node scripts/version.mjs                    new version (today, UTC) written to every file
//   node scripts/version.mjs --set 2026.10.9.4821 [--endpoint URL]
//                                               write a given version (CI, so all platforms match)
//   node scripts/version.mjs --print-only       compute a new version without writing (CI outputs)
import { randomInt } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const root = new URL("../", import.meta.url);
const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

function fresh() {
  const d = new Date();
  // Windows limits each version field to 65535; four digits keep it readable.
  return `${d.getUTCFullYear()}.${d.getUTCMonth() + 1}.${d.getUTCDate()}.${randomInt(1000, 10000)}`;
}

const display = flag("--set") ?? fresh();
const match = display.match(/^(\d{4})\.(\d{1,2})\.(\d{1,2})\.(\d{1,5})$/);
if (!match || Number(match[2]) < 1 || Number(match[2]) > 12 || Number(match[3]) < 1 || Number(match[3]) > 31 || Number(match[4]) > 65535) {
  console.error(`invalid version ${display}: expected <year>.<month>.<day>.<number up to 65535>`);
  process.exit(1);
}
// Semver forbids leading zeros, so normalise each part through Number().
const [year, month, day, build] = match.slice(1).map(Number);
const semver = `${year}.${month}.${day}+${build}`;
const normalized = `${year}.${month}.${day}.${build}`;

if (args.includes("--print-only")) {
  console.log(`version=${normalized}\nsemver=${semver}\ntag=v${normalized}`);
  process.exit(0);
}

const editJson = (path, edit) => {
  const url = new URL(path, root);
  const data = JSON.parse(readFileSync(url, "utf8"));
  edit(data);
  writeFileSync(url, JSON.stringify(data, null, 2) + "\n");
};

editJson("package.json", (p) => {
  p.version = semver;
});

editJson("src-tauri/tauri.conf.json", (c) => {
  c.version = semver;
  c.bundle.macOS = { ...c.bundle.macOS, bundleVersion: normalized };
  const endpoint = flag("--endpoint");
  if (endpoint) c.plugins.updater.endpoints = [endpoint];
});

const cargoUrl = new URL("src-tauri/Cargo.toml", root);
const cargo = readFileSync(cargoUrl, "utf8");
// Only the [package] version (the first `version =` in the file).
writeFileSync(cargoUrl, cargo.replace(/^version = ".*"$/m, `version = "${semver}"`));

console.log(normalized);
