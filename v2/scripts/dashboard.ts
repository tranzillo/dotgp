/**
 * The lab, at a glance: a small local web page following experiments as they
 * run. Every folder under the given roots is an experiment; every .log in it
 * a run (a class, a PPO practice, ...), and every .txt a result. Runs show
 * whether they're still going (their log changed lately), how far along they
 * are, a chart of what they're learning, and their latest lines; results
 * show in full. The page refreshes itself.
 *
 *   npx tsx scripts/dashboard.ts <folder> [<folder> ...] [--port 5180]
 *
 * Then open http://localhost:5180. Read-only: it only reads files under the roots.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { basename, join, relative, resolve, sep } from 'node:path';

const args = process.argv.slice(2);
const portAt = args.indexOf('--port');
const port = portAt >= 0 ? Number(args[portAt + 1]) : 5180;
const roots = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--port').map((r) => resolve(r));
if (!roots.length) throw new Error('dashboard.ts <folder> [<folder> ...]');

/** A run is still going if its log changed this recently (ms). */
const LIVE = 90_000;

interface Point { x: number; y: number }
interface Run {
  path: string; name: string; kind: string; live: boolean; modified: number;
  progress: string; status: string; tail: string[];
  /** Charts: name -> points. */
  series: Record<string, Point[]>;
}

/** What a log says about its run: its kind, how far it got, and its learning curves. */
function summarise(text: string): Pick<Run, 'kind' | 'progress' | 'status' | 'series'> {
  const lines = text.split(/\r?\n/).filter(Boolean);
  const series: Record<string, Point[]> = {};
  const add = (k: string, x: number, y: number) => (series[k] ??= []).push({ x, y });
  let kind = 'log', progress = '', status = lines[lines.length - 1] ?? '';
  for (const l of lines) {
    // PPO practice: "it N rR: X s/s ..." and "eval at R m — wheels: L laps, C% clean, ..."
    let m = /^it (\d+) r(\d+): (-?[\d.]+) s\/s/.exec(l);
    if (m) {
      kind = 'practice (PPO)';
      add('seconds of race time per second', +m[1], +m[3]);
      add('curriculum radius (m)', +m[1], +m[2]);
      progress = `iteration ${m[1]}`;
      continue;
    }
    m = /eval at \d+ m — wheels: ([\d.]+) laps, (\d+)% clean.*\| real: ([\d.]+) laps, (\d+)% clean/.exec(l);
    if (m) {
      const x = series['seconds of race time per second']?.at(-1)?.x ?? 0;
      add('clean drives % (real)', x, +m[4]);
      continue;
    }
    // Classes: "lesson: N students, apprenticeship X s", "round N: ...", "N rounds, X s, finished F"
    m = /^(\w+): (\d+) students, apprenticeship (\d+) s/.exec(l);
    if (m) { kind = `class (${m[1]})`; progress = `apprenticed in ${m[3]} s`; continue; }
    m = /^round (\d+): (.*)/.exec(l);
    if (m) { progress = `round ${m[1]}`; const r = /down to (\d+) m/.exec(m[2]); if (r) add('curriculum radius (m)', +m[1], +r[1]); continue; }
    m = /^(\d+) rounds, (\d+) s, finished (\w+)/.exec(l);
    if (m) { progress = `${m[1]} rounds in ${Math.round(+m[2] / 60)} min`; continue; }
  }
  return { kind, progress, status, series };
}

function inRoots(p: string): boolean {
  const full = resolve(p);
  return roots.some((r) => full === r || full.startsWith(r + sep));
}

/** Runs as last read, by path: a log is read again only when it has changed. */
const seen = new Map<string, { mtime: number; size: number; run: Omit<Run, 'live'> }>();

function readRun(path: string, name: string, mtime: number, size: number): Run {
  const known = seen.get(path);
  if (known && known.mtime === mtime && known.size === size) return { ...known.run, live: Date.now() - mtime < LIVE };
  const text = readFileSync(path, 'utf8');
  const run = {
    path, name, modified: mtime, tail: text.split(/\r?\n/).filter(Boolean).slice(-4),
    ...summarise(text.length > 400_000 ? text.slice(-400_000) : text),
  };
  seen.set(path, { mtime, size, run });
  return { ...run, live: Date.now() - mtime < LIVE };
}

