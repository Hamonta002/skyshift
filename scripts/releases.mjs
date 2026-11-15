// New SPHEREx releases appear as top-level folders (qr4/, dr2/) in IRSA's
// public bucket. A release newer than every configured one of its kind, and
// laid out like the others (a level2/ image folder), is searched without
// anyone editing config/archive.json. Older releases stay as configured.
const BUCKET = 'https://nasa-irsa-spherex.s3.amazonaws.com/';
const RECHECK_MS = 12 * 3600000;
let known = { releases: [], checked: 0 };
let inflight;

/** Folder names listed under `prefix` in an S3 ListObjectsV2 reply. */
export function listedPrefixes(xml, prefix = '') {
  if (!/<ListBucketResult\b/.test(xml)) throw new Error('Unexpected bucket listing.');
  return [...xml.matchAll(/<Prefix>([^<]*)<\/Prefix>/g)].map((m) => m[1]).filter((p) => p !== prefix && p.startsWith(prefix));
}

const parse = (release) => { const m = /^(qr|dr)(\d+)$/.exec(release); return m && { kind: m[1], number: Number(m[2]) }; };

/** Releases in `available` newer than the configured ones of the same kind. */
export function newerReleases(configured, available) {
  const newest = {};
  for (const release of configured) {
    const r = parse(release);
    if (r) newest[r.kind] = Math.max(newest[r.kind] ?? 0, r.number);
  }
  return available.filter((release) => {
    const r = parse(release);
    return r && newest[r.kind] !== undefined && r.number > newest[r.kind];
  }).sort();
}

async function list(prefix, fetcher) {
  const url = new URL(BUCKET);
  url.search = new URLSearchParams({ 'list-type': '2', delimiter: '/', ...(prefix ? { prefix } : {}) });
  const response = await fetcher(url, { signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error(`Bucket listing returned HTTP ${response.status}.`);
  const body = await response.text();
  if (body.length > 1_000_000) throw new Error('Bucket listing is too large.');
  return listedPrefixes(body, prefix);
}

export async function discoverReleases(configured, fetcher = fetch) {
  const top = (await list('', fetcher)).map((p) => p.replace(/\/$/, ''));
  const found = [];
  for (const release of newerReleases(configured, top)) {
    const folders = await list(`${release}/`, fetcher);
    if (folders.includes(`${release}/level2/`)) found.push(release);
  }
  return found;
}

/**
 * Collections to add to the configured list, checked at most every 12 hours.
 * Never throws: if the bucket cannot be listed, the configuration stands.
 */
export async function discoveredCollections(configuredCollections, fetcher = fetch, now = Date.now()) {
  if (now - known.checked > RECHECK_MS) {
    inflight ??= (async () => {
      const configured = [...new Set(configuredCollections.map((name) => name.replace(/^spherex_/, '').replace(/_deep$/, '')))];
      try { known = { releases: await discoverReleases(configured, fetcher), checked: now }; }
      catch { known = { releases: known.releases, checked: now - RECHECK_MS + 600000 }; }
    })().finally(() => { inflight = undefined; });
    await inflight;
  }
  return known.releases.flatMap((release) => [`spherex_${release}`, `spherex_${release}_deep`]);
}

/** Forget the last check (tests). */
export function resetDiscovery() { known = { releases: [], checked: 0 }; }
