import { readFileSync, existsSync } from "node:fs";
import { join, extname } from "node:path";
import { STAGES } from "../schema/stages.js";
import { pathOf, pretty } from "./format.js";

// Plays the crash record back as the agent lived it: stage by stage, each request typed out, its
// response shown, the agent's own words under it, and the screenshot when there was a UI. With ?play=1
// it advances on a timer so it can be recorded; without, it advances on click or arrow keys.

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
const PILLAR = { discover: "Web", understand: "Web", signup: "Onboarding", access: "Onboarding", pay: "Monetization", use: "Monetization", manage: "Monetization" };

function dataUri(dir, path) {
  if (!path || !dir) return null;
  const full = join(dir, path);
  if (!existsSync(full)) return null;
  const mime = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" }[extname(full).toLowerCase()] || "application/octet-stream";
  return `data:${mime};base64,${readFileSync(full).toString("base64")}`;
}

export function replayFrames(report) {
  const flows = report.sources?.crash?.flows || [];
  const byId = Object.fromEntries(flows.map((f) => [f.id, f]));
  return STAGES.filter((id) => byId[id] && byId[id].result !== "SKIP").map((id) => {
    const f = byId[id];
    const p = f.http ? pathOf(f.http.url) : "";
    return { id, label: STEP_TEXT[id], request: f.http ? `${f.http.method} ${p}` : STEP_TEXT[id].toLowerCase(), status: f.http?.status ?? null, quote: f.quote || "" };
  });
}

