// Terminal output for `agent-ready check`. Written to stderr; --json goes to stdout. Color only on a TTY,
// never with NO_COLOR or --no-color. Every line reads the same with color stripped, and fits 80 columns.

export function makeStyle(enabled) {
  const wrap = (code) => (s) => (enabled ? `\x1b[${code}m${s}\x1b[0m` : String(s));
  return { bold: wrap("1"), dim: wrap("2"), green: wrap("32"), red: wrap("31"), yellow: wrap("33") };
}

const PASSING = new Set(["agent_did", "agent_can", "handoff"]);
const FAILING = new Set(["needs_person", "blocked"]);
const TAG = { observed: "from your files", heuristic: "from page text", not_checked: "needs a test run" };

function mark(state, style) {
  if (PASSING.has(state)) return style.green("✓");
  if (FAILING.has(state)) return style.red("✗");
  return style.dim("·");
}

// Breaks text into lines of at most `width` characters, at spaces. A word longer than a line (a long URL) is split.
export function wrap(text, width) {
  const words = String(text).split(/\s+/).filter(Boolean).flatMap((w) => (w.length <= width ? [w] : w.match(new RegExp(`.{1,${width}}`, "g"))));
  const lines = [];
  let line = "";
  for (const w of words) {
    if (line && line.length + 1 + w.length > width) {
      lines.push(line);
      line = w;
    } else line = line ? `${line} ${w}` : w;
  }
  if (line) lines.push(line);
  return lines;
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// A tally, not a walk: a missing llms.txt does not make every later step fail.
export function renderVerdict(audit, style) {
  const unchecked = audit.steps.filter((s) => s.state === "not_checked").length;
  const parts = [];
  if (audit.findings.length) parts.push(`${plural(audit.findings.length, "needs a fix", "need a fix")}.`);
  if (unchecked) parts.push(`${plural(unchecked, "needs", "need")} a test run.`);
  const handoffs = audit.steps.filter((s) => s.state === "handoff").length;
  if (handoffs) parts.unshift(`${plural(handoffs, "works", "work")} because a person steps in once.`);
  // One sentence of the headline a line: "Your public pages document 5 of 7 steps." then "None is verified yet: …".
  const headline = audit.headline.split(/(?<=\.) /).flatMap((sentence) => wrap(sentence, 76));
  return [...headline.map((line) => `  ${style.bold(line)}`), ...wrap(parts.join(" "), 76).map((line) => `  ${line}`)];
}

// One row per step: mark, name, reason, and how the state was found, on the first line.
const NAME = 12;
const REASON = 44;
export function renderSteps(audit, style) {
  const out = [];
  for (const s of audit.steps) {
    const [first = "", ...rest] = wrap(s.reason, REASON);
    out.push(`  ${mark(s.state, style)} ${s.name.padEnd(NAME)}  ${first.padEnd(REASON)}  ${style.dim(TAG[s.basis] || s.basis)}`);
    for (const line of rest) out.push(`  ${" ".repeat(NAME + 4)}${line}`);
  }
  return out;
}

// savedTo: the config file the answers were saved to or read from this run, or null.
export function renderSummary(audit, paths, style, relative, savedTo) {
  const where = savedTo ? ` · ${savedTo}` : "";
  const out = ["", `  ${style.bold("Onboarding")}  ${audit.onboarding.chosen.name} ${style.dim(`(${audit.onboarding.chosen.source}${where})`)}`];
  if (!audit.findings.length) {
    out.push("", `  ${style.bold("No fixes from public pages.")}`);
  } else {
    out.push("", `  ${style.bold(plural(audit.findings.length, "fix", "fixes"))}  ${style.dim(audit.findings.length === 1 ? "a prompt for your coding agent" : "one prompt each, for your coding agent")}`);
    for (const f of audit.findings) {
      const high = f.severity === "high" ? `  ${style.red("high")}` : "";
      out.push(`    ${style.bold(String(f.n).padStart(2, "0"))}  ${f.name.padEnd(10)}${f.title}${high}`);
    }
    out.push("", `  ${style.bold("Fix")}   paste this prompt into your coding agent:`, `        ${relative(paths.promptsDir)}/${audit.findings[0].file}`, `        then run ${style.bold(`npx @tansohq/agent-ready check ${audit.target.host}`)} again`);
  }
  out.push("", `  ${style.dim(`Folder  ${relative(paths.folder)}/`)}`, `  ${style.dim(`        ${audit.findings.length ? "prompts/ for the fixes · " : ""}brief.md for security, legal, billing`)}`, "");
  return out;
}

// The aeo-ready catalog: one line per benchmark, then the failed checks by benchmark, name only. Their scores are
// the benchmarks' own (Cloudflare grades a level out of 5, the others out of 100); the seven steps above are not
// changed by any of it. standards: the audit's `standards` field, or null when --no-standards skipped it.
export function renderStandards(standards, style) {
  if (!standards) return [`  ${style.bold("Standards")}  skipped (--no-standards)`, ""];
  const head = `  ${style.bold("Standards")}  `;
  if (!standards.benchmarks.length) return [`${head}${style.red("aeo-ready did not run.")} ${standards.error}`, ""];
  const out = [
    `${head}${standards.benchmarks.length} third-party benchmarks of your public surface ${style.dim(`(aeo-ready ${standards.generator.version})`)}`,
    `             Their checks and scores; they do not change the seven steps above.`,
    `             ${style.dim("Sent your URL to isitagentready.com (Cloudflare) and AgentGrade's")}`,
    `             ${style.dim("service; agentic-seo, Fern and Vercel fetched your pages from here.")}`,
    `             ${style.dim("Runs one catalog at a time; for many products use --no-standards")}`,
    `             ${style.dim("and run the catalog later.")}`,
  ];
  for (const b of standards.benchmarks) {
    const name = b.name.padEnd(12);
    if (b.error) {
      out.push(`    ${style.dim("·")} ${name}  ${style.red("did not run:")} ${b.error}`);
      continue;
    }
    const score = `${b.id === "cloudflare" ? "level" : "score"} ${b.score}/${b.maxScore}${b.grade ? ` ${b.grade}` : ""}`;
    const counts = b.total ? `${b.passed}/${b.total} checks passed` : "no individual checks";
    const mark = !b.total ? style.dim("·") : b.passed === b.total ? style.green("✓") : style.red("✗");
    out.push(`    ${mark} ${name}  ${counts.padEnd(22)}  ${style.dim(score)}`);
  }
  const failing = standards.benchmarks.filter((b) => b.failed.length);
  if (failing.length) out.push("", `  ${style.bold("Failed checks")}  ${style.dim("names as each benchmark reports them")}`);
  for (const b of failing) {
    out.push(`    ${style.bold(b.name)}`);
    for (const name of b.failed) out.push(`      ${style.red("✗")} ${name}`);
  }
  if (standards.error) out.push("", `  ${style.red("aeo-ready:")} ${standards.error}`);
  out.push("");
  return out;
}
