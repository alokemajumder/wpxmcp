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
 * Confirmation tokens for irreversible work
 * ------------------------------------------------------------------ */

interface PendingOp {
  token: string;
  createdAt: number;
  site: string;
  summary: string;
  fingerprint: string;
}

const pending = new Map<string, PendingOp>();
const CONFIRM_TTL_MS = 10 * 60 * 1000;

/**
 * A stable fingerprint of a pending operation's arguments.
 *
 * This is not a security boundary — it exists so that a confirm_token issued for
 * one preview cannot be replayed against different arguments. The unguessable
 * part is the token itself, which uses the CSPRNG below.
 */
export function fingerprintOp(parts: unknown[]): string {
  const input = JSON.stringify(parts);
  // FNV-1a, 64-bit, so it works identically on Node and Workers without a hash API.
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let i = 0; i < input.length; i++) {
    hash = ((hash ^ BigInt(input.charCodeAt(i) & 0xff)) * prime) & mask;
  }
  return hash.toString(16).padStart(16, "0");
}

/** Issues a short-lived token the caller must echo back to actually run a destructive op. */
export function issueConfirmation(site: string, summary: string, fingerprint: string): string {
  const bytes = new Uint8Array(9);
  crypto.getRandomValues(bytes);
  const token = "confirm-" + Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  pending.set(token, { token, createdAt: Date.now(), site, summary, fingerprint });
  return token;
}

export function consumeConfirmation(token: string, fingerprint: string): { valid: boolean; reason?: string } {
  const op = pending.get(token);
  if (!op) return { valid: false, reason: "That confirm_token is unknown or has already been used. Re-run the tool without a token to get a fresh dry-run preview." };
  pending.delete(token);
  if (Date.now() - op.createdAt > CONFIRM_TTL_MS) {
    return { valid: false, reason: "That confirm_token expired (tokens last 10 minutes). Re-run for a fresh preview." };
  }
  if (op.fingerprint !== fingerprint) {
    return {
      valid: false,
      reason: "The arguments changed since the preview was generated, so the token no longer matches. Re-run without a token to preview the new operation, then confirm that.",
    };
  }
  return { valid: true };
}

/* ------------------------------------------------------------------ *
 * SQL guard — SELECT-only by default
 * ------------------------------------------------------------------ */

const SQL_MUTATING = [
  "insert", "update", "delete", "drop", "truncate", "alter", "create", "replace",
  "grant", "revoke", "rename", "call", "handler", "load", "lock", "unlock",
  "set", "prepare", "execute", "into outfile", "into dumpfile",
];

export interface SqlVerdict {
  allowed: boolean;
  mutating: boolean;
  reason?: string;
  normalized: string;
  statementCount: number;
}

export function inspectSql(rawQuery: string, allowMutations: boolean): SqlVerdict {
  const stripped = rawQuery
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\n]*/g, " ")
    .replace(/#[^\n]*/g, " ")
    .trim();
  const normalized = stripped.replace(/\s+/g, " ").replace(/;\s*$/, "");
  const lower = normalized.toLowerCase();

  const statements = normalized.split(";").map((s) => s.trim()).filter(Boolean);
  if (statements.length > 1) {
    return {
      allowed: false, mutating: true, normalized, statementCount: statements.length,
      reason: "Multiple statements in one query are refused — stacked queries are a classic injection shape. Send one statement at a time.",
    };
  }

  const startsRead = /^(select|show|describe|desc|explain|with)\b/.test(lower);
  const hit = SQL_MUTATING.find((kw) =>
    kw.includes(" ") ? lower.includes(kw) : new RegExp(`\\b${kw}\\b`).test(lower)
  );

  if (startsRead && !hit) {
    return { allowed: true, mutating: false, normalized, statementCount: 1 };
  }
  if (!startsRead || hit) {
    const mutating = true;
    if (!allowMutations) {
      return {
        allowed: false, mutating, normalized, statementCount: 1,
        reason: startsRead
          ? `The query reads but contains the blocked keyword "${hit}". Mutating SQL needs allow_mutation: true plus a confirm_token.`
          : `Only SELECT/SHOW/DESCRIBE/EXPLAIN/WITH run without approval. This statement starts with "${lower.split(/\s+/)[0]}", so it needs allow_mutation: true plus a confirm_token.`,
      };
    }
    return { allowed: true, mutating, normalized, statementCount: 1 };
  }
  return { allowed: true, mutating: false, normalized, statementCount: 1 };
}

/** Forces a LIMIT onto an unbounded SELECT so a huge table cannot flood the context. */
export function enforceRowLimit(query: string, maxRows: number): { query: string; applied: boolean } {
  const lower = query.toLowerCase();
  if (!/^\s*(select|with)\b/.test(lower)) return { query, applied: false };
  if (/\blimit\s+\d+/.test(lower)) return { query, applied: false };
  return { query: `${query.replace(/;\s*$/, "")} LIMIT ${maxRows}`, applied: true };
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
  "eval": { write: true, description: "Evaluate PHP (blocked unless WPX_ALLOW_EVAL=true on the server AND enabled site-side)" },
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
  "site list": { write: false, description: "List sites on a multisite network" },
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
  "user create": { write: true, description: "Create a user" },
  "user update": { write: true, description: "Update a user" },
  "menu list": { write: false, description: "List nav menus" },
  "menu item list": { write: false, description: "List items in a nav menu" },
  "sidebar list": { write: false, description: "List sidebars" },
  "widget list": { write: false, description: "List widgets in a sidebar" },
  "language core list": { write: false, description: "List installed core translations" },
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
  if (matched === "eval" && platform().env.WPX_ALLOW_EVAL !== "true") {
    return { allowed: false, write: true, matched, reason: "`eval` executes arbitrary PHP and is disabled. Set WPX_ALLOW_EVAL=true on the MCP server (and enable it site-side) only if you truly need it." };
  }
  return { allowed: true, write: CLI_ALLOWLIST[matched].write, matched };
}
