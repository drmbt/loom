# Connect an agent

Loom exposes editing, validation and preview tools through desktop MCP and browser
WebMCP. Networks, shaders and parameter changes use the editor's command system and
remain undoable. Save authored networks as `.loom.json` files with their media.

## Desktop MCP

Loom's **Agents** help tab generates a config with the local paths filled in. Use
it as `.mcp.json` for Claude Code, or merge `mcpServers` into the Claude Desktop
configuration:

```json
{
  "mcpServers": {
    "loom": {
      "type": "stdio",
      "command": "node",
      "args": [
        "--import",
        "/ABSOLUTE/PATH/TO/loom/src/tooling/alias-hooks.ts",
        "/ABSOLUTE/PATH/TO/loom/src/mcp/serve.ts"
      ]
    }
  }
}
```

Launch `node` directly in this config. A pnpm script banner shares stdout with the
MCP protocol and can interfere with the connection.

Restart the client and ask it to call `bridge_status` for the pairing code.

## Edit the visible tab

1. Run `pnpm dev` and open the local Loom URL.
2. Open **agent → Connections** and enter the helper's pairing code.
3. Check the bridge state to confirm the agent is attached to that tab.

Until you pair a tab, the MCP server edits its own headless document. Hosted Loom
tabs cannot attach to the local helper.

For previews, start the helper with pixel access:

```bash
pnpm helper --grant-export
```

Use `--all` if you also need terminal panes. Agents can compile and validate without
pixel access, but cannot inspect rendered frames. A paired tab exposes preview-size
images; full-resolution readbacks and point data come from the helper's headless
runtime.

Keep the helper running to reuse the pairing code across chats. Additional clients
attach to that process. If it stops, those connections report an error.

[Claude MCP configuration](https://code.claude.com/docs/en/mcp)

## Browser WebMCP

1. Enable `chrome://flags/#enable-webmcp-testing` and relaunch Chrome.
2. Open Loom with a WebMCP-capable browser agent or extension.
3. Check **agent → Connections**. Tools register automatically, with no pairing code.

[Chrome WebMCP setup](https://developer.chrome.com/docs/ai/webmcp)
