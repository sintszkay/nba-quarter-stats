// 规则：开赛前胜率 ≥ PRE（默认 75%）的强队，盘中价格第一次跌穿 50¢ 时买入
//   入场时间窗：第1–2节（也测全场）
//   出场：止盈价（开赛价 / 60¢ / 65¢）或时间止损（第3节开始 / 第3节结束 / 拿到终场）
// 用法: node bt-dip.js [season=2025] [--pre 0.75] [--trig 0.50] [--cost 1]
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const db = require('./btdb');
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : Number(args[i + 1]); };
const season = Number(args.find(a => /^\d{4}$/.test(a))) || 2025;
const PRE = opt('pre', .75), TRIG = opt('trig', .50), COST = opt('cost', 1) / 100;

const rows = db.prepare(`SELECT g.id, g.date, g.home, g.away, g.hf, g.af, b.tip, b.q2, b.q3, b.series, x.box
  FROM bt_games b JOIN games g ON g.id=b.game_id LEFT JOIN bt_box x ON x.game_id=b.game_id
  WHERE b.status='ok' AND g.season=? AND b.q2 IS NOT NULL AND b.q3 IS NOT NULL ORDER BY g.date`).all(season);
const priceBefore = (S, t) => { let v = null; for (const [x, p] of S) { if (x <= t) v = p; else break; } return v; };

// 主力（场均得分前二）
const P = {};
for (const r of rows) if (r.box) for (const [t, pl] of Object.entries(JSON.parse(r.box))) for (const [id, , , min, pts] of pl) {
  if (!min) continue; const o = ((P[t] ??= {})[id] ??= { pts: 0, gp: 0 }); o.pts += pts; o.gp++;
}
const KEY = {};
for (const [t, ps] of Object.entries(P)) KEY[t] = Object.entries(ps).filter(([, o]) => o.gp >= 20)
  .sort((a, b) => b[1].pts / b[1].gp - a[1].pts / a[1].gp).slice(0, 2).map(([id]) => id);

const T = [];
let favGames = 0;
for (const r of rows) {
  const S = JSON.parse(r.series);
  const preH = priceBefore(S, r.tip); if (preH === null) continue;
  const side = preH >= PRE ? 1 : (1 - preH) >= PRE ? -1 : 0; if (!side) continue;
  favGames++;
  const pre = side === 1 ? preH : 1 - preH, won = side === 1 ? r.hf > r.af : r.af > r.hf;
  const q = p => side === 1 ? p : 1 - p;
  const fav = side === 1 ? r.home : r.away, opp = side === 1 ? r.away : r.home;
  let full = null, oppMissing = null;
  if (r.box) { const box = JSON.parse(r.box), st = t => new Set((box[t] || []).filter(p => p[2]).map(p => p[0]));
    full = (KEY[fav] || []).every(id => st(fav).has(id)); oppMissing = !(KEY[opp] || []).every(id => st(opp).has(id)); }
  // 入场：开赛后第一次价格 < TRIG（买入价 = 该分钟价格）
  let ei = -1;
  for (let i = 0; i < S.length; i++) if (S[i][0] > r.tip && q(S[i][1]) < TRIG) { ei = i; break; }
  if (ei < 0) continue;
  const [et, ep] = [S[ei][0], q(S[ei][1])];
  const inH1 = et < r.q2;
  const exit = (tp, stopT) => { // 返回卖出价
    for (let i = ei + 1; i < S.length; i++) { const [x, p] = S[i]; if (stopT && x > stopT) break; if (q(p) >= tp) return { px: q(p), how: 'tp' }; }
    if (!stopT) return { px: won ? 1 : 0, how: 'end' };
    const p = priceBefore(S, stopT); return { px: p === null ? (won ? 1 : 0) : q(p), how: 'stop' };
  };
  const res = {};
  for (const [tpName, tp] of [['开赛价', pre], ['60¢', .60], ['65¢', .65], ['不止盈', 2]])
    for (const [stName, stopT] of [['第3节开始', r.q2 + 60], ['第3节结束', r.q3 + 60], ['终场', null]]) {
      if (stopT && et >= stopT) continue;
      const e = exit(tp, stopT);
      res[`${tpName}|${stName}`] = { ...e, pnl: e.px - ep - (e.how === 'end' ? COST : 2 * COST) };
    }
  T.push({ date: r.date, fav, opp, pre, ep, inH1, won, full, oppMissing, res });
}

const stat = (list, key) => {
  const L = list.map(t => t.res[key]).filter(Boolean); const n = L.length; if (n < 8) return `n=${n}（太少）`;
  const v = L.map(x => x.pnl), m = v.reduce((a, b) => a + b) / n, se = Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / (n - 1) / n);
  const tp = L.filter(x => x.how === 'tp').length;
  const s = x => (x >= 0 ? '+' : '') + (x * 100).toFixed(1) + '¢';
  return `n=${String(n).padStart(3)} 止盈${String(Math.round(tp / n * 100)).padStart(3)}%  每张 ${s(m).padStart(6)} ±${(se * 100).toFixed(1)}${Math.abs(m) > 2 * se ? (m > 0 ? ' ★' : ' ✗') : ''}`;
};
const h1 = T.filter(t => t.inH1);
console.log(`${season}-${String(season + 1).slice(2)} 常规赛 · 开赛前 ≥${PRE * 100}% 的强队 ${favGames} 场，其中盘中跌穿 ${TRIG * 100}¢ 的 ${T.length} 场（上半场跌穿 ${h1.length} 场）· 每次 ${COST * 100}¢ 成本`);
const avg = (L, f) => (L.reduce((a, t) => a + f(t), 0) / L.length * 100).toFixed(1);
console.log(`  上半场跌穿的：平均开赛价 ${avg(h1, t => t.pre)}¢，平均买入价 ${avg(h1, t => t.ep)}¢，最终赢球 ${avg(h1, t => t.won ? 1 : 0)}%  → 拿到终场每张约 ${(avg(h1, t => (t.won ? 1 : 0) - t.ep - COST))}¢`);
console.log(`  全场跌穿的：  平均买入价 ${avg(T, t => t.ep)}¢，最终赢球 ${avg(T, t => t.won ? 1 : 0)}%`);

for (const [name, L] of [['只在第1–2节跌穿时买', h1], ['第1–2节 + 我方主力齐 + 对手缺主力', h1.filter(t => t.full && t.oppMissing)], ['第1–2节 + 我方主力齐', h1.filter(t => t.full)]]) {
  console.log(`\n【${name}】`);
  console.log('  止盈 \\ 止损      第3节开始                         第3节结束                         拿到终场');
  for (const tp of ['开赛价', '60¢', '65¢', '不止盈'])
    console.log(`  ${tp.padEnd(6, '　')} ${['第3节开始', '第3节结束', '终场'].map(st => stat(L, `${tp}|${st}`).padEnd(34)).join('')}`);
}
// 逐笔明细（上半场）
console.log('\n上半场跌穿明细（最近 15 笔）：日期 强队 vs 对手 开赛价→买入价 结果');
for (const t of h1.slice(-15)) console.log(`  ${t.date} ${t.fav} vs ${t.opp}  ${(t.pre * 100).toFixed(0)}¢→${(t.ep * 100).toFixed(0)}¢  ${t.won ? '赢' : '输'}`);
