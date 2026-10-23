import { STAGES } from "../schema/stages.js";
import { pathOf, pretty } from "./format.js";

// The ~60-second hero cut as a self-playing page: title → the agent's discover line → the seven steps
// filling on the Before run → the stall → the raw failing response, in silence → the agent's own
// sentence typed out → the fix card with what remains → the console clip → the retest → the same
// request side by side, failure next to hand-off → the after steps → end card. Hard cuts only. Captions are part of the page, so they are burned in when recorded.
// ?play=1 runs the timeline and sets data-done on #hero when finished; ?layout=square renders 1:1.

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const STEP_TEXT = {
  discover: "Find the product and its docs",
  understand: "Read plans and prices",
  signup: "Create an account",
  access: "Use the key on its own data",
  pay: "Pay for the plan",
  use: "Make one metered call",
  manage: "Change plan or limits",
};
const CLASS = { AGENT_VERIFIED: "done", AGENT_CAPABLE: "done", HUMAN_REQUIRED: "human", BLOCKED: "blocked", NOT_TESTED: "unknown", NOT_APPLICABLE: "unknown" };
const WORD = { AGENT_VERIFIED: "Done", AGENT_CAPABLE: "Documented", HUMAN_REQUIRED: "Human", BLOCKED: "Blocked", NOT_TESTED: "Not reached", NOT_APPLICABLE: "Not claimed" };
const PERSON = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 3.6-7 8-7s8 3 8 7"/></svg>';

function flowOf(report, id) {
  return report?.sources?.crash?.flows?.find((f) => f.id === id) || null;
}

function firstStop(states) {
  return STAGES.find((id) => ["BLOCKED", "HUMAN_REQUIRED"].includes(states[id])) || null;
}

function steps(states) {
  return STAGES.filter((id) => states[id] !== "NOT_APPLICABLE").map((id) => {
    const cls = CLASS[states[id]];
    const icon = cls === "done" ? "✓" : cls === "human" ? PERSON : cls === "blocked" ? "!" : "?";
    return `<li class="${cls}" data-stage="${esc(id)}"><span class="ic" aria-hidden="true">${icon}</span><span>${esc(STEP_TEXT[id])}</span><small>${esc(WORD[states[id]])}</small></li>`;
  }).join("");
}

function lastSentence(text) {
  return text.split(/(?<=[.!?])\s/).slice(-1)[0];
}

function fixLine(fixed, remain) {
  const head = `${numberWord(fixed)} ${fixed === 1 ? "finding" : "findings"} fixed.`;
  if (!remain) return head;
  return `${head} ${numberWord(remain)} ${remain === 1 ? "remains" : "remain"}.`;
}

