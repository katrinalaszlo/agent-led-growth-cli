// ONE paid call against ONE product, over x402, from the agent's own wallet. Real money moves: USDC on Base. The
// wallet's private key comes from the environment under AGENT_READY_WALLET_KEY, is handed to the agent under another
// name, and is redacted everywhere like every other credential. The per-run cap is AGENT_READY_PAY_CAP_USD (default
// 2.00); the evaluator fails any payment above it. The evaluator never asks the agent: it reads work/PAYMENT.json and
// confirms the transaction on Base itself.

export const USDC_BASE = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
// keccak256("Transfer(address,address,uint256)"), as the first real run's receipt carried it; the first version of
// this file had the hash wrong in its last bytes and failed a payment that had gone through.
export const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
export const BASE_RPC = "https://mainnet.base.org";
const DEFAULT_CAP_USD = 2;

export function payCapUsd(env = process.env) {
  const raw = env.AGENT_READY_PAY_CAP_USD;
  if (raw === undefined || raw === "") return DEFAULT_CAP_USD;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`AGENT_READY_PAY_CAP_USD must be a positive number of dollars, got ${JSON.stringify(raw)}`);
  return n;
}

const WALLET = {
  env: "AGENT_READY_WALLET_KEY",
  injectAs: "WALLET_PRIVATE_KEY",
  test: /^0x[0-9a-fA-F]{64}$/,
  rejectReason: "must be an EVM private key: 0x followed by 64 hex characters",
  description: "private key of a wallet funded with a few dollars of USDC on Base, used only for this run",
};

const ALWAYS = [
  "Work only inside the current directory. Do not touch other directories.",
  "Write PLAN.md first: the product page that documents paying over x402 (URL), the endpoint you will pay for, the price it quotes, and the exact steps. Then act.",
  "The wallet's private key is in the environment variable WALLET_PRIVATE_KEY. Use it only to sign the x402 payment for this one call. Never print it, never write it to a file, never send it anywhere but the signing library.",
  "Make exactly ONE paid request. Do not retry a payment that the product reports as settled. Do not transfer funds anywhere except as the x402 payment for that call.",
  "Install what you need (an x402 client such as @x402/fetch with @x402/evm and viem) with npm; it lands under .tools/.",
  "When the paid request has answered, write PAYMENT.json with: product, endpoint (method and URL), amountUsd (the price you paid, as a number), payee (the address the payment went to, if the 402 or the client reported it), walletAddress (your wallet's public address), network (the CAIP-2 id, expected eip155:8453), txHash (the settlement transaction hash, from the PAYMENT-RESPONSE / X-PAYMENT-RESPONSE header, decoded, or from the product's response), responseStatus (the HTTP status of the paid request), and paymentResponse (the decoded settlement JSON, if any).",
  "If the product refuses before any payment (403 not eligible, no wallet balance, a step only a person can do), write NEEDS_HUMAN.md stating the exact step, the URL and what it asked for, and stop. Do not pay twice.",
  "Do not decide or state whether you succeeded. When you have done what you can, stop.",
];

function payTask({ id, url, apiHost, network, text, docs, extra = [], credentials = [WALLET] }) {
  return {
    id,
    url,
    apiHost,
    credentialEnvName: null,
    text,
    credentials,
    network,
    instructions: {
      always: [...ALWAYS, `The product documents this at ${docs}.`, ...extra],
      withCredential: [],
      signup: [],
      withoutCredential: ["No wallet is available for this run. Read the documentation, write PLAN.md with the exact paid request you would make, write NEEDS_CREDENTIAL.md naming AGENT_READY_WALLET_KEY, and stop."],
    },
    criteria: {
      local: ["PLAN.md exists and cites the product's x402 documentation", "PAYMENT.json records one paid request with its settlement transaction hash"],
      live: ["the transaction exists on Base and succeeded", "it moved USDC from the agent's wallet", "the amount is within AGENT_READY_PAY_CAP_USD", "the paid request answered 2xx"],
    },
  };
}

