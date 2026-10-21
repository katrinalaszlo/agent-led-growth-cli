import { createInterface } from "node:readline/promises";

// The few questions that pick how an agent should onboard. Everything else is inferred from the product's pages.
// Each question has a default; where it came from is shown next to it (documented, inferred, recommended).

export const HOLDER_OPTIONS = [
  { id: "try_then_claim", label: "Nobody yet; a person claims it later" },
  { id: "limited_until_claimed", label: "Nobody yet; limited until a person claims it" },
  { id: "agent_is_customer", label: "The agent holds it" },
  // One implementation is AgentID (https://www.agentid.com), AgentMail's OpenID Connect provider for agents: the
  // agent signs in as itself with its AgentMail inbox. The Sign up fix prompt for this choice adds AgentID.
  { id: "agent_identity", label: "The agent, with an identity a person delegated (for example Sign in with AgentID)" },
  { id: "existing_account", label: "A person sets it up and gives the agent a key" },
  { id: "pay_per_request", label: "No account; pay per request (HTTP 402)" },
];

export const ABUSE_OPTIONS = [
  { id: "low", label: "Low: reads and storage" },
  { id: "high", label: "High: compute, sending email or SMS, phone numbers" },
];

export const HUMAN_OPTIONS = [
  { id: "never", label: "Never. An agent may act on its own" },
  { id: "outbound", label: "Before it affects anyone else (sending, publishing, charging)" },
  { id: "always", label: "Before any use: a verified person owns the account first" },
];

export const QUESTIONS = [
  { key: "onboarding", text: "Who holds the account when an agent first uses it?", options: HOLDER_OPTIONS },
  { key: "abuse_cost", text: "What does one abusive free account cost you?", options: ABUSE_OPTIONS },
  { key: "human_before", text: "Must a verified person exist before the agent acts?", options: HUMAN_OPTIONS },
];

// Defaults before anyone answers. The onboarding default follows what the docs describe; with nothing described,
// try first, claim later is recommended because it is the pattern most passing live runs used.
export function defaultAnswers(funnel) {
  const detected = funnel.path ? funnel.paths.find((p) => p.id === funnel.path.id) : null;
  return {
    onboarding: { value: detected ? detected.id : "try_then_claim", source: detected ? detected.status : "recommended" },
    abuse_cost: { value: "low", source: "default" },
    human_before: { value: "never", source: "default" },
  };
}

export function optionLabel(key, value) {
  const q = QUESTIONS.find((x) => x.key === key);
  return q.options.find((o) => o.id === value)?.label || value;
}

const UNSURE = /^(\?|not sure|unsure|idk|i don'?t know|dunno)$/i;

// Asks on a terminal: each option numbered, Enter keeps the default. Never called without a TTY.
// Ctrl+C and Ctrl+D both reject with an AbortError (code ABORT_ERR); the caller reports it as a cancel.
export async function askQuestions(defaults, { input = process.stdin, output = process.stderr, style }) {
  const rl = createInterface({ input, output });
  const cancel = new AbortController();
  rl.on("SIGINT", () => cancel.abort());
  const answers = {};
  try {
    for (const q of QUESTIONS) {
      const current = defaults[q.key];
      output.write(`\n  ${style.bold(q.text)}\n`);
      // What the product's agent-facing pages document is the answer already; asking again only invites a guess.
      if (current.source === "documented") {
        output.write(`  › ${optionLabel(q.key, current.value)}${style.dim("  (documented; change it in agent-ready.yml)")}\n`);
        answers[q.key] = current;
        continue;
      }
      q.options.forEach((o, i) => {
        const mark = o.id === current.value ? style.bold("›") : " ";
        const note = o.id === current.value ? style.dim(`  (${current.source})`) : "";
        output.write(`  ${mark} ${i + 1}. ${o.label}${note}\n`);
      });
      // An answer that is neither Enter, "not sure" nor an option number is asked again, never silently read as the default.
      let answer = null;
      while (!answer) {
        const reply = (await rl.question(style.dim("  Enter to keep, or a number: "), { signal: cancel.signal })).trim();
        const picked = /^\d+$/.test(reply) ? q.options[Number(reply) - 1] : null;
        if (!reply || UNSURE.test(reply)) answer = current;
        else if (picked) answer = { value: picked.id, source: "asked" };
        else output.write(`  Pick 1 to ${q.options.length}, or press Enter to keep the default.\n`);
      }
      answers[q.key] = answer;
    }
  } finally {
    rl.close();
  }
  return answers;
}
