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
php wp-cli.phar core install --url=http://127.0.0.1:8090 --title="wpxmcp Test" \
  --admin_user=admin --admin_password=adminpass123 --admin_email=test@example.com --skip-email
php -S 127.0.0.1:8090 -t site &

# 5. Credentials for the audit
php wp-cli.phar user application-password create admin wpxmcp --porcelain
```

Then write `$SP/sites.json`. `php -S` does not serve pretty permalinks, so use the plain REST prefix — which usefully exercises that code path too:

```json
{"sites":[{"id":"local","url":"http://127.0.0.1:8090","username":"admin",
           "appPassword":"<the value above>","restPrefix":"/?rest_route="}]}
```

Install the companion plugin to cover the remaining 24 tools:

```bash
cp -r wp-plugin/wpxmcp-helper site/wp-content/plugins/
php wp-cli.phar plugin activate wpxmcp-helper
```

## Running

```bash
export SP=/path/to/scratch    # holds sites.json and the audit's WPX_HOME
npm run build

node audit/run.mjs      # 103 tools: reads, writes, refusals, error paths
node audit/run2.mjs     # the remaining 14: widgets, templates, global styles,
                        # revisions, theme scaffolding, activation + rollback
node audit/run3.mjs     # dry-run → confirm → apply, for bulk, SQL and search-replace
node audit/worker.mjs   # the same server over Streamable HTTP (needs `npm run cf:dev`)
```

Each prints a problem count and exits non-zero if anything failed. The suites are idempotent — running them twice must stay clean.

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
