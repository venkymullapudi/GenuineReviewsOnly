# GenuineReviewsOnly

Hides fake, paid and incentivised reviews so you see only genuine ones.

- `extension/` – browser extension (Chrome, Edge, Brave, Firefox). Works on any product page you open: Amazon, sites using schema.org review markup, and a generic fallback.
- `docs/` – GitHub Pages site: install instructions plus a paste-in checker that needs no install.
- `test/` – run with `node --test test/*.test.js`.

The scoring lives in `extension/scorer.js`. After editing it, run `cp extension/scorer.js docs/scorer.js` (a test checks the two match).

It is a heuristic filter, not proof: every hidden review shows the reasons it was flagged.
