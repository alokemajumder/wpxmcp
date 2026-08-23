import { z } from "zod";
import { defineTool, ok, siteIdSchema, stripHtml, unwrap, type ToolContext } from "../lib/tooling.js";
import { platform } from "../lib/platform.js";
import { readLocalFile, guessMimeType, sanitizeFilename, type WordPressClient } from "../lib/client.js";
import { audit } from "../lib/safety.js";

function shapeMedia(m: any) {
  return {
    id: m.id,
    title: stripHtml(unwrap(m.title)),
    slug: m.slug,
    status: m.status,
    date: m.date,
    author: m.author,
    mime_type: m.mime_type,
    media_type: m.media_type,
    source_url: m.source_url,
    link: m.link,
    alt_text: m.alt_text ?? "",
    caption: stripHtml(unwrap(m.caption)),
    description: stripHtml(unwrap(m.description)).slice(0, 500),
    post: m.post ?? null,
    width: m.media_details?.width,
    height: m.media_details?.height,
    filesize: m.media_details?.filesize,
    sizes: m.media_details?.sizes ? Object.keys(m.media_details.sizes) : undefined,
  };
}

const MAX_UPLOAD_BYTES = 128 * 1024 * 1024;

/** Base64 decode that works on both Node and Workers. */
function decodeBase64(input: string): Uint8Array {
  const binary = atob(input);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function fetchRemote(url: string, timeoutMs: number): Promise<{ data: Uint8Array; filename: string; contentType: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(url, { signal: controller.signal, redirect: "follow", headers: { "User-Agent": "wpxmcp/1.0" } });
  } catch (e: any) {
    throw new Error(`Could not download "${url}": ${e?.message ?? e}. Check the URL is publicly reachable from the machine running this MCP server.`);
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw new Error(`Downloading "${url}" returned HTTP ${res.status} ${res.statusText}.`);

  const buffer = new Uint8Array(await res.arrayBuffer());
  if (buffer.byteLength > MAX_UPLOAD_BYTES) {
    throw new Error(`That file is ${(buffer.byteLength / 1024 / 1024).toFixed(1)} MB, above the ${MAX_UPLOAD_BYTES / 1024 / 1024} MB ceiling this tool enforces.`);
  }
  const headerType = res.headers.get("content-type")?.split(";")[0]?.trim();
  const urlName = (new URL(url).pathname.split("/").pop() || "download");
  const disposition = res.headers.get("content-disposition");
  const dispositionName = disposition ? /filename\*?=(?:UTF-8''|")?([^";]+)/i.exec(disposition)?.[1] : undefined;
  const filename = sanitizeFilename(decodeURIComponent(dispositionName ?? urlName));
  const withExt = /\.[a-z0-9]{1,5}$/i.test(filename) ? filename : `${filename}${extensionFor(headerType)}`;
  return { data: buffer, filename: withExt, contentType: headerType || guessMimeType(withExt) };
}

function extensionFor(mime?: string): string {
  const map: Record<string, string> = {
    "image/jpeg": ".jpg", "image/png": ".png", "image/gif": ".gif", "image/webp": ".webp",
    "image/avif": ".avif", "image/svg+xml": ".svg", "application/pdf": ".pdf",
    "video/mp4": ".mp4", "audio/mpeg": ".mp3", "application/zip": ".zip",
  };
  return (mime && map[mime]) || ".bin";
}

async function applyMediaFields(client: WordPressClient, id: number, fields: Record<string, unknown>) {
  const body: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) if (v !== undefined) body[k] = v;
  if (Object.keys(body).length === 0) return null;
  const res = await client.post<any>(`/wp/v2/media/${id}`, body);
  return res.data;
}

