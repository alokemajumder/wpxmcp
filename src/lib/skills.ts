import { platform } from "./platform.js";
import { BUNDLED_SKILLS } from "../generated/skills.js";

export interface Skill {
  name: string;
  title: string;
  description: string;
  keywords: string[];
  source: "bundled" | "saved";
  content: string;
}

function parseFrontMatter(text: string): { meta: Record<string, string>; body: string } {
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text);
  if (!match) return { meta: {}, body: text };
  const meta: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    meta[line.slice(0, idx).trim()] = line.slice(idx + 1).trim().replace(/^["']|["']$/g, "");
  }
  return { meta, body: match[2] };
}

export function listSkills(): Skill[] {
  const saved: Skill[] = [];
  try {
    for (const entry of platform().skills.listSaved()) {
      const { meta, body } = parseFrontMatter(entry.content);
      saved.push({
        name: meta.name ?? entry.name,
        title: meta.title ?? entry.name,
        description: meta.description ?? "",
        keywords: (meta.keywords ?? "").split(",").map((k) => k.trim()).filter(Boolean),
        source: "saved",
        content: body.trim(),
      });
    }
  } catch {
    /* no saved skills on this runtime */
  }

  const savedNames = new Set(saved.map((s) => s.name));
  const bundled: Skill[] = BUNDLED_SKILLS
    .filter((s) => !savedNames.has(s.name))
    .map((s) => ({ ...s, source: "bundled" as const }));

  return [...saved, ...bundled].sort((a, b) => a.name.localeCompare(b.name));
}

export function readSkill(name: string): Skill | null {
  return listSkills().find((s) => s.name === name) ?? null;
}

/** Words too common to signal anything on their own. */
const STOPWORDS = new Set([
  "the", "a", "an", "my", "our", "your", "this", "that", "these", "those",
  "and", "or", "but", "for", "with", "from", "into", "onto", "about",
  "how", "what", "why", "when", "where", "which", "who",
  "can", "should", "would", "could", "will", "want", "need", "help", "please",
  "some", "any", "all", "more", "most", "new", "old",
  "site", "website", "wordpress", "wp", "make", "get", "set", "put", "use",
]);

function tokenize(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 2 && !STOPWORDS.has(t));
}

/**
 * Ranks skills against a free-text task description.
 *
 * Weighted so that a deliberate multi-word keyword ("page builder", "meta
 * description") outranks an incidental single word. Matching is on whole words:
 * substring matching made "clear the spam comments" score against a skill whose
 * text merely contained those letters somewhere.
 */
export function matchSkills(query: string): Array<Skill & { score: number }> {
  const q = query.toLowerCase();
  const terms = tokenize(query);
  const termSet = new Set(terms);

  // Whole-word, but tolerant of the plural a person naturally types:
  // "photos" should match the keyword "photo", and "categories" "category".
  const hasWord = (haystack: string, word: string) => {
    const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const stem = escaped.replace(/(?:ies|es|s)$/i, "");
    return new RegExp(`\\b(?:${escaped}|${stem}(?:s|es|ies)?)\\b`, "i").test(haystack);
  };

  return listSkills()
    .map((skill) => {
      let score = 0;
      const title = skill.title.toLowerCase();
      const description = skill.description.toLowerCase();

      for (const raw of skill.keywords) {
        const keyword = raw.toLowerCase().trim();
        if (!keyword) continue;
        if (keyword.includes(" ")) {
          // A multi-word keyword is a deliberate signal; require the whole phrase.
          if (q.includes(keyword)) score += 14;
        } else if (!STOPWORDS.has(keyword) && hasWord(q, keyword)) {
          score += 6;
        }
      }

      // The skill's own name, spoken aloud.
      if (q.includes(skill.name.replace(/-/g, " "))) score += 16;
      for (const part of skill.name.split("-")) {
        if (part.length > 3 && termSet.has(part)) score += 3;
      }

      // Weaker corroborating signal from the title and description.
      for (const term of terms) {
        if (hasWord(title, term)) score += 3;
        else if (hasWord(description, term)) score += 1;
      }

      if (skill.source === "saved") score += 4; // the user's own conventions win ties
      return { ...skill, score };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
}

export function canSaveSkills(): boolean {
  try {
    return platform().skills.canSave;
  } catch {
    return false;
  }
}

export function saveSkill(name: string, content: string, meta: { title?: string; description?: string; keywords?: string[] }): string {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
    throw new Error(`"${name}" is not a valid skill name — use lowercase letters, digits and hyphens, e.g. "client-blog-conventions".`);
  }
  const runtime = platform();
  if (!runtime.skills.canSave || !runtime.skills.save) {
    throw new Error(
      `This server cannot save skills: it is running on ${runtime.kind}, which has no writable filesystem. Saved skills work when wpxmcp runs locally over stdio. To ship a playbook with a remote deployment, add it to skills/ in the repository and redeploy.`
    );
  }
  const document = [
    "---",
    `name: ${name}`,
    `title: ${meta.title ?? name}`,
    `description: ${(meta.description ?? "").replace(/\n/g, " ")}`,
    `keywords: ${(meta.keywords ?? []).join(", ")}`,
    "---",
    "",
    content.trim(),
    "",
  ].join("\n");
  return runtime.skills.save(name, document);
}

export function deleteSkill(name: string): boolean {
  const runtime = platform();
  if (!runtime.skills.remove) return false;
  return runtime.skills.remove(name);
}

export function skillDirs() {
  try {
    return { saved: platform().skills.savedDir ?? null, bundled: `${BUNDLED_SKILLS.length} compiled into the build` };
  } catch {
    return { saved: null, bundled: `${BUNDLED_SKILLS.length} compiled into the build` };
  }
}
