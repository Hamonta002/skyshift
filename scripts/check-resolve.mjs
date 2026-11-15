import assert from 'node:assert/strict';
import { parseResolve, parseSesame, resolveName } from './resolve.mjs';
import { separationArcsec } from './identify.mjs';

const sesame = (resolver) => `<?xml version="1.0" encoding="UTF-8"?>
<Sesame><Target option="SNV"><name>x</name>${resolver}</Target></Sesame>`;
const barnardXml = sesame(`<Resolver name="Sc=Simbad (CDS, via client/server)">
    <otype>BY*</otype><jradeg>269.45207696</jradeg><jdedeg>4.69336497</jdedeg>
    <pm><v>10393</v><pmRA>-801.551</pmRA><epmRA>0.032</epmRA><pmDE>10362.394</pmDE><epmDE>0.036</epmDE></pm>
    <oname>NAME Barnard&apos;s star</oname></Resolver>`);
const nothingXml = sesame(`<INFO> *** Nothing found *** </INFO>`);

// Parsing.
const parsed = parseSesame(barnardXml);
assert.equal(parsed.catalogueName, "Barnard's star");
assert.equal(parsed.type, 'BY*');
assert.equal(parsed.source, 'Simbad');
assert.equal(parsed.pmdec, 10362.394);
assert.equal(parseSesame(nothingXml), null);
assert.throws(() => parseSesame('<html>Page unavailable</html>'), /Unexpected/);
assert.equal(parseSesame(sesame('<Resolver name="N=NED"><otype>HII</otype><jradeg>83.82</jradeg><jdedeg>-5.39</jdedeg></Resolver>')).pmra, null);

// Input checks.
assert.equal(parseResolve(new URLSearchParams({ name: '  Barnard’s   Star ' })).name, 'Barnard’s Star');
assert.throws(() => parseResolve(new URLSearchParams({ name: '' })), /Type the name/);
assert.throws(() => parseResolve(new URLSearchParams({ name: 'x'.repeat(81) })), /too long/);
assert.throws(() => parseResolve(new URLSearchParams({ name: '<script>' })), /unsupported/);
assert.throws(() => parseResolve(new URLSearchParams({ name: 'M42', year: '1850' })), /year/);

// The first Sesame mirror fails; the second answers. SIMBAD supplies the type.
const calls = [];
const fetcher = async (url) => {
  calls.push(url.host);
  if (url.host === 'vizier.cfa.harvard.edu') throw new TypeError('network down');
  if (url.host === 'cds.unistra.fr') return new Response(url.search.includes('Nowhere') ? nothingXml : barnardXml);
  if (url.host === 'simbad.harvard.edu') return new Response('description\n"BY Dra Variable"\n');
  throw new Error(`unexpected host ${url.host}`);
};
const found = await resolveName({ name: "Barnard's Star", year: 2026.25 }, fetcher);
assert.equal(found.description, 'BY Dra Variable');
assert.deepEqual(calls, ['vizier.cfa.harvard.edu', 'cds.unistra.fr', 'simbad.harvard.edu']);
// Moved to 2026 with its proper motion: about 4.5′ north of the J2000 position, and
// within a few arcseconds of the bundled example position.
assert.ok(separationArcsec(269.45207696, 4.69336497, found.ra, found.dec) > 250);
assert.ok(separationArcsec(269.446269, 4.768204, found.ra, found.dec) < 15);

await assert.rejects(() => resolveName({ name: 'Nowhere', year: 2026 }, fetcher), (error) => error.status === 404 && /No object called/.test(error.message));
await assert.rejects(() => resolveName({ name: 'M42', year: 2026 }, async () => { throw new TypeError('offline'); }), (error) => error.status === 502);

console.log('Name lookup checks passed.');
