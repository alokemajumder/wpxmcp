# The companion plugin

Core WordPress REST cannot reach some things at all — there is no endpoint for running WP-CLI, reading a theme file or the PHP error log, profiling a request, or submitting a plugin's settings screen. The plugin in [`wp-plugin/wpxmcp-helper`](../wp-plugin/wpxmcp-helper) adds those endpoints under the `wpxmcp/v1` namespace.

**It is optional.** Posts, pages, media, taxonomies, users, comments, plugins, menus, widgets, block templates, global styles, SEO metadata, link checks and the fleet report all work without it. The [tool reference](TOOLS.md) marks the tools that need it (🔌) and the ones that return more when it is present (➕).

**Keep it in step with the server.** Tools added in 2.0.0 call routes a 1.0.0 plugin does not have; when they meet an older plugin they say it needs updating rather than failing obscurely.

---

## Install

1. Zip the `wp-plugin/wpxmcp-helper` folder (the folder itself, not its contents).
2. **Plugins → Add New → Upload Plugin** → choose the zip → **Install Now** → **Activate**.
3. Run `test_site`. The check named *Companion plugin* should now pass.

Or from the command line:

```bash
cd wp-plugin && zip -r wpxmcp-helper.zip wpxmcp-helper
```

To update, deactivate and delete the old copy, then upload the new zip. Settings, snippets, field groups and the audit log are stored in options and survive.

Requires WordPress 6.0+ and PHP 7.4+.

---

## Routes

Every route is under `/wp-json/wpxmcp/v1` (or `?rest_route=/wpxmcp/v1/…`), and every route's permission check is the same administrator check described under [Security](#security). Routes marked **theme editor** additionally need the `edit_themes` capability.

### Site, WP-CLI, SQL, meta and options — `class-wpxmcp-rest.php`

| Method | Route | Tools |
| --- | --- | --- |
| GET | `/site-info` | `site_info`, `fleet_report` — PHP version, database and table sizes, Site Health *direct* tests, pending updates. Core exposes only the async tests at `wp-site-health/v1`, which wpxmcp runs without the plugin. |
| POST | `/cli` | `run_wp_cli` — 50+ emulated commands |
| POST | `/sql` | `execute_sql_query` |
| GET, POST | `/meta` | `get_content_meta`, `set_content_meta`, `get_seo_meta` and `set_seo_meta` (for SEO keys not registered with `show_in_rest`) |
| GET, POST | `/options` | `get_options`, `set_option`, `seo_site_check` |
| GET, POST | `/theme-mods` | `get_theme_mods`, `set_theme_mod` |
| GET | `/roles` | `list_roles` |
| GET | `/abilities` | `discover_abilities` (on sites without the core Abilities API) |
| GET | `/audit` | The site-side audit log, for an administrator reading it over REST |

### Themes and drafts — `class-wpxmcp-themes.php`

| Method | Route | Tools |
| --- | --- | --- |
| GET | `/themes/files` | `list_theme_files` |
| GET | `/themes/file` | `read_theme_file`, `edit_theme_file`, `validate_theme_json` |
| POST, DELETE | `/themes/file` | `write_theme_file`, `edit_theme_file`, `delete_theme_file` — **theme editor** |
| POST, DELETE | `/themes/draft` | `create_draft_theme`, `delete_draft_theme` — **theme editor** |
| GET | `/themes/drafts` | `list_draft_themes`, `publish_draft_theme` (its preview) |
| POST | `/themes/scaffold` | `create_classic_theme` — **theme editor** |
| GET | `/themes/preview-url` | `get_preview_url` |
| POST | `/themes/publish` | `publish_draft_theme` — **theme editor** |
| POST | `/themes/activate` | `activate_theme` |
| POST | `/themes/install` | `install_theme` |

### Editable fields and snippets — `class-wpxmcp-fields.php`, `class-wpxmcp-snippets.php`

