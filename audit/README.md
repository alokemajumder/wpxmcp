# Live audit suite

The unit tests in `tests/` need no network and run in CI. These suites are different: they exercise every tool against a **real WordPress install**, which is the only way to catch the class of bug that unit tests structurally cannot — wrong REST routes, wrong HTTP methods, guards that look right but do not hold, and behaviour that differs between the two transports.

They are not run by CI because they need a WordPress to talk to.

## Setting up a throwaway WordPress

No database server required — WordPress runs on SQLite via the official integration plugin.

```bash
# 1. WordPress core
curl -sL https://wordpress.org/latest.tar.gz | tar xz && mv wordpress site

# 2. SQLite integration
curl -sL https://downloads.wordpress.org/plugin/sqlite-database-integration.zip -o s.zip
unzip -q s.zip -d site/wp-content/plugins/
cp site/wp-content/plugins/sqlite-database-integration/db.copy site/wp-content/db.php
sed -i '' "s#{SQLITE_IMPLEMENTATION_FOLDER_PATH}#$(pwd)/site/wp-content/plugins/sqlite-database-integration#" site/wp-content/db.php

# 3. wp-config.php — the two settings that matter
#    WP_ENVIRONMENT_TYPE=local   → Application Passwords work without HTTPS
#    WPXMCP_ALLOW_SQL_WRITES     → lets the mutating-SQL path be exercised

# 4. Install and serve
curl -sL https://raw.githubusercontent.com/wp-cli/builds/gh-pages/phar/wp-cli.phar -o wp-cli.phar
# Pick your own throwaway password; this install is local, disposable, and
# should never be reachable from the internet.
php wp-cli.phar core install --url=http://127.0.0.1:8090 --title="wpxmcp Test" \
  --admin_user=admin --admin_password="$(openssl rand -hex 12)" \
  --admin_email=test@example.com --skip-email
php -S 127.0.0.1:8090 -t site &

# 5. Credentials for the audit
php wp-cli.phar user application-password create admin wpxmcp --porcelain
```

Then write `$SP/sites.json`. `php -S` does not serve pretty permalinks, so use the plain REST prefix — which usefully exercises that code path too:

```json
{"sites":[{"id":"local","url":"http://127.0.0.1:8090","username":"admin",
           "appPassword":"<the value above>","restPrefix":"/?rest_route="}]}
```

Install the companion plugin to cover the tools that need it:

```bash
cp -r wp-plugin/wpxmcp-helper site/wp-content/plugins/
php wp-cli.phar plugin activate wpxmcp-helper
```

## Running

```bash
export SP=/path/to/scratch    # holds sites.json and the audit's WPX_HOME
npm run build

node audit/run.mjs      # the main sweep: reads, writes, refusals, error paths
node audit/run2.mjs     # widgets, templates, global styles, revisions,
                        # theme scaffolding, activation + rollback
node audit/run3.mjs     # dry-run → confirm → apply, for bulk, SQL and search-replace
# (npm run audit runs all three in that order)
```

**Both protocol eras.** The stdio suites connect through `audit/harness.mjs`, which uses the SDK v2 client (`@modelcontextprotocol/client`) and, by default, negotiates the **2026-07-28** revision. Run them a second time over the **2025-era** `initialize` handshake:

```bash
WPX_AUDIT_ERA=legacy node audit/run.mjs
WPX_AUDIT_ERA=legacy node audit/run2.mjs
WPX_AUDIT_ERA=legacy node audit/run3.mjs
```

**The Worker.** `audit/worker.mjs` talks to a running Worker over HTTP with two SDK v2 clients at once — one pinned to 2026-07-28, one on the legacy handshake — and checks that a confirmation token issued on one era is accepted on the other. It defaults to `http://127.0.0.1:8802`; `npm run cf:dev` listens on 8787 unless told otherwise, so either start it with `npx wrangler dev --port 8802` or set `WPX_AUDIT_URL`. Give it the same token the Worker is using — nothing is hardcoded:

```bash
WPX_AUTH_TOKEN=<the token in your .dev.vars> \
WPX_AUDIT_APPPW=<the application password from step 5> \
SP=/path/to/scratch \
  node audit/worker.mjs          # or: npm run audit:worker
```

Keep `SP` set for this one too: the tool-parity check starts the stdio server from `$SP/sites.json` and compares its `tools/list` with the Worker's, name for name. Without `SP` that check is skipped and reported as a note, so parity is not verified. `WPX_AUDIT_APPPW` is used only to assert the password never appears in any output.

No credential belongs in this repository. The audit reads them from the
environment, and `.dev.vars` is gitignored.

**Coverage is measured live.** `run.mjs` ends by listing the server's tools with `tools/list` and reporting any it did not exercise, so the coverage figure always reflects the tool surface as built — there is no checked-in tool list to fall out of date (the old `audit/all-tools.json` snapshot is gone).

**No private-address setting needed.** The throwaway site lives on `127.0.0.1`, and `create_media` and `check_links` refuse loopback and private addresses by default. The configured WordPress host is always exempt, so the audit runs without `WPX_ALLOW_PRIVATE_URLS`; leave it unset.

Each suite prints a problem count and exits non-zero if anything failed. The suites are idempotent — running them twice must stay clean.

## What they assert

Not merely "the call returned". Each check validates the *shape and meaning* of the result: that a summary never carries a body, that an edit reports one replacement, that content created without a status is a draft, that a permanently deleted post is really gone, and that a widget is reported in the sidebar it actually landed in.

Refusals are asserted just as carefully. A guard that fails open is worse than no guard, so the suites confirm that live-theme writes, path traversal, disallowed extensions, protected options, non-allowlisted commands, shell metacharacters, stacked SQL and unconfirmed destructive operations are each refused, **and** that the message explains why.

## Bugs these found that unit tests could not

- Ability routes matching the published docs but not core's actual registration
- Ability calls using the wrong HTTP verb, which core rejects with 405
- Identifiers containing slashes being double-encoded into a 404
- `rest_api` throwing on any response larger than `max_chars`
- Confirmation tokens not surviving between Cloudflare isolates
- Stock-photo keys read from `process.env`, which is empty on Workers
- `create_widget` reporting a sidebar placement that WordPress had overridden
