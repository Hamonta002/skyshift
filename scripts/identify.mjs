// Read-only identification proxy: SIMBAD (object type and name), Gaia DR3
// (astrometry and photometry) and IMCCE SkyBoT (known solar-system objects).
// Catalogue positions are propagated with their proper motions to the epoch of
// the SPHEREx frame before matching; each service reports its own status.
import { parseCsv } from './catalogue.mjs';

const SIMBAD_HOSTS = ['https://simbad.cds.unistra.fr/simbad/sim-tap/sync', 'https://simbad.harvard.edu/simbad/sim-tap/sync'];
const GAIA_TAP = 'https://gea.esac.esa.int/tap-server/tap/sync';
const SKYBOT = 'https://ssp.imcce.fr/webservices/skybot/api/conesearch.php';
const cache = new Map();
const DEG = Math.PI / 180;

function fail(message, status = 400) { const error = new Error(message); error.status = status; return error; }

export function parseIdentify(params) {
  const number = (name, fallback) => {
    const raw = params.get(name);
    if (raw === null || raw === '') { if (fallback !== undefined) return fallback; throw fail(`Missing ${name}.`); }
    const value = Number(raw);
    if (!Number.isFinite(value)) throw fail(`Invalid ${name}.`);
    return value;
  };
  const ra = number('ra'), dec = number('dec'), mjd = number('mjd'), radius = number('radius', 8);
  if (ra < 0 || ra >= 360 || dec < -90 || dec > 90) throw fail('Position is out of range.');
  if (mjd < 60000 || mjd > 70000) throw fail('Epoch is out of range.');
  if (radius <= 0 || radius > 30) throw fail('Radius must be between 0 and 30 arcsec.');
  const epochs = (params.get('epochs') ?? String(mjd)).split(',').filter(Boolean).map(Number);
  if (!epochs.length || epochs.length > 4 || epochs.some((m) => !Number.isFinite(m) || m < 60000 || m > 70000)) throw fail('Give one to four frame epochs (MJD).');
  return { ra, dec, mjd, radius, epochs };
}

export function separationArcsec(ra1, dec1, ra2, dec2) {
  const a = Math.sin((dec2 - dec1) * DEG / 2) ** 2 + Math.cos(dec1 * DEG) * Math.cos(dec2 * DEG) * Math.sin((ra2 - ra1) * DEG / 2) ** 2;
  return 2 * Math.asin(Math.min(1, Math.sqrt(a))) / DEG * 3600;
}

/** Position at `year` from a catalogue position at `epoch` with proper motion in mas/yr. */
export function propagate(ra, dec, pmra, pmdec, epoch, year) {
  const dt = year - epoch, cos = Math.cos(dec * DEG);
  if (!Number.isFinite(pmra) || !Number.isFinite(pmdec) || Math.abs(cos) < 1e-9) return [ra, dec];
  return [ra + dt * pmra / 3.6e6 / cos, dec + dt * pmdec / 3.6e6];
}

const yearOf = (mjd) => 2000 + (mjd - 51544.5) / 365.25;
const num = (value) => (value === '' || value === undefined || !Number.isFinite(Number(value)) ? null : Number(value));

async function tap(url, query, fetcher) {
  const target = new URL(url);
  target.search = new URLSearchParams({ REQUEST: 'doQuery', LANG: 'ADQL', FORMAT: 'csv', QUERY: query });
  const response = await fetcher(target, { signal: AbortSignal.timeout(25000) });
  const body = await response.text();
  if (!response.ok) throw fail(`HTTP ${response.status}`, 502);
  if (body.length > 2_000_000) throw fail('Response too large.', 502);
  if (/^\s*</.test(body)) throw fail('Service returned a page instead of data.', 502);
  return parseCsv(body);
}

// High proper-motion objects can have moved minutes of arc since the catalogue
// epoch, so search a wider circle but keep only nearby or fast-moving entries.
export async function searchSimbad({ ra, dec, mjd, radius }, fetcher = fetch) {
  const query = `SELECT TOP 100 b.main_id, b.otype, d.description, b.ra, b.dec, b.pmra, b.pmdec, b.plx_value, b.sp_type, b.nbref AS refs
    FROM basic AS b JOIN otypedef AS d ON b.otype = d.otype
    WHERE CONTAINS(POINT('ICRS', b.ra, b.dec), CIRCLE('ICRS', ${ra}, ${dec}, 0.0833)) = 1
    AND (DISTANCE(POINT('ICRS', b.ra, b.dec), POINT('ICRS', ${ra}, ${dec})) < 0.0167 OR b.pmra * b.pmra + b.pmdec * b.pmdec > 40000)`;
  let rows, lastError;
  for (const host of SIMBAD_HOSTS) {
    try { rows = await tap(host, query.replace(/\s+/g, ' '), fetcher); break; } catch (error) { lastError = error; }
  }
  if (!rows) throw fail(`SIMBAD is unavailable (${lastError?.message ?? 'no response'}).`, 502);
  const year = yearOf(mjd);
  const matches = rows.map((row) => {
    const [r, d] = propagate(Number(row.ra), Number(row.dec), num(row.pmra), num(row.pmdec), 2000, year);
    return { name: row.main_id.replace(/^NAME /, ''), type: row.otype, description: row.description || row.otype, separation: separationArcsec(ra, dec, r, d),
      pmra: num(row.pmra), pmdec: num(row.pmdec), parallax: num(row.plx_value), spectralType: row.sp_type || null, refs: num(row.refs) ?? 0 };
  }).filter((m) => m.separation <= radius);
  return rankMatches(matches);
}

