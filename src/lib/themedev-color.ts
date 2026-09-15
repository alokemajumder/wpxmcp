/**
 * Colour parsing and WCAG contrast maths. Pure TypeScript, no platform APIs,
 * so it runs identically on Node and Workers.
 */

export interface RGBA {
  r: number;
  g: number;
  b: number;
  /** 0–1 */
  a: number;
}

/** CSS named colours that realistically appear in themes. Unknown names are treated as unparseable, never guessed. */
const NAMED: Record<string, string> = {
  black: "#000000", white: "#ffffff", red: "#ff0000", green: "#008000", blue: "#0000ff",
  yellow: "#ffff00", orange: "#ffa500", purple: "#800080", gray: "#808080", grey: "#808080",
  silver: "#c0c0c0", maroon: "#800000", navy: "#000080", teal: "#008080", olive: "#808000",
  lime: "#00ff00", aqua: "#00ffff", cyan: "#00ffff", fuchsia: "#ff00ff", magenta: "#ff00ff",
  pink: "#ffc0cb", brown: "#a52a2a", gold: "#ffd700", beige: "#f5f5dc", ivory: "#fffff0",
  indigo: "#4b0082", violet: "#ee82ee", coral: "#ff7f50", salmon: "#fa8072", tomato: "#ff6347",
  crimson: "#dc143c", khaki: "#f0e68c", lavender: "#e6e6fa", plum: "#dda0dd", tan: "#d2b48c",
  chocolate: "#d2691e", darkgray: "#a9a9a9", darkgrey: "#a9a9a9", lightgray: "#d3d3d3", lightgrey: "#d3d3d3",
  dimgray: "#696969", dimgrey: "#696969", whitesmoke: "#f5f5f5", gainsboro: "#dcdcdc", snow: "#fffafa",
  darkblue: "#00008b", darkred: "#8b0000", darkgreen: "#006400", slategray: "#708090", slategrey: "#708090",
  midnightblue: "#191970", royalblue: "#4169e1", steelblue: "#4682b4", skyblue: "#87ceeb", firebrick: "#b22222",
  rebeccapurple: "#663399", transparent: "#00000000",
};

/** Keywords that are valid colour values but cannot be resolved statically. */
export const DYNAMIC_COLOR_KEYWORDS = new Set(["currentcolor", "inherit", "initial", "unset", "revert", "revert-layer", "none"]);

function clamp(n: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, n));
}

function channel(token: string, scale: number): number | null {
  const t = token.trim();
  if (!t) return null;
  if (t === "none") return 0;
  if (t.endsWith("%")) {
    const n = Number(t.slice(0, -1));
    return Number.isFinite(n) ? clamp((n / 100) * scale, 0, scale) : null;
  }
  const n = Number(t);
  return Number.isFinite(n) ? clamp(n, 0, scale) : null;
}

function alphaToken(token: string | undefined): number | null {
  if (token === undefined) return 1;
  const t = token.trim();
  if (t.endsWith("%")) {
    const n = Number(t.slice(0, -1));
    return Number.isFinite(n) ? clamp(n / 100, 0, 1) : null;
  }
  const n = Number(t);
  return Number.isFinite(n) ? clamp(n, 0, 1) : null;
}

