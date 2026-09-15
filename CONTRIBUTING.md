# Contributing

Thanks for helping. This document covers the setup, the shape of the codebase, and the conventions that keep the tools usable by a model.

## Setup

```bash
git clone https://github.com/alokemajumder/wpxmcp.git
cd wpxmcp
npm install
npm run build
npm test
```

Node 20+ (24 recommended). The tests import the compiled `dist/`, so build before running them. They need no network and no WordPress site.

## Layout

```
src/
  index.ts              Local stdio entry point (serveStdio)
  worker.ts             Cloudflare Workers entry point: auth, CORS, /health
  toolset.ts            The shared tool list, VERSION and server instructions
  platform-node.ts      Node runtime: filesystem audit log, saved skills, local file reads
  lib/
    server.ts           createWpxServer — the one server definition both entry points use
    http-transport.ts   Streamable HTTP for Workers: body-size cap, CORS on every response
    http-utils.ts       readCapped (bounded body reads) and requireHelper (the plugin check)
    platform.ts         Runtime abstraction (Node vs Workers)
    config.ts           Site configuration resolution and validation
    client.ts           WordPress REST client: retries, manual redirects, PHP-notice recovery
    registry.ts         Multi-site resolution
    safety.ts           SQL lexer and guard, CLI allowlist, confirmation tokens, audit
    errors.ts           WPError and actionable hints for HTTP failures
    tooling.ts          defineTool, registerTools, result helpers, schemaDescription
    content-utils.ts    Targeted edits, URL resolution, summaries, SEO extraction
    theme-scaffold.ts   The classic PHP + Tailwind theme generator
    skills.ts           Playbook loading and matching
    ops-security.ts     Pure rules behind security_audit and the other ops tools
    devtools-core.ts    Registry kinds and cleanup constants for the developer tools
    growth-seo.ts       SEO plugin detection and meta-key mapping
    growth-links.ts     Link extraction, link graphs, robots.txt, CSV
    themedev-*.ts       theme.json diffs and linting, colour/contrast maths, an HTML tokenizer
    plugin-control-html.ts  wp-admin screens and forms turned into structure
  tools/                One module per domain
  generated/            Skills baked in at build time — do not edit
scripts/
  bundle-skills.mjs     skills/*.md → src/generated/skills.ts
  gen-tools-doc.mjs     The built toolset → docs/TOOLS.md
skills/                 Playbook sources (Markdown)
wp-plugin/              The companion WordPress plugin
tests/                  node:test suites
audit/                  Live suites against a real WordPress (not run in CI)
```

## Adding a tool

Add one `defineTool({...})` to the appropriate `src/tools/*.ts`. It becomes available over **both** stdio and HTTP automatically, because both entry points build their server with `createWpxServer` from `src/toolset.ts`. A new module must also be added to `buildToolset` in `src/toolset.ts` and to the `GROUPS` list in `scripts/gen-tools-doc.mjs`.

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

Schemas are **zod 4**: a record needs both key and value types (`z.record(z.string(), z.any())`), and `registerTools` wraps the shape in `z.object()` for the SDK.

### The companion plugin marker

`docs/TOOLS.md` marks each tool that needs the companion plugin. The generator reads it from the handler: a handler that calls `requireHelper(client, …)` (from `src/lib/http-utils.ts`) is marked **required**, and one that only asks `client.hasHelperPlugin()` is marked **enhanced**. When the handler reaches the plugin indirectly — through a helper function the generator cannot see — set it explicitly:

```ts
defineTool({ name: "profile_url", companion: "required", ... })
```

### The tool reference is generated

Never edit `docs/TOOLS.md` by hand. After adding, renaming or re-describing a tool:

```bash
npm run build && npm run docs:tools
```

The first sentence of each description becomes its row. CI regenerates the file and fails when the committed copy is stale.

### Conventions

**Descriptions are the interface.** A model chooses tools by reading them. Say what the tool does, when to use it instead of a neighbouring tool, and what will surprise someone who knows the REST API but not this site. Every parameter gets a `.describe()` — `tests/tool-contract.test.mjs` fails on a missing one, on a description under 40 characters, and on a tool marked both `readOnly` and `destructive`.