// SPHEREx cannot separate objects a few arcseconds apart (its pixels are 6″),
// so among entries that close to the nearest one the most-studied leads; this
// picks a binary system over one component and a star over its planets.
export function rankMatches(matches) {
  const stars = matches.filter((m) => m.type !== 'Pl').sort((a, b) => a.separation - b.separation);
  const planets = matches.filter((m) => m.type === 'Pl').sort((a, b) => a.separation - b.separation);
  const nearest = stars[0]?.separation ?? Infinity;
  const close = stars.filter((m) => m.separation <= nearest + 3).sort((a, b) => b.refs - a.refs);
  return [...close, ...stars.filter((m) => m.separation > nearest + 3), ...planets].slice(0, 5);
}

export async function searchGaia({ ra, dec, mjd, radius }, fetcher = fetch) {
  const query = `SELECT TOP 100 source_id, ra, dec, pmra, pmdec, parallax, phot_g_mean_mag, bp_rp FROM gaiadr3.gaia_source
    WHERE 1 = CONTAINS(POINT('ICRS', ra, dec), CIRCLE('ICRS', ${ra}, ${dec}, 0.0333))
    AND (DISTANCE(POINT('ICRS', ra, dec), POINT('ICRS', ${ra}, ${dec})) < 0.0083 OR pmra * pmra + pmdec * pmdec > 10000)`;
  let rows;
  try { rows = await tap(GAIA_TAP, query.replace(/\s+/g, ' '), fetcher); }
  catch (error) { throw fail(`Gaia DR3 is unavailable (${error.message}).`, 502); }
  const year = yearOf(mjd);
  return rows.map((row) => {
    const [r, d] = propagate(Number(row.ra), Number(row.dec), num(row.pmra), num(row.pmdec), 2016, year);
    return { name: `Gaia DR3 ${row.source_id}`, type: 'star', description: 'Gaia DR3 source', separation: separationArcsec(ra, dec, r, d),
      pmra: num(row.pmra), pmdec: num(row.pmdec), parallax: num(row.parallax), magnitude: num(row.phot_g_mean_mag), colour: num(row.bp_rp) };
  }).filter((m) => m.separation <= radius).sort((a, b) => a.separation - b.separation).slice(0, 5);
}

export function parseSkybot(text, mjd) {
  const lines = text.split(/\r?\n/);
  const flag = lines.find((line) => line.startsWith('# Flag:'));
  if (!flag) throw fail('Unexpected SkyBoT response.', 502);
  if (/Flag:\s*-1/.test(flag)) throw fail('SkyBoT reported an error.', 502);
  return lines.filter((line) => line.trim() && !line.startsWith('#')).map((line) => {
    const cells = line.split('|').map((cell) => cell.trim());
    return { number: cells[0] && cells[0] !== '-' ? cells[0] : null, name: cells[1], kind: cells[4], magnitude: num(cells[5]), separation: Number(cells[7]), mjd };
  }).filter((item) => item.name && Number.isFinite(item.separation));
}

// Geocentric ephemerides; SPHEREx's low orbit shifts nearby asteroids by a few
// arcseconds at most for main-belt objects, so the match radius is generous.
export async function searchSkybot({ ra, dec, radius, epochs }, fetcher = fetch) {
  const radiusDeg = Math.max(60, radius * 6) / 3600;
  const found = [];
  for (const mjd of epochs) {
    const url = new URL(SKYBOT);
    url.search = new URLSearchParams({ '-ep': String(mjd + 2400000.5), '-ra': String(ra), '-dec': String(dec), '-rd': radiusDeg.toFixed(5),
      '-mime': 'text', '-output': 'basic', '-loc': '500', '-filter': '120', '-objFilter': '111', '-refsys': 'EQJ2000', '-from': 'SkyShift' });
    let response;
    try { response = await fetcher(url, { signal: AbortSignal.timeout(25000) }); }
    catch { throw fail('SkyBoT is unavailable.', 502); }
    // SkyBoT answers 204 No Content when no known object is in the cone.
    if (response.status === 204) continue;
    if (!response.ok) throw fail(`SkyBoT returned HTTP ${response.status}.`, 502);
    found.push(...parseSkybot(await response.text(), mjd));
  }
  const best = new Map();
  for (const item of found) if (!best.has(item.name) || best.get(item.name).separation > item.separation) best.set(item.name, item);
  return [...best.values()].sort((a, b) => a.separation - b.separation).slice(0, 5);
}

export async function identify(params, fetcher = fetch) {
  const request = parseIdentify(params);
  const settle = async (task) => {
    try { return { status: 'ok', matches: await task(request, fetcher) }; }
    catch (error) { return { status: error.message || 'unavailable', matches: [] }; }
  };
  const [simbad, gaia, skybot] = await Promise.all([settle(searchSimbad), settle(searchGaia), settle(searchSkybot)]);
  return { query: request, simbad, gaia, skybot, checkedAtUtc: new Date().toISOString() };
}

export async function handleIdentify(params) {
  const request = parseIdentify(params);
  const key = JSON.stringify(request), saved = cache.get(key);
  if (saved && saved.expires > Date.now()) return saved.value;
  const value = await identify(params);
  // Only cache complete answers; a service outage should be retried.
  if ([value.simbad, value.gaia, value.skybot].every((part) => part.status === 'ok')) {
    cache.set(key, { value, expires: Date.now() + 6 * 3600000 });
    if (cache.size > 256) cache.delete(cache.keys().next().value);
  }
  return value;
}
