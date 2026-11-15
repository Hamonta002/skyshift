import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolvePython } from "./quality.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));

const checks = [
  { name: "build", cmd: process.execPath, args: ["scripts/build.mjs"] },
  { name: "check-cache", cmd: process.execPath, args: ["scripts/check-cache.mjs"] },
  { name: "check-archive", cmd: process.execPath, args: ["scripts/check-archive.mjs"] },
  { name: "check-features", cmd: process.execPath, args: ["scripts/check-features.mjs"] },
  { name: "check-map", cmd: process.execPath, args: ["scripts/check-map.mjs"] },
  { name: "check-track", cmd: process.execPath, args: ["scripts/check-track.mjs"] },
  { name: "check-identify", cmd: process.execPath, args: ["scripts/check-identify.mjs"] },
  { name: "check-comparison", cmd: process.execPath, args: ["scripts/check-comparison.mjs"] },
  { name: "check-flag-reader", cmd: resolvePython(), args: ["scripts/check-flag-reader.py"] },
];

let failed = 0;
for (const check of checks) {
  console.log(`\n=== ${check.name} ===`);
  const result = spawnSync(check.cmd, check.args, { cwd: root, stdio: "inherit" });
  if (result.error) {
    console.error(`[FAIL] ${check.name}: ${result.error.message}`);
    failed++;
    if (check.name === "build") break;
  } else if (result.status !== 0) {
    console.error(`[FAIL] ${check.name} exited with code ${result.status}`);
    failed++;
    if (check.name === "build") break;
  }
}

if (failed > 0) {
  console.error(`\n${failed} check(s) failed.`);
  process.exit(1);
}
console.log(`\nAll ${checks.length} test steps completed cleanly.`);
