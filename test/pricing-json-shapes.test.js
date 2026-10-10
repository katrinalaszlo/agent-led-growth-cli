import { test } from "node:test";
import assert from "node:assert/strict";
import { extractPricingJson } from "../src/interface/extract.js";

const obs = [{ id: "o1", role: "pricing_json", url: "https://acme.dev/pricing.json", ok: true, contentType: "application/json" }];
const read = (doc) => extractPricingJson(obs, new Map([["o1", { text: JSON.stringify(doc), contentType: "application/json" }]])).value.plans.map((p) => [p.id, p.amount, p.currency]);

test("pricing.json price as { amount, currency } is read", () => {
  assert.deepEqual(read({ plans: [{ id: "pro", price: { amount: 20, currency: "USD", period: "month" } }] }), [["pro", 20, "USD"]]);
});

test("a bare number price takes the currency from the plan, then the document", () => {
  assert.deepEqual(read({ currency: "EUR", plans: [{ id: "a", price: 5 }, { id: "b", price: 9, currency: "USD" }] }), [["a", 5, "EUR"], ["b", 9, "USD"]]);
});

test("a plan with no price stays unpriced", () => {
  assert.deepEqual(read({ plans: [{ id: "enterprise", price: "contact us" }] }), [["enterprise", null, null]]);
});
