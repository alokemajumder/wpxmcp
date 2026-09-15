import { fingerprintOp } from "./safety.js";
import type { WordPressClient } from "./client.js";
import { requireHelper } from "./http-utils.js";

/** Registries inspect_registry can read, in the order they are documented. */
export const REGISTRY_KINDS = [
  "post_types", "taxonomies", "meta", "blocks", "shortcodes", "rest_routes", "hooks", "cron",
  "image_sizes", "menus_locations", "sidebars", "capabilities", "scripts_styles",
] as const;
export type RegistryKind = (typeof REGISTRY_KINDS)[number];

export const CLEANUP_ACTIONS = ["delete_expired_transients", "set_autoload_off", "delete_options"] as const;
export type CleanupAction = (typeof CLEANUP_ACTIONS)[number];

export const MAX_CLEANUP_NAMES = 200;

/** One-line pointer shown with each registry kind, so the next step is obvious. */
export const REGISTRY_HINTS: Record<RegistryKind, string> = {
  post_types: "Includes types hidden from REST (show_in_rest false) — those cannot be edited through wp/v2; use execute_sql_query or the owning plugin's API.",
  taxonomies: "Includes taxonomies hidden from REST.",
  meta: "Registered meta is REST-visible; unregistered keys are not — read or write them with get_content_meta/set_content_meta or register_fields.",
  blocks: "is_dynamic blocks render in PHP, so their saved markup is only a placeholder.",
  shortcodes: "file:line points at the callback that renders each shortcode.",
  rest_routes: "permission \"public\" routes answer anonymous requests — review what they expose.",
  hooks: "Without filter: the busiest hooks. With filter set to an exact hook name: every callback with priority, file:line and owner.",
  cron: "orphan events have no callback attached; overdue events usually mean WP-Cron is not being triggered.",
  image_sizes: "Every registered size is generated for each upload — unused plugin sizes waste disk.",
  menus_locations: "Classic menu locations and the menus assigned to them.",
  sidebars: "Registered widget areas and how many widgets each holds.",
  capabilities: "added/removed are relative to a fresh WordPress install.",
  scripts_styles: "Only handles registered during a REST request; front-end enqueues need a page profile.",
};

/** Trimmed, de-duplicated, sorted option names — sorted so the fingerprint does not depend on order. */
export function normalizeOptionNames(names: readonly string[] | undefined): string[] {
  const out = [...new Set((names ?? []).map((n) => String(n ?? "").trim()).filter(Boolean))].sort();
  if (out.length > MAX_CLEANUP_NAMES) {
    throw new Error(`At most ${MAX_CLEANUP_NAMES} option names per cleanup call; got ${out.length}. Split the list.`);
  }
  return out;
}

/** Whether a cleanup preview contains anything that would actually change. */
export function previewHasChanges(action: CleanupAction, preview: any): boolean {
  if (action === "delete_expired_transients") {
    return Number(preview?.expired_count ?? 0) + Number(preview?.orphan_timeouts ?? 0) > 0;
  }
  return Array.isArray(preview?.changes) && preview.changes.length > 0;
}

/**
 * Binds a confirm_token to the action, the names and what the preview showed.
 *
 * For named actions the digest is each option's name, size and autoload value,
 * so an option that grew, was re-autoloaded or appeared since the preview
 * invalidates the token. Transients expire continuously, so for
 * delete_expired_transients the token is bound to the rule rather than to the
 * exact set: the apply step deletes whatever is expired at that moment.
 */
export function cleanupFingerprint(site: string, action: CleanupAction, names: readonly string[], preview: any): string {
  const digest = action === "delete_expired_transients"
    ? []
    : (Array.isArray(preview?.changes) ? preview.changes : [])
      .map((c: any) => [String(c?.name ?? ""), Number(c?.bytes ?? 0), String(c?.autoload ?? "")])
      .sort((a: any[], b: any[]) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return fingerprintOp(["cleanup_options", site, action, [...names], digest]);
}

/** The helper plugin's namespace, or an actionable error when it is missing. */
export const requireHelperNamespace = requireHelper;

/** A plugin that predates these routes answers 404 rest_no_route — say so plainly. */
export function explainMissingRoute(error: unknown, tool: string): never {
  const e = error as any;
  if (e && (e.status === 404 || /rest_no_route/.test(String(e.code ?? e.message ?? "")))) {
    throw new Error(
      `"${tool}" needs a newer wpxmcp companion plugin — this site's copy does not have the route. Update wp-plugin/wpxmcp-helper on the site, then retry.`
    );
  }
  throw error;
}
