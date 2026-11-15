/// <reference path="science.ts" />
/// <reference path="wasm.ts" />
/// <reference path="coordinates.ts" />
/// <reference path="archive.ts" />
namespace SkyShift {
  export type CacheLevel = "none" | "inputs" | "results" | "prime";
  export type CacheHit = "miss" | "inputs" | "results";

  export interface WorkRequest {
    engine: EngineName;
    scenario: Scenario;
    cache: CacheLevel;
    fixture: PackedFixture;
    wasm: string;
    frameMode?: "visits" | "exposures";
    liveFetch?: {
      observations: Observation[];
      ra: number;
      dec: number;
      fov: number;
      useCache: boolean;
      onlyFixture?: boolean;
    };
  }

  export interface WorkResult {
    series: AlignedSeries;
    cacheHit: CacheHit;
    computeMs: number;
    initializeMs: number;
    totalMs: number;
  }

  export type WorkMessage =
    | { type: "progress"; done: number; total: number; phase?: "download" | "align" }
    | { type: "frame"; index: number; total: number; side: number; count: number; pixels: Float32Array }
    | { type: "fixture"; fixture: PackedFixture }
    | { type: "result"; result: WorkResult }
    | { type: "error"; message: string };

  type CachedValue = Exposure[] | AlignedSeries;

  interface CacheMetadata {
    key: string;
    bytes: number;
    used: number;
  }

  interface CacheRecord extends CacheMetadata {
    value: CachedValue;
  }

  export interface ProcessingCache {
    read<T extends CachedValue>(key: string): Promise<T | undefined>;
    write(key: string, value: CachedValue, bytes: number): Promise<void>;
  }

  const CACHE_NAME = "skyshift-comparison";
  const CACHE_BUDGET = 64 * 1024 * 1024;
  const SAVE_WAIT = 1500;
  let cacheDatabase: Promise<IDBDatabase> | undefined;

  function openCache(): Promise<IDBDatabase> {
    cacheDatabase ??= new Promise((resolve, reject) => {
      const open = indexedDB.open(CACHE_NAME, 2);
      const deadline = setTimeout(() => reject(new Error("Cache opening timed out.")), SAVE_WAIT);
      open.onupgradeneeded = () => {
        const db = open.result;
        const entries = db.objectStoreNames.contains("entries")
          ? open.transaction!.objectStore("entries")
          : db.createObjectStore("entries", { keyPath: "key" });
        const usage = db.createObjectStore("usage", { keyPath: "key" });
        const records = entries.openCursor();
        records.onsuccess = () => {
          const cursor = records.result;
          if (!cursor) return;
          const { key, bytes, used } = cursor.value as CacheRecord;
          usage.put({ key, bytes, used });
          cursor.continue();
        };
      };
      open.onsuccess = () => {
        clearTimeout(deadline);
        open.result.onversionchange = () => open.result.close();
        resolve(open.result);
      };
      open.onerror = () => { clearTimeout(deadline); reject(open.error); };
      open.onblocked = () => { clearTimeout(deadline); reject(new Error("Cache upgrade is blocked.")); };
    });
    return cacheDatabase;
  }

  async function cacheRead<T extends CachedValue>(key: string): Promise<T | undefined> {
    try {
      const db = await openCache();
      return await new Promise<T | undefined>((resolve) => {
        const transaction = db.transaction(["entries", "usage"], "readwrite");
        const request = transaction.objectStore("entries").get(key);
        let value: T | undefined;
        request.onsuccess = () => {
          const item = request.result as CacheRecord | undefined;
          if (!item) return;
          value = item.value as T;
          transaction.objectStore("usage").put({ key, bytes: item.bytes, used: Date.now() });
        };
        const deadline = setTimeout(() => resolve(undefined), SAVE_WAIT);
        const settle = () => { clearTimeout(deadline); resolve(value); };
        transaction.oncomplete = settle;
        transaction.onerror = settle;
        transaction.onabort = settle;
      });
    } catch {
      return undefined;
    }
  }

  async function cacheWrite(key: string, value: CachedValue, bytes: number): Promise<void> {
    if (bytes > CACHE_BUDGET) return;
    try {
      const db = await openCache();
      await new Promise<void>((resolve) => {
        const transaction = db.transaction(["entries", "usage"], "readwrite");
        const entries = transaction.objectStore("entries");
        const usage = transaction.objectStore("usage");
        const request = usage.getAll();
        const deadline = setTimeout(resolve, SAVE_WAIT);
        const settle = () => { clearTimeout(deadline); resolve(); };
        transaction.oncomplete = settle;
        transaction.onerror = settle;
        transaction.onabort = settle;
        request.onsuccess = () => {
          const existing = (request.result as CacheMetadata[]).filter((item) => item.key !== key);
          let total = bytes + existing.reduce((sum, item) => sum + item.bytes, 0);
          for (const item of existing.sort((a, b) => a.used - b.used)) {
            if (total <= CACHE_BUDGET) break;
            entries.delete(item.key);
            usage.delete(item.key);
            total -= item.bytes;
          }
          const used = Date.now();
          entries.put({ key, bytes, used, value });
          usage.put({ key, bytes, used });
        };
      });
    } catch {
      // Quota and storage permissions do not block the viewer.
    }
  }

