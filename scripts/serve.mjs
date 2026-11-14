import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { handleObservations } from "./observations.mjs";
import { handleCatalogue } from "./catalogue.mjs";
import { handleQuality } from "./quality.mjs";
import { handleChannels } from "./channels.mjs";
import { handleIdentify } from "./identify.mjs";

const root = fileURLToPath(new URL("../dist/", import.meta.url));
const port = Number(process.env.PORT ?? 4173);
// Loopback by default; set HOST=0.0.0.0 to serve publicly (for example in a container).
const host = process.env.HOST ?? "127.0.0.1";
const types = {
  ".html": "text/html; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
};

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("PORT must be an integer between 1 and 65535.");
}

const server = createServer(async (request, response) => {
  try {
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405, { Allow: "GET, HEAD" }).end();
      return;
    }
    const url = new URL(request.url ?? "/", "http://localhost");
    const routes = {
      "/api/observations": () => handleObservations(url.searchParams),
      "/api/catalogue": () => handleCatalogue(url.searchParams),
      "/api/quality": () => handleQuality(url.searchParams),
      "/api/channels": () => handleChannels(),
      "/api/identify": () => handleIdentify(url.searchParams),
    };
    if (Object.hasOwn(routes, url.pathname)) {
      try {
        const data = await routes[url.pathname]();
        response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        response.end(JSON.stringify(data));
      } catch (error) {
        response.writeHead(error.status ?? 400, { "Content-Type": "application/json; charset=utf-8" });
        response.end(JSON.stringify({ error: error.message }));
      }
      return;
    }
    const requested = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname);
    const path = resolve(root, "." + requested);
    const remainder = relative(root, path);
    if (remainder === ".." || remainder.startsWith(".." + sep)) {
      response.writeHead(403).end("Forbidden");
      return;
    }
    const body = await readFile(path);
    response.writeHead(200, { "Content-Type": types[extname(path)] ?? "application/octet-stream" });
    response.end(request.method === "HEAD" ? undefined : body);
  } catch (error) {
    const status = error?.code === "ENOENT" || error?.code === "EISDIR" ? 404 : 500;
    response.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
    response.end(status === 404 ? "Not found" : "Could not serve file");
  }
}).listen(port, host, () => {
  console.log(`SkyShift is available at http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${port}/`);
});
// Stop promptly when a container host or Ctrl-C asks (Node as PID 1 ignores SIGTERM by default).
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => {
  server.close(() => process.exit(0));
  server.closeAllConnections?.();
  setTimeout(() => process.exit(0), 2000).unref();
});
