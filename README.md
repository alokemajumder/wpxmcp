# wpxmcp

**The open-source MCP server that runs your WordPress sites like a senior admin would** — content, design, plugins, SEO, performance, security and the whole fleet, from Claude, ChatGPT, Cursor or any MCP client.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/alokemajumder/wpxmcp)
[![CI](https://github.com/alokemajumder/wpxmcp/actions/workflows/ci.yml/badge.svg)](https://github.com/alokemajumder/wpxmcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![MCP 2026-07-28](https://img.shields.io/badge/MCP-2026--07--28-black.svg)](https://modelcontextprotocol.io/specification/2026-07-28)
[![WordPress 6.0–7.1](https://img.shields.io/badge/WordPress-6.0%E2%80%937.1-21759b.svg)](https://wordpress.org)

**150 tools · 20 playbooks · stdio + remote · many sites, one server · MIT · no subscription, no usage cap**

---

## Why I built this

I run several WordPress sites, and I wanted an AI agent to do the real work on them — not just draft a post, but find out why a page is slow, fix a meta description in Rank Math, check whether a plugin update broke the checkout, tidy a bloated options table.

**The official route stopped short.** The [WordPress MCP Adapter](https://github.com/WordPress/mcp-adapter) is the right long-term idea, but it can only expose what something has registered as an *ability* — and out of the box core registers three, all read-only. It is one endpoint per site, it has to be installed on every site, and nothing in it tells you why a page is slow or whether your site is exposed.

**The commercial route came with a meter.** The hosted and plugin-based MCPs that *can* do more charge per site or per seat, cap how many requests or actions you get, and hold your credentials on their servers. For a handful of sites managed every day, the limits arrived before the work was done — and I could not read, fix or extend the thing I was paying for.

So I built the server I needed, used it on my own sites until it was dependable, and released it. **It is free, MIT-licensed, self-hosted, and has no usage limit other than your own WordPress.**

---

## What it looks like

> *"The pricing page still shows the old price, and it feels slow. Sort it out."*
>
> <sub>An illustrative session, abridged.</sub>

```
find_content_by_url  https://example.com/pricing/          → page 812
update_content       edits: [{ find: "$39", replace: "$49" }]  → 1 replacement
get_page_html        /pricing/                              → still shows $39
purge_cache          scope: url                             → WP Rocket purged
get_page_html        /pricing/                              → $49 ✓
profile_url          /pricing/
  → 184 queries (61 duplicates from wp-content/plugins/pricing-table)
  → external HTTP call to api.currency.example 1.4s on every request
```

It read the **rendered page** instead of trusting a `200`, found the stale cache, and then found the real reason the page was slow — with the file and plugin responsible.

---

## Why wpxmcp

### It is not reinventing the wheel

wpxmcp is built on what WordPress already ships: the **REST API**, **Application Passwords** and the **Abilities API** (it is a client of `wp-abilities/v1`, so plugin-registered abilities just work). When a plugin offers its own REST route or ability, wpxmcp uses it — so the plugin's validation, hooks and cache invalidation run. It falls back in order: ability → REST → the plugin's own settings save → WP-CLI → guarded SQL. The optional companion plugin only adds what core has **no API for at all**: logs, profiling, theme files, WP-CLI, SQL, admin screens.

### Compared with the official MCP Adapter

| | WordPress MCP Adapter | wpxmcp |
| --- | --- | --- |
| What the agent can do | Whatever plugins registered as abilities | 150 tools on day one, **plus** every registered ability |
| Sites per connection | One | **Many** — one server, one connection |
| Install on each site | Required | Optional (113 tools need nothing on the site) |
| Diagnostics, profiling, security, SEO, fleet | — | ✅ |
| Guardrails (dry-run, drafts, confirm tokens) | Up to each ability | ✅ built in |

They are complementary: install the adapter if you like, and wpxmcp will call the same abilities.

### Compared with commercial plugin-based MCPs

| | Typical commercial MCP | wpxmcp |
| --- | --- | --- |
| Price | Per site / per seat, monthly | **Free** |
| Usage | Request or action quotas | **No cap** |
| Where credentials live | Vendor's servers, or inside the site | **Your** Cloudflare account or your machine |
| Can you read and change it | No | **Yes — MIT** |
| Lock-in | Their plugin, their dashboard | Standard MCP, standard WordPress APIs |

### The power of open source, in practice

- **Auditable guardrails.** Every safety claim in [SECURITY.md](SECURITY.md) is code you can read and a test you can run — and each was verified to *refuse*, not just to exist.
- **Extensible by you.** Add a tool with one `defineTool({...})`; save your team's conventions as a playbook with `save_skill`.
- **Yours to deploy.** Cloudflare Workers free tier, or `node dist/index.js` on a laptop. No telemetry; the only outside services it calls are the ones a tool names (WordPress.org, the WPVulnerability database, stock-photo APIs you configure).

---

## What it does, by who you are

**Site owners and webmasters**
- Plain-language edits that read the page back before and after, draft before publish, and say plainly when something cannot be undone
- `security_audit` — exposed files, user enumeration, XML-RPC, weak config, admin accounts, and **known-vulnerable plugins** from the WPVulnerability database, scored and sorted
- `purge_cache` for WP Rocket, LiteSpeed, W3TC, WP Super Cache, SiteGround, Kinsta, WP Engine and more — then proves the page changed
- `backup_status` before anything risky; `tail_error_log` when the site shows a critical error

**Plugin power users — operate any installed plugin as an admin**
- `inspect_plugin` maps what a plugin exposes: REST routes, abilities, settings, admin screens
- `get_plugin_settings` / `update_plugin_settings` write through WordPress's own settings save, so the plugin's sanitisation runs — with a preview, a confirm step and one-call undo
- `admin_page` / `submit_admin_form` read and submit **any wp-admin screen** as the administrator — Yoast, Rank Math, WooCommerce, forms, caching — even where no API exists

**WordPress developers**
- `profile_url` — Query Monitor over MCP: every query with caller and plugin, duplicates, external HTTP calls, PHP warnings, assets, memory, and the template that rendered the page
- `inspect_registry` — post types, meta, blocks, REST routes, shortcodes, cron, and **hooks with `file:line`** of every callback
- `inspect_options`, `cleanup_options`, `inspect_database` — autoload bloat, orphaned data and tables, attributed to the plugin that left them
- WP-CLI (emulated — no SSH), guarded SQL, the Abilities API, `rest_api` for anything else

**Theme developers**
- Sandboxed theme drafts with private preview links; never edit a live theme
- `diff_global_styles` — what the Site Editor changed versus theme.json; `reset_template_customization` to revert
- `validate_theme_json` — schema, duplicate slugs, missing font files, **WCAG contrast** across every style variation
- `check_accessibility` on any page or draft preview; `apply_style_variation`, `list_block_patterns`, classic PHP + Tailwind scaffolding

**SEO and content teams**
- `get_seo_meta` / `set_seo_meta` across Yoast, Rank Math, AIOSEO, SEOPress and The SEO Framework — and a check that what is stored is what actually renders
- `seo_site_check`, `check_links`, `internal_link_report` (orphans and link suggestions), `content_inventory` (CSV), `content_calendar`
- Page-builder aware: Elementor, Divi, Beaver Builder, Bricks and Breakdance content is detected and never corrupted by an HTML edit

**Agencies**
- `fleet_report` — every client site in one call: reachability, versions, pending updates, Site Health, noindex left on, HTTPS — worst first
- One deployment, one bearer token per team, credentials in Worker Secrets instead of on every laptop

**[Every tool →](docs/TOOLS.md)**

---

## Guardrails that hold

- New content is a **draft**; deletes go to the **trash**.
- Bulk edits, SQL, search-replace, settings changes and form submissions **preview first** and return a single-use `confirm_token` bound to those exact arguments.
- Theme work happens in a **sandboxed copy**; publishing backs up the previous theme.
- Protected options, path traversal, stacked SQL, off-site fetches and private-network requests are **refused** — at the server *and* in the plugin.
- Every sensitive action is written to an **append-only audit log**, locally and on the site.

---

## Deploy remotely (recommended)

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/alokemajumder/wpxmcp)

Or three commands:

```bash
npm install
openssl rand -hex 32 | npx wrangler secret put WPX_AUTH_TOKEN
npx wrangler secret put WPX_SITES     # your sites JSON, then Ctrl-D
npm run deploy
```

Connect any client:

```jsonc
{
  "mcpServers": {
    "wpxmcp": {
      "type": "http",
      "url": "https://wpxmcp.<your-subdomain>.workers.dev/mcp",
      "headers": { "Authorization": "Bearer <your WPX_AUTH_TOKEN>" }
    }
  }
}
```

It speaks **MCP 2026-07-28** (stateless, no handshake) and still serves clients on 2025-era revisions from the same endpoint. The free tier covers 100,000 requests a day. **[Full walkthrough →](docs/DEPLOY_CLOUDFLARE.md)**

## Or run it locally

```bash
git clone https://github.com/alokemajumder/wpxmcp.git
cd wpxmcp && npm install && npm run build
npm run doctor          # checks reachability, auth, capabilities, plugin
```

```bash
claude mcp add wpxmcp -- node /absolute/path/to/wpxmcp/dist/index.js \
  -e WORDPRESS_URL=https://example.com \
  -e WORDPRESS_USERNAME=admin \
  -e "WORDPRESS_APP_PASSWORD=abcd EFGH ijkl MNOP qrst UVWX"
```

Create the Application Password under **Users → Profile → Application Passwords**. WordPress only offers them over **HTTPS**, and some hosts **strip the `Authorization` header** — `test_site` detects both. **[Auth guide →](docs/WORDPRESS_AUTH.md)**

---

## Do you need the companion plugin?

**Not for most work.** 113 of the 150 tools run against a stock WordPress with nothing installed.

The other 37 do things **core WordPress has no API for**: reading the error log, profiling a request, operating admin screens, WP-CLI, SQL, theme files, cache purges and code snippets. Each of those tools names the plugin when it is missing, and tells you how to install it. **[What it adds and how it is secured →](docs/COMPANION_PLUGIN.md)** · **[Comparison and evidence →](docs/COMPARISON.md)**

---

## Documentation

| | |
| --- | --- |
| [Tool reference](docs/TOOLS.md) | Every tool, generated from the code |
| [Deploy to Cloudflare](docs/DEPLOY_CLOUDFLARE.md) | Secrets, custom domains, rotation, troubleshooting |
| [WordPress auth](docs/WORDPRESS_AUTH.md) | Application Passwords, roles, HTTPS, header passthrough |
| [Configuration](docs/CONFIGURATION.md) | Every option and precedence rule |
| [Companion plugin](docs/COMPANION_PLUGIN.md) | What it adds, how it is secured |
| [Comparison](docs/COMPARISON.md) | Versus other WordPress MCP servers |
| [Security](SECURITY.md) | Threat model and guardrails |
| [Contributing](CONTRIBUTING.md) | Setup, conventions, adding a tool or playbook |

---

## Status

**v2.0.0.** CI on Node 20, 22 and 24, PHP 7.4 and 8.3, with the Worker build verified on every push.

Every release is verified against a **live WordPress 7.1**, not only unit-tested: the full tool surface exercised over stdio and over HTTP, on both the 2026-07-28 and 2025-era protocols, with every guardrail confirmed to refuse. The suites are in [`audit/`](audit/) and re-runnable against any throwaway WordPress.

Issues and pull requests are read. Especially welcome: playbooks for plugins you know well, and adapters for more cache, backup and SEO plugins. If wpxmcp saves you time, **a star helps other people find it.**

## Development

```bash
npm install && npm run build
npm test            # unit tests, no network needed
npm run cf:dev      # the Worker locally at :8787/mcp
```

Adding a tool is one `defineTool({...})` — it appears on both transports and in the generated tool reference automatically.

## License

MIT — see [LICENSE](LICENSE). Not affiliated with the WordPress Foundation, Automattic, or Cloudflare.
