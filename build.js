// 把 nba.db 打包进 index.html（单文件，可直接用浏览器打开）
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs'), path = require('path');
const db = new DatabaseSync(path.join(__dirname, 'nba.db'), { readOnly: true });
const rows = db.prepare('SELECT date,season,stype,home,away,h1,h2,h3,h4,a1,a2,a3,a4,hf,af,ot FROM games ORDER BY date').all()
  .map(r => Object.values(r));
const meta = { updated: rows.at(-1)[0], current: Math.max(...rows.map(r => r[1])) };
// Polymarket 赛前盘口：最近 7 天 + 未来的比赛
let pm = [];
try {
  const since = new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10);
  pm = db.prepare('SELECT date,start,home,away,home_p,kind,as_of FROM pm_odds WHERE date>=? ORDER BY start, home').all(since)
    .map(r => ({ ...r }));
} catch (e) { /* 还没跑过 pm.js */ }
let ledger = [];
try {
  const L = db.prepare(`SELECT game_id,date,season,stype,start,home,away,open_p,h24_p,h1_p,close_p,snap_p,snap_t,hf,af,home_won,status,volume,hist FROM pm_ledger
    WHERE status IN ('settled','pending') ORDER BY start`).all();
  // 盘前走势压缩成 [[距开赛分钟(负数), 主队价×1000]]，连续相同价格只留首尾
  const pack = r => { if (!r.hist) return null; const t0 = Date.parse(r.start) / 1000, out = [];
    const H = JSON.parse(r.hist).filter(x => x[0] <= t0 + 60 && x[1] !== null);
    H.forEach((x, i) => { const p = Math.round(x[1] * 1000), prev = H[i - 1], next = H[i + 1];
      if (prev && next && Math.round(prev[1] * 1000) === p && Math.round(next[1] * 1000) === p) return;
      out.push([Math.round((x[0] - t0) / 60), p]); });
    return out.length > 1 ? out : null; };
  const recent = new Date(Date.now() - 3 * 864e5).toISOString().slice(0, 10);
  const files = {};
  ledger = L.map(r => { const h = pack(r), inline = r.status !== 'settled' || r.date >= recent;
    if (h && !inline) (files[r.date.slice(0, 7)] ??= {})[r.game_id] = h;
    return [r.date, r.season, r.stype, r.start, r.home, r.away, r.open_p, r.h24_p, r.h1_p,
      r.close_p, r.snap_p, r.snap_t, r.hf, r.af, r.home_won, r.status === 'settled' ? 1 : 0, r.volume ? Math.round(r.volume) : null, r.game_id, inline ? h : 0]; });
  // 较早比赛的走势按月份拆成 hist/YYYY-MM.js，点开时才加载（<script> 方式，本地双击打开也能用）
  const HD = path.join(__dirname, 'hist'); fs.mkdirSync(HD, { recursive: true });
  for (const f of fs.readdirSync(HD)) if (/^d{4}-d{2}.js$/.test(f) && !files[f.slice(0, 7)]) fs.unlinkSync(path.join(HD, f));
  for (const [m, o] of Object.entries(files)) fs.writeFileSync(path.join(HD, m + '.js'), `HIST_LOAD(${JSON.stringify(m)},${JSON.stringify(o)});`);
  meta.histMonths = Object.keys(files);
  meta.ledgerAt = db.prepare('SELECT MAX(updated) u FROM pm_ledger').get().u;
} catch (e) { /* 还没跑过 ledger.js */ }
meta.pmFetched = pm.length ? pm.map(r => r.as_of).sort().at(-1) : null;
const html = fs.readFileSync(path.join(__dirname, 'template.html'), 'utf8')
  .replace('__DATA__', JSON.stringify(rows)).replace('__META__', JSON.stringify(meta)).replace('__PM__', JSON.stringify(pm)).replace('__LEDGER__', JSON.stringify(ledger));
fs.writeFileSync(path.join(__dirname, 'index.html'), html);
console.log(`index.html 已生成：${rows.length} 场，PM 盘口 ${pm.length} 场，台账 ${ledger.length} 场，${(html.length / 1024).toFixed(0)} KB`);