| Method | Route | Tools |
| --- | --- | --- |
| GET, POST | `/fields` | `list_field_groups`, `register_fields` |
| DELETE | `/fields/{group_key}` | `delete_field_group` |
| GET, POST | `/snippets` | `code_snippet` (list, create) |
| GET, POST, DELETE | `/snippets/{id}` | `code_snippet` (get, update, delete) |

### Diagnostics — `class-wpxmcp-diagnostics.php`

| Method | Route | Tools |
| --- | --- | --- |
| GET | `/logs` | `tail_error_log` — reads backwards from the end of the log (at most 2,000 lines and 8 MB scanned), groups duplicates, attributes each to a plugin, theme or core file |
| POST | `/cache/purge` | `purge_cache` — only URLs on this site |
| GET | `/security` | `security_audit` — the inside-out half: debug display, file editor, `wp-config.php` location and permissions, administrator usernames, application passwords, salts, updates, PHP support, inactive plugins and themes |
| GET | `/backups` | `backup_status` |

### Introspection — `class-wpxmcp-inspect.php`

| Method | Route | Tools |
| --- | --- | --- |
| GET | `/registry` | `inspect_registry` |
| GET | `/options/report` | `inspect_options` |
| POST | `/options/cleanup` | `cleanup_options` — a dry run unless `dry_run` is explicitly false; at most 200 names per call |
| GET | `/database` | `inspect_database` |

### Profiling — `class-wpxmcp-profiler.php`

| Method | Route | Tools |
| --- | --- | --- |
| POST | `/profile/token` | `profile_url`, `get_template_for_url` — issues a profiling token |
| GET | `/profile/result` | `profile_url`, `get_template_for_url` — collects the report |

### Plugin administration — `class-wpxmcp-admin.php`

| Method | Route | Tools |
| --- | --- | --- |
| GET | `/plugins/inspect` | `inspect_plugin`, `update_plugin_settings` (its preview) |
| GET | `/plugins/settings` | `get_plugin_settings`, `update_plugin_settings` (its preview) |
| POST | `/plugins/settings` | `update_plugin_settings` |
| POST | `/plugins/settings/restore` | `restore_plugin_settings` |
| GET | `/admin/menu` | `list_admin_pages` |
| GET | `/admin/allowed-options` | `submit_admin_form` — which options `options.php` accepts for a settings group, as captured on the last admin-token request |
| POST | `/admin/token` | `admin_page`, `submit_admin_form`, `inspect_plugin`, `list_admin_pages` — issues an admin token |

### Front-end parameters

Three query parameters are read on ordinary (non-REST) requests. Each does nothing without a valid token issued through the routes above.

| Parameter | Issued by | Effect |
| --- | --- | --- |
| `wpxmcp_preview` | `/themes/preview-url` | Renders that request with a draft theme. Valid for 6 hours, and reusable until then. |
| `wpxmcp_profile` | `/profile/token` | Profiles that one request. |
| `wpxmcp_admin` | `/admin/token` | Authenticates that one wp-admin request as the issuing administrator. |

---

## Security

### Who can call it

- **Administrators only.** Every route requires an authenticated user with `manage_options`; an unauthenticated request gets `401` and a non-administrator `403`.
- **Network super admins on multisite.** A site administrator holds `manage_options` too, but SQL, plugin installs and theme files reach every site on the network, so on multisite every route requires `is_super_admin()`.
- **`DISALLOW_FILE_EDIT` and `DISALLOW_FILE_MODS` are honoured.** Writing, deleting or scaffolding theme files, creating or deleting drafts, and publishing a draft require `edit_themes`, which those constants remove. The WP-CLI emulation checks `install_plugins`, `activate_plugins`, `update_plugins`, `delete_plugins`, `install_themes`, `update_themes` and `switch_themes` before acting, and names the constant when it refuses.

### Single-use tokens for profiling and wp-admin

Profiling a page, or loading a wp-admin screen, happens in a normal front-end request that cannot carry the Application Password. The plugin bridges that with tokens:

