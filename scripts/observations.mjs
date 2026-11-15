import { readFileSync } from "node:fs";
import { discoveredCollections } from "./releases.mjs";
const config = JSON.parse(readFileSync(new URL("../config/archive.json", import.meta.url), "utf8"));
const { collections: COLLECTIONS, bandsMicron: BANDS, siaEndpoint: ARCHIVE, productPrefix: PREFIX } = config;
const MAX_ROWS = 500;
const releaseOf = (name) => name.replace(/^spherex_/, "").replace(/_deep$/, "");
const releases = new Set(COLLECTIONS.map(releaseOf));
const cache = new Map();
const inflight = new Map();

function xmlText(value) {
  return value.replace(/<[^>]*>/g, "").replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, entity) => {
    if (entity[0] === "#") {
      const hex = entity[1].toLowerCase() === "x";
      return String.fromCodePoint(parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10));
    }
    return { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" }[entity.toLowerCase()] ?? "";
  }).trim();
}

export function parseVOTable(xml, known = releases) {
  if (!/<VOTABLE[\s>]/i.test(xml)) throw new Error("Archive returned an invalid VOTable.");
  const infos = [...xml.matchAll(/<INFO\b([^>]*)>/gi)].map((entry) => entry[1]);
  const status = (value) => infos.some((attrs) => /\bname\s*=\s*["']QUERY_STATUS["']/i.test(attrs)
    && new RegExp(`\\bvalue\\s*=\\s*["']${value}["']`, "i").test(attrs));
  if (status("ERROR")) {
    throw new Error("Archive query failed.");
  }
  if (/<(?:BINARY2?|FITS)\b/i.test(xml)) throw new Error("Unsupported VOTable serialization.");
  const fields = [...xml.matchAll(/<FIELD\b([^>]*?)\/?\s*>/gi)].map((match) => {
    const name = match[1].match(/\bname\s*=\s*["']([^"']+)["']/i);
    return name?.[1] ?? "";
  });
  const required = ["obs_id", "obs_collection", "energy_bandpassname", "access_url", "t_min", "t_max"];
  if (required.some((name) => !fields.includes(name))) throw new Error("Archive response is missing required fields.");
  const observations = [];
  for (const row of xml.matchAll(/<TR\b[^>]*>([\s\S]*?)<\/TR\s*>/gi)) {
    const cells = [...row[1].matchAll(/<TD\b[^>]*>([\s\S]*?)<\/TD\s*>|<TD\b[^>]*\/>/gi)];
    const data = Object.fromEntries(fields.map((name, i) => [name, xmlText(cells[i]?.[1] ?? "")]));
    if (!data.access_url.startsWith(PREFIX)) continue;
    const productKey = data.access_url.slice(PREFIX.length);
    if (!/^[a-z0-9_]+\/level2\/[a-zA-Z0-9_./-]+\.fits$/.test(productKey)
      || !known.has(productKey.split("/")[0]) || productKey.includes("..")) continue;
    const detector = Number(data.energy_bandpassname.match(/D([1-6])$/)?.[1]);
    const startMjd = Number(data.t_min);
    const endMjd = Number(data.t_max);
    if (!data.t_min || !data.t_max || !detector || !Number.isFinite(startMjd) || !Number.isFinite(endMjd) || startMjd > endMjd) continue;
    const version = productKey.match(/l2b(?:_retry)?-v(\d+)-(\d{4}-\d{3})/);
    observations.push({
      id: data.obs_id, collection: data.obs_collection, detector, productKey,
      processingVersion: version ? Number(version[1]) : null,
      processingDate: version?.[2] ?? null, startMjd, endMjd,
      footprintIcrs: data.s_region || null, sourceUrl: data.access_url,
    });
  }
  const truncated = status("OVERFLOW")
    || observations.length >= MAX_ROWS;
  return { observations, truncated };
}

async function readBoundedText(response, maxBytes) {
  if (Number(response.headers.get("content-length")) > maxBytes) throw new Error("Archive response exceeds the size limit.");
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0, result = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new Error("Archive response exceeds the size limit.");
      result += decoder.decode(value, { stream: true });
    }
    return result + decoder.decode();
  } finally { await reader.cancel().catch(() => {}); }
}

