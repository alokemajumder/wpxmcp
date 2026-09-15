/**
 * Turns a rendered wp-admin screen into structure: the page title, its notices,
 * the wp-admin links on it, and every form with its fields, current values and
 * labels. No DOM and no dependencies — it runs on Workers, reusing the tolerant
 * tokenizer from themedev-html.
 */
import { parseHtml, textContent, type HtmlElement } from "./themedev-html.js";

export interface AdminField {
  name: string;
  type: string;
  label?: string;
  value?: string;
  checked?: boolean;
  options?: Array<{ value: string; label: string; selected?: boolean }>;
  required?: boolean;
  description?: string;
  /** A password/file field is sensitive or unsubmittable and is flagged. */
  sensitive?: boolean;
  file?: boolean;
}

export interface AdminForm {
  index: number;
  id?: string;
  action: string;
  method: string;
  has_nonce: boolean;
  fields: AdminField[];
  submit_buttons: string[];
  /** Named controls counted directly in the form's source (outside script/style). */
  raw_control_count: number;
  /** Named controls the parser attributed to the form. */
  parsed_control_count: number;
}

export interface AdminStructure {
  title: string | null;
  notices: Array<{ type: string; text: string }>;
  links: Array<{ text: string; href: string }>;
  forms: AdminForm[];
  text_summary: string;
}

/** Fields WordPress adds to every settings form; not meaningful configuration. */
export const VOLATILE_FIELDS = new Set(["_wpnonce", "_wp_http_referer", "_wp_original_http_referer"]);

/**
 * Source ranges [start, end) for each form: from its start tag to the next
 * </form> outside script/style/template/textarea content, or to the next <form>
 * start (an unclosed form is implicitly ended by the next one), or end of document.
 */
export function formRanges(html: string, formEls: HtmlElement[]): Array<[number, number]> {
  const lower = html.toLowerCase();
  const skip: Array<[number, number]> = [];
  const rawRe = /<(script|style|template|textarea)\b[^>]*>/g;
  for (let m = rawRe.exec(lower); m; m = rawRe.exec(lower)) {
    const close = lower.indexOf(`</${m[1]}`, m.index + m[0].length);
    const end = close === -1 ? lower.length : close;
    skip.push([m.index, end]);
    rawRe.lastIndex = end;
  }
  const inSkip = (i: number) => skip.some(([a, b]) => i > a && i < b);
  const closes: number[] = [];
  const closeRe = /<\/form\s*>/g;
  for (let m = closeRe.exec(lower); m; m = closeRe.exec(lower)) if (!inSkip(m.index)) closes.push(m.index);
  return formEls.map((f, i) => {
    const next = i + 1 < formEls.length ? formEls[i + 1].start : html.length;
    const close = closes.find((c) => c > f.start);
    return [f.start, Math.min(close ?? html.length, next)];
  });
}

function nearestAncestor(el: HtmlElement, tag: string): HtmlElement | null {
  for (let n: HtmlElement | null = el.parent; n; n = n.parent) if (n.tag === tag) return n;
  return null;
}

/** The label text for a control, tried in the order WordPress screens use. */
function labelFor(el: HtmlElement, byId: Map<string, HtmlElement>, labelByFor: Map<string, string>): string | undefined {
  const id = el.attrs.id;
  if (id && labelByFor.has(id)) return labelByFor.get(id);
  const wrapping = nearestAncestor(el, "label");
  if (wrapping) {
    const t = textContent(wrapping).trim();
    if (t) return t;
  }
  // form-table layout: <tr><th>Label</th><td>…control…</td></tr>
  const row = nearestAncestor(el, "tr");
  if (row) {
    const th = row.children.find((c): c is HtmlElement => c.type === "element" && (c.tag === "th"));
    if (th) {
      const t = textContent(th).trim();
      if (t) return t;
    }
  }
  if (el.attrs["aria-label"]?.trim()) return el.attrs["aria-label"].trim();
  if (el.attrs.placeholder?.trim()) return el.attrs.placeholder.trim();
  return undefined;
}

