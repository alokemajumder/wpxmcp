/**
 * Runtime abstraction.
 *
 * wpxmcp runs in two places: as a local stdio server on a developer's machine,
 * and as a remote Streamable HTTP server on Cloudflare Workers. Workers has no
 * filesystem and no `process`, so anything that touches either goes through here
 * and degrades explicitly rather than throwing something inscrutable.
 */

export type RuntimeKind = "node" | "workers";

export interface AuditEntry {
  ts: string;
  site: string;
  tool: string;
  action: string;
  target?: string | number;
  outcome: "ok" | "error" | "dry-run" | "refused";
  detail?: string;
}

export interface Platform {
  kind: RuntimeKind;
  /** Configuration source: process.env on Node, the Worker `env` binding on Workers. */
  env: Record<string, string | undefined>;
  /** Append one audit entry. Never throws — auditing must not break a tool call. */
  audit(entry: AuditEntry): void;
  /** Most recent audit entries, newest first. */
  readAudit(limit: number, site?: string): AuditEntry[];
  /** Read a file from the machine running the server. Unavailable on Workers. */
  readLocalFile?(path: string): { data: Uint8Array; filename: string; contentType: string };
  /**
   * A stable secret used to sign confirmation tokens.
   *
   * It must be identical across every process and isolate serving this
   * deployment, or a token issued by one will be rejected by another.
   */
  confirmSecret(): string;
  /** Persisted user skills. Bundled skills are always available; saving needs a filesystem. */
  skills: {
    canSave: boolean;
    listSaved(): Array<{ name: string; content: string }>;
    save?(name: string, content: string): string;
    remove?(name: string): boolean;
    savedDir?: string;
  };
}

let current: Platform | null = null;

export function setPlatform(platform: Platform) {
  current = platform;
}

export function platform(): Platform {
  if (!current) {
    throw new Error("No platform has been installed. The entry point must call setPlatform() before building tools.");
  }
  return current;
}

/** In-memory audit ring, used by Workers and as the Node fallback if a disk write fails. */
export function createMemoryAudit(capacity = 500) {
  const entries: AuditEntry[] = [];
  return {
    push(entry: AuditEntry) {
      entries.push(entry);
      if (entries.length > capacity) entries.splice(0, entries.length - capacity);
    },
    read(limit: number, site?: string): AuditEntry[] {
      const out: AuditEntry[] = [];
      for (let i = entries.length - 1; i >= 0 && out.length < limit; i--) {
        if (!site || entries[i].site === site) out.push(entries[i]);
      }
      return out;
    },
  };
}
