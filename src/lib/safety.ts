import { platform, type AuditEntry } from "./platform.js";

export type { AuditEntry };

/* ------------------------------------------------------------------ *
 * Append-only audit log
 * ------------------------------------------------------------------ */

/**
 * Records a sensitive action. Where it lands depends on the runtime: an
 * append-only JSONL file on Node, an in-memory ring (plus the site-side log
 * kept by the companion plugin) on Workers.
 */
export function audit(entry: Omit<AuditEntry, "ts">) {
  try {
    platform().audit({ ts: new Date().toISOString(), ...entry });
  } catch {
    /* auditing must never break a tool call */
  }
}

export function readAudit(limit = 100, siteFilter?: string): AuditEntry[] {
  try {
    return platform().readAudit(limit, siteFilter);
  } catch {
    return [];
  }
}

/* ------------------------------------------------------------------ *
 * Confirmation tokens
 * ------------------------------------------------------------------ */

/**
 * Tokens are self-contained and signed rather than held in memory.
 *
 * The remote deployment is stateless: every request builds a fresh server, and
 * Cloudflare may route the follow-up call to a different isolate or evict the
 * one that issued the token. An in-memory map therefore validates a token only
 * when the confirm happens to land on the same isolate — intermittent failure,
 * which is the worst possible behaviour for a destructive-action guard.
 *
 * A token instead carries its own site, fingerprint and expiry, signed with a
 * secret that is stable across the deployment, so any isolate can verify any
 * token without shared state.
 */

const CONFIRM_TTL_MS = 10 * 60 * 1000;

/**
 * Best-effort replay guard, mapping a spent token to when it expires.
 *
 * Correctness does not depend on this surviving — the signature and expiry do
 * that. Entries are pruned by expiry rather than cleared wholesale, because
 * clearing would make every previously spent token replayable again.
 */
const spent = new Map<string, number>();

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((value.length + 3) % 4);
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

async function sign(payload: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return toBase64Url(new Uint8Array(signature));
}

/** Constant-time comparison, so a signature cannot be discovered by timing. */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * A stable fingerprint of a pending operation's arguments.
 *
 * Not the security boundary — the HMAC signature is. This exists so a token
 * issued for one preview cannot be replayed against different arguments.
 */
export function fingerprintOp(parts: unknown[]): string {
  // Hashed as UTF-8 bytes. Masking UTF-16 code units to their low byte made
  // every non-ASCII character collide with an ASCII one ("Ā" and "\u0000").
  const input = new TextEncoder().encode(JSON.stringify(parts));
  // FNV-1a, 64-bit: identical on Node and Workers without needing a hash API.
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (const byte of input) {
    hash = ((hash ^ BigInt(byte)) * prime) & mask;
  }
  return hash.toString(16).padStart(16, "0");
}

/** Issues a short-lived signed token the caller must echo back to proceed. */
export async function issueConfirmation(site: string, summary: string, fingerprint: string): Promise<string> {
  const payload = toBase64Url(
    new TextEncoder().encode(JSON.stringify({ s: site, f: fingerprint, x: Date.now() + CONFIRM_TTL_MS }))
  );
  const signature = await sign(payload, platform().confirmSecret());
  return `confirm.${payload}.${signature}`;
}

export async function consumeConfirmation(token: string, fingerprint: string): Promise<{ valid: boolean; reason?: string }> {
  const parts = String(token ?? "").split(".");
  if (parts.length !== 3 || parts[0] !== "confirm") {
    return { valid: false, reason: "That confirm_token is malformed. Re-run the tool without a token to get a fresh dry-run preview." };
  }

  const [, payload, signature] = parts;

  let expected: string;
  try {
    expected = await sign(payload, platform().confirmSecret());
  } catch {
    return { valid: false, reason: "The confirmation token could not be verified on this server." };
  }
  if (!safeEqual(signature, expected)) {
    return { valid: false, reason: "That confirm_token failed its signature check — it was not issued by this server. Re-run the tool without a token to get a fresh preview." };
  }

  let decoded: { s: string; f: string; x: number };
  try {
    decoded = JSON.parse(new TextDecoder().decode(fromBase64Url(payload)));
  } catch {
    return { valid: false, reason: "That confirm_token is malformed." };
  }

  if (Date.now() > decoded.x) {
    return { valid: false, reason: "That confirm_token expired (tokens last 10 minutes). Re-run for a fresh preview." };
  }
  if (decoded.f !== fingerprint) {
    return {
      valid: false,
      reason: "The arguments changed since the preview was generated, so the token no longer matches. Re-run without a token to preview the new operation, then confirm that.",
    };
  }
  const shared = platform().spentTokens;
  const tokenHash = shared ? await sha256Hex(token) : "";
  if (spent.has(token) || (shared && (await shared.has(tokenHash).catch(() => false)))) {
    return { valid: false, reason: "That confirm_token has already been used. Re-run the tool without a token to get a fresh preview." };
  }

  spent.set(token, decoded.x);
  if (shared) await shared.add(tokenHash, decoded.x).catch(() => undefined);
  if (spent.size > 500) {
    // Drop only what can no longer be replayed anyway.
    const now = Date.now();
    for (const [key, expiry] of spent) if (expiry <= now) spent.delete(key);
  }
  return { valid: true };
}

