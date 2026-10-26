// The web cut as a self-playing page, about 36 s: other sites' web probes as an anonymized grid → our own
// column joins it → our four probes on a card, one warning → the request and a plain-language reason → the
// plans typed in and the request run again → the same card, the row turning green → end card. Four probes,
// the same four rows in every scene. ?play=1 runs the timeline and sets data-done on #web when finished.

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const WEB_PROBES = ["llms_txt", "agent_json", "openapi", "pricing_json"];
const PROBE_TEXT = {
  llms_txt: "/llms.txt",
  agent_json: "/.well-known/agent.json",
  openapi: "OpenAPI spec",
  pricing_json: "/pricing.json an agent can price from",
};
const PROBE_PATH = { llms_txt: "/llms.txt", agent_json: "/.well-known/agent.json", openapi: "/openapi.json", pricing_json: "/pricing.json" };
const WORD = { pass: "Pass", warn: "Warning", fail: "Fail", skip: "Skipped" };

// What the viewer reads instead of the probe's own detail string.
function plain(p) {
  if (p.id === "pricing_json" && p.status === "pass") {
    const m = /(\d+) plan/.exec(p.detail || "");
    return m ? `${m[1]} plan${m[1] === "1" ? "" : "s"}. Readable.` : "Readable.";
  }
  if (p.id === "pricing_json") return "File found. No schema, no plans.";
  return p.status === "pass" ? "Readable." : "Not found.";
}

function probe(scan, id) {
  return scan.probes.find((p) => p.id === id) || { id, status: "skip", detail: "" };
}

function probeRows(scan) {
  return WEB_PROBES.map((id) => {
    const p = probe(scan, id);
    const icon = p.status === "pass" ? "✓" : p.status === "warn" ? "!" : p.status === "fail" ? "✕" : "?";
    return `<li class="${esc(p.status)}" data-probe="${esc(id)}"><span class="ic" aria-hidden="true">${icon}</span><span>${esc(PROBE_TEXT[id])}</span><small>${esc(WORD[p.status])}</small></li>`;
  }).join("");
}

