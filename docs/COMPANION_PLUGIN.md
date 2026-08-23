# The companion plugin

Core WordPress REST cannot reach some things at all — there is no endpoint for running WP-CLI, reading a theme file, or writing a meta key that was registered without `show_in_rest`. The plugin in [`wp-plugin/wpxmcp-helper`](../wp-plugin/wpxmcp-helper) adds those endpoints under the `wpxmcp/v1` namespace.

**It is optional.** Posts, pages, media, taxonomies, users, comments, plugins, menus, widgets, block templates and global styles all work without it.

---

## Install

1. Zip the `wp-plugin/wpxmcp-helper` folder (the folder itself, not its contents).
2. **Plugins → Add New → Upload Plugin** → choose the zip → **Install Now** → **Activate**.
3. Run `test_site`. The check named *Companion plugin* should now pass.

Or from the command line:

```bash
cd wp-plugin && zip -r wpxmcp-helper.zip wpxmcp-helper
```

---

## What it adds

| Endpoint | Tools it powers |
| --- | --- |
| `/site-info` | `site_info` — PHP version, database and table sizes, Site Health *direct* tests, pending updates. Core exposes only the async tests at `wp-site-health/v1` (loopback, HTTPS, background updates, the Authorization header), which wpxmcp uses without the plugin. |
| `/cli` | `run_wp_cli` — 50+ emulated commands |
| `/sql` | `execute_sql_query` |
| `/meta` | `get_content_meta`, `set_content_meta` |
| `/options` | `get_options`, `set_option` |
| `/theme-mods` | `get_theme_mods`, `set_theme_mod` |
| `/themes/*` | Every theme file and draft tool |
| `/fields` | `register_fields`, `list_field_groups`, `delete_field_group` |
| `/snippets` | `code_snippet` |
| `/roles`, `/abilities`, `/audit` | `list_roles`, `discover_abilities`, site-side audit |

---

## Security

- **Administrator only.** Every route requires an authenticated user with `manage_options`.
- **SQL writes need a second opt-in.** Even with the client's `allow_mutation` and a confirmation token, the plugin refuses mutating SQL unless `wp-config.php` contains:
  ```php
  define( 'WPXMCP_ALLOW_SQL_WRITES', true );
  ```
  Two independent switches, one on each side.
- **Stacked statements are refused** at the plugin, not only at the client.
- **Protected options** (`siteurl`, `home`, `active_plugins`, `template`, `stylesheet`) cannot be written — those are the values that lock you out of your own site.
- **Path traversal is blocked.** Theme paths are confined to the theme directory, symlinks resolved, and extensions allowlisted.
- **Live themes are protected.** Writing to the active theme is refused unless explicitly overridden.
- **PHP is linted before it is written.** A parse error is reported instead of fataling the site.
- **Snippets arrive disabled**, and can only be activated from wp-admin. A misbehaving snippet disables itself rather than taking down every request.
- **Everything sensitive is logged** to an append-only, bounded record in the `wpxmcp_audit_log` option.

---

## The theme draft workflow

`create_draft_theme` copies the theme to `wp-content/themes/wpxmcp-draft-<theme>-<timestamp>/`. Edits go there; the live site is untouched.

`get_preview_url` issues a 6-hour token. Requests carrying it render the draft through the `stylesheet` and `template` filters; everyone else sees the live theme.

`publish_draft_theme` copies the current theme to `wpxmcp-backup-<theme>-<timestamp>/` **before** switching, and refuses to publish at all if that backup fails. Rolling back is one `activate_theme` call.

---

## Editable fields

`register_fields` stores a group definition and registers each field with WordPress. Fields render as native meta boxes (or a settings page under **Settings → Site Fields**) and are exposed to REST, so `get_content` and `update_content` can read and write them through `meta`.

Thirteen types: `text`, `textarea`, `wysiwyg`, `number`, `email`, `url`, `date`, `select`, `checkbox`, `radio`, `color`, `image`, `gallery`, `repeater`.

Values are stored as **standard post meta and options**. Deactivating the plugin removes the editing UI, not the data.

---

## Uninstalling

Deactivate and delete as usual. Your content is untouched. Left behind are a few options (`wpxmcp_audit_log`, `wpxmcp_field_groups`, `wpxmcp_snippets`, `wpxmcp_drafts`, `wpxmcp_preview_tokens`) and any draft or backup theme directories, which you can remove manually.
