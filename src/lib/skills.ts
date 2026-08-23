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

/** Ranks skills against a free-text task description. */
export function matchSkills(query: string): Array<Skill & { score: number }> {
  const q = query.toLowerCase();
  const terms = q.split(/[^a-z0-9]+/).filter((t) => t.length > 2);

  return listSkills()
    .map((skill) => {
      let score = 0;
      const haystack = `${skill.name} ${skill.title} ${skill.description} ${skill.keywords.join(" ")}`.toLowerCase();
      for (const keyword of skill.keywords) {
        if (q.includes(keyword.toLowerCase())) score += 10;
      }
      if (q.includes(skill.name.replace(/-/g, " "))) score += 12;
      for (const term of terms) {
        if (haystack.includes(term)) score += 2;
      }
      if (skill.source === "saved") score += 3; // the user's own conventions win ties
      return { ...skill, score };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);
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
