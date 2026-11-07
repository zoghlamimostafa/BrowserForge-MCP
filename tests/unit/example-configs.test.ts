import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

// The example client configs must parse, point at the real endpoint, and never hold a real token.
const EX = join(__dirname, '../../examples');
const read = (f: string) => readFileSync(join(EX, f), 'utf8');
const URL_OK = 'http://127.0.0.1:7345/mcp';

describe('example MCP client configs', () => {
  it('Cursor and Windsurf use their own url key and an environment token', () => {
    const cursor = JSON.parse(read('cursor-mcp.json')).mcpServers.browserforge;
    expect(cursor.url).toBe(URL_OK);
    expect(cursor.headers.Authorization).toBe('Bearer ${env:BROWSERFORGE_MCP_TOKEN}');
    const windsurf = JSON.parse(read('windsurf-mcp_config.json')).mcpServers.browserforge;
    expect(windsurf.serverUrl).toBe(URL_OK);
    expect(windsurf.headers.Authorization).toBe('Bearer ${env:BROWSERFORGE_MCP_TOKEN}');
  });

  it('Continue: the main file starts stdio, the HTTP file points at the daemon', () => {
    const stdio = parse(read('continue-browserforge.yaml'));
    expect(stdio).toMatchObject({ schema: 'v1', mcpServers: [{ name: 'browserforge', type: 'stdio', command: 'browserforge', args: ['stdio'] }] });
    const http = parse(read('continue-browserforge-http.yaml'));
    expect(http.mcpServers[0]).toMatchObject({ type: 'streamable-http', url: URL_OK });
    expect(http.mcpServers[0].requestOptions.headers.Authorization).toContain('secrets.BROWSERFORGE_MCP_TOKEN');
  });

  it('no example config contains a literal token', () => {
    for (const f of ['claude-mcp.json', 'codex-config.toml', 'cursor-mcp.json', 'windsurf-mcp_config.json', 'continue-browserforge.yaml', 'continue-browserforge-http.yaml']) {
      expect(read(f), f).not.toMatch(/[A-Fa-f0-9]{32,}|Bearer\s+(?!\$\{)[A-Za-z0-9_-]{16,}/);
    }
  });
});
