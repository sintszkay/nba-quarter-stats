// pm_ledger 台账报告：盘前价格准不准、买热门/冷门的回报、盘口移动、各队被高估/低估
// 用法: node ledger-report.js [--season 2026] [--team NYK] [--cost 1]
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const db = new DatabaseSync(path.join(__dirname, 'nba.db'), { readOnly: true });
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const COST = Number(opt('cost', 1)) / 100;
const all = db.prepare(`SELECT * FROM pm_ledger WHERE status='settled' AND close_p IS NOT NULL ORDER BY start`).all();
const seasons = [...new Set(all.map(r => r.season))].sort();
const season = opt('season', null) ? Number(opt('season')) : null;
const rows = season ? all.filter(r => r.season === season) : all;
const team = opt('team', null);
const sLab = s => `${s}-${String(s + 1).slice(2)}`;
const pct = x => (x * 100).toFixed(1) + '%', c = x => (x >= 0 ? '+' : '') + (x * 100).toFixed(1) + '¢';
const meanSe = v => { const n = v.length, m = v.reduce((a, b) => a + b, 0) / n, se = Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, n - 1) / n); return { n, m, se }; };
const fmtR = v => { if (v.length < 10) return `n=${v.length}（太少）`; const { n, m, se } = meanSe(v); return `${c(m).padStart(7)} ±${(se * 100).toFixed(1)} (n=${n})${Math.abs(m) > 2 * se ? (m > 0 ? ' ★' : ' ✗') : ''}`; };

const st = db.prepare(`SELECT season, status, COUNT(*) n FROM pm_ledger GROUP BY season, status ORDER BY season`).all();
console.log('台账概况：' + seasons.map(s => `${sLab(s)} ` + st.filter(x => x.season === s).map(x => `${x.status} ${x.n}`).join('/')).join(' · '));
const pend = st.filter(x => x.status === 'pending').reduce((a, x) => a + x.n, 0);
console.log(`范围：${season ? sLab(season) : '全部赛季'}，已结算 ${rows.length} 场${pend ? `；待结算/未开赛 ${pend} 场` : ''} · 交易成本每张 ${COST * 100}¢`);

// 1) 准确度：开盘 / 24 小时 / 1 小时 / 收盘
console.log('\n【1】盘前价格的准确度（Brier 越低越准；对数损失越低越准）');
for (const [k, nm] of [['open_p', '开盘'], ['h24_p', '开赛前 24h'], ['h1_p', '开赛前 1h'], ['close_p', '收盘（开赛价）']]) {
  const L = rows.filter(r => r[k] !== null && r[k] > 0 && r[k] < 1);
  const b = L.reduce((a, r) => a + (r[k] - r.home_won) ** 2, 0) / L.length;
  const fav = L.filter(r => (r[k] >= .5) === (r.home_won === 1)).length / L.length;
  console.log(`  ${nm.padEnd(8, '　')} Brier ${b.toFixed(4)} · 热门最终赢 ${pct(fav)} (n=${L.length})`);
}

// 2) 校准：按收盘价分档
console.log('\n【2】按开赛价分档：热门的价格 vs 实际胜率，以及按开赛价买热门 / 买冷门的每张回报');
console.log('  热门价格      场数   平均价格  实际胜率   买热门          买冷门');
for (const [lo, hi] of [[.5, .55], [.55, .6], [.6, .65], [.65, .7], [.7, .75], [.75, .8], [.8, .85], [.85, .9], [.9, .95], [.95, 1.01]]) {
  const L = rows.map(r => { const fh = r.close_p >= .5; return { p: fh ? r.close_p : 1 - r.close_p, w: fh ? r.home_won : 1 - r.home_won }; }).filter(x => x.p >= lo && x.p < hi);
  if (!L.length) continue;
  const ap = L.reduce((a, x) => a + x.p, 0) / L.length, aw = L.reduce((a, x) => a + x.w, 0) / L.length;
  console.log(`  ${(lo * 100).toFixed(0)}–${Math.min(100, hi * 100).toFixed(0)}¢`.padEnd(14) + `${String(L.length).padStart(4)}   ${pct(ap).padStart(6)}   ${pct(aw).padStart(6)}   ${fmtR(L.map(x => x.w - x.p - COST)).padEnd(24)} ${fmtR(L.map(x => (1 - x.w) - (1 - x.p) - COST))}`);
}
const H = rows.map(r => r.home_won - r.close_p - COST), A = rows.map(r => (1 - r.home_won) - (1 - r.close_p) - COST);
console.log(`  每场都买主队 ${fmtR(H)}   每场都买客队 ${fmtR(A)}`);

