---
name: genuine-reviews
description: Filter product reviews down to the genuine ones. Use when the user shares a product link or pastes reviews and wants fake, paid or incentivised reviews removed, asks "are these reviews real?", or wants an honest rating for a product.
---

# Genuine reviews only

1. **If the user gave a link**, call `fetch_and_filter_reviews` with the URL.
   - If it returns `ok: false` (site blocked access, or reviews load with JavaScript), tell the user in one line and ask them to copy the reviews from the page and paste them.
2. **If the user pasted reviews**, split them into separate reviews and call `filter_reviews`. Fill in `rating` (1–5) and `verified` (true/false) only when the text shows them; otherwise leave them out.
3. **Answer with:**
   - One line: "X of Y reviews look genuine", and the average rating of the genuine ones if available, compared with the overall average.
   - The genuine reviews (quote or summarise; for many reviews, summarise common praise and complaints).
   - A short list of what was removed and why, using the `reasons` field.
   - A reminder that this is a heuristic filter, not proof.
4. If the user says the filter is too aggressive or too lenient, re-run with `strictness` `relaxed` or `strict`.
