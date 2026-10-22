/** src/extension/pi-types.ts — the minimal Pi surface this extension needs.
 *  Zero @earendil-works/* imports (the package must stay installable without
 *  the host SDK at runtime). */

export interface ToolTextContent {
  type: "text";
  text: string;
}

export interface ToolResult {
  content: ToolTextContent[];
  details?: Record<string, unknown>;
}

export interface SessionContext {
  cwd: string;
}

export type ToolExecuteFn = (
  toolCallId: string,
  params: Record<string, unknown>,
  signal?: unknown,
  onUpdate?: unknown,
  ctx?: SessionContext,
) => Promise<ToolResult>;

export interface ToolDefinition {
  name: string;
  label: string;
  description: string;
  promptSnippet?: string;
  parameters: Record<string, unknown>;
  execute: ToolExecuteFn;
}

export interface EventBusApi {
  emit(event: string, data: unknown): void;
  on?(event: string, handler: (data: unknown) => void): void;
}

export interface ExtensionAPI {
  registerTool(tool: ToolDefinition): void;
  /** Cross-extension bus (used for remote job control from pi-mesh). */
  events?: EventBusApi;
}

export function textResult(text: string, details?: Record<string, unknown>): ToolResult {
  const out: ToolResult = { content: [{ type: "text", text }] };
  if (details !== undefined) out.details = details;
  return out;
}