export const TASKS = [
  payTask({
    id: "pay-x402-agentmail",
    url: "https://agentmail.to",
    apiHost: "x402.api.agentmail.to",
    network: ["agentmail.to", "docs.agentmail.to", "api.agentmail.to", "x402.api.agentmail.to", "registry.npmjs.org", "mainnet.base.org", "x402.org", "www.x402.org"],
    text: "Create one AgentMail inbox by paying for it over x402 from your own wallet (no API key: the payment is the authentication).",
    docs: "https://docs.agentmail.to/integrations/x402",
    extra: ["AgentMail's x402 base URL is https://x402.api.agentmail.to and inbox creation is priced at $2.00; the client's default cap is $1 per payment, so raise it to exactly the price. Name the inbox agent-ready-<runId>."],
  }),
  payTask({
    id: "pay-x402-telnyx",
    url: "https://telnyx.com",
    apiHost: "api.telnyx.com",
    network: ["telnyx.com", "developers.telnyx.com", "api.telnyx.com", "registry.npmjs.org", "mainnet.base.org", "x402.org", "www.x402.org"],
    text: "Add $1 of account credit to Telnyx by paying over x402 from your own wallet (quote, sign an EIP-3009 authorization, submit).",
    docs: "https://telnyx.com/.well-known/agent-skills/telnyx-x402-payment/SKILL.md",
    extra: [
      "A Telnyx API key is in the environment variable TELNYX_API_KEY. Use it as the Bearer token for the quote and submit calls. Never print it.",
      "Flow: POST /v2/x402/credit_account/quote with the USD amount, sign the EIP-712 TransferWithAuthorization from the quote (ethers or viem), then POST /v2/x402/credit_account with the quote id and the base64 payload in the body. The record's status moves to settled and carries tx_hash: that is the txHash for PAYMENT.json.",
      "If Telnyx answers 403, the account lacks the X402_PAYMENTS_ENABLED flag: write NEEDS_HUMAN.md and stop.",
    ],
    credentials: [WALLET, { env: "TELNYX_API_KEY", injectAs: "TELNYX_API_KEY", test: /^KEY[A-Za-z0-9_-]{12,}$/, rejectReason: "must be a Telnyx API key (KEY...)", description: "Telnyx API key of the account to credit" }],
  }),
];

