// Terminal output for `alg check`. Written to stderr; --json goes to stdout. Color only on a TTY,
// never with NO_COLOR or --no-color. Every line reads the same with color stripped, and fits 80 columns.

export function makeStyle(enabled) {
  const wrap = (code) => (s) => (enabled ? `\x1b[${code}m${s}\x1b[0m` : String(s));
  return { bold: wrap("1"), dim: wrap("2"), green: wrap("32"), red: wrap("31"), yellow: wrap("33") };
}

import { PASSING, mark, label } from "../dashboard/strip.js";
const TAG = { observed: "from your files", heuristic: "from page text", not_checked: "needs a test run", tested: "from your test" };

// The page a quote is on, as a path: "/docs.md".
const pathOf = (url) => {
  try {
    return new URL(url).pathname;
  } catch {
    return url || "";
  }
};


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
const listNames = (names) => (names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`);

// The outcome of the newest test of this product on this machine, from the funnel's evidence, or null.
export function latestTestOutcome(funnel) {
  const tests = (funnel?.steps || []).flatMap((s) => (s.evidence || []).filter((e) => e.kind === "test"));
  tests.sort((a, b) => (b.at > a.at ? 1 : b.at < a.at ? -1 : 0));
  return tests[0]?.outcome || null;
}

// The answer to "can an agent do it?", before the tally: which steps the pages leave an agent without.
const DOES = { discover: "finds you", understand: "understands what you sell", signup: "signs up", access: "gets a key", use: "uses the product", pay: "pays", manage: "changes a plan" };
export function renderAnswer(audit, style) {
  const steps = [...new Set(audit.findings.map((f) => f.step))];
  if (!steps.length) return [`  ${style.bold("No gaps in your pages. Only a test shows an agent can do it.")}`];
  const verbs = steps.map((s) => DOES[s] || s);
  const list = verbs.length === 1 ? verbs[0] : `${verbs.slice(0, -1).join(", ")} or ${verbs[verbs.length - 1]}`;
  return wrap(`Not yet. Your pages don't show how an agent ${list}.`, 76).map((line) => `  ${style.bold(line)}`);
}

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
    // A claim that the product requires something is shown with the sentence it came from, so a reader can check it.
    for (const q of s.quotes || []) {
      const text = q.quote.length > 160 ? `${q.quote.slice(0, 157).replace(/\s+\S*$/, "")}...` : q.quote;
      for (const line of wrap(`"${text}" (${pathOf(q.url)})`, 60)) out.push(`  ${" ".repeat(NAME + 4)}${style.dim(line)}`);
    }
  }
  return out;
}

// The fixes, the onboarding model they build toward, and where the files are. savedTo: the config file the answers
// were saved to or read from this run, or null.
export function renderSummary(audit, paths, style, relative, savedTo) {
  const out = [""];
  if (!audit.findings.length) out.push(`  ${style.bold("No fixes from public pages.")}`);
  else {
    out.push(`  ${style.bold(plural(audit.findings.length, "fix", "fixes"))}  ${style.dim(audit.findings.length === 1 ? "a prompt for your coding agent" : "one prompt each, for your coding agent")}`);
    for (const f of audit.findings) {
      const high = f.severity === "high" ? `  ${style.red("high")}` : "";
      out.push(`    ${style.bold(String(f.n).padStart(2, "0"))}  ${f.name.padEnd(10)}${f.title}${high}`);
    }
  }
  // Nobody picked it this run, so say how to change it: it shapes the fix prompts.
  const change = ["asked", "flag"].includes(audit.onboarding.chosen.source) ? (savedTo ? ` Saved to alg.yml.` : "") : " Change it in alg.yml or with --ask.";
  out.push(...wrap(`Onboarding: ${audit.onboarding.chosen.name} (${audit.onboarding.chosen.source}).${change}`, 76).map((line) => `  ${style.dim(line)}`));
  out.push(`  ${style.dim(`Files: ${relative(paths.folder)}/`)}`, `  ${style.dim(`       ${audit.findings.length ? "prompts/ for the fixes, " : ""}brief.md for security, legal, billing`)}`, "");
  return out;
}

