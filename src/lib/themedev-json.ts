/**
 * theme.json analysis: structural diffs, linting and contrast checks. Pure
 * functions over plain JSON, shared by the theme-developer tools and tests.
 */
import {
  AA_LARGE, AA_NORMAL, contrastRatio, isPlausibleCssColor, parseColor, resolveColorRef, toHex, type RGBA,
} from "./themedev-color.js";

type Json = unknown;
const isObj = (v: unknown): v is Record<string, any> => typeof v === "object" && v !== null && !Array.isArray(v);

/* ------------------------------------------------------------------ *
 * JSON paths and diffs
 * ------------------------------------------------------------------ */

/** Appends a key to a JSON path: identifiers dotted, anything else (block names like "core/button") bracket-quoted. */
export function joinPath(base: string, key: string | number): string {
  if (typeof key === "number") return `${base}[${key}]`;
  if (/^[A-Za-z_$][\w$]*$/.test(key)) return base ? `${base}.${key}` : key;
  return `${base}[${JSON.stringify(key)}]`;
}

export interface DiffEntry {
  path: string;
  change: "added" | "changed" | "removed" | "unchanged";
  base?: Json;
  value?: Json;
}

/** Arrays of preset objects (palette, fontSizes…) are keyed by slug so a diff names the colour, not an index. */
function slugKeyed(arr: unknown[]): Map<string, any> | null {
  if (!arr.length || !arr.every((x) => isObj(x) && typeof x.slug === "string")) return null;
  const map = new Map<string, any>();
  for (const x of arr as any[]) {
    if (map.has(x.slug)) return null;
    map.set(x.slug, x);
  }
  return map;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Diffs an override layer against its base. Every leaf the override sets is
 * reported: "added" when the base has nothing there, "changed" when it
 * differs, and — only with includeUnchanged — "unchanged" when the override
 * merely restates the base. With `reportRemoved`, leaves only the base has
 * are reported as "removed" (used when comparing two complete documents).
 */
export function jsonDiff(base: Json, override: Json, options: { reportRemoved?: boolean; includeUnchanged?: boolean; path?: string } = {}): DiffEntry[] {
  const out: DiffEntry[] = [];
  const walk = (b: Json, o: Json, path: string) => {
    if (isObj(o) && isObj(b)) {
      for (const key of Object.keys(o)) walk(b[key], o[key], joinPath(path, key));
      if (options.reportRemoved) for (const key of Object.keys(b)) if (!(key in o)) out.push({ path: joinPath(path, key), change: "removed", base: b[key] });
      return;
    }
    if (isObj(o) && b === undefined) {
      for (const key of Object.keys(o)) walk(undefined, o[key], joinPath(path, key));
      return;
    }
    if (Array.isArray(o) && Array.isArray(b)) {
      const bm = slugKeyed(b);
      const om = slugKeyed(o);
      if (bm && om) {
        for (const [slug, item] of om) walk(bm.get(slug), item, `${path}[slug=${slug}]`);
        if (options.reportRemoved) for (const [slug, item] of bm) if (!om.has(slug)) out.push({ path: `${path}[slug=${slug}]`, change: "removed", base: item });
        return;
      }
    }
    if (o === undefined) return;
    if (b === undefined) out.push({ path, change: "added", value: o });
    else if (!same(b, o)) out.push({ path, change: "changed", base: b, value: o });
    else if (options.includeUnchanged) out.push({ path, change: "unchanged", value: o });
  };
  walk(base, override, options.path ?? "");
  return out;
}

/* ------------------------------------------------------------------ *
 * Palettes
 * ------------------------------------------------------------------ */

/**
 * Flattens a palette into slug → colour. Accepts the raw theme.json form (an
 * array) and the REST merged form ({default, theme, custom}); later origins
 * win, matching how WordPress emits the CSS custom properties.
 */
export function paletteMap(palette: unknown, into: Record<string, string> = {}): Record<string, string> {
  const add = (arr: unknown) => {
    if (!Array.isArray(arr)) return;
    for (const p of arr) if (isObj(p) && typeof p.slug === "string" && typeof p.color === "string") into[p.slug.toLowerCase()] = p.color;
  };
  if (Array.isArray(palette)) add(palette);
  else if (isObj(palette)) for (const origin of ["default", "blocks", "theme", "custom"]) add(palette[origin]);
  return into;
}

/** Palette colours defined as CSS custom properties in a rendered page (`--wp--preset--color--slug: value`). */
export function paletteFromCss(css: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of css.matchAll(/--wp--preset--color--([a-z0-9_-]+)\s*:\s*([^;}]+)[;}]/gi)) out[m[1].toLowerCase()] = m[2].trim();
  return out;
}