// Base JSON-RPC, keyless. Only eth_getTransactionReceipt is needed.
export async function getReceipt(txHash, rpc = BASE_RPC) {
  const res = await fetch(rpc, { method: "POST", signal: AbortSignal.timeout(30_000), headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getTransactionReceipt", params: [txHash] }) });
  if (!res.ok) throw new Error(`Base RPC answered ${res.status}`);
  const body = await res.json();
  if (body.error) throw new Error(`Base RPC error: ${body.error.message || JSON.stringify(body.error)}`);
  return body.result;
}

const addressOf = (topic) => `0x${String(topic).slice(-40)}`.toLowerCase();

// The USDC transfers in a receipt: EIP-3009 settlement emits a plain Transfer from the payer, so the payer's address
// is topic[1] whoever sent the transaction.
export function usdcTransfers(receipt) {
  return (receipt?.logs || [])
    .filter((l) => String(l.address).toLowerCase() === USDC_BASE && l.topics?.[0] === TRANSFER_TOPIC && l.topics.length === 3)
    .map((l) => ({ from: addressOf(l.topics[1]), to: addressOf(l.topics[2]), usd: Number(BigInt(l.data)) / 1e6 }));
}

export function parsePayment(text) {
  if (!text) return { ok: false, reason: "no PAYMENT.json" };
  let doc;
  try { doc = JSON.parse(text); } catch (err) { return { ok: false, reason: `PAYMENT.json is not JSON: ${err.message}` }; }
  if (!/^0x[0-9a-fA-F]{64}$/.test(doc.txHash || "")) return { ok: false, reason: "PAYMENT.json has no txHash of the form 0x + 64 hex" };
  if (!/^0x[0-9a-fA-F]{40}$/.test(doc.walletAddress || "")) return { ok: false, reason: "PAYMENT.json has no walletAddress of the form 0x + 40 hex" };
  return { ok: true, doc };
}

// Deterministic. Reads what the agent recorded, then confirms the money moved on Base, from the agent's wallet, for
// no more than the cap. Never trusts the agent's amountUsd: the chain's number is the one reported.
export async function evaluate({ files, mode, fetchReceipt = getReceipt, env = process.env }) {
  const checks = [];
  const plan = files.read("PLAN.md");
  const planUrl = plan ? (plan.match(/https?:\/\/[^\s)>\]]+/) || [null])[0] : null;
  checks.push({ id: "plan_written", tier: "local", pass: Boolean(plan && planUrl), detail: plan ? `PLAN.md ${plan.length} chars; cites ${planUrl || "no URL"}` : "no PLAN.md", evidence: { file: "PLAN.md" } });

  const done = (stoppedAt) => ({ method: "deterministic", checkedAt: new Date().toISOString(), success: checks.filter((c) => c.tier === "live").length > 0 && checks.every((c) => c.pass === true), stoppedAt, checks, authenticated: null, objects: null, keySource: null });

  if (mode === "none") {
    const needs = files.read("NEEDS_CREDENTIAL.md");
    checks.push({ id: "credential_need_documented", tier: "local", pass: Boolean(needs && /AGENT_READY_WALLET_KEY/.test(needs)), detail: needs ? "NEEDS_CREDENTIAL.md names the wallet" : "no NEEDS_CREDENTIAL.md", evidence: { file: "NEEDS_CREDENTIAL.md" } });
    for (const id of ["transaction_confirmed", "paid_from_wallet", "amount_within_cap", "paid_request_ok"]) checks.push({ id, tier: "live", pass: null, status: "credential_required", detail: "no wallet in this mode", evidence: null });
    return done("credential_required");
  }

  const human = files.read("NEEDS_HUMAN.md");
  const payment = parsePayment(files.readRaw("PAYMENT.json"));
  checks.push({ id: "payment_recorded", tier: "local", pass: payment.ok, status: payment.ok ? undefined : human ? "human_required" : "not_recorded", detail: payment.ok ? `PAYMENT.json: ${payment.doc.endpoint || "endpoint unnamed"}, tx ${payment.doc.txHash}` : human ? `stopped before paying: ${human.split("\n").find((l) => l.trim()) || "NEEDS_HUMAN.md"}` : payment.reason, evidence: { file: payment.ok ? "PAYMENT.json" : human ? "NEEDS_HUMAN.md" : "PAYMENT.json" } });
  if (!payment.ok) {
    for (const id of ["transaction_confirmed", "paid_from_wallet", "amount_within_cap", "paid_request_ok"]) checks.push({ id, tier: "live", pass: null, status: human ? "human_required" : "not_recorded", detail: "no payment to confirm", evidence: null });
    return done(human ? "human_required" : "not_recorded");
  }

  const { doc } = payment;
  const cap = payCapUsd(env);
  let receipt;
  try { receipt = await fetchReceipt(doc.txHash); } catch (err) {
    checks.push({ id: "transaction_confirmed", tier: "live", pass: null, status: "evaluator_rpc_failed", detail: err.message, evidence: { txHash: doc.txHash } });
    for (const id of ["paid_from_wallet", "amount_within_cap", "paid_request_ok"]) checks.push({ id, tier: "live", pass: null, status: "evaluator_rpc_failed", detail: "receipt not read", evidence: null });
    return done("evaluator_rpc_failed");
  }
  const confirmed = Boolean(receipt) && receipt.status === "0x1";
  checks.push({ id: "transaction_confirmed", tier: "live", pass: confirmed, detail: receipt ? `receipt status ${receipt.status} in block ${receipt.blockNumber}` : "no receipt on Base for that hash", evidence: { request: `eth_getTransactionReceipt ${doc.txHash}`, blockNumber: receipt?.blockNumber ?? null } });

  const transfers = usdcTransfers(receipt);
  const mine = transfers.filter((t) => t.from === doc.walletAddress.toLowerCase());
  const paid = mine.reduce((sum, t) => sum + t.usd, 0);
  checks.push({ id: "paid_from_wallet", tier: "live", pass: confirmed && mine.length > 0, detail: mine.length ? `${mine.length} USDC transfer(s) from ${doc.walletAddress}: $${paid.toFixed(6)} to ${[...new Set(mine.map((t) => t.to))].join(", ")}` : `no USDC Transfer from ${doc.walletAddress} in the receipt (${transfers.length} USDC transfer(s) in all)`, evidence: { transfers: mine } });
  checks.push({ id: "amount_within_cap", tier: "live", pass: mine.length > 0 && paid <= cap, detail: `$${paid.toFixed(6)} paid; cap $${cap.toFixed(2)}`, evidence: { paidUsd: paid, capUsd: cap } });
  const status = Number(doc.responseStatus);
  checks.push({ id: "paid_request_ok", tier: "live", pass: status >= 200 && status < 300, detail: `paid request answered ${doc.responseStatus ?? "no status recorded"}`, evidence: { endpoint: doc.endpoint || null, responseStatus: doc.responseStatus ?? null } });

  const result = done(null);
  result.objects = { txHash: doc.txHash, walletAddress: doc.walletAddress, payees: [...new Set(mine.map((t) => t.to))], paidUsd: paid, network: doc.network || null, endpoint: doc.endpoint || null };
  return result;
}
