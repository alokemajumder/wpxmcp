/**
 * A small, forgiving HTML tokenizer and tree builder plus deterministic
 * accessibility checks. No dependencies and no DOM — it runs on Workers.
 *
 * It is not a spec-complete HTML5 parser. It is built to be robust on real
 * WordPress output: raw-text elements (script/style/textarea) are skipped
 * whole, void elements never take children, unmatched end tags are ignored
 * and unclosed elements are closed by their nearest matching ancestor's end.
 */
import { AA_LARGE, AA_NORMAL, contrastRatio, resolveColorRef, toHex, type RGBA } from "./themedev-color.js";

export interface HtmlElement {
  type: "element";
  tag: string;
  attrs: Record<string, string>;
  children: HtmlNode[];
  parent: HtmlElement | null;
  /** Offset of the start tag in the source. */
  start: number;
  /** Raw start tag text, for snippets. */
  raw: string;
}

export interface HtmlText {
  type: "text";
  text: string;
  parent: HtmlElement | null;
}

export type HtmlNode = HtmlElement | HtmlText;

const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
const RAW_TEXT = new Set(["script", "style", "textarea", "title", "xmp", "noscript", "template"]);
/** Elements whose start implicitly closes an open element of the listed kinds. */
const IMPLIED_END: Record<string, string[]> = {
  p: ["p"], li: ["li"], dt: ["dt", "dd"], dd: ["dt", "dd"], option: ["option"], tr: ["tr", "td", "th"], td: ["td", "th"], th: ["td", "th"],
  div: ["p"], ul: ["p"], ol: ["p"], section: ["p"], article: ["p"], header: ["p"], footer: ["p"], h1: ["p"], h2: ["p"], h3: ["p"], h4: ["p"], h5: ["p"], h6: ["p"], table: ["p"], form: ["p"], figure: ["p"], blockquote: ["p"], nav: ["p"], main: ["p"], aside: ["p"],
};

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", hellip: "…", ndash: "–", mdash: "—", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", raquo: "»", laquo: "«", copy: "©" };

export function decodeHtmlEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, body: string) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[body.toLowerCase()] ?? m;
  });
}