/* ------------------------------------------------------------------ *
 * SQL guard — SELECT-only by default
 * ------------------------------------------------------------------ */

/**
 * Keywords that make a statement need approval. Each is matched as a whole word
 * against the query with string literals and comments removed, so a post titled
 * "How to delete a page" does not trip it and a keyword cannot hide in a comment.
 */
const SQL_MUTATING: Array<{ label: string; pattern: RegExp }> = [
  ...[
    "update", "delete", "drop", "alter", "create", "grant", "revoke", "rename", "call",
    "handler", "load", "lock", "unlock", "set", "prepare", "execute",
  ].map((kw) => ({ label: kw, pattern: new RegExp(`\\b${kw}\\b`) })),
  // INSERT(), REPLACE() and TRUNCATE() are also ordinary string/number functions.
  // A read cannot contain the statement forms, so only the function call is let through.
  ...["insert", "replace", "truncate"].map((kw) => ({ label: kw, pattern: new RegExp(`\\b${kw}\\b(?!\\s*\\()`) })),
  { label: "into outfile", pattern: /\binto\s+outfile\b/ },
  { label: "into dumpfile", pattern: /\binto\s+dumpfile\b/ },
  // Reads that are still dangerous: a file off the database server's disk, or a
  // query built to hold a PHP worker hostage.
  { label: "load_file", pattern: /\bload_file\s*\(/ },
  { label: "sleep", pattern: /\bsleep\s*\(/ },
  { label: "benchmark", pattern: /\bbenchmark\s*\(/ },
  { label: "get_lock", pattern: /\bget_lock\s*\(/ },
];

interface LexedSql {
  /** Comments removed and whitespace collapsed, string literals untouched. This is what runs. */
  normalized: string;
  /** The same, with every quoted literal emptied — what keywords and `;` are searched in. */
  masked: string;
}

/**
 * A MySQL-aware scan of a query.
 *
 * Regexes over the raw text cannot tell a comment marker from the same
 * characters inside a string: `'#fff'` lost everything after the `#`, and
 * whitespace inside literals was collapsed, rewriting the data a mutation
 * writes. MySQL's own rules apply here instead: `-- ` needs trailing
 * whitespace, and a `/*! ... *\/` comment is executed, so its body is code.
 *
 * `backslashEscapes` mirrors the server's sql_mode — whether `\'` continues a
 * string (the default) or NO_BACKSLASH_ESCAPES is on. A string left unterminated
 * is not masked, so nothing can hide inside it.
 */
function lexSql(input: string, backslashEscapes: boolean): LexedSql {
  let normalized = "";
  let masked = "";
  let pendingSpace = false;
  let src = input;
  let i = 0;

  const emit = (n: string, m: string) => {
    if (pendingSpace && normalized) {
      normalized += " ";
      masked += " ";
    }
    pendingSpace = false;
    normalized += n;
    masked += m;
  };

  while (i < src.length) {
    const ch = src[i];
    const next = src[i + 1];

    if (/\s/.test(ch)) {
      pendingSpace = true;
      i++;
    } else if (ch === "/" && next === "*") {
      const close = src.indexOf("*/", i + 2);
      const end = close === -1 ? src.length : close;
      if (src[i + 2] === "!") {
        // Executable comment: splice its body back in as ordinary code.
        const body = src.slice(i + 3, end).replace(/^\d{5,6}/, "");
        src = src.slice(0, i) + " " + body + " " + src.slice(close === -1 ? src.length : close + 2);
      } else {
        pendingSpace = true;
        i = close === -1 ? src.length : close + 2;
      }
    } else if (ch === "#" || (ch === "-" && next === "-" && (i + 2 >= src.length || /[\s\x00-\x1f]/.test(src[i + 2])))) {
      const eol = src.indexOf("\n", i);
      pendingSpace = true;
      i = eol === -1 ? src.length : eol + 1;
    } else if (ch === "'" || ch === '"' || ch === "`") {
      let j = i + 1;
      let closed = false;
      while (j < src.length) {
        if (backslashEscapes && ch !== "`" && src[j] === "\\") {
          j += 2;
        } else if (src[j] === ch) {
          if (src[j + 1] === ch) {
            j += 2; // a doubled quote is an escaped quote
          } else {
            closed = true;
            break;
          }
        } else {
          j++;
        }
      }
      if (closed) {
        emit(src.slice(i, j + 1), ch + ch);
        i = j + 1;
      } else {
        emit(src.slice(i), src.slice(i));
        i = src.length;
      }
    } else {
      emit(ch, ch);
      i++;
    }
  }

  const trailing = /[;\s]+$/;
  return { normalized: normalized.replace(trailing, ""), masked: masked.replace(trailing, "") };
}

export interface SqlVerdict {
  allowed: boolean;
  mutating: boolean;
  reason?: string;
  normalized: string;
  statementCount: number;
}

export function inspectSql(rawQuery: string, allowMutations: boolean): SqlVerdict {
  const { normalized } = lexSql(rawQuery, true);

  // The normalized text is what gets executed, so that is what is inspected —
  // under both escape modes, since which one applies is the server's setting.
  const views = [lexSql(normalized, true).masked, lexSql(normalized, false).masked].map((m) => m.toLowerCase());

  const statementCount = Math.max(...views.map((m) => m.split(";").map((part) => part.trim()).filter(Boolean).length));
  if (statementCount > 1) {
    return {
      allowed: false, mutating: true, normalized, statementCount,
      reason: "Multiple statements in one query are refused — stacked queries are a classic injection shape. Send one statement at a time.",
    };
  }

  const startsRead = views.every((m) => /^\(*\s*(select|show|describe|desc|explain|with)\b/.test(m));
  let hit: string | undefined;
  for (const view of views) {
    hit = SQL_MUTATING.find((kw) => kw.pattern.test(view))?.label;
    if (hit) break;
  }

  if (startsRead && !hit) {
    return { allowed: true, mutating: false, normalized, statementCount: 1 };
  }
  if (!allowMutations) {
    return {
      allowed: false, mutating: true, normalized, statementCount: 1,
      reason: startsRead
        ? `The query reads but contains the blocked keyword "${hit}". Mutating SQL needs allow_mutation: true plus a confirm_token.`
        : `Only SELECT/SHOW/DESCRIBE/EXPLAIN/WITH run without approval. This statement starts with "${views[0].split(/\s+/)[0]}", so it needs allow_mutation: true plus a confirm_token.`,
    };
  }
  return { allowed: true, mutating: true, normalized, statementCount: 1 };
}

/** Forces a LIMIT onto an unbounded SELECT so a huge table cannot flood the context. */
export function enforceRowLimit(query: string, maxRows: number): { query: string; applied: boolean } {
  // Normalizing first means a trailing comment cannot swallow the appended LIMIT.
  const { normalized, masked } = lexSql(query, true);
  const lower = masked.toLowerCase();
  if (!/^\(*\s*(select|with)\b/.test(lower)) return { query, applied: false };

  // Only a LIMIT outside every parenthesis bounds the result; one in a subquery does not.
  let depth = 0;
  let topLevel = "";
  for (const ch of lower) {
    if (ch === "(") depth++;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    else if (depth === 0) topLevel += ch;
  }
  if (/\blimit\s+\d/.test(topLevel)) return { query, applied: false };
  return { query: `${normalized} LIMIT ${maxRows}`, applied: true };
}

/* ------------------------------------------------------------------ *
 * WP-CLI allowlist — default deny
 * ------------------------------------------------------------------ */

/** Commands the emulated CLI will run. Anything not listed here is refused. */
export const CLI_ALLOWLIST: Record<string, { write: boolean; description: string }> = {
  "cache flush": { write: true, description: "Flush the object cache" },
  "core check-update": { write: false, description: "Check for a core update" },
  "core version": { write: false, description: "Print the WordPress version" },
  "core verify-checksums": { write: false, description: "Verify core files against the official checksums" },
  "cron event list": { write: false, description: "List scheduled cron events" },
  "cron event run": { write: true, description: "Run a due cron event now" },
  "db size": { write: false, description: "Report database and table sizes" },
  "db tables": { write: false, description: "List database tables" },
  "option get": { write: false, description: "Read an option" },
  "option list": { write: false, description: "List options" },
  "option update": { write: true, description: "Write an option" },
  "option delete": { write: true, description: "Delete an option" },
  "plugin list": { write: false, description: "List plugins" },
  "plugin get": { write: false, description: "Show one plugin" },
  "plugin activate": { write: true, description: "Activate a plugin" },
  "plugin deactivate": { write: true, description: "Deactivate a plugin" },
  "plugin install": { write: true, description: "Install a plugin from the .org repository" },
  "plugin update": { write: true, description: "Update a plugin" },
  "plugin delete": { write: true, description: "Delete an inactive plugin" },
  "post list": { write: false, description: "List posts" },
  "post meta get": { write: false, description: "Read post meta" },
  "post meta list": { write: false, description: "List post meta" },
  "post meta update": { write: true, description: "Write post meta" },
  "post meta delete": { write: true, description: "Delete post meta" },
  "rewrite flush": { write: true, description: "Flush rewrite rules" },
  "rewrite list": { write: false, description: "List rewrite rules" },
  "role list": { write: false, description: "List roles" },
  "search-replace": { write: true, description: "Search and replace across tables (dry-run first)" },
  "theme list": { write: false, description: "List themes" },
  "theme get": { write: false, description: "Show one theme" },
  "theme activate": { write: true, description: "Activate a theme" },
  "theme install": { write: true, description: "Install a theme from the .org repository" },
  "theme update": { write: true, description: "Update a theme" },
  "theme mod list": { write: false, description: "List theme modifications" },
  "theme mod get": { write: false, description: "Read a theme modification" },
  "theme mod set": { write: true, description: "Write a theme modification" },
  "transient delete": { write: true, description: "Delete a transient" },
  "transient get": { write: false, description: "Read a transient" },
  "user list": { write: false, description: "List users" },
  "user get": { write: false, description: "Show one user" },
  "user meta get": { write: false, description: "Read user meta" },
  "user meta update": { write: true, description: "Write user meta" },
  "user add-role": { write: true, description: "Add a role to a user" },
  "user remove-role": { write: true, description: "Remove a role from a user" },
  "menu list": { write: false, description: "List nav menus" },
  "menu item list": { write: false, description: "List items in a nav menu" },
  "sidebar list": { write: false, description: "List sidebars" },
  "widget list": { write: false, description: "List widgets in a sidebar" },
  "maintenance-mode status": { write: false, description: "Report maintenance mode" },
  "maintenance-mode activate": { write: true, description: "Enter maintenance mode" },
  "maintenance-mode deactivate": { write: true, description: "Leave maintenance mode" },
};

export interface CliVerdict {
  allowed: boolean;
  write: boolean;
  matched?: string;
  reason?: string;
}

/** Longest-prefix match against the allowlist, so `plugin activate x` matches `plugin activate`. */
export function inspectCliCommand(command: string): CliVerdict {
  const normalized = command.trim().replace(/^wp\s+/, "").replace(/\s+/g, " ");
  if (!normalized) return { allowed: false, write: false, reason: "Empty command." };

  if (/[;&|`$><]|\$\(/.test(normalized.split("--")[0])) {
    return { allowed: false, write: false, reason: "Shell metacharacters are not allowed — commands are emulated in PHP, not run through a shell." };
  }

  const candidates = Object.keys(CLI_ALLOWLIST)
    .filter((cmd) => normalized === cmd || normalized.startsWith(cmd + " "))
    .sort((a, b) => b.length - a.length);

  if (candidates.length === 0) {
    const head = normalized.split(" ").slice(0, 2).join(" ");
    const near = Object.keys(CLI_ALLOWLIST).filter((c) => c.startsWith(normalized.split(" ")[0])).slice(0, 8);
    return {
      allowed: false, write: false,
      reason: `"${head}" is not on the allowlist, and the allowlist is default-deny.${near.length ? ` Related allowed commands: ${near.join(", ")}.` : ""} Run list_cli_commands for the full set.`,
    };
  }

  const matched = candidates[0];
  return { allowed: true, write: CLI_ALLOWLIST[matched].write, matched };
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