export function heroPlan(report, previousReport, { label = "run 01", fixCount = null, product = "our product", cta = "tansohq.com", fixedIn = "tanso-oss", uiClip = null } = {}) {
  if (!previousReport) throw new Error("hero needs a previous run: the cut is Before → After");
  const before = Object.fromEntries(previousReport.stages.map((s) => [s.id, s.state]));
  const after = Object.fromEntries(report.stages.map((s) => [s.id, s.state]));
  const stopB = firstStop(before);
  const stopA = firstStop(after);
  const flowB = stopB ? flowOf(previousReport, stopB) : null;
  const flowA = stopB ? flowOf(report, stopB) : null;
  const applicable = STAGES.filter((id) => before[id] !== "NOT_APPLICABLE");
  const clearedB = STAGES.filter((id) => ["AGENT_VERIFIED", "AGENT_CAPABLE"].includes(before[id])).length;
  const clearedA = STAGES.filter((id) => ["AGENT_VERIFIED", "AGENT_CAPABLE"].includes(after[id])).length;
  const humanA = STAGES.filter((id) => after[id] === "HUMAN_REQUIRED").length;
  const fixes = fixCount ?? (report.delta?.findings?.fixed?.length || 0);
  const remainingIds = [...(report.delta?.findings?.persisted || []), ...(report.delta?.findings?.new || [])];
  const remaining = remainingIds.map((id) => report.findings?.find((f) => f.id === id)?.text || id).map((t) => (t.length > 70 ? t.slice(0, 69) + "…" : t));
  const fixed = fixLine(fixes, remaining.length);
  const quote = flowB?.quote ? lastSentence(flowB.quote) : "The response tells me nothing I can act on.";
  const discoverQuote = flowOf(previousReport, "discover")?.quote ? lastSentence(flowOf(previousReport, "discover").quote) : "";
  const reqB = flowB?.http ? `${flowB.http.method} ${pathOf(flowB.http.url)}` : "";
  const reqA = flowA?.http ? `${flowA.http.method} ${pathOf(flowA.http.url)}` : reqB;
  const codeB = flowB?.http?.status ?? "";
  const codeA = flowA?.http?.status ?? "";
  const bodyB = pretty(flowB?.http?.body, 420);
  const bodyA = pretty(flowA?.http?.body, 420);
  const handoffUrl = (() => {
    try {
      return JSON.parse(flowA?.http?.body || "{}").checkoutUrl || null;
    } catch {
      return null;
    }
  })();
  const stopText = stopB ? STEP_TEXT[stopB] : "";
  const handoff = stopA && after[stopA] === "HUMAN_REQUIRED";

  // Scenes in order, each with its caption and hold. Times add up to about 62 s at the default pace.
  // Discover and console scenes are optional: they need the before run's discover quote / a trimmed clip.
  const scenes = [
    { id: "title", hold: 3000, cap: `An AI agent tried to buy ${product}.` },
    ...(discoverQuote ? [{ id: "discover", hold: 4500, cap: discoverQuote }] : []),
    { id: "before-steps", hold: 7000, cap: `${applicable.length} steps. Discover to manage.` },
    { id: "before-stall", hold: 4000, cap: `${clearedB} of ${applicable.length} steps done.${stopB ? ` Stalled at ${STEP_TEXT[stopB].toLowerCase().replace(/^pay for the plan$/, "pay")}.` : ""}` },
    { id: "fail", hold: 8000, cap: "" },
    { id: "quote", hold: 7000, cap: "" },
    { id: "fixed", hold: 3500, cap: fixed },
    ...(uiClip ? [{ id: "console", hold: 3500, cap: fixed }] : []),
    { id: "retest", hold: 3000, cap: "Retest." },
    { id: "split", hold: 7000, cap: `${codeB} → ${codeA}. Same request.` },
    { id: "handoff", hold: 5000, cap: handoff ? "Blocked became a hand-off. Human pays." : "Blocked became done." },
    { id: "after-steps", hold: 3000, cap: `${clearedA} of ${applicable.length} done.${humanA ? ` ${humanA === 1 ? "One step needs" : `${humanA} steps need`} a person.` : ""}` },
    { id: "end", hold: 2500, cap: "" },
  ];

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>alg hero: ${esc(label)}</title>
<link rel="stylesheet" href="https://api.fontshare.com/v2/css?f[]=satoshi@500,700&display=swap">
<style>
:root{--ink:#193126;--line:#dce3d8;--muted:#53645a;--sage:#eef3e9;--forest:#0f4d36;--bg:#f4f6f2;--term:#12201a;--termfg:#d7e6dc;--warn:#9b5c39;--ok:#44783e}
*{box-sizing:border-box;margin:0}
html,body{background:var(--bg);height:100%;overflow:hidden}
body{color:var(--ink);font:20px/1.5 Satoshi,"Helvetica Neue",Arial,Helvetica,sans-serif}
.stage{position:relative;width:100vw;height:100vh;overflow:hidden}
.scene{position:absolute;inset:0;display:none;padding:64px 88px;flex-direction:column}
.scene.on{display:flex}
.mono{font-family:"JetBrains Mono",ui-monospace,SFMono-Regular,Consolas,monospace;letter-spacing:.09em;text-transform:uppercase;font-size:22px;color:var(--muted)}
.tag{position:absolute;top:40px;left:88px}
.cap{position:absolute;left:88px;right:88px;bottom:64px;font-size:40px;font-weight:500;letter-spacing:-.01em;line-height:1.2;max-width:26ch;text-wrap:balance}
.cap .cur::after{content:"▍";color:var(--forest);animation:blink 1s steps(1) infinite}
@keyframes blink{50%{opacity:0}}
/* title + text cards */
.card-text{align-items:flex-start;justify-content:center}
.card-text h1{font-size:64px;font-weight:500;letter-spacing:-.02em;line-height:1.1;max-width:20ch;text-wrap:balance}
.card-text.end h1{font-size:56px}
.card-text .sub{margin-top:22px;font-size:26px;color:var(--muted)}
.remain{list-style:none;padding:0;margin-top:28px;font-size:26px;line-height:1.6;color:var(--muted)}
.remain li::before{content:"— "}
/* console clip, played inside the panel area */
.clip{width:min(1400px,100%);margin:auto;border:1px solid #cfd9c7;border-radius:14px;overflow:hidden;background:#fff;box-shadow:0 12px 30px -24px #17342366;max-height:calc(100vh - 260px);aspect-ratio:16/10}
.clip video{display:block;width:100%;height:100%;object-fit:contain}
body.square .clip{width:100%}
.btn{display:inline-block;margin-top:34px;background:var(--forest);color:#fff;padding:18px 28px;border-radius:8px;font-size:24px;font-weight:600}
/* step panel, same language as the site demo */
.panel{background:#fff;border:1px solid #cfd9c7;border-radius:14px;box-shadow:0 12px 30px -24px #17342366;width:min(1400px,100%);margin:0 auto;overflow:hidden;transform-origin:50% 40%}
.panel .hd{display:flex;justify-content:space-between;padding:20px 32px;background:#f2f5ed;border-bottom:1px solid var(--line)}
.steps{list-style:none;padding:14px 32px}
.steps li{display:flex;align-items:center;gap:18px;min-height:74px;padding:0 18px;margin:0 -18px;font-size:26px;opacity:0;transform:translateY(8px);transition:opacity .3s ease,transform .3s ease}
.steps li.shown{opacity:1;transform:none}
.steps li small{margin-left:auto;font-size:18px;color:var(--muted)}
.ic{width:36px;height:36px;border-radius:50%;border:1px solid #d4dfcb;background:#edf3e6;color:var(--ok);display:flex;align-items:center;justify-content:center;font-weight:700;font-size:17px;flex:none}
li.human .ic{background:#faf1df;border-color:#e4d5b4;color:#806126}
li.blocked .ic{background:#faeee7;border-color:#e8c7b3;color:var(--warn)}
li.unknown .ic{background:#f3f4f2;border-color:#d9ddd6;color:#7a847d}
li.focus{background:#fbf3ee;outline:2px solid #e8c7b3;outline-offset:-2px;border-radius:10px;margin:6px -18px}
.zoom{animation:zoom 3.6s ease-out forwards}
@keyframes zoom{to{transform:scale(1.12)}}
body.square .zoom{animation-name:zoomsq}
@keyframes zoomsq{to{transform:scale(1.08)}}
.zoom-hi{animation:zoomhi 3.2s ease-out forwards}
@keyframes zoomhi{to{transform:scale(1.2)}}
body.square .zoom-hi{animation-name:zoomhisq}
@keyframes zoomhisq{to{transform:scale(1.06)}}
/* terminal */
.term{background:var(--term);color:var(--termfg);border-radius:12px;padding:34px 40px;font-family:"JetBrains Mono",ui-monospace,SFMono-Regular,Consolas,monospace;font-size:28px;line-height:1.7;width:min(1400px,100%);margin:auto;transform-origin:20% 45%}
.term .req{color:#fff}.term .prompt{color:#8fbf7a}
.term .res{margin-top:16px;white-space:pre-wrap;overflow-wrap:anywhere;opacity:0;transition:opacity .25s}
.term .res.show{opacity:1}
.term .code{font-weight:700;color:#8fbf7a;font-size:36px}
.term.bad .code{color:#f0a48a}
.term .hi{background:#1f4a35;color:#fff;border-radius:4px;padding:0 4px}
.typed::after{content:"▍";color:#8fbf7a;animation:blink 1s steps(1) infinite}
.typed.finished::after{content:""}
/* quote */
.quote{justify-content:center}
.quote .who{margin-bottom:18px}
.quote p{font-size:48px;font-weight:500;letter-spacing:-.01em;line-height:1.25;max-width:22ch;text-wrap:balance}
/* split */
.split{display:grid;grid-template-columns:1fr 1fr;gap:40px;align-items:start;width:100%;margin:auto 0}
.split .term{width:100%;font-size:22px;margin:0}
.split .term.was{filter:saturate(.75);opacity:.85}
.split .lab{margin-bottom:12px}
/* retest: segment control */
.seg{display:inline-flex;gap:2px;padding:4px;border:1px solid var(--line);border-radius:6px;background:#f5f7f0;margin:0 auto}
.seg span{padding:18px 30px;font-size:26px;color:var(--muted);border-radius:6px}
.seg span.on{background:#fff;color:var(--ink);font-weight:700;box-shadow:0 1px 2px #1a2f2222}
.pointer{position:absolute;width:30px;height:30px;border:2px solid var(--ink);border-radius:50%;background:#fff;box-shadow:0 2px 6px #0003;transition:transform .5s ease}
/* square layout */
body.square .scene{padding:48px 56px}
body.square .cap{left:56px;right:56px;bottom:48px;font-size:34px}
body.square .tag{left:56px;top:32px}
body.square .card-text h1{font-size:50px}
body.square .split{grid-template-columns:1fr;gap:20px}
body.square .split .term{font-size:17px}
body.square .term{font-size:19px}
body.square .steps li{min-height:58px;font-size:20px}
body.square .quote p{font-size:38px}
</style>
</head>
<body class="${"${LAYOUT}"}">
<div class="stage" id="hero" data-scenes='${esc(JSON.stringify(scenes))}'>

  <section class="scene card-text" data-id="title"><span class="tag mono">${esc(label)}</span><h1 id="title-h1"></h1></section>

  <section class="scene quote" data-id="discover"><span class="tag mono">Before · the agent</span><div><div class="who mono">the agent, at discover</div><p>${esc(discoverQuote)}</p></div></section>

  <section class="scene" data-id="before-steps"><span class="tag mono">Before</span><div class="panel"><div class="hd"><span class="mono">Customer goal</span><span class="mono">${esc(label)}</span></div><ol class="steps">${steps(before)}</ol></div><div class="cap"></div></section>

  <section class="scene" data-id="before-stall"><span class="tag mono">Before</span><div class="panel"><div class="hd"><span class="mono">Customer goal</span><span class="mono">${esc(label)}</span></div><ol class="steps shown-all">${steps(before)}</ol></div><div class="cap"></div></section>

  <section class="scene" data-id="fail"><span class="tag mono">Before · ${esc(stopText)}</span><div class="term bad"><div class="req"><span class="prompt">$</span> <span class="typed" data-text="${esc(reqB)}"></span></div><pre class="res"><span class="code">${esc(codeB)}</span>\n${esc(bodyB)}</pre></div></section>

  <section class="scene quote" data-id="quote"><span class="tag mono">Before · the agent</span><div><div class="who mono">the agent, at ${esc(stopText.toLowerCase())}</div><p><span class="typed-q" data-text="${esc(quote)}"></span></p></div></section>

  <section class="scene card-text" data-id="fixed"><span class="tag mono">Fix · ${esc(fixedIn)}</span><h1 class="cap-here"></h1><ul class="remain">${remaining.map((t) => `<li>${esc(t)}</li>`).join("")}</ul></section>

  <section class="scene" data-id="console"><span class="tag mono">Fix · ${esc(fixedIn)}</span><div class="clip"><video src="${esc(uiClip || "")}" muted playsinline preload="auto"></video></div><div class="cap">${esc(fixed)}</div></section>

  <section class="scene" data-id="retest" style="align-items:center;justify-content:center"><span class="tag mono">Retest</span><div class="seg"><span id="seg-before" class="on">Before</span><span id="seg-after">After the change</span></div><div class="pointer" id="pointer"></div><div class="cap"></div></section>

  <section class="scene" data-id="split"><span class="tag mono">Same request, before and after</span><div class="split"><div><div class="lab mono">Before</div><div class="term bad was"><div class="req"><span class="prompt">$</span> ${esc(reqB)}</div><pre class="res show"><span class="code">${esc(codeB)}</span>\n${esc(bodyB)}</pre></div></div><div><div class="lab mono">After</div><div class="term"><div class="req"><span class="prompt">$</span> <span class="typed" data-text="${esc(reqA)}"></span></div><pre class="res"><span class="code">${esc(codeA)}</span>\n${esc(bodyA)}</pre></div></div></div><div class="cap"></div></section>

  <section class="scene" data-id="handoff"><span class="tag mono">After · ${esc(stopText)}</span><div class="term zoom-hi"><div class="req"><span class="prompt">$</span> ${esc(reqA)}</div><pre class="res show"><span class="code">${esc(codeA)}</span>\n${handoffUrl ? esc(bodyA).replace(esc(handoffUrl), `<span class="hi">${esc(handoffUrl)}</span>`) : esc(bodyA)}</pre></div><div class="cap"></div></section>

  <section class="scene" data-id="after-steps"><span class="tag mono">After</span><div class="panel"><div class="hd"><span class="mono">Customer goal</span><span class="mono">${esc(label)}</span></div><ol class="steps">${steps(after)}</ol></div><div class="cap"></div></section>

  <section class="scene card-text end" data-id="end"><span class="tag mono">${esc(cta)}</span><h1>Run it on your product.</h1><div class="sub">Before, after, evidence.</div><div class="btn">${esc(cta)}</div></section>
</div>
<script>
(function(){
  var params=new URLSearchParams(location.search);
  if(params.get('layout')==='square') document.body.classList.add('square');
  var hero=document.getElementById('hero'); var scenes=JSON.parse(hero.dataset.scenes);
  var speed=Number(params.get('speed')||1);
  function el(id){ return document.querySelector('.scene[data-id="'+id+'"]'); }
  function type(node, text, cps, done){ var i=0; node.textContent=''; (function t(){ if(i>=text.length){ node.classList.add('finished'); if(done) done(); return; } node.textContent+=text[i++]; setTimeout(t, 1000/cps); })(); }
  function showSteps(sec, ms, done){ var items=sec.querySelectorAll('.steps li'); var i=0; (function n(){ if(i>=items.length){ if(done) done(); return; } items[i++].classList.add('shown'); setTimeout(n, ms); })(); }
  function run(i){
    if(i>=scenes.length){ hero.dataset.done='1'; return; }
    var s=scenes[i]; var sec=el(s.id); document.querySelectorAll('.scene.on').forEach(function(x){x.classList.remove('on')}); sec.classList.add('on');
    var cap=sec.querySelector('.cap, .cap-here, #title-h1'); if(cap && s.cap && s.id==='title'){ cap.textContent=s.cap; } else if(cap && s.cap && !cap.textContent){ var span=document.createElement('span'); span.className='cur'; cap.textContent=''; cap.appendChild(span); type(span, s.cap, 42, function(){ span.classList.remove('cur'); }); }
    var hold=s.hold/speed;
    if(s.id==='before-steps'){ showSteps(sec, 800/speed); }
    if(s.id==='before-stall'){ sec.querySelectorAll('.steps li').forEach(function(li){li.classList.add('shown')}); var stop=sec.querySelector('.steps li.blocked, .steps li.human'); if(stop){ stop.classList.add('focus'); } sec.querySelector('.panel').classList.add('zoom'); }
    if(s.id==='fail'){ var t=sec.querySelector('.typed'); type(t, t.dataset.text, 36/speed, function(){ setTimeout(function(){ sec.querySelector('.res').classList.add('show'); setTimeout(function(){ sec.querySelector('.term').classList.add('zoom'); }, 900/speed); }, 400/speed); }); }
    if(s.id==='quote'){ var q=sec.querySelector('.typed-q'); setTimeout(function(){ type(q, q.dataset.text, 40/speed); }, 400/speed); }
    if(s.id==='console'){ var v=sec.querySelector('video'); v.currentTime=0; v.play(); }
    if(s.id==='retest'){ var p=document.getElementById('pointer'); var a=document.getElementById('seg-after'); var r=a.getBoundingClientRect(); p.style.left=(r.left+r.width/2-11)+'px'; p.style.top=(r.top+r.height+40)+'px'; setTimeout(function(){ p.style.transform='translateY(-'+(r.height/2+40)+'px)'; setTimeout(function(){ document.getElementById('seg-before').classList.remove('on'); a.classList.add('on'); }, 550/speed); }, 900/speed); }
    if(s.id==='split'){ var t2=sec.querySelector('.typed'); setTimeout(function(){ type(t2, t2.dataset.text, 36/speed, function(){ setTimeout(function(){ sec.querySelector('.term:not(.was) .res').classList.add('show'); }, 400/speed); }); }, 1200/speed); }
    if(s.id==='after-steps'){ showSteps(sec, 300/speed); }
    setTimeout(function(){ run(i+1); }, hold);
  }
  if(params.get('play')==='1'){ setTimeout(function(){ run(0); }, 500); }
  else { run(0); }
})();
</script>
</body>
</html>
`.replace("${LAYOUT}", "");
  return { html, scenes, quote, failText: `${reqB} → ${codeB}`, label, cta };
}

export function renderHero(report, previousReport, opts = {}) {
  return heroPlan(report, previousReport, opts).html;
}

function numberWord(n) {
  const words = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];
  const w = words[n] || String(n);
  return w.charAt(0).toUpperCase() + w.slice(1);
}