function parseAttributes(src: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([^\s"'<>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  for (const m of src.matchAll(re)) {
    const name = m[1].toLowerCase();
    if (name in attrs) continue; // the first occurrence wins, as in browsers
    attrs[name] = decodeHtmlEntities(m[2] ?? m[3] ?? m[4] ?? "");
  }
  return attrs;
}

export interface ParsedDocument {
  root: HtmlElement;
  elements: HtmlElement[];
  /** Concatenated contents of every <style> element, for reading CSS custom properties. */
  css: string;
  title: string | null;
}

export function parseHtml(html: string): ParsedDocument {
  const root: HtmlElement = { type: "element", tag: "#document", attrs: {}, children: [], parent: null, start: 0, raw: "" };
  const elements: HtmlElement[] = [];
  const stack: HtmlElement[] = [root];
  let css = "";
  let title: string | null = null;
  const top = () => stack[stack.length - 1];
  const len = html.length;
  const lower = html.toLowerCase();
  let i = 0;

  const pushText = (text: string) => {
    if (!text) return;
    const parent = top();
    parent.children.push({ type: "text", text: decodeHtmlEntities(text), parent });
  };

  while (i < len) {
    const lt = html.indexOf("<", i);
    if (lt === -1) {
      pushText(html.slice(i));
      break;
    }
    if (lt > i) pushText(html.slice(i, lt));
    i = lt;

    if (html.startsWith("<!--", i)) {
      const end = html.indexOf("-->", i + 4);
      i = end === -1 ? len : end + 3;
      continue;
    }
    if (html[i + 1] === "!" || html[i + 1] === "?") {
      const end = html.indexOf(">", i + 2);
      i = end === -1 ? len : end + 1;
      continue;
    }

    const isEnd = html[i + 1] === "/";
    const nameMatch = /^[a-zA-Z][a-zA-Z0-9:-]*/.exec(html.slice(i + (isEnd ? 2 : 1), i + (isEnd ? 2 : 1) + 64));
    if (!nameMatch) {
      pushText("<");
      i++;
      continue;
    }
    const tag = nameMatch[0].toLowerCase();

    // Find the end of the tag, respecting quoted attribute values that may contain ">".
    let j = i + (isEnd ? 2 : 1) + nameMatch[0].length;
    let quote: string | null = null;
    for (; j < len; j++) {
      const ch = html[j];
      if (quote) {
        if (ch === quote) quote = null;
      } else if (ch === '"' || ch === "'") {
        // Only a quote directly after "=" (optionally spaced) opens a value.
        if (/=\s*$/.test(html.slice(Math.max(i, j - 8), j))) quote = ch;
      } else if (ch === ">") break;
    }
    const tagEnd = Math.min(j, len);
    const raw = html.slice(i, tagEnd + 1);
    i = tagEnd + 1;

    if (isEnd) {
      for (let k = stack.length - 1; k > 0; k--) {
        if (stack[k].tag === tag) {
          stack.length = k;
          break;
        }
      }
      continue;
    }

    const attrSrc = raw.slice(1 + nameMatch[0].length).replace(/\/?>$/, "");
    const implied = IMPLIED_END[tag];
    if (implied) {
      // Close an implicitly-ended sibling, but never past a container boundary.
      for (let k = stack.length - 1; k > 0; k--) {
        const t = stack[k].tag;
        if (implied.includes(t)) {
          stack.length = k;
          break;
        }
        if (["div", "ul", "ol", "table", "section", "article", "body", "form", "dl", "select", "tbody", "thead"].includes(t)) break;
      }
    }
    const parent = top();
    const el: HtmlElement = { type: "element", tag, attrs: parseAttributes(attrSrc), children: [], parent, start: raw === "" ? i : i - raw.length, raw };
    parent.children.push(el);
    elements.push(el);

    if (RAW_TEXT.has(tag)) {
      const close = lower.indexOf(`</${tag}`, i);
      const content = html.slice(i, close === -1 ? len : close);
      if (tag === "style") css += content + "\n";
      if (tag === "textarea" || tag === "title") el.children.push({ type: "text", text: decodeHtmlEntities(content), parent: el });
      if (tag === "title" && title === null && !stack.some((s) => s.tag === "svg")) title = decodeHtmlEntities(content).trim();
      if (close === -1) i = len;
      else {
        const gt = html.indexOf(">", close);
        i = gt === -1 ? len : gt + 1;
      }
      continue;
    }
    // "<div/>" is not self-closing in HTML, but "<path/>" inside SVG is.
    const foreign = tag === "svg" || tag === "math" || stack.some((s) => s.tag === "svg" || s.tag === "math");
    if (!VOID.has(tag) && !(foreign && raw.endsWith("/>"))) stack.push(el);
  }
  return { root, elements, css, title };
}

/* ------------------------------------------------------------------ *
 * Tree helpers
 * ------------------------------------------------------------------ */

function isHidden(el: HtmlElement | null): boolean {
  for (let n = el; n; n = n.parent) {
    if ("hidden" in n.attrs || n.attrs["aria-hidden"] === "true") return true;
    if (/display\s*:\s*none|visibility\s*:\s*hidden/i.test(n.attrs.style ?? "")) return true;
    if (n.tag === "input" && n.attrs.type?.toLowerCase() === "hidden") return true;
  }
  return false;
}

function classes(el: HtmlElement): string[] {
  return (el.attrs.class ?? "").split(/\s+/).filter(Boolean);
}

/** Text content, including img alt text, skipping aria-hidden subtrees — an approximation of accessible name from content. */
export function textContent(el: HtmlElement, includeAlt = true, skip?: (node: HtmlElement) => boolean): string {
  let out = "";
  const walk = (node: HtmlNode) => {
    if (node.type === "text") {
      out += node.text;
      return;
    }
    if (node.attrs["aria-hidden"] === "true" || "hidden" in node.attrs) return;
    if (skip && node !== el && skip(node)) return;
    if (includeAlt && (node.tag === "img" || node.tag === "area" || (node.tag === "input" && node.attrs.type === "image"))) out += ` ${node.attrs.alt ?? ""} `;
    if (node.tag === "svg") {
      const t = node.children.find((c): c is HtmlElement => c.type === "element" && c.tag === "title");
      if (t) out += ` ${textContent(t)} `;
      else if (node.attrs["aria-label"]) out += ` ${node.attrs["aria-label"]} `;
      return;
    }
    if (node.attrs["aria-label"] && node !== el) {
      out += ` ${node.attrs["aria-label"]} `;
      return;
    }
    for (const c of node.children) walk(c);
  };
  walk(el);
  return out.replace(/\s+/g, " ").trim();
}

function accessibleName(el: HtmlElement, byId: Map<string, HtmlElement>): string {
  const labelledby = el.attrs["aria-labelledby"];
  if (labelledby) {
    const text = labelledby.split(/\s+/).map((id) => byId.get(id)).filter(Boolean).map((n) => textContent(n!)).join(" ").trim();
    if (text) return text;
  }
  if (el.attrs["aria-label"]?.trim()) return el.attrs["aria-label"].trim();
  const content = textContent(el);
  if (content) return content;
  return (el.attrs.title ?? "").trim();
}

export function snippet(el: HtmlElement, max = 160): string {
  const s = el.raw.replace(/\s+/g, " ");
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/* ------------------------------------------------------------------ *
 * Checks
 * ------------------------------------------------------------------ */

export type Severity = "critical" | "serious" | "moderate" | "minor";

export interface A11yIssue {
  rule: string;
  wcag: string;
  severity: Severity;
  snippet: string;
  message: string;
  fix: string;
}

export interface A11yOptions {
  /** slug → colour for resolving has-{slug}-color classes, used when the page's own CSS does not define the preset. */
  palette?: Record<string, string>;
  /** Root text and background colours (theme.json styles.color), as fallbacks. */
  rootText?: string;
  rootBackground?: string;
  /** Only run these rule ids. */
  rules?: string[];
}

export const A11Y_RULES = [
  "html-lang", "document-title", "single-h1", "heading-order", "image-alt", "link-name", "button-name",
  "link-text-generic", "form-label", "duplicate-id", "frame-title", "media-autoplay", "meta-viewport", "color-contrast",
] as const;

const GENERIC_LINK_TEXT = new Set([
  "click here", "click", "here", "read more", "more", "learn more", "link", "this", "this link", "continue",
  "continue reading", "details", "more info", "more information", "go", "info", "see more", "view more", "find out more",
]);

export interface A11yReport {
  issues: A11yIssue[];
  stats: {
    elements: number;
    images: number;
    decorative_images: number;
    links: number;
    headings: Array<{ level: number; text: string }>;
    contrast_pairs_checked: number;
  };
}

export function checkAccessibility(html: string, options: A11yOptions = {}): A11yReport {
  const doc = parseHtml(html);
  const issues: A11yIssue[] = [];
  const enabled = (rule: string) => !options.rules?.length || options.rules.includes(rule);
  const push = (rule: string, wcag: string, severity: Severity, el: HtmlElement | null, message: string, fix: string) => {
    if (enabled(rule)) issues.push({ rule, wcag, severity, snippet: el ? snippet(el) : "", message, fix });
  };

  const byId = new Map<string, HtmlElement>();
  const idCounts = new Map<string, HtmlElement[]>();
  for (const el of doc.elements) {
    const id = el.attrs.id;
    if (id === undefined || id === "") continue;
    if (!byId.has(id)) byId.set(id, el);
    idCounts.set(id, [...(idCounts.get(id) ?? []), el]);
  }

  // html lang
  const htmlEl = doc.elements.find((e) => e.tag === "html");
  if (!htmlEl || !htmlEl.attrs.lang?.trim()) {
    push("html-lang", "3.1.1", "serious", htmlEl ?? null, "The <html> element has no lang attribute, so screen readers guess the pronunciation language.", "Add lang to <html>, e.g. <html lang=\"en-US\">. WordPress does this via language_attributes() in header.php for classic themes.");
  }

  if (!doc.title) {
    push("document-title", "2.4.2", "serious", null, "The page has no <title>.", "Block themes get one from add_theme_support('title-tag') (automatic); classic themes must call wp_head() and declare title-tag support.");
  }

  // headings
  const headings = doc.elements
    .filter((e) => /^h[1-6]$/.test(e.tag) && !isHidden(e))
    .map((e) => ({ el: e, level: Number(e.tag[1]), text: textContent(e).slice(0, 120) }));
  const h1s = headings.filter((h) => h.level === 1);
  if (h1s.length === 0) {
    push("single-h1", "1.3.1", "moderate", null, "The page has no <h1>.", "Give the page one h1 describing its main content — in a block theme, usually the Post Title or Query Title block set to level 1 in the template.");
  } else if (h1s.length > 1) {
    for (const h of h1s.slice(1)) {
      push("single-h1", "1.3.1", "moderate", h.el, `The page has ${h1s.length} <h1> elements ("${h1s.map((x) => x.text).slice(0, 3).join('", "')}").`, "Keep one h1 per page; demote the site title or secondary headings to h2 or a paragraph (in a block theme, change the Site Title block's level in the header part).");
    }
  }
  let prev = 0;
  for (const h of headings) {
    if (prev && h.level > prev + 1) {
      push("heading-order", "1.3.1", "moderate", h.el, `Heading level jumps from h${prev} to h${h.level} ("${h.text}").`, `Use h${prev + 1} here, or restyle it with a font-size preset instead of picking a heading level for its looks.`);
    }
    prev = h.level;
  }

  // images
  let images = 0;
  let decorative = 0;
  for (const el of doc.elements) {
    if (el.tag !== "img" || isHidden(el)) continue;
    images++;
    const role = el.attrs.role;
    if (!("alt" in el.attrs)) {
      if (role === "presentation" || role === "none") { decorative++; continue; }
      if (el.attrs["aria-label"] || el.attrs["aria-labelledby"]) continue;
      push("image-alt", "1.1.1", "critical", el, `Image ${el.attrs.src ? `"${el.attrs.src.split("/").pop()}" ` : ""}has no alt attribute, so screen readers announce its file name.`, "Add alt text describing the image in the media library (or the Image block's Alternative text); use alt=\"\" only if it is purely decorative.");
    } else if (el.attrs.alt.trim() === "") decorative++;
  }
  for (const el of doc.elements) {
    if (el.tag === "input" && el.attrs.type?.toLowerCase() === "image" && !el.attrs.alt?.trim() && !isHidden(el)) {
      push("image-alt", "1.1.1", "critical", el, "An image button has no alt text.", "Add alt describing the button's action.");
    }
    if (el.tag === "area" && el.attrs.href !== undefined && !el.attrs.alt?.trim() && !isHidden(el)) {
      push("image-alt", "1.1.1", "serious", el, "An image-map area has no alt text.", "Add alt to each <area>.");
    }
  }

  // links and buttons
  let links = 0;
  for (const el of doc.elements) {
    if (isHidden(el)) continue;
    const role = el.attrs.role;
    const isLink = (el.tag === "a" && el.attrs.href !== undefined) || role === "link";
    const inputType = el.attrs.type?.toLowerCase();
    const isButton = el.tag === "button" || role === "button" || (el.tag === "input" && ["button", "submit", "reset"].includes(inputType ?? ""));
    if (!isLink && !isButton) continue;
    if (el.attrs.tabindex === "-1" && el.attrs.href === undefined && isLink) continue;
    let name = accessibleName(el, byId);
    if (el.tag === "input") name = name || el.attrs.value?.trim() || (inputType === "submit" || inputType === "reset" ? inputType : "");
    if (isLink) {
      links++;
      if (!name) {
        push("link-name", "2.4.4, 4.1.2", "serious", el, `A link${el.attrs.href ? ` to "${el.attrs.href}"` : ""} has no accessible name — screen readers read out the URL or nothing.`, "Give it visible text, or an aria-label when it wraps only an icon; for an image link, give the image alt text describing the destination.");
      } else if (GENERIC_LINK_TEXT.has(name.toLowerCase().replace(/[.…:!»›→\s]+$/u, "").trim())) {
        push("link-text-generic", "2.4.4", "moderate", el, `Link text "${name}" does not say where it goes, which is meaningless when links are listed out of context.`, "Make the text specific (\"Read more about pricing\"), or add visually hidden text / an aria-label that includes the target — core's Read More block accepts screen-reader text for this.");
      }
    } else if (!name) {
      push("button-name", "4.1.2", "critical", el, "A button has no accessible name.", "Add text inside the button, or aria-label for an icon-only button (e.g. the navigation's open/close toggles).");
    }
  }

  // form labels
  const labelFor = new Set(doc.elements.filter((e) => e.tag === "label" && e.attrs.for).map((e) => e.attrs.for));
  for (const el of doc.elements) {
    if (!["input", "select", "textarea"].includes(el.tag) || isHidden(el)) continue;
    const type = (el.attrs.type ?? "text").toLowerCase();
    if (el.tag === "input" && ["hidden", "submit", "button", "reset", "image"].includes(type)) continue;
    const hasLabel =
      (el.attrs.id && labelFor.has(el.attrs.id) && byId.get(el.attrs.id) === el) ||
      el.attrs["aria-label"]?.trim() ||
      (el.attrs["aria-labelledby"] && el.attrs["aria-labelledby"].split(/\s+/).some((id) => byId.has(id))) ||
      el.attrs.title?.trim() ||
      (() => { for (let p = el.parent; p; p = p.parent) if (p.tag === "label") return textContent(p, true).length > 0; return false; })();
    if (!hasLabel) {
      push("form-label", "1.3.1, 4.1.2", "serious", el, `A ${el.tag === "input" ? `${type} input` : el.tag}${el.attrs.name ? ` named "${el.attrs.name}"` : ""} has no label${el.attrs.placeholder ? " (a placeholder is not a label — it disappears on input)" : ""}.`, "Associate a <label for=\"id\"> with it, wrap it in a <label>, or add aria-label. For the Search block, keep its label visible or use its \"hide label\" option, which keeps it for screen readers.");
    }
  }

  // duplicate ids
  const referenced = new Set<string>();
  for (const el of doc.elements) {
    for (const attr of ["for", "aria-labelledby", "aria-describedby", "aria-controls", "headers", "list"]) {
      for (const id of (el.attrs[attr] ?? "").split(/\s+/)) if (id) referenced.add(id);
    }
  }
  for (const [id, els] of idCounts) {
    if (els.length < 2) continue;
    const isRef = referenced.has(id);
    push("duplicate-id", "4.1.1", isRef ? "serious" : "minor", els[1], `id "${id}" is used ${els.length} times${isRef ? " and is referenced by a label or ARIA attribute, which will point at the wrong element" : ""}.`, "Make ids unique — usually a block or pattern inserted twice with a hard-coded anchor, or a template part included twice.");
  }

  // frames
  for (const el of doc.elements) {
    if (!["iframe", "frame"].includes(el.tag) || isHidden(el)) continue;
    if (!el.attrs.title?.trim() && !el.attrs["aria-label"]?.trim()) {
      push("frame-title", "4.1.2", "serious", el, `An iframe${el.attrs.src ? ` (${el.attrs.src.slice(0, 80)})` : ""} has no title.`, "Add a title describing the embedded content, e.g. title=\"Map of our office\". Core embeds set one automatically; custom HTML embeds do not.");
    }
  }

  // autoplay
  for (const el of doc.elements) {
    if (!["video", "audio"].includes(el.tag) || !("autoplay" in el.attrs)) continue;
    const muted = "muted" in el.attrs;
    if (el.tag === "audio" || !muted) {
      push("media-autoplay", "1.4.2", "serious", el, `${el.tag === "audio" ? "Audio" : "A video with sound"} starts playing automatically.`, "Remove autoplay, or mute it and provide controls so visitors can stop it.");
    } else if (!("controls" in el.attrs)) {
      push("media-autoplay", "2.2.2", "minor", el, "A muted video autoplays without controls, so moving content cannot be paused.", "Add controls (the Video block's \"Playback controls\" setting) or a pause button, or remove autoplay/loop for background videos longer than 5 seconds.");
    }
  }

  // viewport
  for (const el of doc.elements) {
    if (el.tag !== "meta" || el.attrs.name?.toLowerCase() !== "viewport") continue;
    const content = (el.attrs.content ?? "").toLowerCase();
    const scalable = /user-scalable\s*=\s*(no|0)\b/.exec(content);
    const max = /maximum-scale\s*=\s*([\d.]+)/.exec(content);
    if (scalable || (max && Number(max[1]) < 2)) {
      push("meta-viewport", "1.4.4", "critical", el, `The viewport meta tag disables zoom (${scalable ? scalable[0] : max![0]}).`, "Remove user-scalable=no and maximum-scale from the viewport tag — usually hard-coded in a classic theme's header.php or added by a plugin.");
    }
  }

  // colour contrast of palette classes
  let pairs = 0;
  if (enabled("color-contrast")) pairs = contrastChecks(doc, options, push);

  return {
    issues,
    stats: {
      elements: doc.elements.length,
      images,
      decorative_images: decorative,
      links,
      headings: headings.map((h) => ({ level: h.level, text: h.text })),
      contrast_pairs_checked: pairs,
    },
  };
}

function inlineStyleColor(el: HtmlElement, prop: "color" | "background-color"): string | undefined {
  const style = el.attrs.style;
  if (!style) return undefined;
  const re = prop === "color" ? /(?:^|;)\s*color\s*:\s*([^;]+)/i : /(?:^|;)\s*background(?:-color)?\s*:\s*([^;]+)/i;
  const m = re.exec(style);
  return m ? m[1].replace(/!important/i, "").trim() : undefined;
}

function presetClass(el: HtmlElement, kind: "text" | "background"): string | undefined {
  for (const c of classes(el)) {
    if (kind === "background") {
      const m = /^has-([a-z0-9-]+)-background-color$/.exec(c);
      if (m) return m[1];
    } else {
      if (c.endsWith("-background-color") || c.endsWith("-border-color")) continue;
      const m = /^has-([a-z0-9-]+)-color$/.exec(c);
      if (m && m[1] !== "text" && m[1] !== "link") return m[1];
    }
  }
  return undefined;
}

function contrastChecks(
  doc: ParsedDocument,
  options: A11yOptions,
  push: (rule: string, wcag: string, severity: Severity, el: HtmlElement | null, message: string, fix: string) => void,
): number {
  const palette: Record<string, string> = { ...(options.palette ?? {}) };
  // The page's own CSS is authoritative — it reflects a draft theme preview or style variation.
  for (const m of doc.css.matchAll(/--wp--preset--color--([a-z0-9_-]+)\s*:\s*([^;}]+)[;}]/gi)) palette[m[1].toLowerCase()] = m[2].trim();
  const bodyRule = /(?:^|[}\s])body\s*\{([^}]*)\}/.exec(doc.css)?.[1] ?? "";
  const bodyBg = /background-color\s*:\s*([^;]+)/i.exec(bodyRule)?.[1]?.trim() ?? options.rootBackground;
  const bodyFg = /(?:^|;)\s*color\s*:\s*([^;]+)/i.exec(bodyRule)?.[1]?.trim() ?? options.rootText;
  const white: RGBA = { r: 255, g: 255, b: 255, a: 1 };
  const rootBg = resolveColorRef(bodyBg, palette) ?? white;

  const resolveSlug = (slug: string | undefined) => (slug ? resolveColorRef(`var(--wp--preset--color--${slug})`, palette) : null);
  const fgOf = (el: HtmlElement) => resolveSlug(presetClass(el, "text")) ?? resolveColorRef(inlineStyleColor(el, "color"), palette);
  const bgOf = (el: HtmlElement) => {
    if (/\bhas-[a-z0-9-]+-gradient-background\b/.test(el.attrs.class ?? "") || /gradient\(/i.test(el.attrs.style ?? "")) return "gradient" as const;
    return resolveSlug(presetClass(el, "background")) ?? resolveColorRef(inlineStyleColor(el, "background-color"), palette);
  };

  const hasOwnColor = (n: HtmlElement) =>
    Boolean(presetClass(n, "text") || presetClass(n, "background") || inlineStyleColor(n, "color") || inlineStyleColor(n, "background-color"));
  const seen = new Map<string, { count: number; issue: boolean }>();
  let pairs = 0;
  for (const el of doc.elements) {
    if (!hasOwnColor(el) || isHidden(el)) continue;
    // Only text this element actually colours: descendants with their own colours are checked separately.
    const text = textContent(el, false, (n) => hasOwnColor(n) || n.tag === "script" || n.tag === "style");
    if (!text) continue;

    let fg: RGBA | null = null;
    let bg: RGBA | "gradient" | null = null;
    for (let n: HtmlElement | null = el; n && n.tag !== "#document"; n = n.parent) {
      if (!fg) fg = fgOf(n);
      if (!bg) bg = bgOf(n);
      if (fg && bg) break;
    }
    if (bg === "gradient") continue; // cannot be judged without rendering
    fg ??= resolveColorRef(bodyFg, palette);
    const bgColor = bg ?? rootBg;
    if (!fg) continue;
    pairs++;

    const cls = classes(el).join(" ");
    const large = /^h[1-3]$/.test(el.tag) || /\bhas-(x-large|xx-large|xxx-large|huge|large)-font-size\b/.test(cls);
    const required = large ? AA_LARGE : AA_NORMAL;
    const ratio = contrastRatio(fg, bgColor, rootBg);
    const key = `${toHex(fg)}|${toHex(bgColor)}|${required}`;
    const prior = seen.get(key);
    if (prior) {
      prior.count++;
      continue;
    }
    const failing = ratio < required;
    seen.set(key, { count: 1, issue: failing });
    if (failing) {
      const fgSlug = presetClass(el, "text");
      const bgSlug = presetClass(el, "background");
      push("color-contrast", "1.4.3", ratio < AA_LARGE ? "serious" : "moderate", el,
        `Text ${toHex(fg)}${fgSlug ? ` (${fgSlug})` : ""} on ${toHex(bgColor)}${bgSlug ? ` (${bgSlug})` : ""} has contrast ${ratio}:1; WCAG AA needs ${required}:1${large ? " for large text" : ""}. Text: "${text.slice(0, 60)}".`,
        "Pick a palette pair with more contrast in the block's Color settings, or adjust the palette colour in theme.json / Global Styles (validate_theme_json checks the pairs your styles use).");
    }
  }
  return pairs;
}
