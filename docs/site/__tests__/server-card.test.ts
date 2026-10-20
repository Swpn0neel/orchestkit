// Draft-spec MCP server card at <server>/server-card, listed in ai-catalog.

import { describe, expect, it } from "vitest";
import { GET as serverCardGET } from "@/app/api/mcp/server-card/route";
import { GET as catalogGET } from "@/app/api/well-known/ai-catalog/route";
import { SERVER_CARD_SCHEMA, serverCard } from "@/lib/server-card";

describe("MCP server card (draft server-card extension)", () => {
	it("has the spec fields and no tools[]", async () => {
		const card = await serverCardGET().json();
		expect(card.$schema).toBe(SERVER_CARD_SCHEMA);
		expect(card.$schema).toBe(
			"https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json",
		);
		expect(card.name).toBe("dev.orchestkit/mcp");
		expect(typeof card.version).toBe("string");
		expect(card.description.length).toBeGreaterThan(0);
		expect(card.description.length).toBeLessThanOrEqual(100);
		expect(card.remotes).toEqual([
			{ type: "streamable-http", url: "https://orchestkit.dev/api/mcp" },
		]);
		expect(card).not.toHaveProperty("tools");
		expect(card).toEqual(serverCard());
	});

	it("is the MCP entry in ai-catalog.json", async () => {
		const catalog = await catalogGET().json();
		const urls = catalog.entries.map((e: { url: string }) => e.url);
		expect(urls).toContain("https://orchestkit.dev/api/mcp/server-card");
	});
});