// 3) 盘口移动：开盘 → 开赛前 1 小时，移动方向在收盘时还能不能赚
console.log('\n【3】盘口移动：开盘到开赛前 1h 某一方涨了 ≥X¢，在 1h 时跟买该方 / 反买另一方，持有到终场');
for (const X of [.03, .05, .08]) {
  const fol = [], fad = [];
  for (const r of rows) { if (r.open_p === null || r.h1_p === null) continue; const d = r.h1_p - r.open_p; if (Math.abs(d) < X) continue;
    const side = d > 0 ? 1 : 0, p = d > 0 ? r.h1_p : 1 - r.h1_p, w = d > 0 ? r.home_won : 1 - r.home_won;
    fol.push(w - p - COST); fad.push((1 - w) - (1 - p) - COST); }
  console.log(`  涨 ≥${(X * 100).toFixed(0)}¢  跟买 ${fmtR(fol).padEnd(26)} 反买 ${fmtR(fad)}`);
}
{ // 最后 1 小时的移动（1h → 收盘）
  const L = rows.filter(r => r.h1_p !== null); const mv = L.map(r => Math.abs(r.close_p - r.h1_p));
  console.log(`  开赛前最后 1 小时平均移动 ${(mv.reduce((a, b) => a + b, 0) / mv.length * 100).toFixed(1)}¢；移动 ≥3¢ 的有 ${mv.filter(x => x >= .03).length} 场（多为首发/伤病消息）`);
}

// 4) 各队：实际胜场 vs 市场预期胜场
const S = season || Math.max(...seasons);
const TR = rows.length && season ? rows : all.filter(r => r.season === S);
console.log(`\n【4】${sLab(S)} 各队：实际胜场 vs 开赛价隐含的预期胜场（正 = 市场低估这队），以及每场按开赛价买该队的回报`);
const T = {};
for (const r of TR) for (const [t, p, w] of [[r.home, r.close_p, r.home_won], [r.away, 1 - r.close_p, 1 - r.home_won]]) {
  const o = (T[t] ??= { n: 0, w: 0, e: 0, roi: [] }); o.n++; o.w += w; o.e += p; o.roi.push(w - p - COST);
}
const TL = Object.entries(T).sort((a, b) => (b[1].w - b[1].e) - (a[1].w - a[1].e));
console.log('  球队  场数  战绩     预期胜   差值    每张回报');
for (const [t, o] of TL) console.log(`  ${t.padEnd(4)}  ${String(o.n).padStart(3)}  ${(o.w + '-' + (o.n - o.w)).padEnd(7)} ${o.e.toFixed(1).padStart(6)}  ${((o.w - o.e >= 0 ? '+' : '') + (o.w - o.e).toFixed(1)).padStart(6)}   ${c(o.roi.reduce((a, b) => a + b, 0) / o.n).padStart(7)}`);
console.log('  注：一个赛季里总会有几队偏离 ±3 场以上，纯属正常波动；要看下一季是否延续才有意义。');

// 5) 指定球队明细 / 最近比赛
const L5 = (team ? rows.filter(r => r.home === team || r.away === team) : rows).slice(-15).reverse();
console.log(`\n【5】${team ? team + ' ' : ''}最近 ${L5.length} 场：开盘 → 24h → 1h → 开赛价（主队价格）`);
for (const r of L5) {
  const f = x => x === null ? ' — ' : (x * 100).toFixed(0).padStart(3);
  const fav = r.close_p >= .5 ? r.home : r.away, up = (r.close_p >= .5) !== (r.home_won === 1);
  console.log(`  ${r.date} ${r.away.padEnd(3)} @ ${r.home.padEnd(3)}  ${f(r.open_p)} →${f(r.h24_p)} →${f(r.h1_p)} →${f(r.close_p)}   ${r.af}-${r.hf}  ${up ? '冷门赢 ⚡' : fav + ' 赢'}`);
}