export interface VariationSummary {
  index: number;
  kind: "full" | "color" | "typography";
  title: string;
  slug?: string;
  palette: Array<{ slug: string; name?: string; color: string }>;
  font_families: string[];
  font_sizes: Array<{ slug: string; size: string }>;
  root_colors?: { text?: string; background?: string };
  heading_font?: string;
  body_font?: string;
}

/**
 * Core ships three kinds of style variation: complete ones (styles/*.json) and,
 * since 6.6, colour-only and typography-only partials. REST does not say which
 * file a variation came from, so the kind is inferred from what it defines.
 */
export function variationKind(v: any): "full" | "color" | "typography" {
  const settingsKeys = Object.keys(v?.settings ?? {});
  const styleKeys = new Set<string>();
  const collect = (node: any, depth: number) => {
    if (!isObj(node) || depth > 6) return;
    for (const [k, val] of Object.entries(node)) {
      if (["color", "typography", "spacing", "border", "dimensions", "shadow", "filter", "background", "css", "outline"].includes(k)) styleKeys.add(k);
      if (isObj(val)) collect(val, depth + 1);
    }
  };
  collect(v?.styles, 0);
  const onlyIn = (allowed: string[]) =>
    settingsKeys.every((k) => allowed.includes(k)) && [...styleKeys].every((k) => allowed.includes(k));
  if (settingsKeys.length && settingsKeys.every((k) => k === "typography") && onlyIn(["typography"])) return "typography";
  if (settingsKeys.includes("color") && settingsKeys.every((k) => k === "color" || k === "custom") && !styleKeys.has("typography") && !styleKeys.has("spacing")) return "color";
  return "full";
}

function presetList(value: unknown): any[] {
  if (Array.isArray(value)) return value;
  if (isObj(value)) return [...(value.theme ?? []), ...(value.custom ?? [])];
  return [];
}

export function summarizeVariation(v: any, index: number): VariationSummary {
  const settings = v?.settings ?? {};
  const styles = v?.styles ?? {};
  return {
    index,
    kind: variationKind(v),
    title: String(v?.title ?? `Variation ${index}`),
    slug: v?.slug || undefined,
    palette: presetList(settings.color?.palette).filter(isObj).map((p: any) => ({ slug: p.slug, name: p.name, color: p.color })),
    font_families: presetList(settings.typography?.fontFamilies).filter(isObj).map((f: any) => String(f.name ?? f.slug)),
    font_sizes: presetList(settings.typography?.fontSizes).filter(isObj).map((f: any) => ({ slug: f.slug, size: f.size })),
    root_colors: styles.color ? { text: styles.color.text, background: styles.color.background } : undefined,
    body_font: styles.typography?.fontFamily,
    heading_font: styles.elements?.heading?.typography?.fontFamily,
  };
}

/* ------------------------------------------------------------------ *
 * Linting
 * ------------------------------------------------------------------ */

export interface LintIssue {
  path: string;
  rule: string;
  message: string;
}

export interface LintResult {
  errors: LintIssue[];
  warnings: LintIssue[];
}

export interface LintOptions {
  /** Prefix for every reported path, e.g. `variations[2]`. */
  pathPrefix?: string;
  /** Whether this document is expected to carry a `version` (raw files and variations do; REST merged data does not). */
  expectVersion?: boolean;
  /** Template slugs that exist, to check customTemplates against. */
  templateSlugs?: string[];
  /** Template-part slugs that exist, to check templateParts against. */
  templatePartSlugs?: string[];
  /** Palette to resolve colour references with, in addition to the document's own. */
  basePalette?: Record<string, string>;
  /** Skip the contrast checks (e.g. for a partial that defines no styles). */
  skipContrast?: boolean;
}

