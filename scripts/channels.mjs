const URL_PROPERTIES = 'https://irsa.ipac.caltech.edu/data/hips/SPHEREx/spherex_allsky_cube/properties';
let cache;
export function parseChannelProperties(text) {
  const properties = Object.fromEntries(text.split(/\r?\n/).filter(line => line.includes('=') && !line.trim().startsWith('#')).map(line => {
    const i = line.indexOf('='); return [line.slice(0,i).trim(), line.slice(i+1).trim()];
  }));
  const wavelengths = (properties.data_cube_crval3_arr ?? '').split(/\s+/).filter(Boolean).map(Number);
  if (Number(properties.hips_cube_depth) !== 102 || wavelengths.length !== 102 || wavelengths.some(value => !Number.isFinite(value) || value <= 0)) throw Error('Unsupported SPHEREx cube wavelength metadata.');
  return wavelengths.map((center,index) => {
    const band = Math.floor(index / 17) + 1, local = index % 17;
    const first = (band - 1) * 17, last = first + 16;
    // Midpoints are display bins, not calibrated channel response limits.
    const low = local === 0 ? center - (wavelengths[first+1] - center) / 2 : (wavelengths[index-1] + center) / 2;
    const high = index === last ? center + (center - wavelengths[last-1]) / 2 : (wavelengths[index+1] + center) / 2;
    if (!(low < high)) throw Error('Invalid SPHEREx cube wavelengths.');
    return {number:index+1, band, channel:local+1, center, low, high, blank:index === 50 || index === 51};
  });
}
export async function handleChannels(fetcher = fetch) {
  if (cache && cache.expires > Date.now()) return cache.value;
  const response = await fetcher(URL_PROPERTIES, {signal:AbortSignal.timeout(10000)});
  if (!response.ok) throw Error(`SPHEREx channel metadata returned HTTP ${response.status}.`);
  const text = await response.text();
  if (text.length > 200000) throw Error('Channel metadata is too large.');
  const value = {source:URL_PROPERTIES, channels:parseChannelProperties(text), checkedAtUtc:new Date().toISOString()};
  cache = {value, expires:Date.now() + 86400000};
  return value;
}
