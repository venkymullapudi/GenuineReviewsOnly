/*
 * GenuineReviewsOnly – review authenticity scorer.
 *
 * Pure, dependency-free heuristics. Works in browsers (window.GRO) and Node
 * (module.exports). Each review gets a 0..1 "suspicion" score plus the list
 * of reasons that contributed, so users can see *why* something was hidden.
 *
 * This is a heuristic filter, not proof. It flags reviews that match patterns
 * common in fake, paid or incentivised reviews.
 */
(function (root) {
  "use strict";

  const INCENTIVE = [
    /received (this|the|it)( product)? (for )?free/i,
    /(free|discounted) (product|sample|item) in exchange/i,
    /in exchange for (my|an|a) (honest|unbiased|fair)/i,
    /provided (to me )?(by|from) the (seller|manufacturer|company)/i,
    /\b(seller|company) (sent|gave) me\b/i,
    /\bat a discount(ed)? (price )?(in exchange|for (my|a) review)/i,
    /\bvine (voice|customer review)/i,
    /\b(refund|rebate|gift card) (after|for) (leaving |posting )?(a |my )?review/i,
  ];

  const GENERIC = [
    /\bhighly recommend(ed)?\b/i,
    /\bbest (product|purchase|thing) (ever|i('ve| have) (ever )?(bought|purchased))\b/i,
    /\bmust[- ]buy\b/i,
    /\bfive stars?\b|\b5 stars?\b/i,
    /\bworks (great|perfectly|as (described|expected))\b/i,
    /\b(great|amazing|awesome|excellent|perfect) (product|quality|item|value)\b/i,
    /\bexceeded (all )?(my )?expectations\b/i,
    /\blove (it|this)\b/i,
    /\bgo for it\b/i,
    /\bdon'?t (hesitate|think twice)\b/i,
    /\bworth (every penny|the money)\b/i,
    /\bwould (definitely )?(buy|recommend) (it )?again\b/i,
  ];

  const SUPERLATIVE = /\b(amazing|awesome|perfect|best|incredible|fantastic|excellent|outstanding|wonderful|superb|flawless|life[- ]changing)\b/gi;

  // Signals of real use: time spent, comparisons, concrete specifics, downsides.
  const EXPERIENCE = [
    /\b(after|for|over) (about |nearly |almost )?(\d+|a|one|two|three|four|five|six|several|few) (days?|weeks?|months?|years?)\b/i,
    /\b(compared|compare) (to|with)\b|\bmy (old|previous|last)\b/i,
    /\b(however|but|although|though|downside|cons?:|only (issue|complaint|problem))\b/i,
    /\b\d+(\.\d+)?\s?(mm|cm|inch(es)?|in|lbs?|kg|g|oz|ml|l|mah|w|v|hz|gb|tb|hours?|hrs?|minutes?|mins?)\b/i,
    /\b(returned|replacement|customer service|warranty|broke|stopped working)\b/i,
  ];

  function words(text) {
    return (text.toLowerCase().match(/[a-z0-9']+/g) || []);
  }

  function shingles(text, n) {
    const w = words(text);
    const set = new Set();
    for (let i = 0; i + n <= w.length; i++) set.add(w.slice(i, i + n).join(" "));
    return set;
  }

  function jaccard(a, b) {
    if (!a.size || !b.size) return 0;
    let inter = 0;
    for (const x of a) if (b.has(x)) inter++;
    return inter / (a.size + b.size - inter);
  }

  function countMatches(list, text) {
    let n = 0;
    for (const re of list) if (re.test(text)) n++;
    return n;
  }

  /**
   * Score one review in isolation.
   * review: { text, title?, rating? (1-5), verified? (bool|undefined), date? }
   */
  function scoreOne(review) {
    const text = ((review.title || "") + " " + (review.text || "")).trim();
    const body = review.text || "";
    const w = words(body);
    const reasons = [];
    let s = 0;
    const add = (pts, why) => { s += pts; reasons.push(why); };

    if (countMatches(INCENTIVE, text) > 0) add(0.6, "Mentions a free/discounted product or incentive");

    if (review.verified === false) add(0.25, "Not a verified purchase");

    const extreme = review.rating === 5 || review.rating === 1;
    if (extreme && w.length < 12) add(0.25, "Very short " + review.rating + "-star review");
    else if (w.length < 6) add(0.15, "Almost no content");

    const generic = countMatches(GENERIC, text);
    if (generic >= 3) add(0.3, "Mostly generic praise phrases");
    else if (generic === 2) add(0.15, "Several generic praise phrases");

    const sup = (text.match(SUPERLATIVE) || []).length;
    if (w.length && sup / Math.max(w.length, 1) > 0.08 && sup >= 3) add(0.2, "Unusually dense superlatives");

    const bangs = (text.match(/!/g) || []).length;
    if (bangs >= 4) add(0.1, "Excessive exclamation marks");

    const letters = text.replace(/[^A-Za-z]/g, "");
    const caps = text.replace(/[^A-Z]/g, "");
    if (letters.length > 20 && caps.length / letters.length > 0.5) add(0.1, "Mostly written in capitals");

    if (/\b(click|visit|check out) (my|our|the) (link|profile|store|website)\b|https?:\/\//i.test(text)) {
      add(0.3, "Contains links or self-promotion");
    }

    const exp = countMatches(EXPERIENCE, text);
    if (exp >= 2) add(-0.25, "Describes real usage details");
    else if (exp === 1) add(-0.1, "Some specific usage detail");

    if (w.length > 80) add(-0.1, "Detailed, long-form review");

    return { score: s, reasons };
  }

  /**
   * Score a list of reviews together. Cross-review signals (near-duplicate
   * text, same-day bursts of 5-star reviews) are added on top of scoreOne.
   * options.threshold: 0..1, default 0.5. Lower = stricter.
   */
  function analyze(reviews, options) {
    const threshold = (options && options.threshold != null) ? options.threshold : 0.5;
    const results = reviews.map((r) => scoreOne(r));

    // Near-duplicates (copy/paste or templated reviews).
    const sh = reviews.map((r) => shingles(r.text || "", 3));
    for (let i = 0; i < reviews.length; i++) {
      for (let j = i + 1; j < reviews.length; j++) {
        if (sh[i].size < 4 || sh[j].size < 4) continue;
        if (jaccard(sh[i], sh[j]) >= 0.5) {
          for (const k of [i, j]) {
            if (!results[k].dup) {
              results[k].dup = true;
              results[k].score += 0.55;
              results[k].reasons.push("Nearly identical to another review");
            }
          }
        }
      }
    }

    // Bursts: 3+ five-star reviews on the same date within this page.
    const byDate = {};
    reviews.forEach((r, i) => {
      if (r.date && r.rating === 5) (byDate[r.date] = byDate[r.date] || []).push(i);
    });
    for (const d in byDate) {
      if (byDate[d].length >= 3 && byDate[d].length / reviews.length >= 0.3) {
        for (const i of byDate[d]) {
          results[i].score += 0.15;
          results[i].reasons.push("Part of a same-day burst of 5-star reviews");
        }
      }
    }

    return results.map((r, i) => {
      const score = Math.max(0, Math.min(1, r.score));
      return {
        review: reviews[i],
        score,
        reasons: r.reasons,
        verdict: score >= threshold ? "suspicious" : "genuine",
      };
    });
  }

  const api = { analyze, scoreOne };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.GRO = api;
})(typeof window !== "undefined" ? window : globalThis);