/** A p.description sibling within the same table cell, WordPress's help text. */
function descriptionFor(el: HtmlElement): string | undefined {
  const cell = nearestAncestor(el, "td") ?? nearestAncestor(el, "fieldset") ?? el.parent;
  if (!cell) return undefined;
  const walk = (node: HtmlElement): string | undefined => {
    for (const c of node.children) {
      if (c.type !== "element") continue;
      if (c.tag === "p" && /(^|\s)description(\s|$)/.test(c.attrs.class ?? "")) {
        const t = textContent(c).trim();
        if (t) return t;
      }
      const nested = walk(c);
      if (nested) return nested;
    }
    return undefined;
  };
  return walk(cell);
}

const SENSITIVE = /(pass|secret|token|api[_-]?key|license|private[_-]?key)/i;

export function parseAdminStructure(html: string, opts: { maxSummary?: number } = {}): AdminStructure {
  const doc = parseHtml(html);
  const elements = doc.elements;

  // Notices — .notice, .updated, .error, .notice-warning etc.
  const notices: Array<{ type: string; text: string }> = [];
  for (const el of elements) {
    const cls = el.attrs.class ?? "";
    if (!/\b(notice|updated|error|settings-error)\b/.test(cls)) continue;
    // Skip nested — take the outermost notice container only.
    if (nearestAncestor(el, "div") && /\b(notice|updated|error)\b/.test(nearestAncestor(el, "div")!.attrs.class ?? "")) continue;
    const text = textContent(el).trim().replace(/\s+/g, " ");
    if (!text) continue;
    let type = "info";
    const words = new Set(cls.split(/\s+/));
    if (words.has("notice-success") || words.has("updated")) type = "success";
    else if (words.has("notice-error") || words.has("error")) type = "error";
    else if (words.has("notice-warning")) type = "warning";
    else if (words.has("notice-info")) type = "info";
    notices.push({ type, text: text.slice(0, 500) });
  }

  // Labels indexed by their "for".
  const labelByFor = new Map<string, string>();
  const byId = new Map<string, HtmlElement>();
  for (const el of elements) {
    if (el.attrs.id) byId.set(el.attrs.id, el);
    if (el.tag === "label" && el.attrs.for) {
      const t = textContent(el).trim();
      if (t && !labelByFor.has(el.attrs.for)) labelByFor.set(el.attrs.for, t);
    }
  }

  // wp-admin links (relative, or same-page anchors handled by the caller).
  const links: Array<{ text: string; href: string }> = [];
  const seenHref = new Set<string>();
  for (const el of elements) {
    if (el.tag !== "a" || !el.attrs.href) continue;
    const href = el.attrs.href;
    if (!/(^|\/)(wp-admin\/|admin\.php|options[\w-]*\.php|edit\.php|tools\.php|users\.php|themes\.php)/.test(href) && !href.includes("page=")) continue;
    if (seenHref.has(href)) continue;
    seenHref.add(href);
    const text = textContent(el).trim().replace(/\s+/g, " ");
    if (text) links.push({ text: text.slice(0, 120), href });
    if (links.length >= 100) break;
  }

  const forms: AdminForm[] = [];
  const formEls = elements.filter((e) => e.tag === "form");
  const ranges = formRanges(html, formEls);
  const selectEnds = new Map<HtmlElement, number>();
  const lowerHtml = html.toLowerCase();
  for (const e of elements) {
    if (e.tag !== "select") continue;
    const close = lowerHtml.indexOf("</select", e.start + 1);
    selectEnds.set(e, close === -1 ? html.length : close);
  }
  formEls.forEach((form, index) => {
    const [from, to] = ranges[index];
    const formId = form.attrs.id;
    // Membership by source position between <form> and its </form> (forms cannot nest),
    // or by an explicit form="id" attribute. Tree nesting is not trusted: one stray
    // unclosed <div> in the admin header would otherwise orphan half the fields.
    const controls = elements.filter((e) => {
      if (e.tag !== "input" && e.tag !== "select" && e.tag !== "textarea" && e.tag !== "button") return false;
      if (e.attrs.form !== undefined) return !!formId && e.attrs.form === formId;
      return e.start > from && e.start < to;
    });
    const fields: AdminField[] = [];
    const submitButtons: string[] = [];
    const radioSeen = new Map<string, number>(); // name → index in fields

    for (const c of controls) {
      const name = c.attrs.name;
      const rawType = (c.tag === "select" ? "select" : c.tag === "textarea" ? "textarea" : c.tag === "button" ? "button" : (c.attrs.type ?? "text")).toLowerCase();

      if (c.tag === "button" || rawType === "submit" || rawType === "button") {
        const t = (c.tag === "button" ? textContent(c).trim() : c.attrs.value) || "Submit";
        if (rawType === "submit" || c.tag === "button") submitButtons.push(t.slice(0, 80));
        continue;
      }
      if (!name) continue;

      if (rawType === "radio") {
        const value = c.attrs.value ?? "";
        const checked = "checked" in c.attrs;
        if (radioSeen.has(name)) {
          const f = fields[radioSeen.get(name)!];
          f.options = f.options ?? [];
          f.options.push({ value, label: labelFor(c, byId, labelByFor) ?? value, selected: checked });
          if (checked) f.value = value;
          continue;
        }
        radioSeen.set(name, fields.length);
        fields.push({
          name, type: "radio",
          label: labelFor(c, byId, labelByFor),
          value: checked ? value : undefined,
          options: [{ value, label: labelFor(c, byId, labelByFor) ?? value, selected: checked }],
          description: descriptionFor(c),
        });
        continue;
      }

      const field: AdminField = { name, type: rawType };
      field.label = labelFor(c, byId, labelByFor);
      const desc = descriptionFor(c);
      if (desc) field.description = desc;
      if ("required" in c.attrs) field.required = true;

      if (rawType === "checkbox") {
        field.checked = "checked" in c.attrs;
        field.value = c.attrs.value ?? "1";
      } else if (c.tag === "select") {
        const selEnd = selectEnds.get(c) ?? c.start;
        const optionEls = elements.filter((o) => o.tag === "option" && o.start > c.start && o.start < selEnd);
        field.options = optionEls.map((o) => ({
          value: o.attrs.value ?? textContent(o).trim(),
          label: textContent(o).trim(),
          selected: "selected" in o.attrs,
        }));
        const sel = field.options.find((o) => o.selected) ?? field.options[0];
        field.value = sel?.value ?? "";
      } else if (c.tag === "textarea") {
        field.value = textContent(c);
      } else {
        field.value = c.attrs.value ?? "";
        if (rawType === "password") field.sensitive = true;
        if (rawType === "file") field.file = true;
      }
      if (SENSITIVE.test(name)) field.sensitive = true;
      fields.push(field);
    }

    const hasNonce = fields.some((f) => f.name === "_wpnonce" || /nonce/i.test(f.name));
    const parsedControls = controls.filter((c) => c.attrs.name).length;
    const rawControls = countRawControls(html, from, to);
    forms.push({
      index,
      id: form.attrs.id || undefined,
      action: form.attrs.action ?? "",
      method: (form.attrs.method || "get").toLowerCase(),
      has_nonce: hasNonce,
      fields,
      submit_buttons: submitButtons,
      raw_control_count: rawControls,
      parsed_control_count: parsedControls,
    });
  });

  // A capped visible-text summary of the main content.
  const body = elements.find((e) => e.tag === "body") ?? doc.root;
  let summary = textContent(body as HtmlElement).replace(/\s+/g, " ").trim();
  const max = opts.maxSummary ?? 2000;
  if (summary.length > max) summary = summary.slice(0, max) + "…";

  // themedev-html decodes common entities only; admin titles use &lsaquo; / &rsaquo;.
  const title = doc.title === null ? null : doc.title.replace(/&lsaquo;/g, "‹").replace(/&rsaquo;/g, "›").replace(/&#8212;/g, "—");
  return { title, notices, links, forms, text_summary: summary };
}

/**
 * Build the application/x-www-form-urlencoded body for submitting a form with
 * some fields changed. Unchecked checkboxes are omitted; a checked one carries
 * its value attribute. Returns the encoded string and the list of names changed.
 */
export function buildFormBody(
  form: AdminForm,
  changes: Record<string, unknown>
): { body: string; changed: Array<{ name: string; from: string | undefined; to: string }>; unknown: string[] } {
  const params = new URLSearchParams();
  const changeKeys = new Set(Object.keys(changes));
  const known = new Set(form.fields.map((f) => f.name));
  const unknown = [...changeKeys].filter((k) => !known.has(k));
  const changed: Array<{ name: string; from: string | undefined; to: string }> = [];

  for (const f of form.fields) {
    const hasChange = changeKeys.has(f.name);
    if (f.type === "checkbox") {
      const current = !!f.checked;
      const next = hasChange ? toBool(changes[f.name]) : current;
      if (next) params.append(f.name, f.value ?? "1");
      if (hasChange && next !== current) changed.push({ name: f.name, from: current ? (f.value ?? "1") : "(unchecked)", to: next ? (f.value ?? "1") : "(unchecked)" });
      continue;
    }
    const value = hasChange ? String(changes[f.name]) : (f.value ?? "");
    params.append(f.name, value);
    if (hasChange && value !== (f.value ?? "")) changed.push({ name: f.name, from: f.value, to: value });
  }

  return { body: params.toString(), changed, unknown };
}

function toBool(v: unknown): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  const s = String(v).toLowerCase().trim();
  return s === "1" || s === "true" || s === "yes" || s === "on";
}