/** Splits "r g b / a" and "r, g, b, a" argument lists. */
function splitArgs(inner: string): { parts: string[]; alpha?: string } | null {
  let body = inner.trim();
  let alpha: string | undefined;
  const slash = body.indexOf("/");
  if (slash >= 0) {
    alpha = body.slice(slash + 1).trim();
    body = body.slice(0, slash).trim();
  }
  const parts = body.includes(",") ? body.split(",").map((p) => p.trim()) : body.split(/\s+/);
  if (alpha === undefined && parts.length === 4) alpha = parts.pop();
  if (parts.length !== 3) return null;
  return { parts, alpha };
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const hue = ((h % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = l - c / 2;
  let rgb: [number, number, number];
  if (hue < 60) rgb = [c, x, 0];
  else if (hue < 120) rgb = [x, c, 0];
  else if (hue < 180) rgb = [0, c, x];
  else if (hue < 240) rgb = [0, x, c];
  else if (hue < 300) rgb = [x, 0, c];
  else rgb = [c, 0, x];
  return [(rgb[0] + m) * 255, (rgb[1] + m) * 255, (rgb[2] + m) * 255];
}

/**
 * Parses a literal CSS colour: #rgb, #rgba, #rrggbb, #rrggbbaa, rgb()/rgba(),
 * hsl()/hsla() and common named colours. Returns null for anything else
 * (var(), color-mix(), currentColor…), which callers treat as "cannot resolve".
 */
export function parseColor(input: unknown): RGBA | null {
  if (typeof input !== "string") return null;
  const value = input.trim().toLowerCase();
  if (!value) return null;
  if (NAMED[value]) return parseColor(NAMED[value]);

  const hex = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(value);
  if (hex) {
    let h = hex[1];
    if (h.length <= 4) h = [...h].map((c) => c + c).join("");
    return {
      r: parseInt(h.slice(0, 2), 16),
      g: parseInt(h.slice(2, 4), 16),
      b: parseInt(h.slice(4, 6), 16),
      a: h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1,
    };
  }

  const fn = /^(rgba?|hsla?)\(([^()]*)\)$/.exec(value);
  if (fn) {
    const args = splitArgs(fn[2]);
    if (!args) return null;
    const a = alphaToken(args.alpha);
    if (a === null) return null;
    if (fn[1].startsWith("rgb")) {
      const [r, g, b] = args.parts.map((p) => channel(p, 255));
      if (r === null || g === null || b === null) return null;
      return { r, g, b, a };
    }
    const h = Number(args.parts[0].replace(/deg$/, ""));
    const s = channel(args.parts[1].endsWith("%") ? args.parts[1] : `${args.parts[1]}%`, 1);
    const l = channel(args.parts[2].endsWith("%") ? args.parts[2] : `${args.parts[2]}%`, 1);
    if (!Number.isFinite(h) || s === null || l === null) return null;
    const [r, g, b] = hslToRgb(h, s, l);
    return { r, g, b, a };
  }
  return null;
}

/**
 * Whether a string is plausibly a valid CSS colour value for theme.json — a
 * literal colour, a CSS variable, a colour function or a dynamic keyword.
 * Used to flag typos like "#12345" or "blu", not to fully validate CSS.
 */
export function isPlausibleCssColor(input: unknown): boolean {
  if (typeof input !== "string") return false;
  const value = input.trim().toLowerCase();
  if (!value) return false;
  if (parseColor(value)) return true;
  if (DYNAMIC_COLOR_KEYWORDS.has(value)) return true;
  if (value.startsWith("#")) return false;
  if (/^var\(\s*--[\w-]+/.test(value) || value.startsWith("var:preset|color|")) return true;
  if (/^(color-mix|oklch|oklab|lab|lch|hwb|color|light-dark|rgb|rgba|hsl|hsla)\(/.test(value)) return /\)\s*$/.test(value);
  return false;
}

/** Alpha-composites `top` over an opaque `bottom`. */
export function composite(top: RGBA, bottom: RGBA): RGBA {
  const a = top.a;
  return {
    r: top.r * a + bottom.r * (1 - a),
    g: top.g * a + bottom.g * (1 - a),
    b: top.b * a + bottom.b * (1 - a),
    a: 1,
  };
}

/** WCAG 2.x relative luminance. */
export function relativeLuminance(c: RGBA): number {
  const lin = (v: number) => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
}

/**
 * WCAG contrast ratio between a foreground and background. A translucent
 * background is first composited over `canvas` (white by default) and a
 * translucent foreground over the resulting background, as a browser would.
 */
export function contrastRatio(fg: RGBA, bg: RGBA, canvas: RGBA = { r: 255, g: 255, b: 255, a: 1 }): number {
  const solidBg = bg.a < 1 ? composite(bg, canvas.a < 1 ? composite(canvas, { r: 255, g: 255, b: 255, a: 1 }) : canvas) : bg;
  const solidFg = fg.a < 1 ? composite(fg, solidBg) : fg;
  const l1 = relativeLuminance(solidFg);
  const l2 = relativeLuminance(solidBg);
  const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
  return Math.round(ratio * 100) / 100;
}

export function toHex(c: RGBA): string {
  const h = (n: number) => Math.round(clamp(n, 0, 255)).toString(16).padStart(2, "0");
  return `#${h(c.r)}${h(c.g)}${h(c.b)}${c.a < 1 ? h(c.a * 255) : ""}`;
}

/**
 * Resolves a theme.json / CSS colour reference against a slug → value palette:
 * "var(--wp--preset--color--slug)", "var:preset|color|slug", or a literal.
 * Follows one level of var() fallback. Returns null when it cannot be resolved
 * statically (currentColor, color-mix(), unknown slugs).
 */
export function resolveColorRef(value: unknown, palette: Record<string, string>, depth = 0): RGBA | null {
  if (typeof value !== "string" || depth > 4) return null;
  const v = value.trim();
  const preset = /^var\(\s*--wp--preset--color--([a-z0-9_-]+)\s*(?:,\s*(.+))?\)$/i.exec(v);
  if (preset) {
    const hit = palette[preset[1].toLowerCase()];
    if (hit !== undefined) return resolveColorRef(hit, palette, depth + 1);
    return preset[2] ? resolveColorRef(preset[2], palette, depth + 1) : null;
  }
  const short = /^var:preset\|color\|([a-z0-9_-]+)$/i.exec(v);
  if (short) {
    const hit = palette[short[1].toLowerCase()];
    return hit !== undefined ? resolveColorRef(hit, palette, depth + 1) : null;
  }
  return parseColor(v);
}

/** WCAG thresholds: 4.5:1 for normal text, 3:1 for large text and UI components. */
export const AA_NORMAL = 4.5;
export const AA_LARGE = 3;