  const persistentCache: ProcessingCache = { read: cacheRead, write: cacheWrite };

  export async function comparisonCacheDiagnostics(): Promise<{ entries: number; bytes: number }> {
    try {
      const db = await openCache();
      return await new Promise((resolve) => {
        const tx = db.transaction("usage", "readonly");
        const req = tx.objectStore("usage").getAll();
        req.onsuccess = () => {
          const rows = (req.result as CacheMetadata[]) ?? [];
          resolve({ entries: rows.length, bytes: rows.reduce((sum, r) => sum + (r.bytes ?? 0), 0) });
        };
        req.onerror = () => resolve({ entries: 0, bytes: 0 });
      });
    } catch {
      return { entries: 0, bytes: 0 };
    }
  }

  export async function runRequest(
    job: WorkRequest,
    progress: (done: number, total: number) => void,
    storage: ProcessingCache = persistentCache,
    onFrame?: (index: number, total: number, frame: Float32Array, count: number, side: number) => void,
  ): Promise<WorkResult> {
    const started = performance.now();
    const resultKey = `tan-sip2-median1:${job.fixture.id}:${job.engine}:${job.scenario}:${job.frameMode ?? "visits"}`;
    if (job.cache === "results") {
      const cached = await storage.read<AlignedSeries>(resultKey);
      if (cached) {
        return { series: cached, cacheHit: "results", computeMs: 0, initializeMs: 0, totalMs: performance.now() - started };
      }
    }
    const inputKey = `decoded-fixture1:${job.fixture.id}`;
    const cachedInputs = job.cache === "none" ? undefined : await storage.read<Exposure[]>(inputKey);
    const exposures = cachedInputs ?? decodeFixture(job.fixture);
    const sequence = makeSequence(job.fixture, exposures, job.scenario);
    if (job.frameMode === "exposures" && job.scenario === "wise0855") sequence.visits = sequence.visits.flat().map((exposure) => [exposure]);
    const initialize = performance.now();
    const engine = job.engine === "rust"
      ? await rustEngine(Uint8Array.from(atob(job.wasm), (c) => c.charCodeAt(0)))
      : typeScriptEngine;
    const initializeMs = performance.now() - initialize;
    const compute = performance.now();
    const series = processSequence(sequence, engine, progress, onFrame);
    const computeMs = performance.now() - compute;
    if (job.cache !== "none" && !cachedInputs) {
      const bytes = exposures.reduce((sum, item) => sum + item.pixels.byteLength + item.wcs.byteLength + 1500, 0);
      await storage.write(inputKey, exposures, bytes);
    }
    if (job.cache === "results" || job.cache === "prime") {
      await storage.write(resultKey, series, series.frames.reduce((sum, frame) => sum + frame.byteLength, 0));
    }
    return { series, cacheHit: cachedInputs ? "inputs" : "miss", computeMs, initializeMs, totalMs: performance.now() - started };
  }

  export interface WorkerScope {
    onmessage: ((event: MessageEvent<WorkRequest>) => unknown) | null;
    postMessage(message: WorkMessage, transfer?: Transferable[]): void;
  }

  export function installWorker(scope: WorkerScope): void {
    let activeController: AbortController | undefined;
    scope.onmessage = async (event: MessageEvent<WorkRequest>) => {
      activeController?.abort();
      const controller = new AbortController();
      activeController = controller;
      const send = (message: WorkMessage, transfers?: Transferable[]) => scope.postMessage(message, transfers ?? []);
      try {
        let job = event.data;
        if (job.liveFetch) {
          const { observations, ra, dec, fov, useCache, onlyFixture } = job.liveFetch;
          const liveFixture = await makeLiveFixture(
            observations,
            ra,
            dec,
            fov,
            controller.signal,
            (done, total) => send({ type: "progress", done, total, phase: "download" }),
            useCache,
          );
          send({ type: "fixture", fixture: liveFixture });
          if (onlyFixture) return;
          job = { ...job, fixture: liveFixture };
        }
        const result = await runRequest(
          job,
          (done, total) => send({ type: "progress", done, total, phase: "align" }),
          persistentCache,
          (index, total, frame, count, side) => {
            const copy = new Float32Array(frame);
            send({ type: "frame", index, total, side, count, pixels: copy }, [copy.buffer]);
          },
        );
        send({ type: "result", result }, result.series.frames.map((frame) => frame.buffer));
      } catch (error) {
        send({ type: "error", message: error instanceof Error ? error.message : String(error) });
      }
    };
  }
}
