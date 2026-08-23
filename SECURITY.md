# Security policy

## Reporting a vulnerability

Report privately through [GitHub Security Advisories](https://github.com/alokemajumder/wpxmcp/security/advisories/new). Please do not open a public issue for a security problem.

Include what you did, what happened, and what you expected. You will get an acknowledgement within 72 hours and an assessment within a week.

---

## Threat model

wpxmcp gives a language model write access to production websites. The assumption behind every guardrail here is that **the model will sometimes be confidently wrong**, and that the damage from that must be bounded, previewed, and reversible.

The design goals, in priority order:

1. Nothing irreversible happens without an explicit, argument-bound confirmation.
2. Credentials are never disclosed, logged, or returned by any tool.
3. The site's own permission model is respected rather than bypassed.
4. Every sensitive action leaves a record.

---

## Guardrails

### Authentication
- **Application Passwords** — revocable per-integration, never the account password. Sent over HTTPS with Basic auth, which is the mechanism WordPress designed for this.
- **Roles are enforced by WordPress**, not by this server. An Editor's token cannot install a plugin regardless of what a tool is asked to do.
- **Remote deployments require a bearer token.** A Worker with no `WPX_AUTH_TOKEN` refuses every request rather than running wide open, and the token is compared in constant time.

### Destructive operations
- **Content deletes go to the trash.** Permanent deletion requires `force` **and** `confirm`, and first returns what would be destroyed.
- **Term, user, media and plugin deletion** — which have no trash — always preview and require `confirm`.
- **Bulk edits, `search-replace` and mutating SQL** produce a dry run plus a single-use `confirm_token`, fingerprinted against the exact arguments. Change one argument and the token no longer matches.
- **Tokens expire after 10 minutes** and cannot be reused.

### SQL
- SELECT/SHOW/DESCRIBE/EXPLAIN only, by default.
- An unbounded SELECT gets a `LIMIT` appended.
- Comments are stripped before inspection, so keywords cannot be smuggled through them.
- **Stacked statements are always refused**, on both sides.
- Mutations need three independent things: `allow_mutation: true`, a valid `confirm_token`, and `WPXMCP_ALLOW_SQL_WRITES` in `wp-config.php`.

### WP-CLI
- **Default-deny allowlist.** Anything not listed is refused, enforced independently in both the server and the plugin.
- Shell metacharacters are rejected. Commands are emulated in PHP and never reach a shell.
- `wp eval` executes arbitrary PHP and is **disabled** unless `WPX_ALLOW_EVAL=true`.
- Options that would lock you out (`siteurl`, `home`, `active_plugins`, `template`, `stylesheet`) are protected.

### Themes and code
- **Writing to a live theme is refused** unless explicitly overridden. The workflow is draft → preview → publish.
- **Publishing backs up the previous theme first**, and aborts entirely if that backup fails.
- **PHP is syntax-checked before it is written**, so a parse error is reported instead of fataling the site.
- **Path traversal is blocked**: paths are confined to the theme directory, symlinks resolved, extensions allowlisted.
- **Snippets are always created disabled** and can only be activated by a human in wp-admin. One that throws disables itself.

### Content defaults
- `create_content` **defaults to draft**. Publishing is always explicit.
- Sites can be marked `"writable": false`, refusing every write at the server.

### Auditing
- An append-only JSONL log locally (`~/.wpxmcp/audit.log.jsonl`), readable via `get_audit_log`.
- An independent append-only record on each WordPress site, kept by the companion plugin.

---

## Handling of credentials

- Credentials are read from the environment, a local JSON file, or Cloudflare Worker Secrets.
- **No tool returns a credential.** `list_sites` and `get_site` report the *method* ("application password") and never the value; a test asserts this.
- Credentials are not written to the audit log.
- On Workers they live in Cloudflare's encrypted secret store, are not readable back, and are never present in the repository or in any client's configuration.

**Your responsibilities:** keep `.env`, `sites.json` and `.dev.vars` out of version control (all are gitignored); use the least-privileged role that does the job; rotate by revoking the Application Password in wp-admin.

---

## Known limitations

- **This is not a sandbox.** An administrator credential can do administrator things. Guardrails constrain accidents, not a determined operator.
- **`allowInsecureTLS: true` disables certificate verification** for that site. It exists for staging boxes with self-signed certificates; never use it on a site that matters.
- **Raw SQL bypasses WordPress hooks**, so caches are not invalidated and plugin logic does not run. Tools that expose it say so.
- **Workers audit logging is best-effort** unless you bind KV — isolates are evicted freely. The site-side log does not have this limitation.
- **`get_page_html` does not execute JavaScript.** It returns server-rendered HTML, and says so.
