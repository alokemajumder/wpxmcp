import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createMemoryAudit, setPlatform, type AuditEntry, type Platform } from "./lib/platform.js";
import { guessMimeType } from "./lib/client.js";

export const WPX_HOME = process.env.WPX_HOME
  ? path.resolve(process.env.WPX_HOME)
  : path.join(os.homedir(), ".wpxmcp");

/** Stable for the lifetime of this process, used only if the key file is unwritable. */
let cachedProcessKey: string | null = null;
function processKey(): string {
  if (!cachedProcessKey) {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    cachedProcessKey = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  }
  return cachedProcessKey;
}

function ensureHome(): string {
  if (!fs.existsSync(WPX_HOME)) fs.mkdirSync(WPX_HOME, { recursive: true, mode: 0o700 });
  return WPX_HOME;
}

/**
 * Local stdio runtime: a real filesystem for the audit log and saved skills,
 * and the ability to read files the user names by path.
 */
export function installNodePlatform(): Platform {
  const memory = createMemoryAudit();
  const auditFile = () => path.join(ensureHome(), "audit.log.jsonl");
  const savedSkillsDir = () => path.join(ensureHome(), "skills");

  const runtime: Platform = {
    kind: "node",
    env: process.env as Record<string, string | undefined>,

    audit(entry: AuditEntry) {
      memory.push(entry);
      if (process.env.WPX_AUDIT === "off") return;
      try {
        // Opened in append mode, so existing history is never rewritten in place.
        fs.appendFileSync(auditFile(), JSON.stringify(entry) + "\n", { mode: 0o600 });
      } catch {
        /* the in-memory ring still has it */
      }
    },

    readAudit(limit: number, site?: string): AuditEntry[] {
      const file = auditFile();
      if (!fs.existsSync(file)) return memory.read(limit, site);
      let lines: string[];
      try {
        lines = fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean);
      } catch {
        return memory.read(limit, site);
      }
      const out: AuditEntry[] = [];
      for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
        try {
          const entry = JSON.parse(lines[i]) as AuditEntry;
          if (!site || entry.site === site) out.push(entry);
        } catch {
          /* skip a malformed line rather than failing the read */
        }
      }
      return out;
    },

    readLocalFile(filePath: string) {
      const resolved = filePath.startsWith("~")
        ? path.join(os.homedir(), filePath.slice(1))
        : path.resolve(filePath);

      if (!fs.existsSync(resolved)) {
        throw new Error(
          `No file at "${resolved}". file_path is read by the machine running this MCP server, so it must be a path on that machine — for a Mac screenshot that is typically "~/Desktop/Screenshot 2026-08-23 at 2.29.04 PM.png". Quote paths containing spaces.`
        );
      }
      const stat = fs.statSync(resolved);
      if (stat.isDirectory()) throw new Error(`"${resolved}" is a directory, not a file.`);

      return {
        data: new Uint8Array(fs.readFileSync(resolved)),
        filename: path.basename(resolved),
        contentType: guessMimeType(resolved),
      };
    },

    confirmSecret() {
      // Persisted so a token issued before a restart still verifies afterwards.
      const file = path.join(ensureHome(), "confirm.key");
      try {
        if (fs.existsSync(file)) return fs.readFileSync(file, "utf8").trim();
        const bytes = new Uint8Array(32);
        crypto.getRandomValues(bytes);
        const key = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
        fs.writeFileSync(file, key, { mode: 0o600 });
        return key;
      } catch {
        // Read-only home directory: fall back to a per-process key. Tokens then
        // last only as long as the process, which is still correct for stdio.
        return processKey();
      }
    },

    skills: {
      canSave: true,
      savedDir: savedSkillsDir(),

      listSaved() {
        const dir = savedSkillsDir();
        if (!fs.existsSync(dir)) return [];
        return fs
          .readdirSync(dir)
          .filter((f) => f.endsWith(".md"))
          .map((f) => ({ name: path.basename(f, ".md"), content: fs.readFileSync(path.join(dir, f), "utf8") }));
      },

      save(name: string, content: string) {
        const dir = savedSkillsDir();
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        const file = path.join(dir, `${name}.md`);
        fs.writeFileSync(file, content, { mode: 0o600 });
        return file;
      },

      remove(name: string) {
        const file = path.join(savedSkillsDir(), `${name}.md`);
        if (!fs.existsSync(file)) return false;
        fs.unlinkSync(file);
        return true;
      },
    },
  };

  setPlatform(runtime);
  return runtime;
}
