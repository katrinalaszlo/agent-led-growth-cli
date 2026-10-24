// The one vocabulary for a step of the seven-step journey, shared by the server, the CLI's terminal output and the
// dashboard (served as /strip.js). It lives here so the browser loads it as is, and package.json ships this one
// file with the CLI. State names come from src/interface/funnel.js; this file says what each one
// means to a reader: who acted, the label, the mark. No imports, so the browser can load it as is.
export const PASSING = new Set(["agent_did", "agent_can", "handoff"]);
export const FAILING = new Set(["needs_person", "blocked"]);

// Who the colour stands for. A handoff is a person stepping in at a documented point, so it reads as a person.
export const WHO = { agent_did: "agent", agent_can: "agent", handoff: "person", needs_person: "person", blocked: "blocked", not_checked: "none", not_applicable: "none" };
export const LABEL = { agent_did: "Agent did", agent_can: "Agent can", handoff: "Handoff", needs_person: "Needs a person", blocked: "Blocked", not_checked: "Needs a test", not_applicable: "Doesn't apply" };
export const KIND = { agent_did: "success", agent_can: "success", handoff: "success", needs_person: "warning", blocked: "error", not_checked: "neutral", not_applicable: "neutral" };
export const EVIDENCE_KIND = { check: "Check of public pages", test: "Test with a real agent", pay: "Payment run", signal: "Your server", stuck: "Stuck report" };

export const who = (state) => WHO[state] || "none";
export const label = (state) => LABEL[state] || state;
export const kind = (state) => KIND[state] || "neutral";

// Terminal marks. `style` is the makeStyle() object from src/audit/render.js, or null for plain text.
export function mark(state, style = null) {
  const paint = (name, s) => (style ? style[name](s) : s);
  if (PASSING.has(state)) return paint("green", "✓");
  if (FAILING.has(state)) return paint("red", "✗");
  if (state === "not_applicable") return paint("dim", "-");
  return paint("dim", "·");
}
export const markOk = (ok, style = null) => (style ? (ok ? style.green("✓") : style.red("✗")) : ok ? "✓" : "✗");

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

// The strip as HTML: seven dots in order, coloured by who acted, the stopped step marked. Styled by .funnel-strip in
// dashboard.css. `stoppedAt` is a step id or null.
export function stripHtml(funnel, { stoppedAt = null } = {}) {
  if (!funnel?.steps) return "";
  const items = funnel.steps.map((step) => {
    const latest = step.evidence?.[0];
    const title = `${step.name}: ${label(step.state)}${latest ? ` (${EVIDENCE_KIND[latest.kind] || latest.kind})` : ""}`;
    return `<li class="funnel-dot funnel-${esc(step.state)} who-${esc(who(step.state))}${step.id === stoppedAt ? " funnel-stopped" : ""}" title="${esc(title)}"><span>${esc(step.name)}</span></li>`;
  });
  return `<ol class="funnel-strip" aria-label="${esc(funnel.headline || "")}">${items.join("")}</ol>`;
}
