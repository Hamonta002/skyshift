/// <reference path="science.ts" />
/// <reference path="coordinates.ts" />
/// <reference path="map.ts" />
namespace SkyShift {
  export interface CatalogueSource {
    id: string;
    catalogue?: "gaia" | "wise";
    ra: number;
    dec: number;
    pmra: number | null;
    pmdec: number | null;
    epoch: number | null;
    magnitude?: number | null;
    colour?: number | null;
    parallax?: number | null;
  }
  export function cataloguePosition(source: CatalogueSource, year: number | null): [number, number] {
    return propagateProperMotion(source.ra, source.dec, source.pmra, source.pmdec, source.epoch, year);
  }
  export function formatCatalogueSource(source: CatalogueSource): string {
    const label = source.catalogue === "wise" ? "CatWISE2020" : "Gaia DR3";
    const parts: string[] = [`${label} ${source.id}`];
    if (source.magnitude != null && Number.isFinite(source.magnitude)) {
      parts.push(`${source.catalogue === "wise" ? "W1" : "G"} = ${source.magnitude.toFixed(2)}`);
    }
    if (source.colour != null && Number.isFinite(source.colour)) {
      parts.push(`${source.catalogue === "wise" ? "W1−W2" : "BP−RP"} = ${source.colour.toFixed(2)}`);
    }
    if (source.pmra != null && source.pmdec != null && Number.isFinite(source.pmra) && Number.isFinite(source.pmdec)) {
      const pmTotal = Math.hypot(source.pmra, source.pmdec);
      parts.push(`μ = ${pmTotal >= 100 ? (pmTotal / 1000).toFixed(2) + "″/yr" : pmTotal.toFixed(1) + " mas/yr"}`);
    }
    if (source.parallax != null && Number.isFinite(source.parallax) && source.parallax > 0) {
      parts.push(`ϖ = ${source.parallax.toFixed(1)} mas`);
    }
    return parts.join(" · ");
  }
  /** Zero-based aligned-grid pixel (x west, y north) for a sky position. */
  export function fieldPixel(fixture: FieldGeometry, ra: number, dec: number): [number, number] {
    const side = 2 * fixture.half + 1;
    const header: ExposureHeader = {size: side, x0:0, y0:0, crval:[fixture.ra0,fixture.dec0],
      crpix:[fixture.half + 1, fixture.half + 1], cdelt:[-fixture.scale / 3600,fixture.scale / 3600],
      pc:[1,0,0,1], a:{},b:{},ap:{},bp:{}};
    return worldToPixel(packWcs(header), ra, dec);
  }
  export function cataloguePixel(fixture: FieldGeometry, source: CatalogueSource, year: number | null): [number, number] {
    const [ra, dec] = cataloguePosition(source, year);
    return fieldPixel(fixture, ra, dec);
  }
}