/** Named input/select/textarea/button start tags in html[from, to), ignoring script/style/template/textarea contents. */
export function countRawControls(html: string, from: number, to: number): number {
  const segment = html.slice(from, to).replace(/<(script|style|template|textarea)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, (m, tag: string) => (tag.toLowerCase() === "textarea" ? m.replace(/>[\s\S]*$/, ">") : ""));
  let n = 0;
  for (const m of segment.matchAll(/<(input|select|textarea|button)\b([^>]*)>/gi)) {
    if (/(?:^|\s)name\s*=/i.test(m[2])) n++;
  }
  return n;
}

/**
 * Options options.php would write for this form's group but that the parsed form
 * does not contain. options.php sets every option of the group it is not sent to
 * null, so a missing name means the parse is incomplete and the submit would wipe
 * that setting. Compared against the parsed fields (not the POST body): an
 * unchecked checkbox is legitimately absent from the body but present on the form.
 */
export function missingGroupOptions(form: AdminForm, groupOptions: string[], optionPage: string): string[] {
  if (optionPage === "options") return []; // page_options names the fields explicitly.
  const names = form.fields.map((f) => f.name);
  const has = (option: string) => names.some((n) => n === option || n.startsWith(`${option}[`));
  // Options core's options.php derives from another field rather than posting directly.
  const derived: Record<string, Record<string, string>> = { general: { gmt_offset: "timezone_string" } };
  // Options in core's allowlist that core's own screens never render, so a browser save omits them too:
  // image_default_* are not on options-media.php at all; default_link_category only appears with the Link Manager.
  const unrendered: Record<string, string[]> = {
    media: ["image_default_size", "image_default_align", "image_default_link_type"],
    writing: ["default_link_category"],
  };
  return groupOptions.filter((option) => {
    if (has(option)) return false;
    if (unrendered[optionPage]?.includes(option)) return false;
    const source = derived[optionPage]?.[option];
    return !(source && has(source));
  });
}

/** A form whose parsed control count is well below the controls in its source was probably mis-parsed. */
export function looksIncomplete(form: AdminForm, threshold = 0.8): boolean {
  return form.raw_control_count > 0 && form.parsed_control_count < form.raw_control_count * threshold;
}

/** A stable hash input of a form's meaningful field values, excluding volatile ones. */
export function stableFieldValues(form: AdminForm): Array<[string, string]> {
  return form.fields
    .filter((f) => !VOLATILE_FIELDS.has(f.name) && !f.sensitive)
    .map((f) => [f.name, f.type === "checkbox" ? (f.checked ? "1" : "0") : (f.value ?? "")] as [string, string])
    .sort((a, b) => a[0].localeCompare(b[0]));
}

/** Close matches for an unknown field name, for a helpful error. */
export function closeMatches(name: string, known: string[]): string[] {
  const n = name.toLowerCase();
  return known
    .filter((k) => {
      const kl = k.toLowerCase();
      return kl.includes(n) || n.includes(kl) || levenshtein(kl, n) <= 2;
    })
    .slice(0, 5);
}

function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    const curr = [i];
    for (let j = 1; j <= n; j++) {
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = curr;
  }
  return prev[n];
}
