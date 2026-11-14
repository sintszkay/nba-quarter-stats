// 用户规则回测：
//   入场：赛前强队（≥65%），第1–2节内第一次落后 ≥X 分时买入（看到比分 LAG 秒后成交）
//   止盈：PM 价格回到 ≥ 开赛价 就卖
//   时间止损：到时间点仍未止盈，按当时市价卖出（A = 第3节开始/中场；B = 第3节结束）
//   过滤：主客场 / 对赛往绩 / 主力是否首发
// 依赖 bt-collect.js、bt-revert.js、bt-filters.js 已抓好的数据
// 用法: node bt-tp.js [season=2025] [--cost 1] [--lag 60]
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const db = require('./btdb');
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : Number(args[i + 1]); };
const season = Number(args.find(a => /^\d{4}$/.test(a))) || 2025;
const COST = opt('cost', 1) / 100, LAG = opt('lag', 60);

const rows = db.prepare(`SELECT g.id, g.date, g.home, g.away, g.hf, g.af, b.tip, b.q2, b.q3, b.series, s.timeline, x.box
  FROM bt_games b JOIN games g ON g.id=b.game_id JOIN bt_score s ON s.game_id=b.game_id JOIN bt_box x ON x.game_id=b.game_id
  WHERE b.status='ok' AND g.season=? AND b.q2 IS NOT NULL AND b.q3 IS NOT NULL ORDER BY g.date`).all(season);

// 主力：本季场均得分前二（≥20 场）
const P = {};
for (const r of rows) for (const [t, pl] of Object.entries(JSON.parse(r.box))) for (const [id, name, , min, pts] of pl) {
  if (!min) continue; const o = ((P[t] ??= {})[id] ??= { pts: 0, gp: 0 }); o.pts += pts; o.gp++;
}
const KEY = {};
for (const [t, ps] of Object.entries(P)) KEY[t] = Object.entries(ps).filter(([, o]) => o.gp >= 20)
  .sort((a, b) => b[1].pts / b[1].gp - a[1].pts / a[1].gp).slice(0, 2).map(([id]) => id);
// 对赛往绩：此前三季 + 本季更早
const allG = db.prepare(`SELECT date, home, away, hf, af FROM games WHERE season BETWEEN ? AND ?`).all(season - 3, season);
const h2h = (team, opp, date) => { let w = 0, n = 0; for (const g of allG) if (g.date < date &&
  ((g.home === team && g.away === opp) || (g.home === opp && g.away === team))) { n++; if ((g.home === team) === (g.hf > g.af)) w++; } return { w, n }; };

const priceAt = (S, t) => { let v = null; for (const [x, p] of S) { if (x <= t) v = p; else break; } return v; };
const trades = {}; // key `${def}|${stop}` -> []
for (const r of rows) {
  const S = JSON.parse(r.series), TL = JSON.parse(r.timeline), box = JSON.parse(r.box);
  const preH = priceAt(S, r.tip); if (preH === null) continue;
  const side = preH >= .65 ? 1 : (1 - preH) >= .65 ? -1 : 0; if (!side) continue;
  const pre = side === 1 ? preH : 1 - preH;
  const fav = side === 1 ? r.home : r.away, opp = side === 1 ? r.away : r.home;
  const st = t => new Set((box[t] || []).filter(p => p[2]).map(p => p[0]));
  const favSt = st(fav), oppSt = st(opp);
  const hh = h2h(fav, opp, r.date);
  const tags = { home: side === 1, h2hGood: hh.n >= 3 && hh.w / hh.n >= .6, h2hBad: hh.n >= 3 && hh.w / hh.n <= .4,
    full: (KEY[fav] || []).every(id => favSt.has(id)), oppMissing: !(KEY[opp] || []).every(id => oppSt.has(id)) };
  const px = t => { const p = priceAt(S, t); return p === null ? null : side === 1 ? p : 1 - p; };
  for (const def of [5, 8, 10]) {
    let entry = null;
    for (const [t, d, per] of TL) if (per <= 2 && d * side <= -def) { const p = px(t + LAG); if (p !== null && p > .02) { entry = { t: t + LAG, p }; break; } }
    if (!entry) continue;
    for (const [stopName, stopT] of [['A', r.q2 + LAG], ['B', r.q3 + LAG]]) {
      if (entry.t >= stopT) continue;
      let sell = null, how = 'stop';
      for (const [x, p] of S) {
        if (x <= entry.t) continue;
        if (x > stopT) break;
        const q = side === 1 ? p : 1 - p;
        if (q >= pre) { sell = q; how = 'tp'; break; }
      }
      if (sell === null) sell = px(stopT);
      if (sell === null) continue;
      (trades[`${def}|${stopName}`] ??= []).push({ ...tags, buy: entry.p, pre, sell, how, pnl: sell - entry.p - 2 * COST });
    }
  }
}

const fmt = T => {
  const n = T.length; if (n < 8) return `n=${n}（样本太少）`;
  const mean = a => a.reduce((x, y) => x + y, 0) / a.length;
  const Pn = T.map(t => t.pnl), m = mean(Pn), se = Math.sqrt(Pn.reduce((x, y) => x + (y - m) ** 2, 0) / (n - 1) / n);
  const tp = T.filter(t => t.how === 'tp'), sl = T.filter(t => t.how === 'stop');
  const s = v => (v >= 0 ? '+' : '') + (v * 100).toFixed(1) + '¢';
  return `n=${String(n).padStart(3)} 均买${(mean(T.map(t => t.buy)) * 100).toFixed(0)}¢(开赛${(mean(T.map(t => t.pre)) * 100).toFixed(0)}¢) | 止盈${(tp.length / n * 100).toFixed(0).padStart(3)}% 均${tp.length ? s(mean(tp.map(t => t.pnl))) : '-'} | 时间止损 均${sl.length ? s(mean(sl.map(t => t.pnl))) : '-'} | 每张 ${s(m).padStart(6)} ±${(se * 100).toFixed(1)}${Math.abs(m) > 2 * se ? (m > 0 ? '  ★显著为正' : '  ✗显著为负') : ''}`;
};
const F = [
  ['全部（基准）', t => true],
  ['强队主场', t => t.home], ['强队客场', t => !t.home],
  ['对赛往绩好', t => t.h2hGood], ['对赛往绩差', t => t.h2hBad],
  ['强队主力都首发', t => t.full], ['强队缺主力', t => !t.full],
  ['对手缺主力', t => t.oppMissing],
  ['主场+主力齐', t => t.home && t.full],
  ['主场+主力齐+往绩好', t => t.home && t.full && t.h2hGood],
  ['主力齐+对手缺主力', t => t.full && t.oppMissing],
];
console.log(`${season}-${String(season + 1).slice(2)} 常规赛 ${rows.length} 场 · 赛前强队 ≥65% · 第1–2节落后时买入 · 价格回到开赛价止盈 · ${LAG}s 后成交 · 每次 ${COST * 100}¢ 成本`);
for (const [stop, sname] of [['A', '时间止损 = 第3节开始（中场卖）'], ['B', '时间止损 = 第3节结束']])
  for (const def of [5, 8, 10]) {
    console.log(`\n【${sname} · 落后 ≥${def} 分买入】`);
    for (const [name, f] of F) console.log(`  ${name.padEnd(11, '　')} ${fmt((trades[`${def}|${stop}`] || []).filter(f))}`);
  }
console.log('\n注：共 66 个结果，纯运气也可能出现两三个“显著”。主力用全季场均得分前二，有轻微后见之明。');
