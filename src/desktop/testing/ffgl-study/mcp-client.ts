import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

/**
 * VN91: a minimal stdio MCP client (JSON-RPC 2.0, one request at a time) for Resolume Arena's
 * own MCP server, so the oracle runs from a script rather than from an agent session.
 * Arena's server refuses every tool until the client confirms its instructions, which this
 * does on connect. It never sends a save/open/new: those need a person's confirmation.
 */
export interface McpContent { readonly type: string; readonly text?: string; readonly data?: string; readonly mimeType?: string }
export interface McpToolResult { readonly content: readonly McpContent[]; readonly isError?: boolean }

export const ARENA_MCP_SERVER = process.env["RESOLUME_MCP_SERVER"] ?? "/Applications/Resolume Arena/mcp/resolume_arena_mcp_server";
/** Composition-level actions that need a person's confirmation; the study never sends them. */
const REFUSED_COMPOSITION_ACTIONS = new Set(["save", "save_as", "open", "new"]);

export class McpClient {
  private child: ChildProcessWithoutNullStreams;
  private buffer = "";
  private next = 0;
  private pending = new Map<number, (message: { result?: unknown; error?: { message: string } }) => void>();

  private constructor(command: string) {
    this.child = spawn(command, [], { stdio: ["pipe", "pipe", "pipe"] });
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => {
      this.buffer += chunk;
      let newline;
      while ((newline = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, newline).trim(); this.buffer = this.buffer.slice(newline + 1);
        if (!line) continue;
        const message = JSON.parse(line) as { id?: number; result?: unknown; error?: { message: string } };
        if (message.id !== undefined) { this.pending.get(message.id)?.(message); this.pending.delete(message.id); }
      }
    });
  }

  static async connect(command = ARENA_MCP_SERVER): Promise<McpClient> {
    const client = new McpClient(command);
    await client.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "loom-ffgl-study", version: "1" } });
    client.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    await client.tool("status", { action: "instructions", injected: true });
    return client;
  }

  private request(method: string, params: unknown): Promise<unknown> {
    const id = ++this.next;
    return new Promise((resolve, reject) => {
      this.pending.set(id, message => (message.error ? reject(new Error(message.error.message)) : resolve(message.result)));
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  /** Calls a tool; an MCP-level error becomes a thrown Error with the server's text. */
  async tool(name: string, args: Record<string, unknown>): Promise<McpToolResult> {
    if ((name === "composition" && REFUSED_COMPOSITION_ACTIONS.has(String(args["action"]))) || (name === "layer" && /^clear/.test(String(args["action"]))))
      throw new Error(`The study never sends ${name}.${String(args["action"])}`);
    const result = (await this.request("tools/call", { name, arguments: args })) as McpToolResult;
    if (result.isError) throw new Error(`${name} ${JSON.stringify(args)}: ${result.content.map(c => c.text ?? "").join(" ")}`);
    return result;
  }

  async text(name: string, args: Record<string, unknown>): Promise<string> {
    return (await this.tool(name, args)).content.map(c => c.text ?? "").join("\n");
  }

  close(): void { this.child.kill(); }
}
