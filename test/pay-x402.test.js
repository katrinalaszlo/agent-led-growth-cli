import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { TASKS, evaluate, parsePayment, payCapUsd, usdcTransfers, USDC_BASE, TRANSFER_TOPIC } from "../src/harness/tasks/pay-x402.js";
import { resolveCredentials } from "../src/harness/secrets.js";
import { TASKS as ALL } from "../src/harness/index.js";

const WALLET = "0x" + "ab".repeat(32);
const ADDRESS = "0x" + "12".repeat(20);
const PAYEE = "0x" + "34".repeat(20);
const TX = "0x" + "cd".repeat(32);
const pad = (addr) => "0x" + addr.slice(2).padStart(64, "0");
const usdc = (dollars) => "0x" + BigInt(Math.round(dollars * 1e6)).toString(16).padStart(64, "0");
const receipt = (dollars, { from = ADDRESS, status = "0x1" } = {}) => ({ status, blockNumber: "0x1a2b3c", logs: [{ address: USDC_BASE, topics: [TRANSFER_TOPIC, pad(from), pad(PAYEE)], data: usdc(dollars) }] });
const files = (map) => ({ read: (n) => map[n] ?? null, readRaw: (n) => map[n] ?? null });
const payment = (extra = {}) => JSON.stringify({ product: "agentmail", endpoint: "POST https://x402.api.agentmail.to/v0/inboxes", amountUsd: 2, walletAddress: ADDRESS, network: "eip155:8453", txHash: TX, responseStatus: 201, ...extra });
const PLAN = "Pay via https://docs.agentmail.to/integrations/x402";

describe("pay-x402: the wallet key", () => {
  it("is accepted only as an EVM private key and is redacted", () => {
    const task = TASKS[0];
    const ok = resolveCredentials(task, { AGENT_READY_WALLET_KEY: WALLET });
    assert.deepEqual(ok.available, ["WALLET_PRIVATE_KEY"]);
    assert.equal(ok.childEnv.WALLET_PRIVATE_KEY, WALLET);
    assert.equal(ok.childEnv.AGENT_READY_WALLET_KEY, undefined);
    assert.equal(ok.redact(`const signer = privateKeyToAccount("${WALLET}")`), 'const signer = privateKeyToAccount("<redacted>")');
    const bad = resolveCredentials(task, { AGENT_READY_WALLET_KEY: "not-a-key" });
    assert.equal(bad.rejected.length, 1);
    assert.match(bad.rejected[0].reason, /64 hex/);
  });

  it("both tasks are registered for execute --task", () => {
    assert.ok(ALL["pay-x402-agentmail"]);
    assert.ok(ALL["pay-x402-telnyx"]);
    assert.equal(ALL["pay-x402-telnyx"].task.credentials.length, 2);
  });

  it("the cap is a positive number of dollars, 2 by default", () => {
    assert.equal(payCapUsd({}), 2);
    assert.equal(payCapUsd({ AGENT_READY_PAY_CAP_USD: "0.5" }), 0.5);
    assert.throws(() => payCapUsd({ AGENT_READY_PAY_CAP_USD: "free" }), /positive number/);
  });
});

