---
name: security-hardening
title: Security audit, hardening and hack response
description: Use for a security review, hardening a site, vulnerable plugins, or a suspected hack (unknown admins, injected spam, redirects, malware warnings).
keywords: security, secure, security audit, hardening, harden, hacked, is my site hacked, hack, malware, infected, compromised, spam links injected, redirect hack, vulnerability, vulnerabilities, vulnerable plugin, cve, xmlrpc, brute force, user enumeration, wp-config, security headers, salts, file editor, application passwords, unknown admin
---

## When this applies

Proactive review or hardening, a vulnerability notice, or signs of compromise. If the site is down, restore service first with `site-down`.

## Rules

1. `backup_status` before any change. On a suspected hack, do not let a new backup overwrite the last clean one.
2. Read `checks_skipped` before quoting a score: without the companion plugin only outside probes and vulnerability lookups run.
3. A leaked secret stays leaked after the file is removed: rotate it (passwords, application passwords, salts, database password).
4. Hardening snippets are created disabled by `code_snippet`; the owner reads and activates them in wp-admin.
5. Never delete the account wpxmcp authenticates as, and never revoke its own application password (find it with the introspect route below).
6. wpxmcp cannot edit wp-config.php or server config; give exact lines to the owner or host.
7. Never paste the contents of an exposed file into a report.

## Procedure

1. `backup_status`, then `security_audit`. Findings come sorted with `severity`, `evidence`, `fix` and often `tool_to_fix`.
2. Vulnerable or outdated code: `run_wp_cli` with `command: "plugin update {slug}"` or `command: "theme update {stylesheet}"`, one at a time, checking `get_page_html` after each. Inactive and unneeded: `delete_plugin` with `plugin` and `confirm: true` (inactive code is still reachable). No fixed version: `deactivate_plugin` and find a replacement.
3. Users: `list_users` with `roles: ["administrator"]`; confirm each with the owner. Rename-by-replacement for an `admin` username: `create_user` a new administrator, owner logs in with it, then `delete_user` with `id`, `reassign_to` and `confirm: true`.
4. Application passwords: `rest_api` with `route: "/wp/v2/users/{id}/application-passwords"` lists them (name, created, last used, IP); `rest_api` with `route: "/wp/v2/users/me/application-passwords/introspect"` identifies the one in use. Revoke stale ones with `rest_api` with `route: "/wp/v2/users/{id}/application-passwords/{uuid}"` and `method: "DELETE"` after the owner agrees.
5. Registration: `update_site_settings` with `users_can_register: false` unless needed; the default role must stay subscriber (change it in Settings → General; tools refuse it).
6. Snippets for medium findings (`code_snippet` with `action: "create"`, `language: "php"`, `title`, `description`, `code`), from the reference below.
7. Suspected hack, in order: `tail_error_log` with `level: "warning"` and `since` around the first symptom (unknown `by_source` entries); `run_wp_cli` with `command: "core verify-checksums"` (modified core files); `code_snippet` with `action: "list"` (unknown active snippets); `inspect_registry` with `kind: "rest_routes"` (unexpected public routes) and `kind: "cron"` (unknown events); administrators and application passwords as above; `list_plugins` for plugins nobody installed. Then rotate every credential and `purge_cache` with `scope: "all"`.
8. Re-run `security_audit`.

## Verify

`security_audit` shows the fixed findings gone and no new critical or high ones; `get_page_html` with `url: "/"` renders normally; for a cleanup, `core verify-checksums` is clean.

## Report back

Lead with grade, score and critical/high counts, then a numbered action list by severity, each marked who does it (done by wpxmcp, owner in wp-admin, host). Mention `checks_skipped`. For a hack: this process finds the entry points and persistence it can see; recommend a malware scan by the host or a security service before declaring the site clean.

## Reference: snippets (`code_snippet`, PHP without `<?php`)

```php
// Disable XML-RPC when nothing uses it (Jetpack and the mobile apps may).
add_filter( 'xmlrpc_enabled', '__return_false' );
add_filter( 'xmlrpc_methods', function ( $m ) { unset( $m['pingback.ping'], $m['pingback.extensions.getPingbacks'], $m['system.multicall'] ); return $m; } );

// Hide user listing from anonymous REST requests.
add_filter( 'rest_endpoints', function ( $e ) {
	if ( ! is_user_logged_in() ) { unset( $e['/wp/v2/users'], $e['/wp/v2/users/(?P<id>[\d]+)'] ); }
	return $e;
} );

// Stop ?author=N revealing usernames; drop the generator tag.
add_action( 'template_redirect', function () {
	if ( ! is_user_logged_in() && isset( $_GET['author'] ) ) { wp_safe_redirect( home_url( '/' ), 301 ); exit; }
} );
remove_action( 'wp_head', 'wp_generator' );

// Baseline headers (prefer the web server or CDN).
add_action( 'send_headers', function () {
	header( 'X-Content-Type-Options: nosniff' );
	header( 'X-Frame-Options: SAMEORIGIN' );
	header( 'Referrer-Policy: strict-origin-when-cross-origin' );
} );
```

Add `Strict-Transport-Security` only once HTTPS works everywhere it will cover (with `includeSubDomains`, every subdomain); browsers remember it for its max-age.

For the owner or host (wp-config.php and server):

```php
define( 'DISALLOW_FILE_EDIT', true );
define( 'WP_DEBUG_DISPLAY', false );
define( 'WP_DEBUG_LOG', '/home/USER/logs/wp-debug.log' ); // outside the web root
```

New salts from `https://api.wordpress.org/secret-key/1.1/salt/` (logs everyone out); wp-config.php `chmod 640` (600 when PHP runs as the owner); deny `.git`, `.env` and `*.bak` at the server; `Options -Indexes` (Apache) or `autoindex off;` (nginx); 301 http→https; PHP end-of-life upgrades on staging first.
