// Read-only, bounded catalogue proxy. Hosts, tables and selected columns are fixed.
const providers = {
  gaia: {
    url: 'https://gea.esac.esa.int/tap-server/tap/sync',
    table: 'gaiadr3.gaia_source',
    columns: 'source_id,ra,dec,pmra,pmdec,phot_g_mean_mag,bp_rp,parallax',
    orderBy: 'phot_g_mean_mag ASC',
    epoch: 2016,
    pmScale: 1,
    label: 'Gaia DR3',
  },
  wise: {
    url: 'https://irsa.ipac.caltech.edu/TAP/sync',
    table: 'catwise_2020',
    columns: 'source_name,ra,dec,pmra,pmdec,w1mpro,w2mpro',
    orderBy: 'w1mpro ASC',
    epoch: 2015.4,
    pmScale: 1000, // CatWISE2020 proper motion columns are in arcsec/yr; convert to mas/yr.
    label: 'CatWISE2020',
  },
};
const cache = new Map();
export function parseCsv(text) {
  const rows = []; let row = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted && c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
    else if (c === '"') quoted = !quoted;
    else if (!quoted && c === ',') { row.push(cell); cell = ''; }
    else if (!quoted && (c === '\n' || c === '\r')) {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); cell = ''; if (row.some(Boolean)) rows.push(row); row = [];
    } else cell += c;
  }
  if (quoted) throw new Error('Malformed catalogue response.');
  if (cell || row.length) { row.push(cell); rows.push(row); }
  if (!rows.length) throw new Error('Empty catalogue response.');
  const fields = rows.shift().map((s) => s.trim().toLowerCase());
  if (!fields.includes('ra') || !fields.includes('dec')) throw new Error('Unexpected catalogue columns.');
  return rows.map((cells) => Object.fromEntries(fields.map((field, i) => [field, cells[i] ?? ''])));
}
export async function searchCatalogue(params, fetcher = fetch) {
  const name = params.get('catalogue'), provider = providers[name];
  const parse = (name) => { const raw = params.get(name); if (!raw || !Number.isFinite(Number(raw))) throw new Error(`Invalid ${name}.`); return Number(raw); };
  if (!provider) throw new Error('Unknown catalogue.');
  const ra = parse('ra'), dec = parse('dec'), fov = parse('fov');
  if (ra < 0 || ra >= 360 || dec < -90 || dec > 90 || fov <= 0 || fov > 20) throw new Error('Catalogue field is out of range.');
  const radius = fov / 120 * Math.SQRT2;
  const query = `SELECT TOP 250 ${provider.columns} FROM ${provider.table} WHERE 1=CONTAINS(POINT('ICRS',ra,dec),CIRCLE('ICRS',${ra},${dec},${radius})) ORDER BY ${provider.orderBy}`;
  const url = new URL(provider.url);
  url.search = new URLSearchParams({REQUEST:'doQuery', LANG:'ADQL', FORMAT:'csv', MAXREC:'250', QUERY:query});
  let response;
  try { response = await fetcher(url, { signal: AbortSignal.timeout(20000) }); }
  catch { const error = new Error(`${provider.label} is not answering right now.`); error.status = 502; throw error; }
  if (!response.ok) { const error = new Error(`${provider.label} is not answering right now (HTTP ${response.status}).`); error.status = 502; throw error; }
  const body = await response.text();
  if (body.length > 1_000_000) throw new Error('Catalogue response is too large.');
  const rows = parseCsv(body);
  const optNum = (v) => (v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : null);
  const sources = rows.slice(0,250).flatMap((row) => {
    const ra = Number(row.ra), dec = Number(row.dec);
    if (!row.ra || !row.dec || !Number.isFinite(ra) || !Number.isFinite(dec)) return [];
    const rawPmra = optNum(row.pmra), rawPmdec = optNum(row.pmdec);
    const pmra = rawPmra !== null ? Math.round(rawPmra * provider.pmScale * 1e6) / 1e6 : null;
    const pmdec = rawPmdec !== null ? Math.round(rawPmdec * provider.pmScale * 1e6) / 1e6 : null;
    const gMag = optNum(row.phot_g_mean_mag), w1 = optNum(row.w1mpro), w2 = optNum(row.w2mpro);
    const magnitude = name === 'gaia' ? gMag : w1;
    const colour = name === 'gaia' ? optNum(row.bp_rp) : (w1 !== null && w2 !== null ? Math.round((w1 - w2) * 1e6) / 1e6 : null);
    const parallax = name === 'gaia' ? optNum(row.parallax) : null;
    return [{
      id: row.source_id || row.source_name,
      catalogue: name,
      ra,
      dec,
      pmra,
      pmdec,
      epoch: provider.epoch,
      magnitude,
      colour,
      parallax,
    }];
  });
  return { catalogue: provider.label, sources, truncated: rows.length >= 250, checkedAtUtc: new Date().toISOString() };
}
export async function handleCatalogue(params) {
  const key = params.toString(), saved = cache.get(key);
  if (saved && saved.expires > Date.now()) return saved.value;
  const value = await searchCatalogue(params);
  cache.set(key, {value, expires: Date.now() + 6 * 3600000});
  if (cache.size > 128) cache.delete(cache.keys().next().value);
  return value;
}
