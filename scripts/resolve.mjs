// Read-only name lookup. CDS Sesame (SIMBAD, then NED and VizieR) turns a name
// such as "Betelgeuse" or "M42" into a J2000 position and proper motion; the
// position is moved to the requested date so fast stars such as Barnard's Star
// land inside the field. SIMBAD adds a readable object type when it answers.
import { propagate } from './identify.mjs';

const SESAME_HOSTS = [
  'https://vizier.cfa.harvard.edu/viz-bin/nph-sesame/-oxp/SNV',
  'https://cds.unistra.fr/cgi-bin/nph-sesame/-oxp/SNV',
];
const SIMBAD_HOSTS = ['https://simbad.harvard.edu/simbad/sim-tap/sync', 'https://simbad.cds.unistra.fr/simbad/sim-tap/sync'];
const cache = new Map();
const typeNames = new Map();

function fail(message, status = 400) { const error = new Error(message); error.status = status; return error; }

export function parseResolve(params) {
  const name = (params.get('name') ?? '').trim().replace(/\s+/g, ' ');
  if (!name) throw fail('Type the name of an object.');
  if (name.length > 80 || /[\u0000-\u001f<>]/.test(name)) throw fail('That name is too long or contains unsupported characters.');
  const now = params.get('year');
  const year = now === null ? 2000 + (Date.now() / 86400000 + 40587 - 51544.5) / 365.25 : Number(now);
  if (!Number.isFinite(year) || year < 2000 || year > 2100) throw fail('Invalid year.');
  return { name, year };
}

const tag = (block, name) => block.match(new RegExp(`<${name}>([^<]*)</${name}>`))?.[1]?.trim();
const decode = (text) => text?.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'");

/** First resolver in a Sesame XML answer that has a position, or null. */
export function parseSesame(xml) {
  if (!/<Sesame\b/.test(xml)) throw fail('Unexpected answer from the name service.', 502);
  for (const [, attributes, block] of xml.matchAll(/<Resolver\b([^>]*)>([\s\S]*?)<\/Resolver>/g)) {
    const ra = Number(tag(block, 'jradeg')), dec = Number(tag(block, 'jdedeg'));
    if (!Number.isFinite(ra) || !Number.isFinite(dec)) continue;
    const pmra = Number(tag(block, 'pmRA')), pmdec = Number(tag(block, 'pmDE'));
    const source = attributes.match(/name="[^=]*=([^ "(]+)/)?.[1] ?? 'Sesame';
    return {
      ra, dec, source,
      pmra: Number.isFinite(pmra) ? pmra : null, pmdec: Number.isFinite(pmdec) ? pmdec : null,
      catalogueName: decode(tag(block, 'oname'))?.replace(/^NAME /, '').replace(/\s+/g, ' ') ?? null,
      type: decode(tag(block, 'otype')) ?? null,
    };
  }
  return null;
}

/** Readable SIMBAD object type ("Red Supergiant"), or null if SIMBAD does not answer. */
async function describeType(type, fetcher) {
  if (!type || !/^[\w*?:.+-]{1,8}$/.test(type)) return null;
  if (typeNames.has(type)) return typeNames.get(type);
  const query = `SELECT description FROM otypedef WHERE otype = '${type.replace(/'/g, "''")}'`;
  for (const host of SIMBAD_HOSTS) {
    try {
      const url = new URL(host);
      url.search = new URLSearchParams({ REQUEST: 'doQuery', LANG: 'ADQL', FORMAT: 'csv', QUERY: query });
      const response = await fetcher(url, { signal: AbortSignal.timeout(8000) });
      const body = await response.text();
      if (!response.ok || /^\s*</.test(body)) continue;
      // One column, one row: a header line, then the quoted description.
      const description = body.split(/\r?\n/)[1]?.trim().replace(/^"(.*)"$/, '$1').replace(/""/g, '"') || null;
      typeNames.set(type, description);
      return description;
    } catch { /* Try the next mirror; the type is optional. */ }
  }
  return null;
}

export async function resolveName({ name, year }, fetcher = fetch) {
  let found, reached = false;
  for (const host of SESAME_HOSTS) {
    try {
      const response = await fetcher(new URL(`${host}?${encodeURIComponent(name)}`), { signal: AbortSignal.timeout(12000) });
      if (!response.ok) continue;
      const body = await response.text();
      if (body.length > 200_000) continue;
      found = parseSesame(body);
      reached = true;
      break;
    } catch { /* Try the next mirror. */ }
  }
  if (!reached) throw fail('The name lookup service is not answering right now. Try again, or enter RA and Dec.', 502);
  if (!found) {
    throw fail(`No object called “${name}” was found. Check the spelling, or enter RA and Dec. Planets, comets and asteroids move too fast to look up by name.`, 404);
  }
  const [ra, dec] = propagate(found.ra, found.dec, found.pmra, found.pmdec, 2000, year);
  const description = await describeType(found.type, fetcher);
  return {
    name, ra: ((ra % 360) + 360) % 360, dec: Math.max(-90, Math.min(90, dec)),
    catalogueName: found.catalogueName, type: found.type, description, source: found.source,
    epoch: Number(year.toFixed(2)),
  };
}

export async function handleResolve(params) {
  const request = parseResolve(params);
  const key = `${request.name.toLowerCase()}|${request.year.toFixed(1)}`, saved = cache.get(key);
  // Positions are cached for a day; a star moves well under a pixel in that time.
  if (saved && saved.expires > Date.now()) return saved.value;
  const value = await resolveName(request);
  cache.set(key, { value, expires: Date.now() + 86400000 });
  if (cache.size > 256) cache.delete(cache.keys().next().value);
  return value;
}
