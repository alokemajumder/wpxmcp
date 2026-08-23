import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SiteRegistry } from "./registry.js";
import { WPError } from "./errors.js";

export interface ToolContext {
  registry: SiteRegistry;
}

export interface CallToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
}

/** Every content/taxonomy/media tool accepts this so one server can drive many sites. */
export const siteIdSchema = z
  .string()
  .optional()
  .describe(
    "Which configured WordPress site to act on. Optional — with a single site configured it is used automatically; with several, the default site is used unless you name one. Run list_sites for valid ids."
  );

export function ok(payload: unknown, note?: string): CallToolResult {
  const text = typeof payload === "string" ? payload : JSON.stringify(payload, null, 2);
  return { content: [{ type: "text", text: note ? `${note}\n\n${text}` : text }] };
}

export function fail(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

/** Turns any thrown value into a readable, actionable tool error instead of a stack trace. */
export function toErrorResult(error: unknown): CallToolResult {
  if (error instanceof WPError) return fail(error.toReport());
  if (error instanceof z.ZodError) {
    return fail("Invalid arguments:\n" + error.issues.map((i) => `- ${i.path.join(".") || "(root)"}: ${i.message}`).join("\n"));
  }
  if (error instanceof Error) return fail(error.message);
  return fail(String(error));
}

type Handler<S extends z.ZodRawShape> = (args: z.infer<z.ZodObject<S>>) => Promise<CallToolResult>;

export interface ToolSpec<S extends z.ZodRawShape> {
  name: string;
  title: string;
  description: string;
  schema: S;
  handler: Handler<S>;
  readOnly?: boolean;
  destructive?: boolean;
  idempotent?: boolean;
}

export function defineTool<S extends z.ZodRawShape>(spec: ToolSpec<S>): ToolSpec<S> {
  return spec;
}

export function registerTools(server: McpServer, tools: Array<ToolSpec<any>>) {
  for (const tool of tools) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.schema,
        annotations: {
          title: tool.title,
          readOnlyHint: tool.readOnly ?? false,
          destructiveHint: tool.destructive ?? false,
          idempotentHint: tool.idempotent ?? false,
          openWorldHint: true,
        },
      },
      async (args: any) => {
        try {
          return (await tool.handler(args)) as any;
        } catch (error) {
          return toErrorResult(error) as any;
        }
      }
    );
  }
}

/** Keeps tool output small enough to stay useful in a model's context. */
export function trimText(value: unknown, max = 4000): string {
  const s = typeof value === "string" ? value : JSON.stringify(value);
  if (!s) return "";
  return s.length > max ? `${s.slice(0, max)}\n…[truncated ${s.length - max} more characters]` : s;
}

export function stripHtml(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#\d+;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function wordCount(html: string): number {
  const text = stripHtml(html);
  return text ? text.split(/\s+/).length : 0;
}

/** WordPress returns most text fields as {rendered, raw}. */
export function unwrap(field: any): string {
  if (field === null || field === undefined) return "";
  if (typeof field === "string") return field;
  if (typeof field === "object") return field.raw ?? field.rendered ?? "";
  return String(field);
}