export const CURRENT_THEME_JSON_VERSION = 3;

/** Settings renamed when theme.json v2 replaced v1's "custom*" booleans. */
const DEPRECATED_SETTINGS: Record<string, string> = {
  "border.customColor": "border.color",
  "border.customRadius": "border.radius",
  "border.customStyle": "border.style",
  "border.customWidth": "border.width",
  "spacing.customMargin": "spacing.margin",
  "spacing.customPadding": "spacing.padding",
  "typography.customFontStyle": "typography.fontStyle",
  "typography.customFontWeight": "typography.fontWeight",
  "typography.customLetterSpacing": "typography.letterSpacing",
  "typography.customLineHeight": "typography.lineHeight",
  "typography.customTextDecorations": "typography.textDecoration",
  "typography.customTextTransforms": "typography.textTransform",
};

/** Block names that core has deprecated and which theme.json styles still sometimes target. */
const DEPRECATED_BLOCKS: Record<string, string> = {
  "core/post-comments": "core/comments",
  "core/text-columns": "core/columns",
};

const TOP_LEVEL_KEYS = new Set(["$schema", "version", "title", "slug", "description", "settings", "styles", "customTemplates", "templateParts", "patterns", "blockTypes"]);

/** Preset collections: [settings path, value field]. */
const PRESET_COLLECTIONS: Array<[string, string, string]> = [
  ["color", "palette", "color"],
  ["color", "gradients", "gradient"],
  ["color", "duotone", "colors"],
  ["typography", "fontSizes", "size"],
  ["typography", "fontFamilies", "fontFamily"],
  ["spacing", "spacingSizes", "size"],
  ["shadow", "presets", "shadow"],
];

const TEMPLATE_PART_AREAS = new Set(["header", "footer", "uncategorized", "sidebar", "navigation-overlay"]);

function lintPresets(settings: any, path: string, add: (kind: "errors" | "warnings", issue: LintIssue) => void) {
  if (!isObj(settings)) return;
  for (const [section, collection, valueField] of PRESET_COLLECTIONS) {
    const raw = settings[section]?.[collection];
    if (raw === undefined) continue;
    const basePath = joinPath(joinPath(path, section), collection);
    // Raw theme.json uses an array; REST merged data is keyed by origin.
    const groups: Array<[string, unknown]> = Array.isArray(raw)
      ? [[basePath, raw]]
      : isObj(raw) ? Object.entries(raw).map(([origin, list]) => [joinPath(basePath, origin), list] as [string, unknown]) : [];
    if (!groups.length) {
      add("errors", { path: basePath, rule: "preset-shape", message: `${collection} must be an array of preset objects.` });
      continue;
    }
    for (const [groupPath, list] of groups) {
      if (!Array.isArray(list)) {
        add("errors", { path: groupPath, rule: "preset-shape", message: `${collection} must be an array of preset objects.` });
        continue;
      }
      const seen = new Map<string, number>();
      list.forEach((item, i) => {
        const itemPath = `${groupPath}[${i}]`;
        if (!isObj(item)) {
          add("errors", { path: itemPath, rule: "preset-shape", message: "Preset entries must be objects." });
          return;
        }
        if (typeof item.slug !== "string" || !item.slug) {
          add("errors", { path: itemPath, rule: "preset-missing-slug", message: `This ${collection} entry has no slug, so WordPress cannot generate its CSS custom property or class.` });
        } else {
          if (!/^[a-z0-9-]+$/.test(item.slug)) {
            add("warnings", { path: joinPath(itemPath, "slug"), rule: "preset-slug-format", message: `Slug "${item.slug}" contains characters other than lowercase letters, digits and hyphens; WordPress kebab-cases it, so the generated class/variable will not match the slug you wrote.` });
          }
          if (seen.has(item.slug)) {
            add("errors", { path: joinPath(itemPath, "slug"), rule: "duplicate-slug", message: `Duplicate ${collection} slug "${item.slug}" (first defined at index ${seen.get(item.slug)}). The later entry silently overwrites the earlier CSS variable.` });
          } else seen.set(item.slug, i);
        }
        if (collection !== "fontFamilies" && collection !== "spacingSizes" && typeof item.name !== "string") {
          add("warnings", { path: itemPath, rule: "preset-missing-name", message: `This ${collection} entry has no name, so the editor shows a blank label.` });
        }
        const value = item[valueField];
        if (value === undefined || value === "") {
          add("errors", { path: joinPath(itemPath, valueField), rule: "preset-missing-value", message: `This ${collection} entry has no "${valueField}".` });
        } else if (collection === "palette" && !isPlausibleCssColor(value)) {
          add("errors", { path: joinPath(itemPath, "color"), rule: "invalid-color", message: `"${String(value)}" is not a valid CSS colour.` });
        } else if (collection === "duotone") {
          if (!Array.isArray(value) || value.length < 2) add("errors", { path: joinPath(itemPath, "colors"), rule: "invalid-duotone", message: "A duotone needs an array of at least two colours." });
          else value.forEach((c: unknown, ci: number) => {
            if (!parseColor(c)) add("errors", { path: `${joinPath(itemPath, "colors")}[${ci}]`, rule: "invalid-color", message: `Duotone colour "${String(c)}" must be a literal colour (hex/rgb/hsl) — filters cannot use CSS variables.` });
          });
        }
        if (collection === "fontFamilies") lintFontFamily(item, itemPath, add);
      });
    }
  }
}

