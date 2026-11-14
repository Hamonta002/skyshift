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
  }

  export const TARGETS: Target[] = [
    { id: "wise0855", label: "WISE 0855", ra: 133.759765, dec: -7.242186, band: 6 },
    { id: "barnard", label: "Barnard’s Star", ra: 269.446269, dec: 4.768204, band: 6 },
    { id: "epsindiB", label: "Epsilon Indi B", ra: 331.096644, dec: -56.800660, band: 2 },
    { id: "rwaur", label: "RW Aurigae", ra: 76.956587, dec: 30.401291, band: 1 },
    { id: "rdra", label: "R Draconis", ra: 248.167233, dec: 66.755024, band: 5 },
  ];
}
