/**
 * Colour arithmetic, shared by the theme studio's picker and by the theme
 * sniffer (see themeSniff.ts).
 *
 * It lives apart from both because the sniffer has no business importing a
 * React component to find out how dark a background is, and because these are
 * the only functions in the app that need to agree on what a colour *is*:
 * every theme value that names one is CSS text, and this is where that text
 * becomes numbers.
 */

export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

export interface Hsva {
  h: number;
  s: number;
  v: number;
  a: number;
}

let paint: CanvasRenderingContext2D | null | undefined;

/**
 * Any CSS colour to channels, by letting the canvas parse it — so names,
 * `hsl()`, three-digit hex and the rest all work without a parser of our own.
 * An unparseable value (`inherit`, a typo) leaves fillStyle where it was,
 * which two different starting colours give away.
 */
export function parseColor(v: string | undefined): Rgba | null {
  if (!v) return null;
  if (paint === undefined) paint = document.createElement('canvas').getContext('2d');
  if (!paint) return null;
  paint.fillStyle = '#010203';
  paint.fillStyle = v;
  const one = String(paint.fillStyle);
  paint.fillStyle = '#fdfcfb';
  paint.fillStyle = v;
  if (String(paint.fillStyle) !== one) return null;
  if (one.startsWith('#')) {
    const n = parseInt(one.slice(1), 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: 1 };
  }
  const parts = one.match(/[\d.]+/g)?.map(Number) ?? [];
  if (parts.length < 3) return null;
  return { r: parts[0], g: parts[1], b: parts[2], a: parts[3] ?? 1 };
}

const hex2 = (n: number) => Math.round(n).toString(16).padStart(2, '0');
export const toHex = (c: Rgba) => `#${hex2(c.r)}${hex2(c.g)}${hex2(c.b)}`;

/** Opaque colours as hex, translucent ones as rgba() — the two forms the
 *  themes already use, and the two every WeChat renderer understands */
export function formatColor(c: Rgba): string {
  const a = Math.round(c.a * 100) / 100;
  if (a >= 1) return toHex(c);
  return `rgba(${Math.round(c.r)},${Math.round(c.g)},${Math.round(c.b)},${a})`;
}

export function rgbToHsv({ r, g, b, a }: Rgba): Hsva {
  const R = r / 255;
  const G = g / 255;
  const B = b / 255;
  const max = Math.max(R, G, B);
  const d = max - Math.min(R, G, B);
  let h = 0;
  if (d) {
    if (max === R) h = ((G - B) / d) % 6;
    else if (max === G) h = (B - R) / d + 2;
    else h = (R - G) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s: max ? d / max : 0, v: max, a };
}

export function hsvToRgb({ h, s, v, a }: Hsva): Rgba {
  const f = (n: number) => {
    const k = (n + h / 60) % 6;
    return (v - v * s * Math.max(0, Math.min(k, 4 - k, 1))) * 255;
  };
  return { r: f(5), g: f(3), b: f(1), a };
}

export const same = (x: Rgba, y: Rgba) =>
  Math.abs(x.r - y.r) < 1 && Math.abs(x.g - y.g) < 1 && Math.abs(x.b - y.b) < 1 && Math.abs(x.a - y.a) < 0.006;

export const clamp = (n: number, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, n));

/** Every colour written anywhere in a theme's values — including the ones
 *  inside a border shorthand — once each, for the swatch row */
export function collectColors(values: unknown, limit = 18): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const walk = (v: unknown) => {
    if (out.length >= limit) return;
    if (typeof v === 'string') {
      for (const token of v.match(/(rgba?|hsla?)\([^)]*\)|#[0-9a-f]{3,8}\b/gi) ?? []) {
        const c = parseColor(token);
        if (!c || c.a === 0) continue;
        const key = formatColor(c);
        if (seen.has(key) || out.length >= limit) continue;
        seen.add(key);
        out.push(key);
      }
    } else if (v && typeof v === 'object') {
      for (const x of Object.values(v)) walk(x);
    }
  };
  walk(values);
  return out;
}

