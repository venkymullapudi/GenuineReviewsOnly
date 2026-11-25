// End-to-end tests for the bundled MCP server (plugin/server/genuine-reviews.mjs).
// Requires: cd mcp-server && npm install && npm run build
import test from "node:test";
import assert from "node:assert";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Client } from "../mcp-server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js";
import { StdioClientTransport } from "../mcp-server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js";
import { StreamableHTTPClientTransport } from "../mcp-server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(here, "../plugin/server/genuine-reviews.mjs");

const REVIEWS = [
  { rating: 5, verified: false, text: "Amazing!!! Best product ever, love it!! Highly recommend!" },
  { rating: 4, verified: true, text: "Used it for 2 weeks. Battery lasts about 10 hours, but the strap is stiff compared to my old watch." },
  { rating: 5, text: "I received this product for free in exchange for my honest review. Works great." },
];

const PRODUCT_PAGE = `<!doctype html><html><head>
<script type="application/ld+json">${JSON.stringify({
  "@context": "https://schema.org", "@type": "Product", name: "Kettle",
  review: [
    { "@type": "Review", reviewBody: "Five stars! Love it! Best purchase ever!", reviewRating: { ratingValue: "5" }, datePublished: "2026-05-01" },
    { "@type": "Review", reviewBody: "After 3 months the kettle still boils 1.5 L in about 4 minutes, but the lid hinge feels flimsy compared to my old one.", reviewRating: { ratingValue: 4 }, datePublished: "2026-04-11" },
  ],
})}</script></head><body><h1>Kettle</h1></body></html>`;

const AMAZON_PAGE = `<html><body>
<div data-hook="review"><i data-hook="review-star-rating"><span>5.0 out of 5 stars</span></i><span data-hook="review-body">Love it! Five stars!</span></div>
<div data-hook="review"><i data-hook="review-star-rating"><span>3.0 out of 5 stars</span></i><span data-hook="avp-badge">Verified Purchase</span>
<span data-hook="review-body">After 3 weeks the zipper broke, but customer service sent a replacement within 4 days.</span></div>
</body></html>`;

function parse(result) {
  return result.structuredContent ?? JSON.parse(result.content[0].text);
}

function startSite() {
  return new Promise((resolve) => {
    const site = createServer((req, res) => {
      if (req.url === "/product") return res.writeHead(200, { "content-type": "text/html" }).end(PRODUCT_PAGE);
      if (req.url === "/amazon") return res.writeHead(200, { "content-type": "text/html" }).end(AMAZON_PAGE);
      if (req.url === "/redirect") return res.writeHead(302, { location: "/product" }).end();
      if (req.url === "/js-only") return res.writeHead(200, { "content-type": "text/html" }).end("<div id=app></div>");
      res.writeHead(403).end("Access denied");
    }).listen(0, "127.0.0.1", () => resolve(site));
  });
}

async function stdioClient(env = {}) {
  const client = new Client({ name: "test", version: "1" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [SERVER], env: { ...process.env, ...env } }));
  return client;
}

test("stdio: lists both tools", async () => {
  const c = await stdioClient();
  const { tools } = await c.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), ["fetch_and_filter_reviews", "filter_reviews"]);
  await c.close();
});

test("stdio: filter_reviews keeps only the genuine review", async () => {
  const c = await stdioClient();
  const out = parse(await c.callTool({ name: "filter_reviews", arguments: { reviews: REVIEWS } }));
  assert.equal(out.summary.total, 3);
  assert.equal(out.summary.genuine, 1);
  assert.match(out.genuine_reviews[0].text, /Battery lasts/);
  assert.equal(out.removed_reviews.length, 2);
  assert.ok(out.removed_reviews.every((r) => r.reasons.length > 0));
  await c.close();
});

test("stdio: strictness changes the outcome", async () => {
  const c = await stdioClient();
  const r = [{ rating: 5, verified: false, text: "Nice, does the job and arrived quickly." }];
  const relaxed = parse(await c.callTool({ name: "filter_reviews", arguments: { reviews: r, strictness: "relaxed" } }));
  const strict = parse(await c.callTool({ name: "filter_reviews", arguments: { reviews: r, strictness: "strict" } }));
  assert.equal(relaxed.summary.genuine, 1);
  assert.equal(strict.summary.genuine, 0);
  await c.close();
});

test("stdio: fetch_and_filter_reviews reads JSON-LD, Amazon markup and follows redirects", async () => {
  const site = await startSite();
  const base = `http://127.0.0.1:${site.address().port}`;
  const c = await stdioClient({ GRO_ALLOW_PRIVATE: "1" });
  try {
    const ld = parse(await c.callTool({ name: "fetch_and_filter_reviews", arguments: { url: base + "/product" } }));
    assert.equal(ld.ok, true);
    assert.equal(ld.extracted_from, "json-ld");
    assert.equal(ld.summary.total, 2);
    assert.equal(ld.summary.genuine, 1);
    assert.equal(ld.summary.genuine_average_rating, 4);

    const amz = parse(await c.callTool({ name: "fetch_and_filter_reviews", arguments: { url: base + "/amazon" } }));
    assert.equal(amz.extracted_from, "amazon");
    assert.equal(amz.genuine_reviews.length, 1);
    assert.equal(amz.genuine_reviews[0].verified, true);

    const redir = parse(await c.callTool({ name: "fetch_and_filter_reviews", arguments: { url: base + "/redirect" } }));
    assert.equal(redir.ok, true);

    const js = parse(await c.callTool({ name: "fetch_and_filter_reviews", arguments: { url: base + "/js-only" } }));
    assert.equal(js.ok, false);
    assert.match(js.next_step, /paste/);

    const blocked = parse(await c.callTool({ name: "fetch_and_filter_reviews", arguments: { url: base + "/nope" } }));
    assert.equal(blocked.ok, false);
    assert.match(blocked.error, /blocked/);
  } finally {
    await c.close();
    site.close();
  }
});

test("stdio: private network addresses are refused by default", async () => {
  const c = await stdioClient({ GRO_ALLOW_PRIVATE: "" });
  for (const url of ["http://127.0.0.1:1/", "http://169.254.169.254/latest/meta-data/", "http://localhost/", "http://[::1]/"]) {
    const out = parse(await c.callTool({ name: "fetch_and_filter_reviews", arguments: { url } }));
    assert.equal(out.ok, false, url);
    assert.match(out.error, /private network/, url);
  }
  await c.close();
});

test("http: works over Streamable HTTP (ChatGPT / claude.ai connector mode)", async () => {
  const port = 30000 + Math.floor(Math.random() * 20000);
  const proc = spawn(process.execPath, [SERVER, "--http", String(port)], { stdio: ["ignore", "ignore", "pipe"] });
  await new Promise((resolve, reject) => {
    proc.stderr.on("data", (d) => /listening/.test(d) && resolve());
    proc.on("exit", (code) => reject(new Error("server exited " + code)));
  });
  try {
    const health = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(health.status, 200);
    const c = new Client({ name: "test", version: "1" });
    await c.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
    const { tools } = await c.listTools();
    assert.equal(tools.length, 2);
    const out = parse(await c.callTool({ name: "filter_reviews", arguments: { reviews: REVIEWS } }));
    assert.equal(out.summary.genuine, 1);
    await c.close();
  } finally {
    proc.kill();
  }
});
