# Contributing

Thanks for helping. This document covers the setup, the shape of the codebase, and the conventions that keep the tools usable by a model.

## Setup

```bash
git clone https://github.com/wpxmcp/wpxmcp.git
cd wpxmcp
npm install
npm run build
npm test
```

Node 20+ (24 recommended). The tests need no network and no WordPress site.

## Layout

```
src/
  index.ts            Local stdio entry point
  worker.ts           Cloudflare Workers entry point
  toolset.ts          The shared tool list — both entry points build from this
  platform-node.ts    Node runtime: filesystem audit log, saved skills, local file reads
  lib/
    platform.ts       Runtime abstraction (Node vs Workers)
    config.ts         Site configuration resolution
    client.ts         WordPress REST client
    registry.ts       Multi-site resolution
    safety.ts         SQL guard, CLI allowlist, confirmation tokens, audit
    content-utils.ts  Targeted edits, URL resolution, summaries, SEO extraction
    http-transport.ts Stateless Streamable HTTP transport
    theme-scaffold.ts The classic PHP + Tailwind theme generator
    skills.ts         Playbook loading and matching
    tooling.ts        defineTool, result helpers, error formatting
  tools/              One module per domain
  generated/          Skills baked in at build time — do not edit
skills/               Playbook sources (Markdown)
wp-plugin/            The companion WordPress plugin
tests/                node:test suites
```

## Adding a tool

Add one `defineTool({...})` to the appropriate `src/tools/*.ts`. It becomes available over **both** stdio and HTTP automatically, because both entry points build from `src/toolset.ts`.

```ts
defineTool({
  name: "do_the_thing",
  title: "Do the thing",
  readOnly: false,
  destructive: false,
  description:
    "One or two sentences on what this does and when to reach for it, plus anything " +
    "non-obvious about how WordPress behaves here.",
  schema: {
    site_id: siteIdSchema,
    thing_id: z.number().int().describe("Which thing. Get it from list_things."),
  },
  handler: async ({ site_id, thing_id }) => {
    const client = registry.resolve(site_id);
    client.assertWritable("do_the_thing");
    const res = await client.post(`/wp/v2/things/${thing_id}`, { ... });
    audit({ site: client.site.id, tool: "do_the_thing", action: "update", target: thing_id, outcome: "ok" });
    return ok({ updated: true, ...res.data });
  },
})
```

### Conventions

**Descriptions are the interface.** A model chooses tools by reading them. Say what the tool does, when to use it instead of a neighbouring tool, and what will surprise someone who knows the REST API but not this site. Every parameter gets a `.describe()`.

**Errors must be actionable.** `throw new Error("Unknown content type \"foo\". Registered types: post, page, product. Run discover_content_types.")` — not `"not found"`. If you know the fix, say the fix.

**Destructive means previewed.** Anything irreversible returns what *would* happen plus a `confirm_token` on the first call, and only acts when that token comes back. Use `issueConfirmation` / `consumeConfirmation` with a `fingerprintOp` of the arguments.

**Audit every write.** Call `audit({...})` after a successful mutation.

**Keep output small.** Return summaries, not whole documents. Use `trimText` for anything unbounded.

**Never leak credentials.** No tool may return `appPassword` or `bearerToken`. There is a test for this.

**Stay runtime-neutral.** No `node:fs`, `node:path`, `process`, or `Buffer` in `src/lib/` or `src/tools/` — it has to run on Workers. Filesystem access goes through `platform()`.

## Playbooks

Add a Markdown file to `skills/` with front matter:

```markdown
---
name: my-skill
title: What this covers
description: One line — this is what load_skill matches against
keywords: comma, separated, trigger, terms
---
```

Then `npm run bundle:skills` (the build runs it automatically). Write for an agent: concrete steps, exact tool names, and the mistakes worth avoiding.

## The WordPress plugin

PHP in `wp-plugin/wpxmcp-helper/`, following [WordPress Coding Standards](https://developer.wordpress.org/coding-standards/wordpress-coding-standards/php/): tabs, Yoda conditions where natural, full docblocks.

Every route requires `manage_options`. Escape all output. Prepare all SQL. Validate every path against traversal.

```bash
php -l wp-plugin/wpxmcp-helper/includes/class-wpxmcp-rest.php
```

## Tests

```bash
npm test
```

Tests cover pure logic — edits, guards, config, transport — and must not require a network or a WordPress site. Add tests for anything security-relevant.

## Pull requests

1. Branch from `main`.
2. `npm test && npm run typecheck` before pushing.
3. Explain the reasoning, not only the change.
4. Update `docs/TOOLS.md` when you add or rename a tool.

## Code of conduct

See [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