// What to do next, as the README's three steps: 1 check, 2 fix, 3 test. With fixes, step 2 names the first prompt
// by its full path, so it can be copied; the test commands follow for later. They name the product, so test runs on
// it whatever alg.yml the folder holds.
// latestTest: the outcome of the newest local test of this product (latestTestOutcome), or null. After a passing test
// with nothing to fix, Next says what is left instead of suggesting the same test again.
export function renderNext(audit, paths, style, relative, latestTest = null) {
  const cmd = `npx agent-led-growth test ${audit.target.host}`;
  const test = [`        ${style.bold(`${cmd} --check`)}`, `        ${style.bold(cmd)}`, ""];
  const step3 = "Step 3 of 3: test. The plan is free; a signup uses your Claude Code.";
  if (!audit.findings.length && (latestTest === "passed" || latestTest === "handoff")) {
    const skipped = audit.steps.filter((s) => s.state === "not_applicable").map((s) => s.name);
    const open = audit.steps.filter((s) => s.state === "not_checked").map((s) => s.name);
    const left = open.length ? `Not shown by a test yet: ${listNames(open)}.` : "Nothing left to fix or test.";
    const na = skipped.length ? ` ${listNames(skipped)} ${skipped.length === 1 ? "doesn't" : "don't"} apply.` : "";
    const [first, ...rest] = wrap(`Your latest test passed. ${left}${na} Keep it passing in CI:`, 68);
    return [`  ${style.bold("Next")}  ${first}`, ...rest.map((l) => `        ${l}`), `        ${style.bold(`${cmd} --yes --json`)}`, ""];
  }
  if (!audit.findings.length) return [`  ${style.bold("Next")}  ${step3}`, ...test];
  return [
    `  ${style.bold("Next")}  Step 2 of 3: fix. Paste a prompt into your coding agent, deploy,`,
    "        then check again:",
    `        ${relative(paths.promptsDir)}/${audit.findings[0].file}`,
    `        ${style.bold(`npx agent-led-growth check ${audit.target.host}`)}`,
    `  ${style.bold("Then")}  ${step3}`,
    ...test,
  ];
}

// While the catalog runs: what it is and what it sends. The elapsed time goes on the line after, from the caller.
export function renderStandardsStart(style) {
  return [
    `  ${style.bold("Benchmarks")}  optional: 5 third-party scores. Sends your URL to Cloudflare`,
    `              and AgentGrade.`,
  ];
}

// The aeo-ready catalog: one line per benchmark, then the failed checks, one line per benchmark with the first names
// that fit and a count of the rest; every name is in aeo-ready.json (file). Their scores are the benchmarks' own
// (Cloudflare grades a level out of 5, the others out of 100); the seven steps above are not changed by any of it.
// standards: the audit's `standards` field, or null when the check ran without --standards.
export function renderStandards(standards, style, file = null) {
  if (!standards) return [`  ${style.bold("Benchmarks")}  add --standards for five third-party scores (1-3 min)`, ""];
  const indent = "              ";
  if (!standards.benchmarks.length) return [`${indent}${style.red("aeo-ready did not run.")} ${standards.error}`, ""];
  const out = [
    `${indent}Scores from aeo-ready ${standards.generator.version}; they do not change the seven steps.`,
    `${indent}${style.dim("agentic-seo, Fern and Vercel fetched your pages from here.")}`,
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
  if (failing.length) {
    const count = failing.reduce((n, b) => n + b.failed.length, 0);
    out.push("", `  ${style.bold("Failed checks")}  ${count}${file ? ", the first names shown. All of them:" : ""}`);
    if (file) out.push(`    ${style.dim(file)}`);
  }
  for (const b of failing) {
    const lead = `    ${b.name.padEnd(12)} ${String(b.failed.length).padStart(2)}  `;
    let shown = 1;
    const line = (n) => b.failed.slice(0, n).join(", ") + (n < b.failed.length ? `, +${b.failed.length - n}` : "");
    while (shown < b.failed.length && (lead + line(shown + 1)).length <= 76) shown++;
    out.push(`${lead}${line(shown)}`);
  }
  if (standards.error) out.push("", `  ${style.red("aeo-ready:")} ${standards.error}`);
  out.push("");
  return out;
}

// The seven steps on one or two lines, the same strip the hosted product draws: a mark per step, then which steps a
// test proved and where the agent stopped. Every line fits 80 columns and reads the same with color stripped.
export function renderStrip(funnel, style, { stoppedAt = null } = {}) {
  const cells = funnel.steps.map((s) => `${mark(s.state, style)} ${s.id === stoppedAt ? style.bold(s.name) : s.name}`);
  const plain = funnel.steps.map((s) => `x ${s.name}`);
  const rows = [];
  let row = [], width = 0;
  cells.forEach((cell, i) => {
    if (row.length && width + 2 + plain[i].length > 76) { rows.push(row); row = []; width = 0; }
    width += (row.length ? 2 : 0) + plain[i].length;
    row.push(cell);
  });
  if (row.length) rows.push(row);
  const out = ["", `  ${style.bold("Your product, seven steps")}`, ...rows.map((r) => `  ${r.join("  ")}`)];
  const proved = funnel.steps.filter((s) => s.state === "agent_did" || (s.state === "handoff" && s.live)).map((s) => s.name);
  if (proved.length) out.push(...wrap(`A test proved: ${proved.join(", ")}.`, 76).map((l) => `  ${style.dim(l)}`));
  const stop = funnel.steps.find((s) => s.id === stoppedAt) || funnel.steps.find((s) => s.id === funnel.stopsAt);
  if (stop) out.push(...wrap(`Stops at ${stop.name}: ${label(stop.state).toLowerCase()}. ${stop.reason}`, 76).map((l) => `  ${l}`));
  return out;
}