/** `discovered` lists collections of releases found in the bucket but not yet configured. */
export async function searchObservations(params, fetcher = fetch, discovered = []) {
  const number = (key) => {
    const raw = params.get(key);
    if (raw === null || raw.trim() === "") throw new Error(`Missing ${key}.`);
    const value = Number(raw);
    if (!Number.isFinite(value)) throw new Error(`Invalid ${key}.`);
    return value;
  };
  const ra = number("ra"), dec = number("dec"), fov = number("fov"), band = number("band");
  if (ra < 0 || ra >= 360 || dec < -90 || dec > 90 || ![5, 10, 20].includes(fov) || !Number.isInteger(band) || band < 1 || band > 6) {
    throw new Error("Coordinates, field size, or detector are out of range.");
  }
  if (params.has("fromMjd") !== params.has("toMjd")) throw new Error("Provide both time bounds.");
  const now = Date.now() / 86400000 + 40587;
  const from = params.has("fromMjd") ? number("fromMjd") : 60789;
  const to = params.has("toMjd") ? number("toMjd") : now;
  if (from > to || to > now + 1 || from < 60000) throw new Error("Invalid time bounds.");
  const names = [...COLLECTIONS, ...discovered.filter((name) => !COLLECTIONS.includes(name))];
  const known = new Set(names.map(releaseOf));
  const requests = names.map(async (name) => {
    const start = name.endsWith("_deep") ? Math.max(from, to - 90) : from;
    const query = new URLSearchParams({
      COLLECTION: name, POS: `CIRCLE ${ra} ${dec} ${fov / 120}`,
      BAND: `${BANDS[band - 1][0] * 1e-6} ${BANDS[band - 1][1] * 1e-6}`,
      TIME: `${start} ${to}`, MAXREC: String(MAX_ROWS), RESPONSEFORMAT: "VOTABLE",
    });
    try {
      const response = await fetcher(`${ARCHIVE}?${query}`, { signal: AbortSignal.timeout(10000) });
      if (!response.ok) throw new Error(`Archive returned HTTP ${response.status}.`);
      const body = await readBoundedText(response, 10_000_000);
      const parsed = parseVOTable(body, known);
      return { name, status: parsed.truncated ? "truncated" : "ok", fromMjd: start, toMjd: to, ...parsed };
    } catch {
      return { name, status: "unavailable", fromMjd: start, toMjd: to, observations: [] };
    }
  });
  const collections = await Promise.all(requests);
  if (collections.filter((collection) => !discovered.includes(collection.name)).every((collection) => collection.status === "unavailable")) {
    const error = new Error("The SPHEREx archive is not answering right now. Try again in a few minutes.");
    error.status = 502;
    throw error;
  }
  const unique = new Map();
  for (const collection of collections) {
    for (const item of collection.observations) if (item.detector === band) unique.set(item.productKey, item);
  }
  return {
    checkedAtUtc: new Date().toISOString(),
    observations: [...unique.values()].sort((a, b) => a.startMjd - b.startMjd || a.productKey.localeCompare(b.productKey)),
    collections: collections.map(({ name, status, fromMjd, toMjd }) => ({ name, status, fromMjd, toMjd, ...(discovered.includes(name) ? { discovered: true } : {}) })),
  };
}

export async function handleObservations(params) {
  const discovered = await discoveredCollections(COLLECTIONS);
  const key = `${params}|${discovered.join(",")}`;
  const now = Date.now();
  const saved = cache.get(key);
  if (saved && saved.expires > now) return saved.value;
  if (inflight.has(key)) return inflight.get(key);
  const pending = searchObservations(params, fetch, discovered).then((value) => {
    if (value.collections.every((item) => item.status === "ok" || item.discovered)) {
      cache.set(key, { value, expires: now + (value.observations.length ? 3600000 : 300000) });
      if (cache.size > 128) cache.delete(cache.keys().next().value);
    }
    return value;
  }).finally(() => inflight.delete(key));
  inflight.set(key, pending);
  return pending;
}
