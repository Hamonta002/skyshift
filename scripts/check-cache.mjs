import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import worker from "../dist/worker.cjs";

const root = new URL("../", import.meta.url);
const fixture = JSON.parse(readFileSync(new URL("dist/fixture.json", root), "utf8"));
const wasm = readFileSync(new URL("dist/kernel.wasm", root)).toString("base64");
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
const switchedEngine = await run({ ...job, engine: "rust", cache: "results" });
const switchedBack = await run({ ...job, cache: "results" });

assert.equal(first.cacheHit, "miss");
assert.equal(cachedInputs.cacheHit, "inputs");
assert.ok(cachedInputs.computeMs > 0);
assert.equal(cachedFrames.cacheHit, "results");
assert.equal(cachedFrames.computeMs, 0);
assert.equal(cachedFrames.initializeMs, 0);
assert.equal(switchedEngine.cacheHit, "inputs");
assert.equal(switchedBack.cacheHit, "results");
for (const result of [cachedInputs, cachedFrames, switchedEngine, switchedBack]) {
  assert.deepEqual(worker.compareSeries(first.series, result.series), { maxError: 0, maskMismatch: 0 });
}
console.log("Verified cache policy on " + fileURLToPath(root));
console.log("Input reuse reruns processing. Result reuse returns identical pixels and skips initialization and processing.");
console.log("Storage was simulated with structured cloning. Browser IndexedDB timing is provided by the viewer.");