**Errors must be actionable.** `throw new Error("Unknown content type \"foo\". Registered types: post, page, product. Run discover_content_types.")` — not `"not found"`. If you know the fix, say the fix.

**Destructive means previewed.** Anything irreversible returns what *would* happen plus a `confirm_token` on the first call, and only acts when that token comes back. Use `issueConfirmation` / `consumeConfirmation` with a `fingerprintOp` of the arguments — and, where the target can change between preview and apply, of the state the preview saw.

**Audit every write.** Call `audit({...})` after a successful mutation.

**Keep output small.** Return summaries, not whole documents. Use `trimText` for anything unbounded, and `readCapped` for any response body you did not ask WordPress for.

**Stay on the site.** A tool that fetches a page resolves it with `resolveSiteUrl` and follows redirects by hand, re-checking each hop with `isSameSite`. A tool that fetches anything else runs it through `checkDownloadUrl` and `assertResolvesPublic` unless `WPX_ALLOW_PRIVATE_URLS` is set.

**Never leak credentials.** No tool may return `appPassword` or `bearerToken`. There is a test for this.

**Stay runtime-neutral.** No `node:fs`, `node:path`, `process`, or `Buffer` in `src/lib/` or `src/tools/` — it has to run on Workers. Filesystem access goes through `platform()`. The existing exceptions are guarded: `config.ts` checks for a filesystem before touching one, and the DNS check in `media.ts` imports `node:dns` dynamically only when `platform().kind === "node"`.

## Playbooks

Add a Markdown file to `skills/` with front matter:

```markdown
---
name: my-skill
title: What this covers
description: Use when … — this is what load_skill matches against
keywords: comma, separated, trigger, terms
---
```

Then `npm run bundle:skills` (the build runs it automatically) and commit `src/generated/skills.ts` — CI checks it is current.

### House style

Write for an agent: concrete steps, exact tool names, and the mistakes worth avoiding. `tests/skills-accuracy.test.mjs` enforces the structure and the facts:

- The description starts with **"Use when"**, **"Use for"** or **"Use before"**, and keywords are not duplicated.
- Sections appear in this order: **When this applies**, **Rules**, **Procedure**, **Verify**, **Report back**. Reference sections may follow.
- Keep it under about 120 lines; the test fails above 140.
- Every backticked tool name must be a real tool, every parameter passed to it must exist on that tool, and every literal value must fit its schema.
- Every WP-CLI command suggested must be on the allowlist, and every other playbook referenced must exist.

`tests/skills.test.mjs` covers routing: realistic requests must route to exactly one clear playbook, and every playbook must be the clear answer to at least one request. When you add a playbook, add the requests it should win.

## The WordPress plugin

PHP in `wp-plugin/wpxmcp-helper/`, following [WordPress Coding Standards](https://developer.wordpress.org/coding-standards/wordpress-coding-standards/php/): tabs, Yoda conditions where natural, full docblocks. PHP 7.4 must stay supported.

Every route's `permission_callback` is `WPXMCP_REST::instance()->require_admin` (or a stricter check built on it, such as the theme-file editor check). Escape all output. Prepare all SQL. Validate every path against traversal. Parse booleans from requests with `rest_sanitize_boolean()`, never a cast — `(bool) "false"` is `true`. Any option write goes through `wpxmcp_is_protected_option()`.

```bash
find wp-plugin -name '*.php' -print0 | xargs -0 -n1 php -l
```

## Tests

```bash
npm run build
npm test
```

Tests cover pure logic — edits, SQL and CLI guards, config, transport on both protocol eras, the tool contract, playbook accuracy and routing, and the helpers behind every tool module — and must not require a network or a WordPress site. Add tests for anything security-relevant.

The [live audit suites](audit/README.md) exercise the tools against a real WordPress over stdio and HTTP. They run on the 2026-07-28 protocol by default; `WPX_AUDIT_ERA=legacy` runs the stdio suites over the 2025-era handshake instead. Run both after touching the transport or anything that talks to WordPress.

## Pull requests

1. Branch from `main`.
2. `npm run typecheck && npm run build && npm test` before pushing.
3. `npm run docs:tools` if tools changed, and commit `docs/TOOLS.md`.
4. Explain the reasoning, not only the change.

## Code of conduct

See [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