function lintFontFamily(item: any, itemPath: string, add: (kind: "errors" | "warnings", issue: LintIssue) => void) {
  if (item.fontFace === undefined) return;
  if (!Array.isArray(item.fontFace)) {
    add("errors", { path: joinPath(itemPath, "fontFace"), rule: "font-face-shape", message: "fontFace must be an array of @font-face definitions." });
    return;
  }
  item.fontFace.forEach((face: any, fi: number) => {
    const facePath = `${joinPath(itemPath, "fontFace")}[${fi}]`;
    if (!isObj(face)) {
      add("errors", { path: facePath, rule: "font-face-shape", message: "Each fontFace entry must be an object." });
      return;
    }
    const src = face.src;
    const list = Array.isArray(src) ? src : typeof src === "string" ? [src] : [];
    if (!list.length || list.some((s) => typeof s !== "string" || !s.trim())) {
      add("errors", { path: joinPath(facePath, "src"), rule: "font-face-missing-src", message: `fontFace for "${item.name ?? item.slug}" has no src, so no @font-face rule is emitted and the browser falls back to another font.` });
    } else {
      for (const s of list as string[]) {
        if (/^\.?\//.test(s) || (!/^(file:\.\/|https?:|data:|\/\/)/.test(s) && !s.startsWith("file:"))) {
          add("warnings", { path: joinPath(facePath, "src"), rule: "font-face-src-format", message: `Font src "${s}" should be "file:./assets/fonts/…" (relative to the theme) or an absolute URL; a bare path resolves against the page URL and 404s.` });
        } else if (s.startsWith("file:") && !s.startsWith("file:./")) {
          add("warnings", { path: joinPath(facePath, "src"), rule: "font-face-src-format", message: `Font src "${s}" should start with "file:./".` });
        }
      }
    }
    if (!face.fontFamily) add("warnings", { path: facePath, rule: "font-face-missing-family", message: "fontFace entry has no fontFamily, so the @font-face rule has no family name to match." });
  });
}

function lintDeprecatedSettings(settings: any, path: string, add: (kind: "errors" | "warnings", issue: LintIssue) => void) {
  if (!isObj(settings)) return;
  for (const [old, replacement] of Object.entries(DEPRECATED_SETTINGS)) {
    const [section, key] = old.split(".");
    if (isObj(settings[section]) && key in settings[section]) {
      add("warnings", { path: joinPath(joinPath(path, section), key), rule: "deprecated-key", message: `settings.${old} is a theme.json v1 key; use settings.${replacement} instead.` });
    }
  }
  if ("defaults" in settings) add("warnings", { path: joinPath(path, "defaults"), rule: "deprecated-key", message: "settings.defaults is a pre-release Gutenberg key and is ignored; move its contents to the top level of settings." });
}

