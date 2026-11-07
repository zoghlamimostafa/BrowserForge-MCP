# Examples

| | |
|---|---|
| [`plugins/hello`](plugins/hello) | The smallest plugin: a tool, private notes in its own folder, untrusted wrapping |
| [`skills/hello`](skills/hello) | The smallest skill: instructions plus a templated workflow |
| `claude-mcp.json`, `codex-config.toml` | Connecting Claude Code or Codex to a running server |
| `cursor-mcp.json`, `windsurf-mcp_config.json`, `continue-browserforge.yaml` (+ `-http`) | Connecting Cursor, Windsurf or Continue |

Try them:

```bash
browserforge plugin add ./examples/plugins/hello
browserforge skill add ./examples/skills/hello
```

Real-world references: [`plugins/rendercv`](../plugins/rendercv), [`skills/job-apply`](../skills/job-apply) and [`skills/table-to-csv`](../skills/table-to-csv) (a small skill with no plugin). Guides: [docs/PLUGINS.md](../docs/PLUGINS.md), [docs/SKILLS.md](../docs/SKILLS.md).

## Connecting an AI client

BrowserForge speaks MCP over HTTP at `http://127.0.0.1:7345/mcp` with `Authorization: Bearer <mcp-token>`. The token is in `~/.config/browserforge/mcp-token` (`%APPDATA%\browserforge\mcp-token` on Windows). Put it in an environment variable and let the client read it, so it never lands in a file you could commit:

```bash
export BROWSERFORGE_MCP_TOKEN="$(cat ~/.config/browserforge/mcp-token)"
```

Start the client from that same shell (a client started from a desktop launcher does not see the variable). Then check with the tool `system_status`.

| Client | File to copy | Where it goes |
|---|---|---|
| Cursor | [`cursor-mcp.json`](cursor-mcp.json) | `~/.cursor/mcp.json` (all projects) or `.cursor/mcp.json` (one project) |
| Windsurf | [`windsurf-mcp_config.json`](windsurf-mcp_config.json) | `~/.codeium/windsurf/mcp_config.json`; newer builds may read `~/.config/devin/mcp_config.json`, so use the "open MCP config" action in Cascade if edits do not take effect |
| Continue | [`continue-browserforge.yaml`](continue-browserforge.yaml) | `.continue/mcpServers/browserforge.yaml`. It starts `browserforge stdio` itself, so no token is needed. The HTTP form is [`continue-browserforge-http.yaml`](continue-browserforge-http.yaml) |

**How these were checked.** The field names and the `${env:...}` placeholder come from each client's current documentation (Cursor [MCP docs](https://cursor.com/docs/mcp), Windsurf [Cascade MCP](https://docs.windsurf.com/plugins/cascade/mcp), Continue [MCP guide](https://docs.continue.dev/customize/deep-dives/mcp)), and the files are parsed by a test. **They have not been run inside those three programs yet**, so no client version is confirmed. If you try one, tell us which version worked or what it said, in an issue or a pull request that adds the version here. Continue's header form for HTTP is the least certain, which is why its main file uses stdio. Cursor has had reports of `${env:...}` in headers not expanding when the app starts from a desktop launcher; starting it from the shell fixes that.