- **Issued over authenticated REST** to an administrator, and re-checked when used: the issuing user must still be an administrator (a super admin on multisite, for admin tokens).
- **32 random characters, valid for two minutes, used once.** The token is deleted the moment a request presents it, before anything else runs. A reused, expired or malformed token is ignored and the page renders as it would for anyone.
- **Stored only as a keyed hash** — HMAC-SHA256 with the site's nonce salt — never as the token itself.
- **Bound to one request.** A profiling token matches only the path and query string it was issued for; an admin token only the wp-admin script, query string and HTTP method. A mismatch spends the token and changes nothing.
- **At most 20 outstanding tokens per user**, for each kind.
- **Never cached.** A token-carrying request defines `DONOTCACHEPAGE` and sends no-cache headers.
- **Profiling runs as a visitor by default** — any cookie that came along is ignored — or as the issuing administrator with `as_logged_in`. The report is stored for five minutes, readable only by the user who requested it, and deleted when read. Nothing is printed into the profiled page.
- **Admin requests leave nothing behind.** The request is authenticated in memory; no `Set-Cookie` header is sent; the token is removed from the request before WordPress can echo it into a form or a redirect; and the session created for the request is destroyed at shutdown. Tokens may carry a flow id: the wp-admin session is derived from the user and that id, so the page load and form POST of one operation share a session (and the form's nonce validates), while separate operations — and tokens issued without a flow — never share one.
- **Viewing and posting forms, not actions.** A GET admin token cannot carry a nonce parameter (such a URL activates, deletes or trashes something), and admin tokens cannot POST to network-admin screens.
- **Every admin token issued and every request it authenticates** is written to the audit log.

### Settings writes

- `/plugins/settings` writes through `update_option()`, so any sanitize callback attached to the option runs. The response says whether one ran and which fields the sanitizer changed or dropped.
- The option must be attributable to the named plugin — one of its registered settings, or matching its option prefixes — unless `force_option` is passed.
- **The previous value is backed up first**: the last five values per option, in a non-autoloaded `wpxmcp_settings_backup_*` option. `/plugins/settings/restore` backs up the current value before restoring, so a restore is itself undoable.
- Values under secret-looking keys (`pass`, `secret`, `token`, `api_key`, `license`, `private_key`) are masked in every response unless `reveal` is passed on a read.

### Data, SQL and code

- **SQL writes need a second opt-in.** Even with the client's `allow_mutation` and a confirmation token, the plugin refuses mutating SQL unless `wp-config.php` contains:
  ```php
  define( 'WPXMCP_ALLOW_SQL_WRITES', true );
  ```
  Two independent switches, one on each side.
- **Stacked statements are refused**, and statements that read or write files on the database server (`INTO OUTFILE`, `INTO DUMPFILE`, `LOAD_FILE`, `LOAD DATA`) are refused in every mode. The plugin inspects the statement with its own lexer — string literals blanked, comments removed, executable `/*! */` comments kept as code.
- **Read-only queries run in a read-only transaction** (`START TRANSACTION READ ONLY`), and row limits are applied in the database. Results report `truncated` when the limit cut them off.
- **`search-replace` must be dry-run first.** A real run is refused (`409`) unless the same user ran a dry run of the same search and replacement within the last ten minutes; the real run consumes it. It never rewrites the plugin's own `wpxmcp_` options, handles serialised data structurally, and skips corrupt serialised values instead of destroying them.
- **Protected options** cannot be written or deleted through any route — `/options`, WP-CLI `option update` and `option delete`, editable fields, options cleanup, or plugin settings writes and restores: `siteurl`, `home`, `active_plugins`, `active_sitewide_plugins`, `template`, `stylesheet`, `cron`, `db_version`, `rewrite_rules`, `upload_path`, `upload_url_path`, `default_role`, any `*_user_roles` option, the auth/secure_auth/logged_in/nonce keys and salts, and every option prefixed `wpxmcp_`. The last group protects the plugin's own guard state: writing `wpxmcp_snippets` directly would switch on PHP without the wp-admin review, and the audit log is meant to be append-only. Options cleanup also refuses every option a fresh install creates.
- **Path traversal is blocked.** Theme names must be a single path segment (not `.` or `..`); paths containing `..`, null bytes or `:` (drive letters, stream wrappers) are refused; the resolved path must stay inside the theme directory, checked through the nearest existing ancestor so a symlink cannot escape; and extensions are allowlisted. Files over 5 MB are not returned; binary files come back base64-encoded.
- **Live themes are protected.** Writing to or deleting from the active theme is refused unless explicitly overridden.
- **PHP is linted before it is written.** A parse error is reported instead of fataling the site.
- **Snippets arrive disabled**, and can only be activated from wp-admin. Changing the code of an active snippet disables it until it is reviewed again. A snippet that throws, or triggers a fatal error, disables itself and records the error. If a snippet still takes the site down, add this to `wp-config.php` to skip every snippet while you fix it:
  ```php
  define( 'WPXMCP_SAFE_MODE', true );
  ```
- **Everything sensitive is logged** to an append-only record of the last 500 entries in the `wpxmcp_audit_log` option, with the user, time, action and IP.

### What it costs ordinary requests

Very little. On a normal request without any wpxmcp parameter:

- **Profiling and admin access cost one `isset()` each.** The profiler and the admin surface only look for `wpxmcp_profile` and `wpxmcp_admin` in the query string; without one, no collector, error handler or authentication hook is ever registered.
- **Draft previews** check for `wpxmcp_preview` once per request, when WordPress first asks for the theme.
- **The fatal-error recorder** reads `error_get_last()` once at shutdown, and writes to the database only after a fatal error — at most once a minute for the same error — so `tail_error_log` can show the last fatal even when logging is off.
- **Snippets and editable fields** run only if you have activated a snippet or registered a field group.

REST routes are registered only on REST requests, like any plugin's.

---

## The theme draft workflow

`create_draft_theme` copies the theme to `wp-content/themes/wpxmcp-draft-<theme>-<timestamp>/`. Edits go there; the live site is untouched. Symlinks are never followed, `node_modules` and `.git` are skipped, and a theme with more than 5,000 files is refused rather than copied partially.

`get_preview_url` issues a 6-hour token. Requests carrying it render the draft through the `stylesheet` and `template` filters; everyone else sees the live theme.

`publish_draft_theme` accepts only a wpxmcp draft, and refuses one whose `style.css` header is broken or whose parent theme is missing. It copies the current theme to `wpxmcp-backup-<theme>-<timestamp>/` **before** switching, and refuses to publish at all if that backup fails. If the draft has no theme mods of its own, the live theme's (logo, colours, menu locations) are carried over. Rolling back is one `activate_theme` call.

Site Editor customisations (user global styles, edited templates) belong to the active theme and do not follow the switch; `publish_draft_theme` lists them in its preview so they can be baked into the draft first.

---

## Editable fields

`register_fields` stores a group definition and registers each field with WordPress. Fields render as native meta boxes (or a settings page under **Settings → Site Fields**) and are exposed to REST, so `get_content` and `update_content` can read and write them through `meta`.

Fourteen types: `text`, `textarea`, `wysiwyg`, `number`, `email`, `url`, `date`, `select`, `checkbox`, `radio`, `color`, `image`, `gallery`, `repeater`.

A field key cannot start with `wpxmcp_`. In a site-wide (options) group it also cannot name a protected option, or take over a setting that WordPress or another plugin already registered.

Values are stored as **standard post meta and options**. Deactivating the plugin removes the editing UI, not the data.

---

## Uninstalling

Deactivate and delete as usual. Your content is untouched. Left behind are a few options — `wpxmcp_version`, `wpxmcp_audit_log`, `wpxmcp_field_groups`, `wpxmcp_snippets`, `wpxmcp_drafts`, `wpxmcp_preview_tokens`, `wpxmcp_last_fatal` and any `wpxmcp_settings_backup_*` — short-lived `wpxmcp_*` transients that expire on their own, and any draft or backup theme directories, which you can remove manually.