/** Parses JSON text, reporting the error location instead of throwing. */
export function parseJsonText(text: string): { value?: any; error?: string } {
  try {
    return { value: JSON.parse(text) };
  } catch (e: any) {
    const pos = /position (\d+)/.exec(String(e?.message))?.[1];
    if (pos && !/line \d+/i.test(String(e?.message))) {
      const before = text.slice(0, Number(pos));
      const line = before.split("\n").length;
      const col = Number(pos) - before.lastIndexOf("\n");
      return { error: `${e.message} (line ${line}, column ${col})` };
    }
    return { error: String(e?.message ?? e) };
  }
}

export function lintThemeJson(doc: any, options: LintOptions = {}): LintResult {
  const result: LintResult = { errors: [], warnings: [] };
  const prefix = options.pathPrefix ?? "";
  const add = (kind: "errors" | "warnings", issue: LintIssue) => result[kind].push(issue);

  if (!isObj(doc)) {
    add("errors", { path: prefix || "(root)", rule: "not-an-object", message: "theme.json must be a JSON object." });
    return result;
  }

  if (options.expectVersion) {
    const v = doc.version;
    if (v === undefined) add("errors", { path: joinPath(prefix, "version"), rule: "version-missing", message: `No "version" — WordPress treats the file as version 1 and migrates it, which changes defaults. Add "version": ${CURRENT_THEME_JSON_VERSION}.` });
    else if (!Number.isInteger(v)) add("errors", { path: joinPath(prefix, "version"), rule: "version-invalid", message: `"version" must be an integer, got ${JSON.stringify(v)}.` });
    else if (v < 2) add("warnings", { path: joinPath(prefix, "version"), rule: "version-outdated", message: `theme.json version ${v} is deprecated; migrate to version ${CURRENT_THEME_JSON_VERSION}.` });
    else if (v < CURRENT_THEME_JSON_VERSION) add("warnings", { path: joinPath(prefix, "version"), rule: "version-outdated", message: `Version ${v} still works, but version ${CURRENT_THEME_JSON_VERSION} (WordPress 6.6+) is current. Note v3 changes how defaultFontSizes/defaultSpacingSizes interact with theme presets.` });
    else if (v > CURRENT_THEME_JSON_VERSION) add("warnings", { path: joinPath(prefix, "version"), rule: "version-unknown", message: `Version ${v} is newer than this linter knows (${CURRENT_THEME_JSON_VERSION}); some checks may be out of date.` });
  }

  for (const key of Object.keys(doc)) {
    if (!TOP_LEVEL_KEYS.has(key)) add("warnings", { path: joinPath(prefix, key), rule: "unknown-top-level-key", message: `"${key}" is not a recognised top-level theme.json key and is ignored.` });
  }

  const settings = doc.settings;
  const settingsPath = joinPath(prefix, "settings");
  lintPresets(settings, settingsPath, add);
  lintDeprecatedSettings(settings, settingsPath, add);
  if (isObj(settings?.blocks)) {
    for (const [block, blockSettings] of Object.entries<any>(settings.blocks)) {
      const blockPath = joinPath(joinPath(settingsPath, "blocks"), block);
      lintPresets(blockSettings, blockPath, add);
      lintDeprecatedSettings(blockSettings, blockPath, add);
      if (DEPRECATED_BLOCKS[block]) add("warnings", { path: blockPath, rule: "deprecated-block", message: `${block} is deprecated; target ${DEPRECATED_BLOCKS[block]} instead.` });
    }
  }

  const styles = doc.styles;
  if (isObj(styles?.blocks)) {
    for (const block of Object.keys(styles.blocks)) {
      if (DEPRECATED_BLOCKS[block]) add("warnings", { path: joinPath(joinPath(joinPath(prefix, "styles"), "blocks"), block), rule: "deprecated-block", message: `${block} is deprecated; style ${DEPRECATED_BLOCKS[block]} instead.` });
      if (!block.includes("/")) add("warnings", { path: joinPath(joinPath(joinPath(prefix, "styles"), "blocks"), block), rule: "block-name", message: `"${block}" is not a namespaced block name (expected e.g. "core/${block}").` });
    }
  }
  lintStyleColors(styles, joinPath(prefix, "styles"), add);

  if (doc.customTemplates !== undefined) {
    if (!Array.isArray(doc.customTemplates)) add("errors", { path: joinPath(prefix, "customTemplates"), rule: "custom-templates-shape", message: "customTemplates must be an array." });
    else doc.customTemplates.forEach((t: any, i: number) => {
      const p = `${joinPath(prefix, "customTemplates")}[${i}]`;
      if (!isObj(t) || typeof t.name !== "string" || !t.name) return add("errors", { path: p, rule: "custom-template-name", message: "Each customTemplates entry needs a name matching a file in templates/." });
      if (options.templateSlugs && !options.templateSlugs.includes(t.name)) {
        add("errors", { path: joinPath(p, "name"), rule: "custom-template-missing", message: `customTemplates names "${t.name}", but the theme has no templates/${t.name}.html, so it never appears in the template picker.` });
      }
      if (!t.title) add("warnings", { path: p, rule: "custom-template-title", message: `Custom template "${t.name}" has no title; the editor will show its slug.` });
    });
  }
  if (doc.templateParts !== undefined) {
    if (!Array.isArray(doc.templateParts)) add("errors", { path: joinPath(prefix, "templateParts"), rule: "template-parts-shape", message: "templateParts must be an array." });
    else doc.templateParts.forEach((t: any, i: number) => {
      const p = `${joinPath(prefix, "templateParts")}[${i}]`;
      if (!isObj(t) || typeof t.name !== "string" || !t.name) return add("errors", { path: p, rule: "template-part-name", message: "Each templateParts entry needs a name matching a file in parts/." });
      if (options.templatePartSlugs && !options.templatePartSlugs.includes(t.name)) {
        add("errors", { path: joinPath(p, "name"), rule: "template-part-missing", message: `templateParts names "${t.name}", but the theme has no parts/${t.name}.html.` });
      }
      if (t.area !== undefined && !TEMPLATE_PART_AREAS.has(String(t.area))) {
        add("warnings", { path: joinPath(p, "area"), rule: "template-part-area", message: `Area "${t.area}" is not a core area (header, footer, uncategorized); unless a plugin registers it, the part is treated as uncategorized.` });
      }
    });
  }

  if (!options.skipContrast) {
    const palette = paletteMap(settings?.color?.palette, { ...(options.basePalette ?? {}) });
    for (const issue of contrastIssues(styles, palette, prefix)) add(issue.ratio < AA_LARGE ? "errors" : "warnings", issue);
  }
  return result;
}

