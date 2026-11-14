// 回测分析：用 Polymarket 真实盘中价格检验
//   1) PM 节末价格是否准（校准）
//   2) 用户策略：赛前强队、节末落后 5-10 分、价格 ≤ 上限时买入
//   3) 模型信号：模型公允价比 PM 价高 ≥ 4¢ 时买入
// 用法: node bt-analyze.js [season=2025] [--cost 1] [--delay 60]
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const db = require('./btdb');
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : Number(args[i + 1]); };
const season = Number(args.find(a => /^\d{4}$/.test(a))) || 2025;
const COST = opt('cost', 1) / 100;   // 每张合约的交易成本（半个价差 + 滑点）
const DELAY = opt('delay', 60);      // 节末后多少秒取价（给市场反应时间）

// ---- 与网页相同的模型 ----
const Phi = z => { const t = 1 / (1 + 0.2316419 * Math.abs(z)), d = 0.3989423 * Math.exp(-z * z / 2),
  p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274)))); return z > 0 ? 1 - p : p; };
const invPhi = p => { let lo = -8, hi = 8; for (let i = 0; i < 60; i++) { const m = (lo + hi) / 2; Phi(m) < p ? lo = m : hi = m; } return (lo + hi) / 2; };
const SD = 12.47, SDR = [12.47, 10.73, 7.87], K = [-.286, -.211, -.131], F = [.75, .5, .25];
const fair = (pre, qi, m) => Phi((m * (1 + K[qi]) + SD * invPhi(Math.min(.995, Math.max(.005, pre))) * F[qi]) / SDR[qi]);

// ---- 组装样本 ----
const rows = db.prepare(`SELECT g.*, b.tip, b.q1 AS t1, b.q2 AS t2, b.q3 AS t3, b.series FROM bt_games b JOIN games g ON g.id = b.game_id
  WHERE b.status = 'ok' AND g.season = ?`).all(season);
const priceAt = (S, t, maxGap) => { for (const [x, p] of S) if (x >= t) return x - t <= maxGap ? p : null; return null; };
const priceBefore = (S, t) => { let v = null; for (const [x, p] of S) { if (x <= t) v = p; else break; } return v; };

const obs = []; // 每行：一支球队在一个节末
let skipped = 0;
for (const g of rows) {
  const S = JSON.parse(g.series);
  const pre = priceBefore(S, g.tip);
  if (pre === null || !g.tip) { skipped++; continue; }
  const hc = [g.h1, g.h1 + g.h2, g.h1 + g.h2 + g.h3], ac = [g.a1, g.a1 + g.a2, g.a1 + g.a2 + g.a3];
  [g.t1, g.t2, g.t3].forEach((te, qi) => {
    if (!te) return;
    const p = priceAt(S, te + DELAY, 300);
    if (p === null || p <= 0.005 || p >= 0.995) return;
    const m = hc[qi] - ac[qi], hw = g.hf > g.af;
    obs.push({ qi, pre, m, p, win: hw ? 1 : 0, date: g.date, team: g.home, opp: g.away });
    obs.push({ qi, pre: 1 - pre, m: -m, p: 1 - p, win: hw ? 0 : 1, date: g.date, team: g.away, opp: g.home });
  });
}
const QN = ['第1节末', '半场', '第3节末'];
const pct = x => (x * 100).toFixed(1).padStart(5) + '%';
const cents = x => ((x >= 0 ? '+' : '') + (x * 100).toFixed(1) + '¢').padStart(7);
function pnl(list) { // 每张合约盈亏（含成本）
  const v = list.map(o => o.win - o.p - COST); const n = v.length;
  if (!n) return { n: 0, s: '  n=0' };
  const mean = v.reduce((a, b) => a + b) / n, sd = Math.sqrt(v.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, n - 1));
  const wr = list.reduce((a, o) => a + o.win, 0) / n, avgP = list.reduce((a, o) => a + o.p, 0) / n;
  return { n, mean, se: sd / Math.sqrt(n), s: `n=${String(n).padStart(4)}  均价 ${(avgP * 100).toFixed(1)}¢  胜率 ${pct(wr)}  每张 ${cents(mean)} ±${(sd / Math.sqrt(n) * 100).toFixed(1)}¢  总 ${cents(mean * n).trim()}` };
}

console.log(`\n${season}-${String(season + 1).slice(2)} 常规赛 · 有 PM 数据 ${rows.length} 场（跳过 ${skipped}）· 节末后 ${DELAY}s 取价 · 成本 ${COST * 100}¢/张\n`);

// 1) PM 校准
console.log('【1】PM 节末价格校准（价格区间 → 实际胜率）');
for (let qi = 0; qi < 3; qi++) {
  const B = [];
  for (let lo = 0; lo < 1; lo += 0.2) {
    const b = obs.filter(o => o.qi === qi && o.p >= lo && o.p < lo + 0.2);
    const w = b.reduce((a, o) => a + o.win, 0), ap = b.reduce((a, o) => a + o.p, 0);
    B.push(`${(ap / b.length * 100).toFixed(0)}→${(w / b.length * 100).toFixed(0)}`);
  }
  console.log(`  ${QN[qi]}  价格→实际: ${B.join('  ')}   (n=${obs.filter(o => o.qi === qi).length / 2} 场)`);
}

// 2) 用户策略
console.log('\n【2】用户策略：赛前胜率 ≥ X、节末落后 5–10 分、PM 价 ≤ 上限 时买入');
for (const [preMin, cap] of [[.65, .50], [.65, .45], [.70, .50], [.75, .50], [.65, 1]]) {
  console.log(`  赛前≥${preMin * 100}%  价格≤${cap < 1 ? cap * 100 + '¢' : '不限'}`);
  for (let qi = 0; qi < 3; qi++)
    console.log(`    ${QN[qi]}  ${pnl(obs.filter(o => o.qi === qi && o.pre >= preMin && o.m <= -5 && o.m >= -10 && o.p <= cap)).s}`);
}

// 3) 模型 vs PM
console.log('\n【3】模型公允价 − PM 价 的差距 → 实际盈亏（全部球队，不只强队）');
for (let qi = 0; qi < 3; qi++) {
  for (const [lo, hi, name] of [[.04, 1, '模型高 ≥4¢（买）'], [.02, .04, '模型高 2–4¢'], [-.02, .02, '差 2¢ 以内'], [-1, -.04, '模型低 ≥4¢']]) {
    const l = obs.filter(o => o.qi === qi && (fair(o.pre, qi, o.m) - o.p) >= lo && (fair(o.pre, qi, o.m) - o.p) < hi);
    console.log(`  ${QN[qi]}  ${name.padEnd(12)} ${pnl(l).s}`);
  }
}
const all = obs.map(o => fair(o.pre, o.qi, o.m) - o.p);
console.log(`\n  模型与 PM 价平均差 ${cents(all.reduce((a, b) => a + b) / all.length)}，平均绝对差 ${(all.reduce((a, b) => a + Math.abs(b), 0) / all.length * 100).toFixed(1)}¢`);
// 预测力对比：Brier 分数（越低越好）
for (let qi = 0; qi < 3; qi++) {
  const l = obs.filter(o => o.qi === qi);
  const bPM = l.reduce((a, o) => a + (o.p - o.win) ** 2, 0) / l.length, bM = l.reduce((a, o) => a + (fair(o.pre, qi, o.m) - o.win) ** 2, 0) / l.length;
  console.log(`  ${QN[qi]} Brier：PM ${bPM.toFixed(4)}  模型 ${bM.toFixed(4)}  ${bPM < bM ? '→ PM 更准' : '→ 模型更准'}`);
}
