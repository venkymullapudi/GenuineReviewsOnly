/*
 * Content script: finds reviews on the current page, scores them with GRO,
 * and hides the suspicious ones. A small floating panel shows the count and
 * lets the user reveal hidden reviews or change strictness.
 */
(function () {
  "use strict";
  if (window.__groLoaded) return;
  window.__groLoaded = true;

  const STRICTNESS = { relaxed: 0.7, normal: 0.5, strict: 0.35 };
  let settings = { enabled: true, strictness: "normal", showHidden: false };

  // ---- Site adapters: each returns [{ el, text, title, rating, verified, date }] ----

  function txt(el, sel) {
    const n = sel ? el.querySelector(sel) : el;
    return n ? n.textContent.replace(/\s+/g, " ").trim() : "";
  }

  // Microdata value: the content="" attribute if present, else the text.
  function prop(el, name) {
    const n = el.querySelector('[itemprop="' + name + '"]');
    return n ? (n.getAttribute("content") || txt(n)) : "";
  }

  function num(s) {
    const m = String(s || "").match(/(\d+(?:[.,]\d+)?)/);
    return m ? Math.round(parseFloat(m[1].replace(",", "."))) : undefined;
  }

  const adapters = [
    {
      name: "amazon",
      match: () => /(^|\.)amazon\./.test(location.hostname),
      find: () =>
        [...document.querySelectorAll('[data-hook="review"]')].map((el) => ({
          el,
          text: txt(el, '[data-hook="review-body"]'),
          title: txt(el, '[data-hook="review-title"]'),
          rating: num(txt(el, '[data-hook="review-star-rating"], [data-hook="cmps-review-star-rating"], .review-rating')),
          verified: !!el.querySelector('[data-hook="avp-badge"], [data-hook="avp-badge-linkless"]'),
          date: txt(el, '[data-hook="review-date"]').replace(/^.* on /, ""),
        })),
    },
    {
      // Any site using schema.org microdata (many shops, Google-friendly sites).
      name: "schema.org",
      match: () => !!document.querySelector('[itemprop="review"], [itemtype*="schema.org/Review"]'),
      find: () =>
        [...document.querySelectorAll('[itemprop="review"], [itemtype*="schema.org/Review"]')].map((el) => ({
          el,
          text: txt(el, '[itemprop="reviewBody"], [itemprop="description"]') || txt(el),
          title: txt(el, '[itemprop="name"]'),
          rating: num(prop(el, "ratingValue")),
          verified: undefined,
          date: prop(el, "datePublished").slice(0, 10),
        })),
    },
    {
      // Last resort: elements whose class/id/data attribute says "review".
      name: "generic",
      match: () => true,
      find: () => {
        const cands = [...document.querySelectorAll('[class*="review" i], [id*="review" i], [data-testid*="review" i]')]
          .filter((el) => {
            const t = txt(el);
            return t.length > 40 && t.length < 6000 && !el.closest("#gro-panel");
          });
        // Keep only innermost candidates so we don't hide whole review sections.
        const inner = cands.filter((el) => !cands.some((o) => o !== el && el.contains(o)));
        // Too few matches usually means this isn't a review list at all.
        if (inner.length < 3) return [];
        return inner.map((el) => {
          const stars = el.querySelector('[aria-label*="star" i], [title*="star" i]');
          return {
            el,
            text: txt(el),
            rating: stars ? num(stars.getAttribute("aria-label") || stars.getAttribute("title")) : undefined,
            verified: /verified (purchase|buyer)/i.test(txt(el)) ? true : undefined,
          };
        });
      },
    },
  ];

  // ---- UI ----

  let panel;
  function ensurePanel() {
    if (panel) return panel;
    panel = document.createElement("div");
    panel.id = "gro-panel";
    panel.innerHTML =
      '<strong>GenuineReviewsOnly</strong><span id="gro-count"></span>' +
      '<button id="gro-toggle" type="button"></button>';
    document.documentElement.appendChild(panel);
    panel.querySelector("#gro-toggle").addEventListener("click", () => {
      settings.showHidden = !settings.showHidden;
      run();
    });
    return panel;
  }

  function mark(item, result) {
    const el = item.el;
    el.classList.remove("gro-suspicious", "gro-revealed");
    el.querySelector(":scope > .gro-note")?.remove();
    if (result.verdict !== "suspicious") return;
    el.classList.add("gro-suspicious");
    if (settings.showHidden) {
      el.classList.add("gro-revealed");
      const note = document.createElement("div");
      note.className = "gro-note";
      note.textContent =
        "Likely not genuine (" + Math.round(result.score * 100) + "%): " + result.reasons.filter((r) => !/real usage|Detailed|specific usage/.test(r)).join("; ");
      el.prepend(note);
    }
  }

  let running = false;
  function run() {
    if (running) return;
    running = true;
    try {
      document.querySelectorAll(".gro-suspicious").forEach((el) => el.classList.remove("gro-suspicious", "gro-revealed"));
      if (!settings.enabled) { panel?.remove(); panel = null; return; }

      const adapter = adapters.find((a) => a.match());
      const items = adapter.find().filter((r) => (r.text || "").length > 0);
      if (!items.length) { panel?.remove(); panel = null; return; }

      const results = window.GRO.analyze(items, { threshold: STRICTNESS[settings.strictness] });
      results.forEach((r, i) => mark(items[i], r));
      const hidden = results.filter((r) => r.verdict === "suspicious").length;

      const p = ensurePanel();
      p.querySelector("#gro-count").textContent =
        " " + (items.length - hidden) + " genuine · " + hidden + " hidden";
      const btn = p.querySelector("#gro-toggle");
      btn.textContent = settings.showHidden ? "Hide suspicious" : "Show hidden";
      btn.style.display = hidden ? "" : "none";

    } finally {
      running = false;
    }
  }

  // Re-run when the page loads more reviews (pagination, "show more", SPAs).
  let timer;
  const observer = new MutationObserver((muts) => {
    if (muts.every((m) => panel && panel.contains(m.target))) return;
    clearTimeout(timer);
    timer = setTimeout(run, 600);
  });

  chrome.storage.sync.get(settings, (s) => {
    settings = Object.assign(settings, s, { showHidden: false });
    run();
    observer.observe(document.body, { childList: true, subtree: true });
  });

  chrome.storage.onChanged.addListener((changes) => {
    for (const k in changes) settings[k] = changes[k].newValue;
    run();
  });
})();
