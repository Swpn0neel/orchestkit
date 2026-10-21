import { SITE } from "@/lib/constants";

// Values for the MCP server card served by app/api/mcp/server-card/route.ts.
// Kept out of the route file because a Next.js route file may only export
// route fields.
//
// $schema is the published MCP registry server.json schema, the same one the
// repo's server.json declares. The draft server-card schema (SEP-2127) has no
// published URL yet: .../schemas/v1/server-card.schema.json answers 404 (Codex
// XREVIEW on #4819). A copy of this schema is pinned in
// __tests__/fixtures/ and the test validates the whole card against it.
export const SERVER_CARD_SCHEMA =
	"https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json";

// The card name is reverse DNS of the canonical host (orchestkit.dev).
export const SERVER_CARD_NAME = "dev.orchestkit/mcp";

// The schema caps the description at 100 characters (server-card.test.ts).
export const SERVER_CARD_DESCRIPTION =
	"Search and read the OrchestKit Claude Code plugin docs as Markdown over MCP.";

export function serverCard() {
	return {
		$schema: SERVER_CARD_SCHEMA,
		name: SERVER_CARD_NAME,
		title: `${SITE.name} Docs MCP`,
		description: SERVER_CARD_DESCRIPTION,
		version: SITE.version,
		websiteUrl: SITE.domain,
		repository: { url: SITE.github, source: "github" },
		remotes: [{ type: "streamable-http", url: `${SITE.domain}/api/mcp` }],
	};
}
