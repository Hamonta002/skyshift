namespace SkyShift {
  export function parseCoordinate(input: string, kind: "ra" | "dec"): number {
    const value = input.trim().replaceAll("−", "-");
    if (!value) throw new Error("Enter both coordinates.");
    let result: number;
    if (/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value)) {
      result = Number(value);
    } else {
      const pattern = kind === "ra"
        ? /^([+-]?\d+)(?:h|:)\s*(\d+)(?:m|:)\s*(\d+(?:\.\d+)?)(?:s)?$/i
        : /^([+-]?\d+)(?:d|°|:)\s*(\d+)(?:m|′|:)\s*(\d+(?:\.\d+)?)(?:s|″)?$/i;
      const match = value.match(pattern);
      if (!match) throw new Error("Use decimal degrees or a complete sexagesimal coordinate.");
      const first = Number(match[1]);
      const minute = Number(match[2]);
      const second = Number(match[3]);
      if (minute >= 60 || second >= 60) throw new Error("Minutes and seconds must be below 60.");
      const sign = match[1].startsWith("-") ? -1 : 1;
      result = sign * (Math.abs(first) + minute / 60 + second / 3600);
      if (kind === "ra") result *= 15;
    }
    if (!Number.isFinite(result) || (kind === "ra" && (result < 0 || result > 360))
      || (kind === "dec" && (result < -90 || result > 90))) {
      throw new Error(kind === "ra" ? "RA must be between 0° and 360°." : "Declination must be between −90° and 90°.");
    }
    return kind === "ra" && result === 360 ? 0 : result;
  }

  export type Query = { kind: "target"; target: Target } | { kind: "coordinates"; ra: number; dec: number };

  const simplify = (text: string) => text.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]/g, "");

  /** Targets whose label or id starts with the typed text (ignoring case and punctuation). */
  export function matchTargets(text: string): Target[] {
    const key = simplify(text);
    if (!key) return [];
    return TARGETS.filter((target) => simplify(target.label).startsWith(key) || simplify(target.id).startsWith(key));
  }

  /**
   * One search box: a bundled target name, or RA and Dec separated by a comma
   * or by whitespace (each part accepts the forms of `parseCoordinate`).
   */
  export function parseQuery(input: string): Query {
    const text = input.trim().replaceAll("−", "-");
    if (!text) throw new Error("Type a target name, or RA and Dec.");
    const exact = TARGETS.find((target) => simplify(target.label) === simplify(text) || simplify(target.id) === simplify(text));
    if (exact) return { kind: "target", target: exact };
    // Letters other than sexagesimal unit markers mean a name.
    if (/[a-z]/i.test(text.replace(/\d+(?:\.\d+)?\s*[hmsd]/gi, ""))) {
      const [match] = matchTargets(text);
      if (match) return { kind: "target", target: match };
      throw new Error("Name search covers the five examples. Enter RA and Dec for any other field.");
    }
    let parts = text.includes(",") ? text.split(",") : text.split(/\s+/);
    if (!text.includes(",") && parts.length !== 2) {
      // Labelled sexagesimal may contain spaces, e.g. "08h 55m 10.8s -07d 14m 42s".
      const split = text.match(/^(.*?s)\s+([+-]?\d.*)$/i);
      if (split) parts = [split[1].replace(/\s+/g, ""), split[2].replace(/\s+/g, "")];
    }
    if (parts.length !== 2 || parts.some((part) => !part.trim())) {
      throw new Error("Enter RA and Dec separated by a comma, e.g. 133.76, −7.24.");
    }
    const ra = parseCoordinate(parts[0], "ra"), dec = parseCoordinate(parts[1], "dec");
    return { kind: "coordinates", ra, dec };
  }

  export interface Target {
    id: string;
    label: string;
    ra: number;
    dec: number;
    band: number;
    raJ2000?: number;
    decJ2000?: number;
    pmra?: number;
    pmdec?: number;
    epoch?: number;
  }

  export const TARGETS: Target[] = [
    { id: "wise0855", label: "WISE 0855", ra: 133.759765, dec: -7.242186, band: 6, raJ2000: 133.81890825, decJ2000: -7.24704800, pmra: -8123.7, pmdec: 673.2, epoch: 2026.0 },
    { id: "barnard", label: "Barnard’s Star", ra: 269.446269, dec: 4.768204, band: 6, raJ2000: 269.45207696, decJ2000: 4.69336497, pmra: -801.551, pmdec: 10362.394, epoch: 2026.0 },
    { id: "epsindiB", label: "Epsilon Indi B", ra: 331.096644, dec: -56.800660, band: 2, raJ2000: 331.04414659, decJ2000: -56.78284420, pmra: 3981.977, pmdec: -2466.832, epoch: 2026.0 },
    { id: "rwaur", label: "RW Aurigae", ra: 76.956587, dec: 30.401291, band: 1, raJ2000: 76.95652603, decJ2000: 30.40143817, pmra: 7.23, pmdec: -20.33, epoch: 2026.0 },
    { id: "rdra", label: "R Draconis", ra: 248.167233, dec: 66.755024, band: 5, raJ2000: 248.16761083, decJ2000: 66.75497942, pmra: -20.643, pmdec: 6.149, epoch: 2026.0 },
  ];

  export function mjdToJulianYear(mjd: number): number {
    return 2000 + (mjd - 51544.5) / 365.25;
  }

  export function propagateProperMotion(
    ra: number,
    dec: number,
    pmra: number | null | undefined,
    pmdec: number | null | undefined,
    epoch: number | null | undefined,
    year: number | null,
  ): [number, number] {
    if (year === null || epoch == null || pmra == null || pmdec == null) return [ra, dec];
    const dt = year - epoch;
    const cos = Math.cos(dec * Math.PI / 180);
    if (Math.abs(cos) < 1e-8) return [ra, dec];
    return [ra + dt * pmra / 3600000 / cos, dec + dt * pmdec / 3600000];
  }

  export function targetPosition(
    target: Pick<Target, "ra" | "dec" | "raJ2000" | "decJ2000" | "pmra" | "pmdec" | "epoch">,
    mjd: number,
  ): [number, number] {
    const year = mjdToJulianYear(mjd);
    if (target.raJ2000 !== undefined && target.decJ2000 !== undefined) {
      return propagateProperMotion(target.raJ2000, target.decJ2000, target.pmra, target.pmdec, 2000.0, year);
    }
    return propagateProperMotion(target.ra, target.dec, target.pmra, target.pmdec, target.epoch ?? 2026.0, year);
  }

  export function findTargetAt(ra: number, dec: number, radiusDeg = 0.02, mjd?: number): Target | undefined {
    const cos = Math.cos(dec * Math.PI / 180);
    return TARGETS.find((target) => {
      const [tra, tdec] = mjd !== undefined ? targetPosition(target, mjd) : [target.ra, target.dec];
      let dra = Math.abs(tra - ra);
      if (dra > 180) dra = 360 - dra;
      if (Math.hypot(dra * cos, tdec - dec) <= radiusDeg) return true;
      if (target.raJ2000 !== undefined && target.decJ2000 !== undefined) {
        let draJ = Math.abs(target.raJ2000 - ra);
        if (draJ > 180) draJ = 360 - draJ;
        if (Math.hypot(draJ * cos, target.decJ2000 - dec) <= radiusDeg) return true;
      }
      return false;
    });
  }
}
