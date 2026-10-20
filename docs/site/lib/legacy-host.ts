import { LEGACY_HOST, SITE } from "@/lib/constants";

// The pre-GA host (orchestkit.yonyon.ai) stays attached to the same Vercel
// project. Pages answer ONE 301 to the same path on SITE.domain, so a search
// result or an old link lands on orchestkit.dev in one hop.
//
// The agent and MCP surface keeps answering 200 on the old host instead.
// Installed MCP clients POST to /api/mcp, and many HTTP clients do not follow
// a 301 on POST (or replay it as a GET), so a redirect there would break
// existing installs. The same holds for the other POST endpoints and for the
// discovery documents those clients read.
const KEEP_EXACT = new Set(["/mcp", "/mcp.json", "/ask", "/auth.md"]);
const KEEP_PREFIXES = ["/api/", "/.well-known/", "/agent/"];

export function isLegacyHost(host: string | null): boolean {
	if (!host) return false;
	return host.split(":")[0].toLowerCase() === LEGACY_HOST;
}

export function keepsServingOnLegacyHost(pathname: string): boolean {
	if (KEEP_EXACT.has(pathname)) return true;
	return KEEP_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

// The absolute URL to redirect to, or null when the request must be served
// as is. `search` keeps its leading "?" (URL.search shape).
export function legacyRedirectTarget(
	host: string | null,
	pathname: string,
	search: string,
): string | null {
	if (!isLegacyHost(host)) return null;
	if (keepsServingOnLegacyHost(pathname)) return null;
	return `${SITE.domain}${pathname}${search}`;
}
