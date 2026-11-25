const test = require("node:test");
const assert = require("node:assert");
const { analyze } = require("../extension/scorer.js");

const genuine = {
  rating: 4, verified: true,
  text: "I've used this kettle for about 3 months now. It boils 1.5 L in roughly 4 minutes, which is faster than my old one. However the lid hinge feels a bit flimsy and the cord is short.",
};

test("detailed verified review is genuine", () => {
  const [r] = analyze([genuine]);
  assert.equal(r.verdict, "genuine");
});

test("incentivised review is suspicious", () => {
  const [r] = analyze([{ rating: 5, text: "I received this product for free in exchange for my honest review. Great product, highly recommend!" }]);
  assert.equal(r.verdict, "suspicious");
  assert.ok(r.reasons.some((x) => /incentive/i.test(x)));
});

test("short unverified 5-star generic praise is suspicious", () => {
  const [r] = analyze([{ rating: 5, verified: false, text: "Amazing!!! Best product ever, love it!!" }]);
  assert.equal(r.verdict, "suspicious");
});

test("near-duplicate reviews are flagged", () => {
  const a = "This blender is great and makes perfect smoothies every single morning for my whole family";
  const b = "This blender is great and makes perfect smoothies every single morning for my entire family";
  const res = analyze([{ rating: 5, verified: true, text: a }, { rating: 5, verified: true, text: b }, genuine]);
  assert.equal(res[0].verdict, "suspicious");
  assert.equal(res[1].verdict, "suspicious");
  assert.equal(res[2].verdict, "genuine");
});

test("threshold controls strictness", () => {
  const review = { rating: 5, verified: false, text: "Nice, does the job and arrived quickly." };
  assert.equal(analyze([review], { threshold: 0.9 })[0].verdict, "genuine");
  assert.equal(analyze([review], { threshold: 0.2 })[0].verdict, "suspicious");
});

test("docs/scorer.js is in sync with extension/scorer.js", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const a = fs.readFileSync(path.join(__dirname, "../extension/scorer.js"), "utf8");
  const b = fs.readFileSync(path.join(__dirname, "../docs/scorer.js"), "utf8");
  assert.equal(a, b, "Run: cp extension/scorer.js docs/scorer.js");
});