export function webPlan(before, after, aggregate, { label = "tansohq.com", host = "tansohq.com", cta = "alg.katrinalaszlo.com", button = "Request yours" } = {}) {
  const warnB = WEB_PROBES.map((id) => probe(before, id)).find((p) => p.status !== "pass");
  if (!warnB) throw new Error("web cut needs a before scan with at least one web probe not passing");
  const fixedA = probe(after, warnB.id);
  const passB = WEB_PROBES.filter((id) => probe(before, id).status === "pass").length;
  const passA = WEB_PROBES.filter((id) => probe(after, id).status === "pass").length;
  const reqPath = PROBE_PATH[warnB.id];
  const req = `GET ${reqPath}`;
  const n = aggregate.sites.length;
  const stat = aggregate.headline;
  const diff = `+ "$schema": "…/pricing.schema.json"\n+ "plans": [ { "name": "Web evaluation", "price": 0 } ]`;
  const afterCap = `Same request. ${WORD[warnB.status]} → ${WORD[fixedA.status]}. ${passA} of ${WEB_PROBES.length}.`;

  const scenes = [
    { id: "grid", hold: 8000, cap: `${n} public SaaS sites. ${stat}` },
    { id: "ours", hold: 3000, cap: "So we scanned ourselves." },
    { id: "probes", hold: 5000, cap: `${passB} pass. ${WEB_PROBES.length - passB === 1 ? "1 warning" : `${WEB_PROBES.length - passB} warnings`}.` },
    { id: "warn", hold: 6500, cap: `Our ${reqPath.slice(1)} was there. It declared no schema and no plans. An agent could find it, not price from it.` },
    { id: "fix", hold: 5000, cap: "Added the schema and the plans. Ran it again." },
    { id: "after-term", hold: 2500, cap: afterCap },
    { id: "after-card", hold: 3000, cap: afterCap, static: true },
    { id: "end", hold: 4500, cap: "" },
  ];

  const gridRows = WEB_PROBES.map((id) => `<div class="lab">${esc(PROBE_TEXT[id])}</div><div class="dots" data-probe="${esc(id)}">${aggregate.sites.map((s) => `<i class="${esc(s.results[id] || "skip")}"></i>`).join("")}<i class="you ${esc(probe(before, id).status)}"></i></div>`).join("");
  const youOffset = 10 * 56 + 9 * 18 + 30;

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>web cut: ${esc(label)}</title>
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
.cap{position:absolute;left:88px;right:88px;bottom:124px;font-size:40px;font-weight:500;letter-spacing:-.01em;line-height:1.2;max-width:30ch;text-wrap:balance}
.cap .cur::after{content:"▍";color:var(--forest);animation:blink 1s steps(1) infinite}
@keyframes blink{50%{opacity:0}}
.card-text{align-items:flex-start;justify-content:center}
.card-text h1{font-size:64px;font-weight:500;letter-spacing:-.02em;line-height:1.1;max-width:20ch;text-wrap:balance}
.card-text .sub{margin-top:22px;font-size:28px;line-height:1.45;color:var(--muted);max-width:44ch}
.btn{display:inline-block;margin-top:34px;background:var(--forest);color:#fff;padding:18px 28px;border-radius:8px;font-size:24px;font-weight:600}
/* aggregate grid: one row per probe, one dot per site, our own column joins at the end */
.agg{width:min(1560px,100%);margin:auto 0;display:grid;grid-template-columns:520px 1fr;row-gap:34px;column-gap:48px;align-items:center;padding-bottom:120px}
.agg .lab{font-size:30px}
.agg .dots{display:flex;gap:18px;align-items:center}
.agg .dots i{width:56px;height:56px;border-radius:50%;background:#e2e7de;border:1px solid #cfd8c8;opacity:0;transform:scale(.6);transition:opacity .25s,transform .25s}
.agg .dots i.shown{opacity:1;transform:none}
.agg .dots i.pass{background:#8fbf7a;border-color:#6fa35b}.agg .dots i.warn{background:#e8c777;border-color:#c9a44f}.agg .dots i.fail{background:#e59a7a;border-color:#c67b5c}.agg .dots i.skip{background:#e2e7de}
.agg .dots.hi i:not(.pass):not(.you){outline:3px solid var(--warn);outline-offset:2px}
.agg .dots i.you{margin-left:30px;width:0;opacity:0;transition:width .4s ease,opacity .4s ease,transform .25s}
.agg.ours .dots i.you{width:56px;opacity:1;transform:none}
.agg .you-head{grid-column:1 / -1;height:0;overflow:visible}
.agg .you-head span{position:relative;display:inline-block;left:${520 + 48 + youOffset + 28}px;top:-34px;transform:translateX(-50%);opacity:0;transition:opacity .4s ease .3s;white-space:nowrap}
.agg.ours .you-head span{opacity:1}
/* probe card, same language as the site demo */
.panel{background:#fff;border:1px solid #cfd9c7;border-radius:14px;box-shadow:0 12px 30px -24px #17342366;width:min(1400px,100%);margin:auto;overflow:hidden}
.panel .hd{display:flex;justify-content:space-between;padding:20px 32px;background:#f2f5ed;border-bottom:1px solid var(--line)}
.probes{list-style:none;padding:14px 32px}
.probes li{display:flex;align-items:center;gap:18px;min-height:82px;padding:0 18px;margin:0 -18px;font-size:28px;opacity:0;transform:translateY(8px);transition:opacity .3s ease,transform .3s ease,background .4s ease}
.probes li.shown{opacity:1;transform:none}
.probes li small{margin-left:auto;font-size:19px;color:var(--muted)}
.ic{width:38px;height:38px;border-radius:50%;border:1px solid #d4dfcb;background:#edf3e6;color:var(--ok);display:flex;align-items:center;justify-content:center;font-weight:700;font-size:18px;flex:none;transition:background .4s,border-color .4s,color .4s}
li.warn .ic{background:#faf1df;border-color:#e4d5b4;color:#806126}
li.fail .ic{background:#faeee7;border-color:#e8c7b3;color:var(--warn)}
li.skip .ic{background:#f3f4f2;border-color:#d9ddd6;color:#7a847d}
li.focus{background:#fbf6e9;outline:2px solid #e4d5b4;outline-offset:-2px;border-radius:10px;margin:6px -18px}
li.flip{background:#eff6e8;outline-color:#ccdebf}
/* terminal */
.term{background:var(--term);color:var(--termfg);border-radius:12px;padding:34px 40px;font-family:"JetBrains Mono",ui-monospace,SFMono-Regular,Consolas,monospace;font-size:28px;line-height:1.7;width:min(1400px,100%);margin:auto}
.term .req{color:#fff}.term .prompt{color:#8fbf7a}
.term .res{margin-top:10px;white-space:pre-wrap;overflow-wrap:anywhere;opacity:0;transition:opacity .25s}
.term .res.show{opacity:1}
.term .code{font-weight:700;color:#8fbf7a;font-size:34px}
.term.bad .code{color:#e8c777}
.term .why{color:#e8c777;margin-left:18px}
.term .ok{color:#8fbf7a;margin-left:18px}
.term .diff{color:#8fbf7a;margin-top:18px;white-space:pre}
.term .again{margin-top:18px;color:#fff}
.typed::after{content:"▍";color:#8fbf7a;animation:blink 1s steps(1) infinite}
.typed.finished::after{content:""}
.typed.quiet::after{content:""}
</style>
</head>
<body>
<div class="stage" id="web" data-scenes='${esc(JSON.stringify(scenes))}'>

  <section class="scene on" data-id="grid"><span class="tag mono">${n} public SaaS sites · names withheld</span><div class="agg" id="agg"><div class="you-head"><span class="mono">${esc(host)}</span></div>${gridRows}</div><div class="cap"></div></section>

  <section class="scene" data-id="probes"><span class="tag mono">${esc(host)} · web checks</span><div class="panel"><div class="hd"><span class="mono">Web checks</span><span class="mono">${esc(label)}</span></div><ol class="probes">${probeRows(before)}</ol></div><div class="cap"></div></section>

  <section class="scene" data-id="warn"><span class="tag mono">Before · ${esc(reqPath)}</span><div class="term bad"><div class="req"><span class="prompt">$</span> <span class="typed" data-text="${esc(req)}"></span></div><pre class="res"><span class="code">${esc(warnB.http?.status ?? "")}</span><span class="why">${esc(plain(warnB))}</span></pre></div><div class="cap"></div></section>

  <section class="scene" data-id="fix"><span class="tag mono">Fix · ${esc(reqPath)}</span><div class="term"><div class="req"><span class="prompt">$</span> ${esc(req)}</div><pre class="res show"><span class="code" style="color:#e8c777">${esc(warnB.http?.status ?? "")}</span><span class="why">${esc(plain(warnB))}</span></pre><pre class="diff"><span class="typed quiet" data-text="${esc(diff)}"></span></pre><div class="again"><span class="prompt">$</span> <span class="typed quiet" data-text="${esc(req)}"></span></div></div><div class="cap"></div></section>

  <section class="scene" data-id="after-term"><span class="tag mono">After · ${esc(reqPath)}</span><div class="term"><div class="req"><span class="prompt">$</span> ${esc(req)}</div><pre class="res show"><span class="code">${esc(fixedA.http?.status ?? "")}</span><span class="ok">${esc(plain(fixedA))}</span></pre></div><div class="cap"></div></section>

  <section class="scene" data-id="after-card"><span class="tag mono">${esc(host)} · web checks</span><div class="panel"><div class="hd"><span class="mono">Web checks</span><span class="mono">${esc(label)}</span></div><ol class="probes">${probeRows(before)}</ol></div><div class="cap"></div></section>

  <section class="scene card-text end" data-id="end"><span class="tag mono">${esc(cta)}</span><h1>One file changed.</h1><div class="sub">An agent can now find, read and price ${esc(host)}.<br>Of the ${esc(String(n))} sites we scanned, it still can't price any.</div></section>
</div>
<script>
(function(){
  var params=new URLSearchParams(location.search);
  var stage=document.getElementById('web'); var scenes=JSON.parse(stage.dataset.scenes);
  var speed=Number(params.get('speed')||1);
  var SECTION={ ours:'grid' };
  function el(id){ return document.querySelector('.scene[data-id="'+(SECTION[id]||id)+'"]'); }
  function type(node, text, cps, done){ var i=0; node.textContent=''; node.classList.remove('quiet'); (function t(){ if(i>=text.length){ node.classList.add('finished'); if(done) done(); return; } node.textContent+=text[i++]; setTimeout(t, 1000/cps); })(); }
  function showAll(items, ms, done){ var i=0; (function n(){ if(i>=items.length){ if(done) done(); return; } items[i++].classList.add('shown'); setTimeout(n, ms); })(); }
  function run(i){
    if(i>=scenes.length){ stage.dataset.done='1'; return; }
    var s=scenes[i]; var sec=el(s.id); document.querySelectorAll('.scene.on').forEach(function(x){ if(x!==sec) x.classList.remove('on'); }); sec.classList.add('on');
    var cap=sec.querySelector('.cap');
    var hold=s.hold/speed;
    function caption(){ if(!cap || !s.cap) return; if(s.static){ cap.textContent=s.cap; return; } var span=document.createElement('span'); span.className='cur'; cap.textContent=''; cap.appendChild(span); type(span, s.cap, 42, function(){ span.classList.remove('cur'); }); }
    if(s.id==='grid'){ var dots=sec.querySelectorAll('.dots i:not(.you)'); showAll(dots, 3500/speed/dots.length, function(){ sec.querySelector('.dots[data-probe="pricing_json"]').classList.add('hi'); caption(); }); }
    else if(s.id==='ours'){ cap.textContent=''; document.getElementById('agg').classList.add('ours'); sec.querySelectorAll('.dots i.you').forEach(function(d){ d.classList.add('shown'); }); setTimeout(caption, 500/speed); }
    else if(s.id==='probes'){ showAll(sec.querySelectorAll('.probes li'), 700/speed, function(){ var w=sec.querySelector('.probes li.warn, .probes li.fail'); if(w) w.classList.add('focus'); caption(); }); }
    else if(s.id==='warn'){ var t=sec.querySelector('.typed'); type(t, t.dataset.text, 36/speed, function(){ setTimeout(function(){ sec.querySelector('.res').classList.add('show'); setTimeout(caption, 500/speed); }, 400/speed); }); }
    else if(s.id==='fix'){ caption(); var d=sec.querySelector('.diff .typed'); var a=sec.querySelector('.again .typed'); setTimeout(function(){ type(d, d.dataset.text, 48/speed, function(){ setTimeout(function(){ type(a, a.dataset.text, 36/speed); }, 500/speed); }); }, 600/speed); }
    else if(s.id==='after-card'){ caption(); sec.querySelectorAll('.probes li').forEach(function(li){ li.classList.add('shown'); }); var w=sec.querySelector('.probes li.warn, .probes li.fail'); if(w){ w.classList.add('focus'); setTimeout(function(){ w.classList.add('flip'); w.classList.remove('warn'); w.classList.remove('fail'); w.classList.add('pass'); w.querySelector('.ic').textContent='✓'; w.querySelector('small').textContent='Pass'; }, 900/speed); } }
    else { caption(); }
    setTimeout(function(){ run(i+1); }, hold);
  }
  if(params.get('play')==='1'){ setTimeout(function(){ run(0); }, 500); }
  else { run(0); }
})();
</script>
</body>
</html>
`;
  return { html, scenes };
}
