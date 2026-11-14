import { parentPort, workerData } from "node:worker_threads";
import worker from "../dist/worker.cjs";

const { series, initializeMs, computeMs } = await worker.runRequest(workerData, () => {});
parentPort.postMessage({ series, initializeMs, computeMs }, series.frames.map((frame) => frame.buffer));
