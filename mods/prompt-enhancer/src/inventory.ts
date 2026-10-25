import { CATALOG } from "./catalog.js";

// The catalog when there is no local one: what this machine has installed, read
// through the mods API at each Enhance (XREVIEW HOLD 6345168918). The mods API
// can read a file but not list a directory, so this reads only what the
// manifests name: the enabled plugins, each plugin's name and MCP server names,
// and the user MCP servers. OrchestKit's tools come from the bundled catalog,
// and only when an ork plugin is installed and enabled. A plugin's own agents
// and skills need a directory listing: `npm run catalog:local` writes them.
//
// This is part of the cached prefix, so its bytes must not change between calls
// on the same setup: keys are sorted by code unit and nothing time-dependent is
// read. Only names are emitted, never an MCP server's command, args, env or URL.

/** Reads a file through the mods API; throws when it is missing or unreadable. */
export type ReadFile = (path: string) => Promise<string>;

/** The plugin name whose tools the bundled catalog describes. */
export const BUNDLED_PLUGIN = "ork";

/** Sent when nothing installed can be named, so the rewrite names no tool. */
export const NO_TOOLS = "No subagents, skills or MCP servers were found on this setup. Name no tool.";

const byCode = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

const json = async (read: ReadFile, path: string): Promise<unknown> => {
  try { return JSON.parse(await read(path)); } catch { return undefined; }
};
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
// A .mcp.json may wrap its servers in mcpServers or list them at the top level.
const serverNames = (config: unknown): string[] => {
  const top = record(config);
  return Object.keys("mcpServers" in top ? record(top.mcpServers) : top);
};

/** The catalog of what is installed under `home`, deterministic for one setup. */
export async function installedCatalog(read: ReadFile, home: string): Promise<string> {
  const root = home.replace(/\/+$/, "");
  const enabled = record(record(await json(read, `${root}/.claude/settings.json`)).enabledPlugins);
  const installedFile = record(await json(read, `${root}/.claude/plugins/installed_plugins.json`));
  const plugins = record("plugins" in installedFile ? installedFile.plugins : installedFile);
  let bundled = false;
  const mcp = new Set<string>();
  for (const key of Object.keys(plugins).sort(byCode)) {
    if (enabled[key] !== true) continue;
    const raw = plugins[key];
    const entry = record(Array.isArray(raw) ? raw[0] : raw);
    const installPath = typeof entry.installPath === "string" ? entry.installPath.replace(/\/+$/, "") : "";
    if (!installPath) continue;
    const manifest = record(await json(read, `${installPath}/.claude-plugin/plugin.json`));
    const name = typeof manifest.name === "string" && manifest.name ? manifest.name : key.split("@")[0];
    if (name === BUNDLED_PLUGIN) bundled = true;
    for (const server of serverNames(await json(read, `${installPath}/.mcp.json`))) mcp.add(`${name}:${server}`);
  }
  for (const server of serverNames({ mcpServers: record(await json(read, `${root}/.claude.json`)).mcpServers })) mcp.add(server);
  const parts: string[] = [];
  if (bundled) parts.push(CATALOG.trim());
  if (mcp.size > 0) parts.push(["## MCP servers", ...[...mcp].sort(byCode).map(server => `- ${server}`)].join("\n"));
  return parts.length > 0 ? `${parts.join("\n\n")}\n` : NO_TOOLS;
}
