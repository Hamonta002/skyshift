import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import worker from "../dist/worker.cjs";

const root = new URL("../", import.meta.url);
const fixture = JSON.parse(readFileSync(new URL("dist/fixture.json", root), "utf8"));
const wasmUrl = new URL("dist/kernel.wasm", root);
const hasWasm = existsSync(wasmUrl);
const wasm = hasWasm ? readFileSync(wasmUrl).toString("base64") : "";
const values = new Map();
const cache = {
  async read(key) { return structuredClone(values.get(key)); },
  async write(key, value) { values.set(key, structuredClone(value)); },
};
const job = { fixture, wasm, scenario: "20arcmin", engine: "typescript" };
const run = (request) => worker.runRequest(request, () => {}, cache);
const first = await run({ ...job, cache: "results" });
const cachedInputs = await run({ ...job, cache: "inputs" });
const cachedFrames = await run({ ...job, cache: "results" });

assert.equal(first.cacheHit, "miss");
assert.equal(cachedInputs.cacheHit, "inputs");
assert.ok(cachedInputs.computeMs > 0);
assert.equal(cachedFrames.cacheHit, "results");
assert.equal(cachedFrames.computeMs, 0);
assert.equal(cachedFrames.initializeMs, 0);
const toCompare = [cachedInputs, cachedFrames];
if (hasWasm) {
  const switchedEngine = await run({ ...job, engine: "rust", cache: "results" });
  const switchedBack = await run({ ...job, cache: "results" });
  assert.equal(switchedEngine.cacheHit, "inputs");
  assert.equal(switchedBack.cacheHit, "results");
  toCompare.push(switchedEngine, switchedBack);
} else {
  console.log("[SKIP] Rust/WASM engine switch cache check skipped (dist/kernel.wasm not present).");
}
for (const result of toCompare) {
  assert.deepEqual(worker.compareSeries(first.series, result.series), { maxError: 0, maskMismatch: 0 });
}
console.log("Verified cache policy on " + fileURLToPath(root));
console.log("Input reuse reruns processing. Result reuse returns identical pixels and skips initialization and processing.");
console.log("Storage was simulated with structured cloning. Browser IndexedDB timing is provided by the viewer.");
