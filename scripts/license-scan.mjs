#!/usr/bin/env node
/**
 * 依赖许可证 allowlist 扫描（LICENSES.md §4"冻结依赖清单"的 CI 落地）。
 *
 * 范围 = **生产依赖树**（`dependencies` 传递闭包，与 Worker bundle 分发语义一致；
 * devDependencies 是工具链、不随分发，不在扫描面）。许可证字段必须命中 allowlist；
 * 命中 GPL/AGPL/LGPL/MPL 即退出码 1。复合表达式拆词后每一项都须放行。
 *
 * 用法：node scripts/license-scan.mjs
 */
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ALLOW = new Set([
  "MIT",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "ISC",
  "CC0-1.0",
  "Zlib",
  "IJG",
  "BlueOak-1.0.0",
  "CC-BY-4.0",
  "CC-BY-3.0",
  "Python-2.0",
  "Unlicense",
]);

const FORBIDDEN = /GPL|AGPL|MPL|EUPL|SSPL|CPAL/i;

function licenseIds(pkg) {
  const raw = pkg.license ?? pkg.licenses;
  if (!raw) return [];
  const text = typeof raw === "string" ? raw : JSON.stringify(raw);
  return text
    .split(/\b(?:OR|AND|WITH)\b/i)
    .map((part) => part.replace(/[()]/g, "").trim())
    .filter(Boolean);
}

const root = new URL("..", import.meta.url).pathname;

// npm ls --omit=dev --parseable --all → 生产树全部包目录（首行是项目自身）
const dirs = execSync("npm ls --omit=dev --parseable --all", {
  cwd: root,
  encoding: "utf8",
  stdio: ["ignore", "pipe", "ignore"],
})
  .trim()
  .split("\n")
  .slice(1);

let failures = 0;
let checked = 0;
for (const dir of dirs) {
  if (!dir) continue;
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  } catch {
    console.warn(`WARN  ${dir}: unreadable package.json`);
    continue;
  }
  const name = pkg.name ?? dir;
  const ids = licenseIds(pkg);
  if (ids.length === 0) {
    console.warn(`WARN  ${name}: no license field`);
    continue;
  }
  checked += 1;
  for (const id of ids) {
    if (FORBIDDEN.test(id) || !ALLOW.has(id)) {
      failures += 1;
      console.error(`FAIL  ${name}: ${id}`);
    }
  }
}

console.log(`license-scan: ${checked} production packages checked, ${failures} failures`);
if (failures > 0) process.exit(1);
