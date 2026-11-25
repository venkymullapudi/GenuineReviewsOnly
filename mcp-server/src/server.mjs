#!/usr/bin/env node
/*
 * GenuineReviewsOnly MCP server.
 *
 * Tools:
 *   filter_reviews          – score reviews the user pasted, keep the genuine ones
 *   fetch_and_filter_reviews – fetch a product link, extract its reviews, filter them
 *
 * Transports:
 *   (default) stdio – Claude Desktop, Claude Code, any local MCP client
 *   --http [port]   – Streamable HTTP at /mcp, for ChatGPT connectors and claude.ai
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer } from "node:http";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { z } from "zod";
import scorer from "./scorer.cjs";
import { extractReviews } from "./extract.mjs";

const VERSION = "0.1.0";
const STRICTNESS = { relaxed: 0.7, normal: 0.5, strict: 0.35 };

const ReviewSchema = z.object({
  text: z.string().describe("The review body"),
  title: z.string().optional().describe("Review headline, if any"),
  rating: z.number().min(1).max(5).optional().describe("Star rating 1-5"),
  verified: z.boolean().optional().describe("True if the site marks it as a verified purchase, false if explicitly unverified; omit if unknown"),
  date: z.string().optional().describe("Date posted, in any consistent format"),
});

const strictnessArg = z.enum(["relaxed", "normal", "strict"]).default("normal")
  .describe("relaxed = hide only obvious fakes, strict = hide anything doubtful");

// Refuse internal/private addresses so a hosted server can't be used to probe its own network.
function isPrivateIp(ip) {
  if (ip.startsWith("::ffff:")) ip = ip.slice(7);
  if (isIP(ip) === 6) return ip === "::1" || ip === "::" || /^f[cd]/i.test(ip) || /^fe[89ab]/i.test(ip);
  const [a, b] = ip.split(".").map(Number);
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
}

export async function checkPublicUrl(raw) {
  const u = new URL(raw);
  if (!/^https?:$/.test(u.protocol)) throw new Error("Only http(s) links are supported");
  if (process.env.GRO_ALLOW_PRIVATE === "1") return u;
  const host = u.hostname.replace(/^\[|\]$/g, "");
  let addrs;
  try {
    addrs = isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
  } catch {
    // No local DNS (e.g. behind an HTTP proxy): the name can't point at a private address here.
    if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal") || host.endsWith(".local")) throw new Error("That address is on a private network");
    return u;
  }
  if (addrs.some((a) => isPrivateIp(a.address))) throw new Error("That address is on a private network");
  return u;
}

async function safeFetch(url) {
  let current = url;
  for (let hop = 0; hop < 5; hop++) {
    await checkPublicUrl(current);
    const res = await fetch(current, {
      redirect: "manual",
      signal: AbortSignal.timeout(20000),
      headers: {
        "user-agent": "Mozilla/5.0 (compatible; GenuineReviewsOnly/" + VERSION + ")",
        "accept": "text/html,application/xhtml+xml",
        "accept-language": "en;q=0.9",
      },
    });
    const loc = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && loc) { current = new URL(loc, current).href; continue; }
    return res;
  }
  throw new Error("Too many redirects");
}

export function runFilter(reviews, strictness = "normal") {
  const results = scorer.analyze(reviews, { threshold: STRICTNESS[strictness] ?? 0.5 });
  const pack = (r) => ({
    ...r.review,
    suspicion: Math.round(r.score * 100),
    reasons: r.reasons,
  });
  const genuine = results.filter((r) => r.verdict === "genuine").map(pack);
  const removed = results.filter((r) => r.verdict === "suspicious").map(pack);
  const ratings = genuine.map((r) => r.rating).filter((x) => typeof x === "number");
  return {
    summary: {
      total: results.length,
      genuine: genuine.length,
      removed: removed.length,
      genuine_average_rating: ratings.length ? +(ratings.reduce((a, b) => a + b, 0) / ratings.length).toFixed(2) : null,
      strictness,
    },
    genuine_reviews: genuine,
    removed_reviews: removed,
    note: "Heuristic filter, not proof. Show the user the genuine reviews and, briefly, why others were removed.",
  };
}

function reply(obj) {
  return { content: [{ type: "text", text: JSON.stringify(obj, null, 2) }], structuredContent: obj };
}

export function buildServer() {
  const server = new McpServer({ name: "genuine-reviews-only", version: VERSION });

  server.registerTool(
    "filter_reviews",
    {
      title: "Keep only genuine reviews",
      description:
        "Scores a list of product reviews for signs of being fake, paid or incentivised, and returns only the ones that look genuine, plus the removed ones with reasons. Use this when the user pastes reviews, or after you have collected reviews from a page.",
      inputSchema: { reviews: z.array(ReviewSchema).min(1), strictness: strictnessArg },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ reviews, strictness }) => reply(runFilter(reviews, strictness)),
  );

  server.registerTool(
    "fetch_and_filter_reviews",
    {
      title: "Fetch a product link and keep only genuine reviews",
      description:
        "Downloads a product or review page, extracts its reviews (schema.org JSON-LD/microdata, Amazon, Trustpilot-style markup), and returns only the genuine ones. Many big stores block automated access or load reviews with JavaScript; if no reviews are found, ask the user to copy-paste the reviews and use filter_reviews instead.",
      inputSchema: { url: z.string().url().describe("Product or reviews page URL"), strictness: strictnessArg },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ url, strictness }) => {
      let res;
      try {
        res = await safeFetch(url);
      } catch (e) {
        return reply({ ok: false, url, error: "Could not reach the page: " + e.message, next_step: "Ask the user to paste the reviews, then call filter_reviews." });
      }
      const html = await res.text();
      const { reviews, source } = extractReviews(html, res.url || url);
      if (!res.ok || !reviews.length) {
        const blocked = res.status === 403 || res.status === 503 || /captcha|robot check|access denied/i.test(html.slice(0, 20000));
        return reply({
          ok: false,
          url,
          http_status: res.status,
          error: blocked
            ? "The site blocked automated access (bot check / CAPTCHA)."
            : "No reviews found in the page HTML. The site probably loads reviews with JavaScript or needs a login.",
          next_step: "Ask the user to open the page, copy the reviews and paste them here, then call filter_reviews.",
        });
      }
      return reply({ ok: true, url, extracted_from: source, ...runFilter(reviews, strictness) });
    },
  );

  return server;
}

async function main() {
  const args = process.argv.slice(2);
  const httpIdx = args.indexOf("--http");
  if (httpIdx === -1) {
    await buildServer().connect(new StdioServerTransport());
    return;
  }
  const port = +(args[httpIdx + 1] || process.env.PORT || 3000);
  const http = createServer(async (req, res) => {
    res.setHeader("access-control-allow-origin", "*");
    res.setHeader("access-control-allow-headers", "*");
    res.setHeader("access-control-expose-headers", "mcp-session-id");
    if (req.method === "OPTIONS") return res.writeHead(204).end();
    const path = new URL(req.url, "http://x").pathname;
    if (path === "/" || path === "/health") {
      return res.writeHead(200, { "content-type": "text/plain" }).end("GenuineReviewsOnly MCP server. Endpoint: /mcp\n");
    }
    if (path !== "/mcp") return res.writeHead(404).end();
    // Stateless: a fresh server + transport per request.
    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => { transport.close(); server.close(); });
    let body;
    if (req.method === "POST") {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      try { body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "null"); }
      catch { return res.writeHead(400).end("Invalid JSON"); }
    }
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  });
  http.listen(port, () => console.error(`GenuineReviewsOnly MCP listening on http://localhost:${port}/mcp`));
}

const isMain = import.meta.url === new URL(process.argv[1], "file://").href || process.argv[1]?.endsWith("genuine-reviews.mjs") || process.argv[1]?.endsWith("server.mjs");
if (isMain) main().catch((e) => { console.error(e); process.exit(1); });