export function renderReplay(report, { assetDir = null, label = null } = {}) {
  const crash = report.sources?.crash;
  const host = label || (report.target.url ? new URL(report.target.url).host : report.target.dir);
  const flows = crash?.flows || [];
  const byId = Object.fromEntries(flows.map((f) => [f.id, f]));
  const frames = STAGES.filter((id) => byId[id] && byId[id].result !== "SKIP").map((id) => {
    const f = byId[id];
    const shot = f.screenshot ? dataUri(assetDir, f.screenshot) : null;
    const status = f.result === "PASS" ? (f.human_interventions > 0 ? "human" : "done") : "blocked";
    const path = f.http ? pathOf(f.http.url) : "";
    return { id, f, shot, status, path };
  });

  const frameHtml = frames.map(({ id, f, shot, status, path }, i) => `
  <section class="frame" data-i="${i}" data-status="${status}">
    <header><span class="tl-mono">${esc(PILLAR[id])} · step ${i + 1} of ${frames.length}</span><span class="pill ${status}">${status === "done" ? "Done" : status === "human" ? "Needs a person" : "Blocked"}</span></header>
    <h2>${esc(STEP_TEXT[id])}</h2>
    <div class="cols">
      <div class="term">
        ${f.http ? `<div class="req"><span class="prompt">$</span> <span class="typed" data-text="${esc(`${f.http.method} ${path}`)}"></span></div>
        <pre class="res" data-status="${esc(f.http.status)}"><span class="code">${esc(f.http.status)}</span>${f.http.body ? `\n${esc(pretty(f.http.body).slice(0, 600))}` : ""}</pre>` : `<div class="req"><span class="prompt">$</span> <span class="typed" data-text="${esc(STEP_TEXT[id].toLowerCase())}"></span></div>`}
      </div>
      ${shot ? `<figure><img alt="what the agent saw" src="${shot}"></figure>` : ""}
    </div>
    ${f.quote ? `<blockquote class="say"><span class="who">the agent</span>${esc(f.quote)}</blockquote>` : ""}
  </section>`).join("");

  // The end card describes this run's own steps: how many the agent did alone, how many went to a person,
  // how many stopped it. It must not restate the funnel headline, which counts a hand-off as a stall.
  const done = frames.filter((x) => x.status === "done").length;
  const human = frames.filter((x) => x.status === "human").length;
  const blocked = frames.filter((x) => x.status === "blocked").length;
  const summary = [`${done} of ${frames.length} steps done by the agent alone`, human ? `${human} handed to a person` : null, blocked ? `${blocked} blocked` : null].filter(Boolean).join(" · ");
  const outcome = blocked ? "The task stopped." : human ? "The task finished with a person in the loop, which is the designed outcome." : "The task finished without a person.";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>alg replay: ${esc(host)}</title>
<style>
:root{--ink:#193126;--line:#dce3d8;--muted:#53645a;--sage:#eef3e9;--forest:#0f4d36;--bg:#f5f7f2;--term:#12201a;--termfg:#d7e6dc}
*{box-sizing:border-box;margin:0}
html,body{background:var(--bg)}
body{color:var(--ink);font:14px/1.55 Satoshi,"Helvetica Neue",Arial,Helvetica,sans-serif;padding:32px 24px;min-height:100vh}
.tl-mono{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;letter-spacing:.09em;text-transform:uppercase;font-size:11px;color:var(--muted)}
.wrap{max-width:1160px;margin:0 auto}
.card{border:1px solid #cfd9c7;background:#fff;border-radius:11px;overflow:hidden;box-shadow:0 12px 30px -24px #17342366}
.top{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:17px 28px;background:#f2f5ed;border-bottom:1px solid var(--line);font-family:ui-monospace,monospace;font-size:11px;letter-spacing:.08em;text-transform:uppercase}
.goal{padding:22px 28px;border-bottom:1px solid var(--line)}
.goal h3{font-size:20px;font-weight:500;margin-top:6px;max-width:40ch;text-wrap:balance}
.rail{display:flex;gap:6px;padding:14px 28px;border-bottom:1px solid var(--line);background:#fbfcf8;flex-wrap:wrap}
.dot{width:10px;height:10px;border-radius:50%;background:#d9ddd6;border:1px solid #c9cfc6}
.dot.done{background:#8fbf7a;border-color:#6fa35b}.dot.human{background:#e8c777;border-color:#c9a44f}.dot.blocked{background:#e59a7a;border-color:#c67b5c}.dot.now{outline:2px solid var(--forest);outline-offset:2px}
.frame{display:none;padding:26px 28px 22px}
.frame.on{display:block}
.frame header{display:flex;align-items:center;justify-content:space-between;margin-bottom:8px}
.frame h2{font-size:24px;font-weight:500;letter-spacing:-.01em;margin-bottom:16px}
.pill{font-size:11px;padding:4px 7px;border:1px solid #e5cdb7;border-radius:4px;color:#87512a;background:#fcf3e9}
.pill.done{border-color:#ccdebf;color:#426e3b;background:#eff6e8}.pill.human{border-color:#e4d5b4;color:#806126;background:#faf1df}
.cols{display:grid;grid-template-columns:1.1fr .9fr;gap:18px;align-items:start}
.cols:has(figure:empty),.cols:not(:has(figure)){grid-template-columns:1fr}
.term{background:var(--term);color:var(--termfg);border-radius:8px;padding:16px 18px;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:12.5px;line-height:1.7;min-height:120px}
.req{color:#fff}.prompt{color:#8fbf7a}
.typed::after{content:"▍";animation:blink 1s steps(1) infinite;color:#8fbf7a}
.typed.finished::after{content:""}
.res{margin-top:10px;white-space:pre-wrap;overflow-wrap:anywhere;opacity:0;transition:opacity .3s}
.res.show{opacity:1}
.res .code{font-weight:700;color:#8fbf7a}
.res[data-status^="4"] .code,.res[data-status^="5"] .code{color:#f0a48a}
figure{margin:0}figure img{display:block;width:100%;border:1px solid var(--line);border-radius:6px}
.say{margin:16px 0 0;padding:12px 16px;border-left:3px solid var(--forest);background:#fbfcf8;font-size:15px;max-width:70ch;opacity:0;transition:opacity .3s}
.say.show{opacity:1}
.say .who{display:block;font:11px/1 ui-monospace,monospace;letter-spacing:.09em;text-transform:uppercase;color:var(--muted);margin-bottom:6px}
.end{display:none;padding:28px;background:var(--sage);border-top:1px solid var(--line)}
.end.on{display:flex;align-items:center;justify-content:space-between;gap:24px}
.end h3{font-size:18px;font-weight:500}.end p{color:var(--muted);font-size:13px;margin-top:4px}
.hint{padding:10px 28px;font-size:12px;color:var(--muted);border-top:1px solid var(--line)}
@keyframes blink{50%{opacity:0}}
@media (max-width:760px){.cols{grid-template-columns:1fr}}
</style>
</head>
<body>
<div class="wrap"><div class="card" id="replay">
  <div class="top"><span>Inside a customer task · replay</span><span>agent-ready · ${esc(host)} · ${esc(report.generatedAt.slice(0, 10))}</span></div>
  <div class="goal"><span class="tl-mono">Customer goal</span><h3>${esc(report.task || crash?.task || "")}</h3></div>
  <div class="rail" id="rail">${frames.map((x, i) => `<span class="dot ${x.status}" data-i="${i}" title="${esc(STEP_TEXT[x.id])}"></span>`).join("")}</div>
  ${frameHtml}
  <div class="end" id="end"><div><h3>${esc(summary)}.</h3><p>${esc(outcome)}</p></div><span class="tl-mono">${esc(report.maturity.label)}</span></div>
  <div class="hint" id="hint">Click or press → to advance.</div>
</div></div>
<script>
(function(){
  var frames=[].slice.call(document.querySelectorAll('.frame')); var dots=[].slice.call(document.querySelectorAll('#rail .dot'));
  var params=new URLSearchParams(location.search); var auto=params.get('play')==='1';
  var typeMs=Number(params.get('type')||28), holdMs=Number(params.get('hold')||2600);
  var i=-1, busy=false;
  function typeInto(el, done){ var t=el.getAttribute('data-text')||''; var k=0; el.textContent=''; (function tick(){ if(k>=t.length){ el.classList.add('finished'); done(); return; } el.textContent+=t[k++]; setTimeout(tick,typeMs); })(); }
  function showFrame(n, done){
    frames.forEach(function(f){f.classList.remove('on')}); dots.forEach(function(d){d.classList.remove('now')});
    if(n>=frames.length){ document.getElementById('end').classList.add('on'); document.getElementById('hint').textContent='End of replay.'; document.getElementById('replay').dataset.done='1'; return; }
    var f=frames[n]; f.classList.add('on'); dots[n].classList.add('now');
    var typed=f.querySelector('.typed'), res=f.querySelector('.res'), say=f.querySelector('.say');
    busy=true;
    typeInto(typed,function(){ setTimeout(function(){ if(res) res.classList.add('show'); setTimeout(function(){ if(say) say.classList.add('show'); busy=false; if(done) done(); }, 450); }, 350); });
  }
  function next(){ if(busy) return; i++; showFrame(i, auto?function(){ setTimeout(next, holdMs); }:null); }
  if(auto){ document.getElementById('hint').textContent=''; setTimeout(next, 700); }
  else { next(); document.addEventListener('click', next); document.addEventListener('keydown', function(e){ if(e.key==='ArrowRight'||e.key===' ') next(); }); }
})();
</script>
</body>
</html>
`;
}