export function mediaTools(ctx: ToolContext) {
  const { registry } = ctx;
  const site = (id?: string) => registry.resolve(id);

  return [
    defineTool({
      name: "list_media",
      title: "List media",
      readOnly: true,
      description: "List items in the media library with search, type filtering, date filtering and pagination.",
      schema: {
        site_id: siteIdSchema,
        search: z.string().optional().describe("Match against title, caption, alt text and filename."),
        media_type: z.enum(["image", "video", "audio", "application", "text", "file"]).optional().describe("Filter by broad media type."),
        mime_type: z.string().optional().describe("Filter by exact MIME type, e.g. \"image/png\"."),
        parent: z.number().int().optional().describe("Only attachments attached to this content ID."),
        author: z.number().int().optional().describe("User ID of the author."),
        after: z.string().optional().describe("Uploaded after this ISO 8601 date."),
        before: z.string().optional().describe("Uploaded before this ISO 8601 date."),
        per_page: z.number().int().min(1).max(100).optional().default(20).describe("How many results per page."),
        page: z.number().int().min(1).optional().default(1).describe("Which page of results to return."),
        orderby: z.enum(["date", "id", "title", "slug", "modified", "include"]).optional().default("date").describe("Which field to sort by."),
        order: z.enum(["asc", "desc"]).optional().default("desc").describe("Sort direction."),
        missing_alt_text: z.boolean().optional().default(false).describe("Return only images with empty alt text — useful for an accessibility or SEO sweep."),
      },
      handler: async (args) => {
        const client = site(args.site_id);
        const res = await client.get<any[]>("/wp/v2/media", {
          search: args.search, media_type: args.media_type, mime_type: args.mime_type,
          parent: args.parent, author: args.author, after: args.after, before: args.before,
          per_page: args.per_page, page: args.page, orderby: args.orderby, order: args.order,
        });
        let items = res.data.map(shapeMedia);
        const totalBefore = items.length;
        if (args.missing_alt_text) items = items.filter((m) => m.media_type === "image" && !m.alt_text.trim());
        return ok({
          site: client.site.id,
          total: res.total ?? totalBefore,
          total_pages: res.totalPages ?? 1,
          page: args.page,
          returned: items.length,
          filtered_to_missing_alt: args.missing_alt_text || undefined,
          items,
        });
      },
    }),

    defineTool({
      name: "get_media",
      title: "Get a media item",
      readOnly: true,
      description: "Fetch one media item by ID, including its source URL, dimensions, generated sizes, alt text and where it is attached.",
      schema: { site_id: siteIdSchema, id: z.number().int().describe("The attachment ID.") },
      handler: async ({ site_id, id }) => {
        const client = site(site_id);
        const res = await client.get<any>(`/wp/v2/media/${id}`, client.hasCredentials() ? { context: "edit" } : {});
        return ok({ ...shapeMedia(res.data), media_details: res.data.media_details });
      },
    }),

    defineTool({
      name: "create_media",
      title: "Upload media",
      description:
        "Upload a file into the media library from any of three sources: `file_path` (a path on the machine running this MCP server — this is how you upload a local screenshot), `url` (downloaded here, then uploaded), or `base64_data`. WordPress runs its normal image pipeline, generating the registered thumbnail sizes. Always set alt_text for images — it is required for accessibility and read by search engines.",
      schema: {
        site_id: siteIdSchema,
        file_path: z.string().optional().describe("Absolute or ~-relative path on the machine running this MCP server. For a Mac screenshot that is typically \"~/Desktop/Screenshot 2026-08-23 at 2.29.04 PM.png\". Not a path on the WordPress host."),
        url: z.string().optional().describe("Public URL to download and re-upload into the library."),
        base64_data: z.string().optional().describe("Raw base64 file contents (a data: URI prefix is accepted and stripped). Requires `filename`."),
        filename: z.string().optional().describe("Filename to store as. Defaults to the source filename; required for base64_data."),
        title: z.string().optional().describe("Media title. Defaults to the filename."),
        alt_text: z.string().optional().describe("Alternative text. Set this for every image."),
        caption: z.string().optional().describe("Caption shown beneath the image."),
        description: z.string().optional().describe("Longer description, shown on the attachment page."),
        post: z.number().int().optional().describe("Attach the upload to this content ID."),
        set_as_featured_for: z.number().int().optional().describe("After uploading, set this attachment as the featured image of this content ID."),
        featured_for_type: z.string().optional().default("post").describe("Content type of set_as_featured_for."),
        attribution: z.string().optional().describe("Credit line for a stock photo; appended to the description."),
      },
      handler: async (args) => {
        const client = site(args.site_id);
        client.assertWritable("create_media");

        const sources = [args.file_path, args.url, args.base64_data].filter(Boolean);
        if (sources.length === 0) throw new Error("Provide exactly one source: `file_path`, `url`, or `base64_data`.");
        if (sources.length > 1) throw new Error("Provide only one of `file_path`, `url`, or `base64_data`.");

        let payload: { data: Uint8Array; filename: string; contentType: string };
        let sourceNote: string;

        if (args.file_path) {
          payload = readLocalFile(args.file_path);
          sourceNote = `local file ${args.file_path}`;
        } else if (args.url) {
          payload = await fetchRemote(args.url, client.site.timeoutMs ?? 60000);
          sourceNote = `downloaded from ${args.url}`;
        } else {
          if (!args.filename) throw new Error("`filename` is required with base64_data, so WordPress knows the file type.");
          const cleaned = args.base64_data!.replace(/^data:[^;]+;base64,/, "").replace(/\s/g, "");
          const data = decodeBase64(cleaned);
          if (data.byteLength === 0) throw new Error("base64_data decoded to zero bytes.");
          payload = { data, filename: sanitizeFilename(args.filename), contentType: guessMimeType(args.filename) };
          sourceNote = "inline base64 data";
        }

        if (args.filename) payload.filename = sanitizeFilename(args.filename);
        if (payload.data.byteLength > MAX_UPLOAD_BYTES) {
          throw new Error(`That file is ${(payload.data.byteLength / 1024 / 1024).toFixed(1)} MB, above the ${MAX_UPLOAD_BYTES / 1024 / 1024} MB ceiling.`);
        }

        const upload = await client.request<any>("/wp/v2/media", {
          method: "POST",
          raw: payload,
          timeoutMs: Math.max(client.site.timeoutMs ?? 60000, 180000),
        });
        const id = upload.data.id;

        let description = args.description;
        if (args.attribution) description = [description, args.attribution].filter(Boolean).join("\n\n");

        const updated = await applyMediaFields(client, id, {
          title: args.title, alt_text: args.alt_text, caption: args.caption, description, post: args.post,
        });

        let featured: any;
        if (args.set_as_featured_for) {
          const typeBase = await client.restBaseForType(args.featured_for_type ?? "post");
          const res = await client.post<any>(`/wp/v2/${typeBase}/${args.set_as_featured_for}`, { featured_media: id });
          featured = { content_id: args.set_as_featured_for, type: args.featured_for_type, ok: res.data.featured_media === id };
        }

        audit({ site: client.site.id, tool: "create_media", action: "upload", target: id, outcome: "ok", detail: payload.filename });

        const shaped = shapeMedia(updated ?? upload.data);
        const warnings: string[] = [];
        if (shaped.media_type === "image" && !shaped.alt_text) {
          warnings.push("No alt text was set on this image. Add it with update_media — screen readers and search engines both rely on it.");
        }
        return ok({
          uploaded: true,
          source: sourceNote,
          bytes: payload.data.byteLength,
          ...shaped,
          set_as_featured: featured,
          warnings: warnings.length ? warnings : undefined,
        });
      },
    }),

    defineTool({
      name: "update_media",
      title: "Update a media item",
      description: "Update a media item's title, alt text, caption, description or attachment — without re-uploading the file.",
      schema: {
        site_id: siteIdSchema,
        id: z.number().int().describe("The attachment ID."),
        title: z.string().optional().describe("Display title."),
        alt_text: z.string().optional().describe("Alternative text for accessibility and SEO."),
        caption: z.string().optional().describe("Caption shown beneath the item."),
        description: z.string().optional().describe("Longer descriptive text."),
        post: z.number().int().optional().describe("Re-attach to this content ID."),
        author: z.number().int().optional().describe("User ID of the author."),
        slug: z.string().optional().describe("URL slug."),
      },
      handler: async ({ site_id, id, ...fields }) => {
        const client = site(site_id);
        client.assertWritable("update_media");
        const updated = await applyMediaFields(client, id, fields);
        if (!updated) throw new Error("No fields to update were supplied.");
        audit({ site: client.site.id, tool: "update_media", action: "update", target: id, outcome: "ok", detail: Object.keys(fields).filter((k) => (fields as any)[k] !== undefined).join(",") });
        return ok({ updated: true, ...shapeMedia(updated) });
      },
    }),

    defineTool({
      name: "edit_media",
      title: "Edit a media item (alias)",
      description: "Legacy alias for update_media, kept for backward compatibility. Prefer update_media.",
      schema: {
        site_id: siteIdSchema,
        id: z.number().int().describe("The item ID."),
        title: z.string().optional().describe("Display title."),
        alt_text: z.string().optional().describe("Alternative text for accessibility and SEO."),
        caption: z.string().optional().describe("Caption shown beneath the item."),
        description: z.string().optional().describe("Longer descriptive text."),
        post: z.number().int().optional().describe("Attach to this content ID."),
      },
      handler: async ({ site_id, id, ...fields }) => {
        const client = site(site_id);
        client.assertWritable("edit_media");
        const updated = await applyMediaFields(client, id, fields);
        if (!updated) throw new Error("No fields to update were supplied.");
        return ok({ updated: true, ...shapeMedia(updated) }, "edit_media is a legacy alias — update_media is the current name.");
      },
    }),

    defineTool({
      name: "delete_media",
      title: "Delete a media item",
      destructive: true,
      description:
        "Delete a media item. Attachments bypass the trash by default in WordPress, so deletion removes the file from disk permanently and requires confirm: true. Any content still referencing the file will show a broken image.",
      schema: {
        site_id: siteIdSchema,
        id: z.number().int().describe("The attachment ID."),
        confirm: z.boolean().optional().default(false).describe("Required — the file is removed from disk and cannot be recovered."),
      },
      handler: async ({ site_id, id, confirm }) => {
        const client = site(site_id);
        client.assertWritable("delete_media");
        if (!confirm) {
          const current = await client.get<any>(`/wp/v2/media/${id}`);
          audit({ site: client.site.id, tool: "delete_media", action: "delete", target: id, outcome: "refused", detail: "confirm not set" });
          return ok({ deleted: false, requires_confirmation: true, ...shapeMedia(current.data) },
            "Deleting media removes the file from disk permanently, so nothing was deleted. This is what would go. Re-run with confirm: true to proceed.");
        }
        const res = await client.del<any>(`/wp/v2/media/${id}`, { force: true });
        audit({ site: client.site.id, tool: "delete_media", action: "delete", target: id, outcome: "ok" });
        return ok({ deleted: true, id, previous: res.data?.previous ? shapeMedia(res.data.previous) : undefined });
      },
    }),

    defineTool({
      name: "search_stock_photos",
      title: "Search stock photos",
      readOnly: true,
      description:
        "Search Unsplash or Pexels for royalty-free photos and get back candidate image URLs with their required attribution. Pass a chosen result's `download_url` to create_media (along with its `attribution`) to bring it into the library. Requires UNSPLASH_ACCESS_KEY or PEXELS_API_KEY to be set on this MCP server.",
      schema: {
        query: z.string().describe("What to search for, e.g. \"modern office desk\"."),
        provider: z.enum(["unsplash", "pexels", "auto"]).optional().default("auto").describe("Which provider to use. \"auto\" picks whichever API key is configured."),
        per_page: z.number().int().min(1).max(30).optional().default(10).describe("How many results per page."),
        orientation: z.enum(["landscape", "portrait", "squarish"]).optional().describe("Preferred aspect ratio."),
      },
      handler: async ({ query, provider, per_page, orientation }) => {
        // Must come from the platform: on Workers these are Worker Secrets in
        // `env`, and process.env is empty there.
        const runtimeEnv = platform().env;
        const unsplashKey = runtimeEnv.UNSPLASH_ACCESS_KEY;
        const pexelsKey = runtimeEnv.PEXELS_API_KEY;
        const chosen = provider === "auto" ? (unsplashKey ? "unsplash" : pexelsKey ? "pexels" : null) : provider;

        if (!chosen) {
          throw new Error(
            "No stock photo provider is configured. Set UNSPLASH_ACCESS_KEY (free at unsplash.com/developers) or PEXELS_API_KEY (pexels.com/api) in this MCP server's environment, then retry. You can still upload any image by URL with create_media."
          );
        }
        if (chosen === "unsplash" && !unsplashKey) throw new Error("UNSPLASH_ACCESS_KEY is not set on this MCP server.");
        if (chosen === "pexels" && !pexelsKey) throw new Error("PEXELS_API_KEY is not set on this MCP server.");

        if (chosen === "unsplash") {
          const url = new URL("https://api.unsplash.com/search/photos");
          url.searchParams.set("query", query);
          url.searchParams.set("per_page", String(per_page));
          if (orientation) url.searchParams.set("orientation", orientation);
          const res = await fetch(url, { headers: { Authorization: `Client-ID ${unsplashKey}`, "Accept-Version": "v1" } });
          if (!res.ok) throw new Error(`Unsplash returned HTTP ${res.status}: ${await res.text()}`);
          const json: any = await res.json();
          return ok({
            provider: "unsplash",
            query,
            total: json.total,
            results: (json.results ?? []).map((p: any) => ({
              id: p.id,
              description: p.description ?? p.alt_description,
              suggested_alt_text: p.alt_description ?? query,
              width: p.width, height: p.height, color: p.color,
              download_url: p.urls?.full ?? p.urls?.regular,
              preview_url: p.urls?.small,
              page_url: p.links?.html,
              attribution: `Photo by ${p.user?.name} on Unsplash (${p.links?.html})`,
            })),
          }, "Pass a result's download_url and attribution to create_media to import it. Unsplash's guidelines require crediting the photographer.");
        }

        const url = new URL("https://api.pexels.com/v1/search");
        url.searchParams.set("query", query);
        url.searchParams.set("per_page", String(per_page));
        if (orientation) url.searchParams.set("orientation", orientation === "squarish" ? "square" : orientation);
        const res = await fetch(url, { headers: { Authorization: pexelsKey! } });
        if (!res.ok) throw new Error(`Pexels returned HTTP ${res.status}: ${await res.text()}`);
        const json: any = await res.json();
        return ok({
          provider: "pexels",
          query,
          total: json.total_results,
          results: (json.photos ?? []).map((p: any) => ({
            id: p.id,
            description: p.alt,
            suggested_alt_text: p.alt || query,
            width: p.width, height: p.height, color: p.avg_color,
            download_url: p.src?.original,
            preview_url: p.src?.medium,
            page_url: p.url,
            attribution: `Photo by ${p.photographer} on Pexels (${p.url})`,
          })),
        }, "Pass a result's download_url and attribution to create_media to import it.");
      },
    }),
  ];
}
