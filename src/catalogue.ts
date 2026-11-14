namespace SkyShift {
  export interface CatalogueSource { id: string; ra: number; dec: number; pmra: number | null; pmdec: number | null; epoch: number | null }
  export function cataloguePosition(source: CatalogueSource, year: number | null): [number, number] {
    if (year === null || source.epoch === null || source.pmra === null || source.pmdec === null) return [source.ra, source.dec];
    const dt = year - source.epoch;
    const cos = Math.cos(source.dec * Math.PI / 180);
    if (Math.abs(cos) < 1e-8) return [source.ra, source.dec];
    return [source.ra + dt * source.pmra / 3600000 / cos, source.dec + dt * source.pmdec / 3600000];
  }
  /** Zero-based aligned-grid pixel (x west, y north) for a sky position. */
  export function fieldPixel(fixture: PackedFixture, ra: number, dec: number): [number, number] {
    const side = 2 * fixture.half + 1;
    const header: ExposureHeader = {size: side, x0:0, y0:0, crval:[fixture.ra0,fixture.dec0],
      crpix:[fixture.half + 1, fixture.half + 1], cdelt:[-fixture.scale / 3600,fixture.scale / 3600],
      pc:[1,0,0,1], a:{},b:{},ap:{},bp:{}};
    return worldToPixel(packWcs(header), ra, dec);
  }
  export function cataloguePixel(fixture: PackedFixture, source: CatalogueSource, year: number | null): [number, number] {
    const [ra, dec] = cataloguePosition(source, year);
    return fieldPixel(fixture, ra, dec);
  }
}
