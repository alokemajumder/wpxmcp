import { z } from "zod";
import { defineTool, ok, type ToolContext } from "../lib/tooling.js";
import { listSkills, readSkill, matchSkills, saveSkill, deleteSkill, canSaveSkills, skillDirs } from "../lib/skills.js";

export function skillTools(_ctx: ToolContext) {
  return [
    defineTool({
      name: "load_skill",
      title: "Load a playbook",
      readOnly: true,
      description:
        "Load the playbook for the task at hand — a focused guide covering how to do this particular kind of WordPress work correctly, including the traps that are not obvious from the API. Call this FIRST when starting any substantive task: describe what you are about to do and the matching skill is returned. Page builders in particular (Elementor, Divi, Beaver Builder, Bricks, Breakdance) store content in builder-specific structures, and editing their posts as ordinary HTML corrupts the layout — the playbook explains what to do instead.",
      schema: {
        query: z.string().optional().describe("What you are about to do, e.g. \"build a landing page with Elementor\" or \"fix missing meta descriptions\"."),
        name: z.string().optional().describe("Load a specific skill by name instead of searching."),
      },
      handler: async ({ query, name }) => {
        if (name) {
          const found = readSkill(name);
          if (!found) {
            return ok({ found: false, requested: name, available: listSkills().map((s) => s.name) },
              `No skill named "${name}". The available skills are listed above.`);
          }
          return ok(`# ${found.title}\n\n${found.content}`);
        }
        if (!query) {
          return ok({ skills: listSkills().map((s) => ({ name: s.name, title: s.title, description: s.description, source: s.source })) },
            "Describe the task in `query` to load the right playbook, or pass `name` to load one directly.");
        }

        const matches = matchSkills(query);
        if (matches.length === 0) {
          return ok({ found: false, query, available: listSkills().map((s) => ({ name: s.name, description: s.description })) },
            "No skill matched that task closely. Nothing here covers it, so proceed with the tools directly — the available playbooks are listed above in case one is relevant after all.");
        }
        if (matches.length > 1 && matches[1].score >= matches[0].score * 0.8) {
          return ok({
            multiple_candidates: true,
            query,
            candidates: matches.slice(0, 4).map((m) => ({ name: m.name, title: m.title, description: m.description })),
          }, "Several playbooks could fit. Call load_skill again with the `name` of the right one.");
        }

        const best = readSkill(matches[0].name)!;
        return ok(`# ${best.title}\n\n_Loaded because it matched: ${query}_\n\n${best.content}`);
      },
    }),

    defineTool({
      name: "list_skills",
      title: "List playbooks",
      readOnly: true,
      description: "List every available playbook — the bundled ones and any you have saved. Saved skills shadow bundled ones with the same name.",
      schema: {},
      handler: async () => {
        const skills = listSkills();
        const dirs = skillDirs();
        return ok({
          bundled: dirs.bundled,
          saved_dir: dirs.saved ?? "(this runtime cannot save skills)",
          can_save: canSaveSkills(),
          count: skills.length,
          skills: skills.map((s) => ({ name: s.name, title: s.title, description: s.description, keywords: s.keywords, source: s.source })),
        });
      },
    }),

    defineTool({
      name: "save_skill",
      title: "Save a playbook",
      description:
        "Save a playbook so future sessions follow the same conventions — your site's structure, a client's tone of voice, a deployment routine, the fields a particular theme expects. Written to ~/.wpxmcp/skills and loaded by load_skill from then on. Saving a skill with a bundled skill's name overrides it.",
      schema: {
        name: z.string().describe("Lowercase hyphenated identifier, e.g. \"acme-blog-conventions\"."),
        title: z.string().describe("Human-readable title."),
        description: z.string().describe("One line on when this skill applies — this is what load_skill matches against."),
        keywords: z.array(z.string()).optional().describe("Terms that should trigger this skill, e.g. [\"acme\", \"blog post\", \"tone\"]."),
        content: z.string().describe("The playbook itself, in Markdown. Write it for an agent: concrete steps, exact tool names, and the mistakes to avoid."),
      },
      handler: async ({ name, title, description, keywords, content }) => {
        const file = saveSkill(name, content, { title, description, keywords });
        return ok({ saved: true, name, file }, "Saved. load_skill will find it from now on, in this and every future session.");
      },
    }),

    defineTool({
      name: "delete_skill",
      title: "Delete a saved playbook",
      description: "Delete one of your saved playbooks. Bundled playbooks cannot be deleted, but a saved skill of the same name will override one.",
      schema: { name: z.string().describe("Name of the saved skill to delete.") },
      handler: async ({ name }) => {
        const deleted = deleteSkill(name);
        return ok({ deleted, name }, deleted ? "Deleted." : `No saved skill named "${name}" — bundled skills cannot be deleted.`);
      },
    }),
  ];
}
