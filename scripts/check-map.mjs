import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const sky = require('../dist/archive.cjs');
const fixture = require('../dist/fixture.json');

const close = (a, b, tolerance, label) => assert.ok(Math.abs(a - b) <= tolerance, `${label}: ${a} vs ${b}`);
const raDiff = (a, b) => ((a - b + 540) % 360) - 180;

// Gnomonic projection round trips, including high declination and near the poles.
for (const dec0 of [-7.242186, 66.755024, 89, -89]) {
  const camera = { ra: 248.1, dec: dec0, z: 2 };
  const k = sky.pxPerArcsec(camera.z, fixture.scale);
  for (const [dx, dy] of [[0, 0], [300, -200], [-640, 410], [5, 5]]) {
    const [ra, dec] = sky.unproject(camera, dx, dy, k);
    const back = sky.project(camera, ra, dec, k);
    close(back[0], dx, 1e-6, `x round trip at dec ${dec0}`);
    close(back[1], dy, 1e-6, `y round trip at dec ${dec0}`);
  }
}
// North up, east left: +RA lands left of centre, +Dec above it.
{
  const camera = { ra: 133.76, dec: -7.24, z: 3 };
  const k = sky.pxPerArcsec(3, fixture.scale);
  assert.ok(sky.project(camera, 133.77, -7.24, k)[0] < 0);
  assert.ok(sky.project(camera, 133.76, -7.23, k)[1] < 0);
}

// Zooming keeps the sky under the anchor fixed; panning back returns home.
for (const [dec0, zooms] of [[-7.242186, [4.7, -2.2, 6, -3]], [66.755024, [4.7, -2.2, 6]], [88.5, [4.7, -0.5, 6]]]) {
  const camera = { ra: 10, dec: dec0, z: 1.3 };
  const anchor = [420, -260];
  const before = sky.unproject(camera, ...anchor, sky.pxPerArcsec(camera.z, fixture.scale));
  for (const z of zooms) {
    const zoomed = sky.zoomAt(camera, z, ...anchor, fixture.scale);
    const after = sky.unproject(zoomed, ...anchor, sky.pxPerArcsec(zoomed.z, fixture.scale));
    close(raDiff(after[0], before[0]) * Math.cos(dec0 * Math.PI / 180), 0, 1e-9, `zoom anchor RA at dec ${dec0}`);
    close(after[1], before[1], 1e-9, `zoom anchor Dec at dec ${dec0}`);
  }
  // A long drag keeps the grabbed sky point exactly under the pointer.
  const k = sky.pxPerArcsec(camera.z, fixture.scale);
  const grab = sky.unproject(camera, -300, 120, k);
  let dragged = camera;
  for (let i = 1; i <= 40; i++) dragged = sky.placeAt(dragged, ...grab, -300 + 18 * i, 120 - 7 * i, k);
  const held = sky.project(dragged, ...grab, k);
  close(held[0], -300 + 18 * 40, 1e-6, `drag anchor x at dec ${dec0}`);
  close(held[1], 120 - 7 * 40, 1e-6, `drag anchor y at dec ${dec0}`);
  const home = sky.placeAt(dragged, ...grab, -300, 120, k);
  close(raDiff(home.ra, camera.ra) * Math.cos(dec0 * Math.PI / 180), 0, 1e-9, `drag back home at dec ${dec0}`);
  close(home.dec, camera.dec, 1e-9, `drag back home dec at ${dec0}`);
}
// With north kept up, a point 1.4° from the pole cannot sit 1.9° from the
// centre in that direction; zooming out there keeps a valid, finite camera.
{
  const camera = { ra: 10, dec: 88.5, z: 1.3 };
  const zoomed = sky.zoomAt(camera, -2.2, 420, -260, fixture.scale);
  assert.ok(Number.isFinite(zoomed.ra) && zoomed.dec <= 90 && zoomed.dec >= 80, `polar zoom-out camera ${JSON.stringify(zoomed)}`);
}
assert.equal(sky.clampZoom(99), sky.MAP_MAX_ZOOM);
assert.equal(sky.clampZoom(-99), sky.MAP_MIN_ZOOM);