/** Flags literal colour typos in styles (e.g. "#12345"), ignoring variables and dynamic keywords. */
function lintStyleColors(styles: any, path: string, add: (kind: "errors" | "warnings", issue: LintIssue) => void) {
  const walk = (node: any, p: string, depth: number) => {
    if (!isObj(node) || depth > 10) return;
    for (const [k, v] of Object.entries(node)) {
      const childPath = joinPath(p, k);
      if (k === "color" && isObj(v)) {
        for (const [prop, value] of Object.entries(v)) {
          if (!["text", "background"].includes(prop) || typeof value !== "string") continue;
          if (!isPlausibleCssColor(value) && !/gradient\(/.test(value)) {
            add("warnings", { path: joinPath(childPath, prop), rule: "invalid-color", message: `"${value}" does not look like a valid CSS colour or preset reference.` });
          }
        }
      } else if (isObj(v)) walk(v, childPath, depth + 1);
    }
  };
  walk(styles, path, 0);
}

/* ------------------------------------------------------------------ *
 * Contrast of the colour pairs styles actually use
 * ------------------------------------------------------------------ */

export interface ContrastIssue extends LintIssue {
  ratio: number;
  foreground: string;
  background: string;
  required: number;
}

/**
 * Walks styles for every place a text colour meets a background: the root,
 * elements (link, button, headings, caption…), and each block and block style
 * variation, inheriting the nearest defined background. Pairs that cannot be
 * resolved statically (currentColor, color-mix, gradients) are skipped.
 */
export function contrastIssues(styles: any, palette: Record<string, string>, prefix = ""): ContrastIssue[] {
  const issues: ContrastIssue[] = [];
  if (!isObj(styles)) return issues;
  const white: RGBA = { r: 255, g: 255, b: 255, a: 1 };
  const seen = new Set<string>();

  const check = (fgRaw: unknown, bgRaw: unknown, inheritedBg: RGBA, path: string, large: boolean) => {
    const fg = resolveColorRef(fgRaw, palette);
    const ownBg = bgRaw !== undefined ? resolveColorRef(bgRaw, palette) : null;
    if (bgRaw !== undefined && !ownBg) return; // an unresolvable background makes any verdict a guess
    const bg = ownBg ?? inheritedBg;
    if (!fg) return;
    const ratio = contrastRatio(fg, bg, inheritedBg);
    const required = large ? AA_LARGE : AA_NORMAL;
    if (ratio >= required) return;
    const key = `${path}|${ratio}`;
    if (seen.has(key)) return;
    seen.add(key);
    issues.push({
      path,
      rule: "color-contrast",
      ratio,
      required,
      foreground: `${String(fgRaw)}${typeof fgRaw === "string" && !fgRaw.startsWith("#") ? ` (${toHex(fg)})` : ""}`,
      background: `${String(bgRaw ?? "(inherited)")} (${toHex(bg)})`,
      message: `Text ${toHex(fg)} on ${toHex(bg)} has contrast ${ratio}:1, below the WCAG AA minimum of ${required}:1${large ? " for large text" : ""}.`,
    });
  };

  const NON_TEXT_BLOCKS = new Set(["core/separator", "core/spacer", "core/image", "core/cover-image"]);
  const LARGE_ELEMENTS = new Set(["h1", "h2", "h3", "heading"]);

  const visit = (node: any, path: string, inheritedBg: RGBA, inheritedFg: unknown, large: boolean, depth: number) => {
    if (!isObj(node) || depth > 6) return;
    const color = isObj(node.color) ? node.color : {};
    const bgResolved = color.background !== undefined ? resolveColorRef(color.background, palette) : null;
    const bgHere = bgResolved ? (bgResolved.a < 1 ? contrastBase(bgResolved, inheritedBg) : bgResolved) : inheritedBg;
    const fgHere = color.text ?? inheritedFg;
    if (color.text !== undefined || color.background !== undefined) {
      check(fgHere, color.background, inheritedBg, joinPath(path, "color"), large);
    }
    if (isObj(node.elements)) {
      for (const [el, def] of Object.entries<any>(node.elements)) {
        const elPath = joinPath(joinPath(path, "elements"), el);
        visit(def, elPath, bgHere, el === "link" || el === "button" ? undefined : fgHere, large || LARGE_ELEMENTS.has(el), depth + 1);
        // States such as :hover carry their own colours.
        if (isObj(def)) for (const [state, stateDef] of Object.entries<any>(def)) {
          if (!state.startsWith(":") || !isObj(stateDef?.color)) continue;
          const stateBg = isObj(def.color) && def.color.background !== undefined ? resolveColorRef(def.color.background, palette) ?? bgHere : bgHere;
          check(stateDef.color.text ?? def.color?.text, stateDef.color.background, stateBg, joinPath(joinPath(elPath, state), "color"), large || LARGE_ELEMENTS.has(el));
        }
      }
    }
    if (isObj(node.blocks)) {
      for (const [block, def] of Object.entries<any>(node.blocks)) {
        // A separator's or spacer's "text" colour paints a line, not text.
        if (NON_TEXT_BLOCKS.has(block)) continue;
        visit(def, joinPath(joinPath(path, "blocks"), block), bgHere, fgHere, large, depth + 1);
      }
    }
    if (isObj(node.variations)) {
      for (const [name, def] of Object.entries<any>(node.variations)) {
        visit(def, joinPath(joinPath(path, "variations"), name), bgHere, fgHere, large, depth + 1);
      }
    }
  };

  const rootBgRaw = styles.color?.background;
  const rootBg = (rootBgRaw !== undefined && resolveColorRef(rootBgRaw, palette)) || white;
  const solidRoot = rootBg.a < 1 ? contrastBase(rootBg, white) : rootBg;
  visit(styles, joinPath(prefix, "styles"), solidRoot, undefined, false, 0);
  return issues;
}

function contrastBase(top: RGBA, bottom: RGBA): RGBA {
  const a = top.a;
  return { r: top.r * a + bottom.r * (1 - a), g: top.g * a + bottom.g * (1 - a), b: top.b * a + bottom.b * (1 - a), a: 1 };
}
