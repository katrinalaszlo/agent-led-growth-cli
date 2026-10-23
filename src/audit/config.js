import { readFileSync, writeFileSync, existsSync } from "node:fs";

// alg.yml at the repo root: the answers to the onboarding questions, committed so CI and later runs reuse them.
// Flat keys only, so it is read with a line parser rather than a YAML dependency.
export const CONFIG_FILE = "alg.yml";
const KEYS = ["url", "task", "onboarding", "abuse_cost", "human_before", "verify_call", "verify_header", "verify_expect", "verify_assert", "verify_fields", "verify_body", "verify_exchange", "verify_exchange_body", "verify_exchange_token", "verify_hosts", "verify_cli"];

export function readConfig(path) {
  if (!existsSync(path)) return null;
  const config = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const match = /^([a-z_]+):\s*(.*?)\s*(?:#.*)?$/.exec(line);
    if (match && KEYS.includes(match[1]) && match[2]) config[match[1]] = match[2].replace(/^["']|["']$/g, "");
  }
  return config;
}

// The host a saved or passed url names: "example.com" and "https://example.com" both give example.com.
export function configHost(url) {
  return new URL(url.startsWith("http") ? url : `https://${url}`).host;
}

// Rewriting the answers keeps any verify_* lines the user already filled in, unless the file was for another host:
// those lines would send this product's agent key to the old product. Returns the old host when it dropped them.
export function writeConfig(path, { url, task, answers }) {
  const kept = readConfig(path) || {};
  const verifyKeys = KEYS.filter((k) => k.startsWith("verify_"));
  const otherHost = kept.url && configHost(kept.url) !== configHost(url) ? configHost(kept.url) : null;
  const filledIn = otherHost ? [] : verifyKeys.filter((k) => kept[k]);
  const dropped = otherHost && verifyKeys.some((k) => kept[k]) ? otherHost : null;
  const verifyLines = filledIn.length
    ? ["# What `alg test` checks: one call made with the key the agent got.", ...filledIn.map((k) => `${k}: ${kept[k]}`)]
    : [
        "# What `alg test` checks: one call made with the key the agent got. Uncomment and fill in.",
        "# The checker also makes it with no key and with a wrong key; both must be refused (400, 401 or 403).",
        "# verify_call: GET https://api.example.com/v1/me",
        "# verify_header: Authorization: Bearer {key}",
        "# verify_expect: 200",
        "# verify_assert: id            # a field that must be present, or field=value",
        "#",
        "# Only when the product needs them:",
        "# verify_body: {\"query\":\"{ viewer { id } }\"}   # makes the call a POST body; use POST in verify_call",
        "# verify_fields: PROJECT_ID     # values the agent saves next to its key; use {PROJECT_ID} in the call",
        "# verify_exchange: POST https://api.example.com/oauth/token   # trade the key for a token first",
        "# verify_exchange_body: grant_type=client_credentials&assertion={key}",
        "# verify_exchange_token: access_token   # where the token is in the exchange's JSON reply",
        "# verify_cli: npm               # let the agent install the product's CLI from npm (or pypi)",
        "# verify_hosts: auth.example-cloud.com  # more hosts the agent may reach, comma separated",
        "#",
        "# The agent saves its key as AGENT_READY_KEY (and each verify_fields name) in work/CREDENTIAL.env;",
        "# the task does not need to say so, but should name which value is the key when the product returns several.",
        "# Run `alg test --check` to see the plan before a real run.",
      ];
  const lines = [
    "# agent-ready: how agents should onboard to this product. Edit and commit.",
    `url: ${url}`,
    `task: ${task}`,
    `onboarding: ${answers.onboarding.value}      # try_then_claim | limited_until_claimed | agent_is_customer | agent_identity | existing_account | pay_per_request`,
    "# agent_identity: the agent signs in as itself with an identity provider for agents, for example Sign in with AgentID (OpenID Connect).",
    `abuse_cost: ${answers.abuse_cost.value}      # low | high`,
    `human_before: ${answers.human_before.value}  # never | outbound | always`,
    "",
    ...verifyLines,
    "",
  ];
  writeFileSync(path, lines.join("\n"));
  return { droppedVerifyFor: dropped };
}

// Saves a verify_call that `test` inferred and the person accepted. Every other line stays as it is; the commented
// examples `check` writes (or a verify_header already there) are replaced in place, and a file without them gets
// the lines at the end.
export function writeVerifyCall(path, { call, header }) {
  const lines = readFileSync(path, "utf8").split("\n");
  for (const [key, value] of [["verify_call", call], ["verify_header", header]]) {
    const i = lines.findIndex((l) => new RegExp(`^(?:#\\s*)?${key}:`).test(l));
    if (i === -1) {
      if (lines[lines.length - 1] === "") lines.splice(lines.length - 1, 0, `${key}: ${value}`);
      else lines.push(`${key}: ${value}`);
    } else lines[i] = `${key}: ${value}`;
  }
  writeFileSync(path, lines.join("\n"));
}
