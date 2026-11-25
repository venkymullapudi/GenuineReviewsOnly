/*
 * Pull reviews out of raw HTML. Tries, in order:
 *   1. schema.org JSON-LD (Product.review / Review objects) – most shops
 *   2. schema.org microdata (itemprop="review")
 *   3. Amazon markup (data-hook="review")
 */
import { parse } from "node-html-parser";

const clean = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
const num = (s) => {
  const m = String(s ?? "").match(/(\d+(?:[.,]\d+)?)/);
  if (!m) return undefined;
  const n = Math.round(parseFloat(m[1].replace(",", ".")));
  return n >= 1 && n <= 5 ? n : undefined;
};

function fromJsonLd(root) {
  const out = [];
  const visit = (node) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) return node.forEach(visit);
    const type = [].concat(node["@type"] || []);
    if (type.includes("Review")) {
      const rating = node.reviewRating && (node.reviewRating.ratingValue ?? node.reviewRating);
      const text = clean(node.reviewBody || node.description);
      if (text) {
        out.push({
          text,
          title: clean(node.name) || undefined,
          rating: num(rating),
          date: node.datePublished ? String(node.datePublished).slice(0, 10) : undefined,
        });
      }
    }
    for (const k in node) if (k !== "reviewRating") visit(node[k]);
  };
  for (const s of root.querySelectorAll('script[type="application/ld+json"]')) {
    try { visit(JSON.parse(s.textContent)); } catch { /* ignore malformed blocks */ }
  }
  return out;
}

function prop(el, name) {
  const n = el.querySelector(`[itemprop="${name}"]`);
  return n ? (n.getAttribute("content") || clean(n.textContent)) : "";
}

function fromMicrodata(root) {
  return root.querySelectorAll('[itemprop="review"], [itemtype*="schema.org/Review"]').map((el) => ({
    text: clean(prop(el, "reviewBody") || prop(el, "description")),
    title: clean(prop(el, "name")) || undefined,
    rating: num(prop(el, "ratingValue")),
    date: prop(el, "datePublished").slice(0, 10) || undefined,
  })).filter((r) => r.text);
}

function fromAmazon(root) {
  return root.querySelectorAll('[data-hook="review"]').map((el) => {
    const t = (sel) => clean(el.querySelector(sel)?.textContent);
    return {
      text: t('[data-hook="review-body"]'),
      title: t('[data-hook="review-title"]') || undefined,
      rating: num(t('[data-hook="review-star-rating"], [data-hook="cmps-review-star-rating"]')),
      verified: !!el.querySelector('[data-hook="avp-badge"], [data-hook="avp-badge-linkless"]'),
      date: t('[data-hook="review-date"]').replace(/^.* on /, "") || undefined,
    };
  }).filter((r) => r.text);
}

export function extractReviews(html) {
  const root = parse(html, { blockTextElements: { script: true, style: false } });
  for (const [source, fn] of [["json-ld", fromJsonLd], ["microdata", fromMicrodata], ["amazon", fromAmazon]]) {
    const reviews = fn(root);
    if (reviews.length) {
      // De-duplicate (some pages repeat reviews in JSON-LD and markup).
      const seen = new Set();
      return { source, reviews: reviews.filter((r) => !seen.has(r.text) && seen.add(r.text)).slice(0, 200) };
    }
  }
  return { source: null, reviews: [] };
}
