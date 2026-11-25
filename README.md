# GenuineReviewsOnly

Give Claude or ChatGPT a product link, or paste some reviews, and get back only the genuine ones. Fake, paid and "free product in exchange for a review" posts are removed, and each one comes with the reasons it was flagged.

It is an [MCP](https://modelcontextprotocol.io) server, the plugin standard that both Claude and ChatGPT support. It adds two tools:

| Tool | What it does |
| --- | --- |
| `filter_reviews` | Takes reviews (text, plus rating / verified / date if known) and returns the genuine ones, the removed ones with reasons, and the average rating of the genuine ones. |
| `fetch_and_filter_reviews` | Takes a product or reviews link, pulls the reviews out of the page (schema.org JSON-LD or microdata, Amazon markup), then filters them. |

Then just ask, for example: *"Show me only the genuine reviews for https://example-shop.com/product/123"*, or paste reviews and ask *"Which of these are real?"*

> **Links don't always work.** Many big stores (Amazon especially) block automated access or load reviews with JavaScript. When that happens the tool says so, and Claude or ChatGPT asks you to copy-paste the reviews instead. Pasted reviews always work.

## Use it in Claude Code

```
/plugin install genuine-reviews-only --marketplace venkymullapudi/GenuineReviewsOnly
```

On older Claude Code versions, run these two commands instead:

```
/plugin marketplace add venkymullapudi/GenuineReviewsOnly
/plugin install genuine-reviews-only@genuine-reviews-only
```

The plugin also includes a skill that tells Claude how to present the results. It needs Node.js 18 or later.

## Use it in Claude Desktop

1. Download [`plugin/server/genuine-reviews.mjs`](plugin/server/genuine-reviews.mjs). It is a single file with no dependencies.
2. Open **Settings → Developer → Edit Config** and add:

```json
{
  "mcpServers": {
    "genuine-reviews-only": {
      "command": "node",
      "args": ["/full/path/to/genuine-reviews.mjs"]
    }
  }
}
```

3. Restart Claude Desktop.

## Use it in ChatGPT or on claude.ai (for everyone, no install)

Web apps can only connect to a server on the internet, so host the server once and share its URL:

```bash
node plugin/server/genuine-reviews.mjs --http 3000
```

Run that on any Node host (Render, Fly.io, Railway, a VPS…) behind HTTPS. The MCP endpoint is `https://your-host/mcp` and the health check is `/health`. For a quick try from your own computer, a tunnel such as `cloudflared tunnel --url http://localhost:3000` gives you a temporary HTTPS URL.

Then add it as a connector:

- **ChatGPT:** Settings → Apps & Connectors → turn on Developer mode → create a connector with the `/mcp` URL. For a shareable GPT, paste [`chatgpt/instructions.md`](chatgpt/instructions.md) into its instructions.
- **claude.ai:** Settings → Connectors → Add custom connector → paste the `/mcp` URL.

The hosted server refuses links that point at private or internal network addresses. It needs no API keys and stores nothing.

## How it decides

Each review gets a suspicion score. These signals raise it:

- an incentive disclosure ("received this for free in exchange for…")
- not a verified purchase
- a very short 5-star or 1-star review
- mostly generic praise ("highly recommend", "best product ever")
- lots of superlatives, exclamation marks or capitals
- links or self-promotion
- near-identical copies of other reviews
- part of a same-day burst of 5-star reviews

Concrete usage details lower it: how long it was used, measurements, comparisons, downsides, returns or warranty experiences.

Strictness can be `relaxed`, `normal` (the default) or `strict`; just tell Claude or ChatGPT "be stricter" or "be more relaxed".

This is a heuristic filter, not proof. It will sometimes remove a real review or miss a clever fake, which is why every removed review lists its reasons.

## Development

```
mcp-server/src/scorer.cjs    scoring rules
mcp-server/src/extract.mjs   pulls reviews out of HTML
mcp-server/src/server.mjs    MCP tools and the stdio/HTTP transports
plugin/                      Claude Code plugin (bundled server, .mcp.json, skill)
.claude-plugin/              marketplace entry so the repo installs as a plugin
chatgpt/instructions.md      instructions for a ChatGPT GPT
test/                        unit tests and end-to-end MCP tests
```

```bash
cd mcp-server && npm install && npm run build && cd ..
node --test test/*.test.js test/*.test.mjs
```

`npm run build` regenerates `plugin/server/genuine-reviews.mjs`, the bundled file that users run. Rebuild and commit it after changing anything in `mcp-server/src/`.

## License

[Apache License 2.0](LICENSE)
