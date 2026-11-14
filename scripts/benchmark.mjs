import { readFileSync, writeFileSync } from "node:fs";
import { cpus, platform, release } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import science from "../dist/core.cjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const load = (name) => readFileSync(join(root, name));
const fixture = JSON.parse(load("dist/fixture.json"));
const original = JSON.parse(load("reference/fixtures/wise0855_d6.json"));
const build = JSON.parse(load("dist/build.json"));
const wasm = load("dist/kernel.wasm");
const encodedWasm = wasm.toString("base64");
const exposures = science.decodeFixture(fixture);
const engines = { typescript: science.typeScriptEngine, rust: await science.rustEngine(wasm) };
const runs = 5;
const firstRuns = 3;

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function timeSequence(sequence, engine) {
  const begin = performance.now();
  const series = science.processSequence(sequence, engine);
  return { series, ms: performance.now() - begin };
}

function timeFreshWorker(engine, scenario) {
  const begin = performance.now();
  const worker = new Worker(new URL("./benchmark-worker.mjs", import.meta.url), {
    workerData: { engine, scenario, cache: "none", fixture, wasm: engine === "rust" ? encodedWasm : "" },
  });
  return new Promise((resolve, reject) => {
    worker.once("message", ({ initializeMs, computeMs }) => {
      resolve({ initializeMs, computeMs, totalMs: performance.now() - begin });
    });
    worker.once("error", reject);
    worker.once("exit", (code) => {
      if (code !== 0) reject(new Error(`Benchmark worker exited with code ${code}.`));
    });
  });
}

function requireAgreement(left, right, label) {
  const difference = science.compareSeries(left, right);
  if (difference.maskMismatch || difference.maxError > 1e-6) {
    throw new Error(`${label} disagree: ${JSON.stringify(difference)}`);
  }
  return difference;
}

const report = {
  machine: { cpu: cpus()[0]?.model, os: platform(), release: release(), node: process.version },
  build,
  method: {
    compute: "Median of five single-thread runs after one warm-up per engine. Inputs and output sky grid are prepared. Includes allocating the processing buffers and copying data into/out of WASM.",
    first: "Median of three fresh Node workers, including worker startup, fixture transfer/decoding, preparation, initialization, computation and returning the frame buffers. Inputs supplied locally. Cache, browser rendering and network excluded.",
    synthetic: "Larger workloads use deterministic synthetic pixels and the real WISE 0855 transforms. Six bands represent six independent groups of 60 exposures.",
  },
  workloads: [],
};

for (const [scenario, label] of Object.entries(science.SCENARIOS)) {
  const sequence = science.makeSequence(fixture, exposures, scenario);
  const js = timeSequence(sequence, engines.typescript).series;
  const rust = timeSequence(sequence, engines.rust).series;
  const agreement = requireAgreement(js, rust, label);
  const reference = scenario === "wise0855" ? requireAgreement(js, {
    side: 2 * original.oh + 1,
    counts: original.visit_sizes,
    frames: original.stacks.map((pixels) => Float32Array.from(pixels, (pixel) => pixel ?? NaN)),
  }, "TypeScript and Python reference") : undefined;
  const compute = { typescript: [], rust: [] };
  const fresh = { typescript: [], rust: [] };
  for (let trial = 0; trial < runs; trial++) {
    const order = trial % 2 === 0 ? ["typescript", "rust"] : ["rust", "typescript"];
    for (const engine of order) compute[engine].push(timeSequence(sequence, engines[engine]).ms);
  }
  for (let trial = 0; trial < firstRuns; trial++) {
    const order = trial % 2 === 0 ? ["rust", "typescript"] : ["typescript", "rust"];
    for (const engine of order) fresh[engine].push(await timeFreshWorker(engine, scenario));
  }
  const row = { label, side: sequence.grid.side, agreement, reference, engines: {} };
  for (const engine of Object.keys(engines)) {
    row.engines[engine] = {
      processingMs: median(compute[engine]),
      freshWorkerMs: median(fresh[engine].map((sample) => sample.totalMs)),
      freshInitializeMs: median(fresh[engine].map((sample) => sample.initializeMs)),
    };
  }
  report.workloads.push(row);
  const ts = row.engines.typescript, wasm = row.engines.rust;
  console.log(`${label}: processing TS ${ts.processingMs.toFixed(1)} ms, Rust ${wasm.processingMs.toFixed(1)} ms; fresh worker TS ${ts.freshWorkerMs.toFixed(1)} ms, Rust ${wasm.freshWorkerMs.toFixed(1)} ms. Pixel difference ${agreement.maxError}, mask difference ${agreement.maskMismatch}.`);
}

writeFileSync(join(root, "dist/benchmark.json"), JSON.stringify(report, null, 2) + "\n");
console.log("Saved dist/benchmark.json.");