function scan(): { experiments: Array<{ name: string; root: string; runs: Run[]; results: Array<{ path: string; name: string; modified: number }> }> } {
  const experiments = [];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    const dirs = [root, ...readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => join(root, e.name))];
    for (const dir of dirs) {
      const files = readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile());
      const runs: Run[] = [], results = [];
      for (const f of files) {
        const path = join(dir, f.name);
        const st = statSync(path);
        if (f.name.endsWith('.log')) runs.push(readRun(path, f.name.replace(/\.log$/, ''), st.mtimeMs, st.size));
        else if (f.name.endsWith('.txt')) results.push({ path, name: f.name.replace(/\.txt$/, ''), modified: st.mtimeMs });
      }
      if (!runs.length && !results.length) continue;
      runs.sort((a, b) => Number(b.live) - Number(a.live) || b.modified - a.modified);
      results.sort((a, b) => b.modified - a.modified);
      experiments.push({ name: dir === root ? basename(root) : relative(root, dir), root: basename(root), runs, results });
    }
  }
  experiments.sort((a, b) => Math.max(0, ...b.runs.map((r) => r.modified), ...b.results.map((r) => r.modified))
    - Math.max(0, ...a.runs.map((r) => r.modified), ...a.results.map((r) => r.modified)));
  return { experiments };
}

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>DotGP lab</title><style>
:root{--bg:#0f1115;--panel:#171a21;--line:#2a2f3a;--text:#e6e8ee;--dim:#8b93a5;--live:#3ddc84;--accent:#6aa9ff}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.45 system-ui,-apple-system,Segoe UI,sans-serif}
header{padding:14px 16px;border-bottom:1px solid var(--line);display:flex;gap:12px;align-items:baseline}
h1{font-size:16px;margin:0}small{color:var(--dim)}main{padding:12px 16px;max-width:1300px}
.exp{margin:0 0 18px}.exp h2{font-size:14px;margin:6px 0 8px;color:var(--dim);font-weight:600}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(270px,1fr));gap:8px}
.run{background:var(--panel);border:1px solid var(--line);border-radius:6px;padding:8px 10px;cursor:pointer;min-width:0}
.run:hover{border-color:var(--accent)}.top{display:flex;justify-content:space-between;gap:8px}
.name{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.kind{color:var(--dim);font-size:12px}
.dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--dim);margin-right:6px}.dot.live{background:var(--live)}
.last{color:var(--dim);font:11px/1.35 ui-monospace,Consolas,monospace;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:4px}
svg{display:block;width:100%;height:44px;margin-top:4px}.res{display:inline-block;margin:2px 6px 2px 0;padding:3px 8px;border:1px solid var(--line);border-radius:4px;cursor:pointer;color:var(--accent)}
#view{position:fixed;inset:0;background:rgba(0,0,0,.6);display:none;padding:24px}#view.on{display:block}
#box{background:var(--panel);border:1px solid var(--line);border-radius:8px;height:100%;display:flex;flex-direction:column;max-width:1200px;margin:auto}
#box header{justify-content:space-between}#box pre{margin:0;padding:12px 16px;overflow:auto;flex:1;font:12px/1.4 ui-monospace,Consolas,monospace;white-space:pre-wrap}
#charts{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:8px;padding:8px 16px}#charts svg{height:120px}
button{background:none;border:1px solid var(--line);color:var(--text);border-radius:4px;padding:3px 10px;cursor:pointer}
@media(max-width:600px){#view{padding:0}main{padding:12px 16px}}
</style></head><body><header><h1>DotGP lab</h1><small id="stamp"></small></header><main id="main">Loading…</main>
<div id="view"><div id="box"><header><b id="vtitle"></b><button onclick="closeView()">Close</button></header><div id="charts"></div><pre id="vbody"></pre></div></div>
<script>
let open=null;const esc=s=>s.replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
function spark(points,big){if(!points||points.length<2)return'';const xs=points.map(p=>p.x),ys=points.map(p=>p.y);
const x0=Math.min(...xs),x1=Math.max(...xs),y0=Math.min(...ys),y1=Math.max(...ys);const W=300,H=big?120:44;
const pts=points.map(p=>((p.x-x0)/(x1-x0||1)*W).toFixed(1)+','+(H-4-(p.y-y0)/(y1-y0||1)*(H-8)).toFixed(1)).join(' ');
return '<svg viewBox="0 0 '+W+' '+H+'" preserveAspectRatio="none"><polyline fill="none" stroke="#6aa9ff" stroke-width="1.5" points="'+pts+'"/>'+
'<text x="2" y="10" fill="#8b93a5" font-size="9">'+y1.toFixed(2)+'</text><text x="2" y="'+(H-2)+'" fill="#8b93a5" font-size="9">'+y0.toFixed(2)+'</text></svg>';}
async function refresh(){const r=await fetch('/api/state');const s=await r.json();document.getElementById('stamp').textContent='updated '+new Date().toLocaleTimeString();
const live=s.experiments.reduce((n,e)=>n+e.runs.filter(r=>r.live).length,0);document.title=(live?'('+live+') ':'')+'DotGP lab';
document.getElementById('main').innerHTML=s.experiments.map(e=>'<section class="exp"><h2>'+esc(e.name)+' — '+e.runs.filter(r=>r.live).length+' running, '+e.runs.length+' runs</h2>'+
(e.results.length?'<div>'+e.results.map(x=>'<span class="res" onclick="show(\\''+encodeURIComponent(x.path)+'\\',\\''+esc(x.name)+'\\')">'+esc(x.name)+'</span>').join('')+'</div>':'')+
'<div class="grid">'+e.runs.map(r=>{const k=Object.keys(r.series)[0];return '<div class="run" onclick="show(\\''+encodeURIComponent(r.path)+'\\',\\''+esc(r.name)+'\\')">'+
'<div class="top"><span class="name"><span class="dot'+(r.live?' live':'')+'"></span>'+esc(r.name)+'</span><span class="kind">'+esc(r.progress||'')+'</span></div>'+
'<div class="kind">'+esc(r.kind)+(k?' · '+esc(k):'')+'</div>'+(k?spark(r.series[k]):'')+'<div class="last">'+esc(r.status)+'</div></div>'}).join('')+'</div></section>').join('')||'No experiments yet.';
if(open)show(open.path,open.name,true);}
async function show(path,name,quiet){open={path,name};const r=await fetch('/api/file?path='+path);const j=await r.json();
document.getElementById('vtitle').textContent=decodeURIComponent(name);document.getElementById('charts').innerHTML=Object.entries(j.series||{}).map(([k,p])=>'<div><div class="kind">'+esc(k)+'</div>'+spark(p,true)+'</div>').join('');
const pre=document.getElementById('vbody');const atEnd=pre.scrollTop+pre.clientHeight>=pre.scrollHeight-20;pre.textContent=j.text;if(!quiet||atEnd)pre.scrollTop=pre.scrollHeight;document.getElementById('view').classList.add('on');}
function closeView(){open=null;document.getElementById('view').classList.remove('on');}
document.addEventListener('keydown',e=>{if(e.key==='Escape')closeView();});refresh();setInterval(refresh,5000);
</script></body></html>`;

createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${port}`);
  const json = (v: unknown) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(v)); };
  if (url.pathname === '/api/state') return json(scan());
  if (url.pathname === '/api/file') {
    const path = decodeURIComponent(url.searchParams.get('path') ?? '');
    if (!path || !inRoots(path) || !existsSync(path)) { res.writeHead(404); return res.end(); }
    const text = readFileSync(path, 'utf8');
    const shown = text.length > 200_000 ? '…\n' + text.slice(-200_000) : text;
    return json({ text: shown, series: path.endsWith('.log') ? summarise(text).series : {} });
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(PAGE);
}).listen(port, '127.0.0.1', () => console.log(`lab dashboard: http://localhost:${port} (${roots.join(', ')})`));