describe("pay-x402: the evaluator", () => {
  it("passes when the receipt shows USDC leaving the agent's wallet within the cap and the paid request answered 2xx", async () => {
    const r = await evaluate({ mode: "given", files: files({ "PLAN.md": PLAN, "PAYMENT.json": payment() }), fetchReceipt: async (hash) => (assert.equal(hash, TX), receipt(2)), env: {} });
    assert.equal(r.success, true);
    assert.deepEqual(r.checks.map((c) => [c.id, c.pass]), [["plan_written", true], ["payment_recorded", true], ["transaction_confirmed", true], ["paid_from_wallet", true], ["amount_within_cap", true], ["paid_request_ok", true]]);
    assert.equal(r.objects.paidUsd, 2);
    assert.deepEqual(r.objects.payees, [PAYEE]);
  });

  it("fails on the chain's amount, not the agent's, when the payment is over the cap", async () => {
    const r = await evaluate({ mode: "given", files: files({ "PLAN.md": PLAN, "PAYMENT.json": payment({ amountUsd: 1 }) }), fetchReceipt: async () => receipt(5), env: { AGENT_READY_PAY_CAP_USD: "2" } });
    assert.equal(r.success, false);
    assert.equal(r.checks.find((c) => c.id === "amount_within_cap").pass, false);
    assert.match(r.checks.find((c) => c.id === "amount_within_cap").detail, /\$5\.000000 paid; cap \$2\.00/);
  });

  it("fails when the transfer came from another wallet or the transaction reverted", async () => {
    const other = await evaluate({ mode: "given", files: files({ "PLAN.md": PLAN, "PAYMENT.json": payment() }), fetchReceipt: async () => receipt(2, { from: PAYEE }), env: {} });
    assert.equal(other.checks.find((c) => c.id === "paid_from_wallet").pass, false);
    const reverted = await evaluate({ mode: "given", files: files({ "PLAN.md": PLAN, "PAYMENT.json": payment() }), fetchReceipt: async () => receipt(2, { status: "0x0" }), env: {} });
    assert.equal(reverted.checks.find((c) => c.id === "transaction_confirmed").pass, false);
    assert.equal(reverted.success, false);
  });

  it("records a human stop before any payment, and an RPC failure as the evaluator's, never as the agent's", async () => {
    const human = await evaluate({ mode: "given", files: files({ "PLAN.md": PLAN, "NEEDS_HUMAN.md": "403: X402_PAYMENTS_ENABLED missing at https://api.telnyx.com/v2/x402/credit_account/quote" }), fetchReceipt: async () => { throw new Error("must not be called"); }, env: {} });
    assert.equal(human.stoppedAt, "human_required");
    assert.equal(human.checks.find((c) => c.id === "payment_recorded").status, "human_required");
    const rpc = await evaluate({ mode: "given", files: files({ "PLAN.md": PLAN, "PAYMENT.json": payment() }), fetchReceipt: async () => { throw new Error("Base RPC answered 503"); }, env: {} });
    assert.equal(rpc.stoppedAt, "evaluator_rpc_failed");
    assert.equal(rpc.checks.find((c) => c.id === "transaction_confirmed").pass, null);
  });

  it("without a wallet, stops at credential_required", async () => {
    const r = await evaluate({ mode: "none", files: files({ "PLAN.md": PLAN, "NEEDS_CREDENTIAL.md": "Needs AGENT_READY_WALLET_KEY" }), env: {} });
    assert.equal(r.stoppedAt, "credential_required");
    assert.equal(r.success, false);
  });

  it("reads the Transfer log of the first real settlement on Base, by the event hash the chain emits", () => {
    // Receipt of 0xf7f91ac256c702d7629df243e73048d7f06737ca78380e99cb3771834bc7c9ca (AgentMail inbox, $2.00), logs as Base returned them.
    const receipt = {
      status: "0x1",
      blockNumber: "0x32264cb",
      logs: [
        { address: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", topics: ["0x98de503528ee59b575ef0c0a2576a82497bfc029a5685b209e9ec333479b10a5", pad("0xc1240189ec31986a9de010d02301c1e00f0def07"), "0x07c17cbdfe5de0f4a4f4ed7f1bbbf18ea4c6e6b7f5cd9f29cbd8ee2a0e5fb783b"], data: "0x" },
        { address: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", topics: ["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef", pad("0xc1240189ec31986a9de010d02301c1e00f0def07"), pad("0x6e3184c204e596ded89e8a5693b602097f4ab687")], data: "0x00000000000000000000000000000000000000000000000000000000001e8480" },
      ],
    };
    assert.deepEqual(usdcTransfers(receipt), [{ from: "0xc1240189ec31986a9de010d02301c1e00f0def07", to: "0x6e3184c204e596ded89e8a5693b602097f4ab687", usd: 2 }]);
  });

  it("parses PAYMENT.json strictly and reads USDC transfers from a receipt", () => {
    assert.equal(parsePayment(null).ok, false);
    assert.match(parsePayment("{").reason, /not JSON/);
    assert.match(parsePayment(JSON.stringify({ txHash: "abc" })).reason, /txHash/);
    assert.match(parsePayment(JSON.stringify({ txHash: TX })).reason, /walletAddress/);
    const t = usdcTransfers({ logs: [{ address: USDC_BASE.toUpperCase(), topics: [TRANSFER_TOPIC, pad(ADDRESS), pad(PAYEE)], data: usdc(0.25) }, { address: "0x" + "99".repeat(20), topics: [TRANSFER_TOPIC, pad(ADDRESS), pad(PAYEE)], data: usdc(9) }] });
    assert.deepEqual(t, [{ from: ADDRESS, to: PAYEE, usd: 0.25 }]);
  });
});
