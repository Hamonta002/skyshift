// Fetch genuine archive products to build optional offline example bundles.
// Run after `npm run build` on a machine with IRSA and S3 access.
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { searchObservations } from './observations.mjs';
const require = createRequire(import.meta.url);
const sky = require('../dist/archive.cjs');
const targets = [
  { id:'barnard', ra:269.446269, dec:4.768204, band:6 },
  { id:'epsindiB', ra:331.096644, dec:-56.800660, band:2 },
  { id:'rwaur', ra:76.956587, dec:30.401291, band:1 },
  { id:'rdra', ra:248.167233, dec:66.755024, band:5 },
];
// Fallback to the archived discovery tables when the metadata service is temporarily down.
// The needed columns precede cloud_access, whose embedded JSON is not valid RFC CSV.
async function recordedObservations(target) {
  const collections = ['spherex_dr1', 'spherex_dr1_deep', 'spherex_qr3', 'spherex_qr3_deep'];
  const prefix = 'https://irsa.ipac.caltech.edu/ibe/data/spherex/';
  const unique = new Map();
  for (const name of collections) {
    let text;
    try { text = await readFile(`reference/_work/coverage/${target.id}__${name}.csv`, 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    const lines = text.split(/\r?\n/), columns = lines.shift().split(',');
    const at = Object.fromEntries(['access_url','obs_id','obs_collection','energy_bandpassname','t_min','t_max'].map(key => [key, columns.indexOf(key)]));
    if (Object.values(at).some(index => index < 0)) throw Error('Recorded coverage is missing required columns.');
    for (const line of lines) {
      const cells = line.split(',');
      const url = cells[at.access_url], detector = Number(cells[at.energy_bandpassname]?.match(/D([1-6])$/)?.[1]);
      const startMjd = Number(cells[at.t_min]), endMjd = Number(cells[at.t_max]);
      if (!url?.startsWith(prefix) || detector !== target.band || !Number.isFinite(startMjd) || !Number.isFinite(endMjd)) continue;
      const productKey = url.slice(prefix.length);
      if (!/^[a-z0-9_]+\/level2\/[a-zA-Z0-9_./-]+\.fits$/.test(productKey) || productKey.includes('..')) continue;
      unique.set(productKey, {id:cells[at.obs_id], collection:cells[at.obs_collection], detector, productKey, startMjd, endMjd});
    }
  }
  return [...unique.values()].sort((a,b) => a.startMjd - b.startMjd);
}
const wanted = process.argv.slice(2);
if (wanted.some(id => !targets.some(target => target.id === id))) throw Error('Choose barnard, epsindiB, rwaur, or rdra.');
await mkdir('reference/fixtures/examples', {recursive:true});
let failed = false;
for (const target of targets.filter(t => !wanted.length || wanted.includes(t.id))) {
  try {
    const fov = 5;
    console.log(`Searching ${target.id}…`);
    let metadata;
    try {
      metadata = await searchObservations(new URLSearchParams({...target, ra:String(target.ra), dec:String(target.dec), band:String(target.band), fov:String(fov)}));
    } catch (error) {
      const observations = await recordedObservations(target);
      if (!observations.length) throw error;
      console.warn(`${target.id}: live search failed; using recorded coverage metadata. Pixel downloads still require S3.`);
      metadata = {observations, checkedAtUtc:null, collections:[], recordedCoverage:true};
    }
    if (!metadata.observations.length) throw Error('No archive coverage.');
    if (metadata.collections.some(item => item.status !== 'ok')) console.warn(`${target.id}: archive results may be incomplete.`);
    const fixture = await sky.makeLiveFixture(metadata.observations, target.ra, target.dec, fov, new AbortController().signal,
      (done, total) => { if (done === total || done % 10 === 0) console.log(`${target.id}: ${done}/${total} exposures`); }, false);
    const bundle = { target, fixture, archive: { checkedAtUtc: metadata.checkedAtUtc, collections: metadata.collections, recordedCoverage: Boolean(metadata.recordedCoverage) },
      warning: 'Sampled archive exposures. Visual exploration only; quality flags and calibrated uncertainty are not applied.' };
    const path = `reference/fixtures/examples/${target.id}.json`;
    await writeFile(path, JSON.stringify(bundle));
    console.log(`Saved ${path}: ${fixture.dates.length} visits, ${fixture.headers.length} exposures.`);
  } catch (error) { failed = true; console.error(`${target.id}: ${error.message}`); }
}
if (failed) process.exitCode = 1;
else console.log('Run npm run build to include the new examples in the app.');