// Default view: the WISE 0855 field at z = 3 is a 328 CSS px square, north up.
{
  const camera = { ra: fixture.ra0, dec: fixture.dec0, z: sky.MAP_DEFAULT_ZOOM };
  const [a, b, c, d, e, f] = sky.fieldTransform(camera, fixture, sky.pxPerArcsec(camera.z, fixture.scale));
  const side = 2 * fixture.half + 1;
  close(a * side, 328, 1e-6, 'field width');
  close(d * side, 328, 1e-6, 'field height');
  close(b, 0, 1e-9, 'no rotation (b)');
  close(c, 0, 1e-9, 'no rotation (c)');
  close(e + a * side / 2, 0, 1e-6, 'field centred (x)');
  close(f + d * side / 2, 0, 1e-6, 'field centred (y)');
  // The bitmap centre maps to the same sky position as the grid's own centre pixel.
  const [ra, dec] = sky.unproject(camera, 0, 0, sky.pxPerArcsec(camera.z, fixture.scale));
  const [px, py] = sky.fieldPixel(fixture, ra, dec);
  close(px, fixture.half, 1e-8, 'centre pixel x');
  close(py, fixture.half, 1e-8, 'centre pixel y');
}
// Near the pole the field image is drawn rotated to match the sky.
{
  const polar = { ...fixture, ra0: 30, dec0: 85 };
  const camera = { ra: 150, dec: 86, z: -1 };
  const [a, b] = sky.fieldTransform(camera, polar, sky.pxPerArcsec(camera.z, fixture.scale));
  assert.ok(Math.abs(b / a) > 0.05, 'polar field is rotated');
}

// Grid lines stay 80–200 px apart across the zoom range; labels follow the step.
for (let z = sky.MAP_MIN_ZOOM; z <= sky.MAP_MAX_ZOOM; z += 0.25) {
  const k = sky.pxPerArcsec(z, fixture.scale);
  for (const dec of [-7.24, 30.4, 66.76]) {
    const steps = sky.graticuleSteps(k, dec);
    const decPx = steps.dec * k, raPx = steps.ra * 15 * Math.cos(dec * Math.PI / 180) * k;
    assert.ok(decPx >= 80 && decPx <= 200, `dec spacing ${decPx} at z ${z}`);
    assert.ok(raPx >= 80 && raPx <= 200, `ra spacing ${raPx} at z ${z}, dec ${dec}`);
  }
  const bar = sky.scaleBar(k);
  assert.ok(bar.px <= 110 && bar.px > 20, `scale bar ${bar.px}px at z ${z}`);
}
assert.equal(sky.formatRa(133.759765, 0.01), '8h55m02.34s');
assert.equal(sky.formatDec(-7.242186, 0.1), '−7°14′31.9″');
assert.equal(sky.formatDec(-7.25, 900), '−7°15′');
assert.equal(sky.formatRa(135, 3600), '9h');
assert.equal(sky.formatDec(0, 3600), '+0°');
close(sky.separation(10, 0, 10, 1), 3600, 1e-6, 'separation');

// URL view state: at=ra,dec,z and the legacy Fit multipliers.
assert.deepEqual(sky.parseAt('133.759765,-7.242186,3'), { ra: 133.759765, dec: -7.242186, z: 3 });
assert.equal(sky.parseAt('133.7,-7.2'), null);
assert.equal(sky.parseAt('400,0,3'), null);
assert.equal(sky.parseAt('1,2,40').z, sky.MAP_MAX_ZOOM);
assert.equal(sky.formatAt({ ra: 133.759765, dec: -7.242186, z: 3.456 }), '133.759765,-7.242186,3.46');
assert.equal(sky.legacyZoom('1'), 3);
assert.equal(sky.legacyZoom('2'), 4);
assert.equal(sky.legacyZoom('4'), 5);
assert.equal(sky.legacyZoom('3'), null);
assert.equal(sky.legacyZoom(null), null);

// One search box: names or coordinates.
assert.equal(sky.parseQuery('WISE 0855').target.id, 'wise0855');
assert.equal(sky.parseQuery('wise0855').target.id, 'wise0855');
assert.equal(sky.parseQuery('barnard').target.id, 'barnard');
assert.equal(sky.parseQuery('R Dra').target.id, 'rdra');
assert.equal(sky.parseQuery('epsilon indi b').target.id, 'epsindiB');
assert.deepEqual(sky.parseQuery('133.76, -7.24'), { kind: 'coordinates', ra: 133.76, dec: -7.24 });
assert.deepEqual(sky.parseQuery('133.76 −7.24'), { kind: 'coordinates', ra: 133.76, dec: -7.24 });
const sexagesimal = sky.parseQuery('08h55m10.831s -07d14m42.53s');
close(sexagesimal.ra, 133.795129167, 1e-7, 'sexagesimal RA');
close(sexagesimal.dec, -7.24514722, 1e-7, 'sexagesimal Dec');
const spaced = sky.parseQuery('08h 55m 10.831s -07d 14m 42.53s');
close(spaced.ra, 133.795129167, 1e-7, 'spaced sexagesimal RA');
assert.deepEqual(sky.parseQuery('08:55:10.8, -07:14:42').kind, 'coordinates');
for (const bad of ['', '133.76', '133.76, -95', 'Andromeda', '1 2 3']) {
  assert.throws(() => sky.parseQuery(bad), /./, `rejects ${JSON.stringify(bad)}`);
}
assert.match((() => { try { sky.parseQuery('Andromeda'); } catch (error) { return error.message; } })(), /five examples/);
assert.deepEqual(sky.matchTargets('r').map((target) => target.id), ['rwaur', 'rdra']);

console.log('Map projection, zoom, grid, view-state and search parsing checks passed.');
