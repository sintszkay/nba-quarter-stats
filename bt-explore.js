// 系统性寻找盘中正 EV：每个假设都分“前半季（发现）/ 后半季（验证）”两段报告
// 依赖 bt_games（PM 分钟价）、bt_score（比分时间线）
// 用法: node bt-explore.js [season=2025] [--cost 1] [--split 2026-01-15]
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const db = require('./btdb');
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const season = Number(args.find(a => /^\d{4}$/.test(a))) || 2025;
const COST = Number(opt('cost', 1)) / 100;
const SPLIT = opt('split', season === 2025 ? '2026-01-15' : `${season + 1}-01-15`);

const rows = db.prepare(`SELECT g.date, g.hf, g.af, b.tip, b.q1, b.q2, b.q3, b.series, s.timeline FROM bt_games b
  JOIN games g ON g.id=b.game_id JOIN bt_score s ON s.game_id=b.game_id
  WHERE b.status='ok' AND g.season=? AND b.q1 IS NOT NULL AND b.q2 IS NOT NULL AND b.q3 IS NOT NULL`).all(season)
  .map(r => ({ ...r, S: JSON.parse(r.series), TL: JSON.parse(r.timeline), hw: r.hf > r.af ? 1 : 0, half: r.date < SPLIT ? 'A' : 'B' }));
const pAt = (S, t) => { let v = null; for (const [x, p] of S) { if (x <= t) v = p; else break; } return v; };
const mAt = (TL, t) => { let v = 0; for (const [x, d] of TL) { if (x <= t) v = d; else break; } return v; };

// 统计：每笔收益列表 → 均值、标准误（按场聚类：同一场多笔先平均）
function summ(list) { // list: [{g, v}]
  const by = new Map(); for (const { g, v } of list) { (by.get(g) || by.set(g, []).get(g)).push(v); }
  const per = [...by.values()].map(a => a.reduce((x, y) => x + y) / a.length);
  const n = per.length; if (n < 15) return { n, txt: `n=${n}（太少）` };
  const m = per.reduce((a, b) => a + b) / n, se = Math.sqrt(per.reduce((a, b) => a + (b - m) ** 2, 0) / (n - 1) / n);
  return { n, m, se, txt: `${(m >= 0 ? '+' : '') + (m * 100).toFixed(1)}¢ ±${(se * 100).toFixed(1)} (n=${n})${Math.abs(m) > 2 * se ? (m > 0 ? ' ★' : ' ✗') : ''}` };
}
const both = (name, fn) => { // fn(half) -> list
  const a = summ(fn('A')), b = summ(fn('B'));
  const ok = a.m > 0 && b.m > 0 && a.m > 2 * a.se && b.m > 1.5 * b.se;
  console.log(`  ${name.padEnd(30, '　')} 前半季 ${a.txt.padEnd(26)} 后半季 ${b.txt}${ok ? '   ◆ 两段都为正' : ''}`);
};

console.log(`${season}-${String(season + 1).slice(2)} 常规赛 ${rows.length} 场（前半季 ${rows.filter(r => r.half === 'A').length} / 后半季 ${rows.filter(r => r.half === 'B').length}，分界 ${SPLIT}）· 每次进出各 ${COST * 100}¢ 成本`);

// ---------- 1) 各价位、各阶段：买入并持有到终场 ----------
console.log('\n【1】在某阶段以某价位买入、持有到终场（买入价含 1¢ 成本）');
const phases = r => {
  const end = r.TL.at(-1)[0];
  return [['第1节末', r.q1], ['第2节中', (r.q1 + r.q2) / 2], ['半场', r.q2], ['第3节中', (r.q2 + r.q3) / 2], ['第3节末', r.q3],
    ['第4节 1/4', r.q3 + (end - r.q3) * .25], ['第4节一半', r.q3 + (end - r.q3) * .5], ['第4节 3/4', r.q3 + (end - r.q3) * .75], ['第4节 90%', r.q3 + (end - r.q3) * .9]];
};
const bins = [[.02, .10], [.10, .20], [.20, .35], [.35, .50], [.50, .65], [.65, .80], [.80, .90], [.90, .95], [.95, .98]];
for (const [lo, hi] of bins) {
  both(`价格 ${(lo * 100).toFixed(0)}–${(hi * 100).toFixed(0)}¢（所有阶段）`, h => {
    const L = [];
    for (const r of rows) if (r.half === h) for (const [, t] of phases(r)) {
      const p = pAt(r.S, t + 60); if (p === null) continue;
      for (const [q, w] of [[p, r.hw], [1 - p, 1 - r.hw]]) if (q >= lo && q < hi) L.push({ g: r.date + r.tip, v: w - q - COST });
    }
    return L;
  });
}
for (const [lo, hi, nm] of [[.90, .98, '第4节 买 90–98¢ 的领先方'], [.02, .10, '第4节 买 2–10¢ 的落后方']]) {
  both(nm, h => { const L = [];
    for (const r of rows) if (r.half === h) for (const [ph, t] of phases(r).slice(5)) { const p = pAt(r.S, t + 60); if (p === null) continue;
      for (const [q, w] of [[p, r.hw], [1 - p, 1 - r.hw]]) if (q >= lo && q < hi) L.push({ g: r.date + r.tip, v: w - q - COST }); }
    return L; });
}

// ---------- 2) 一波高潮后：价格是否反应过度 ----------
console.log('\n【2】一方在 4 分钟（真实时间）内打出 ≥ N 分净胜高潮后，60 秒成交：买被打的一方 / 买打出高潮的一方，持有 10 分钟后卖');
const runs = (r, N) => { // 返回 [{t, dir}]，dir=+1 表示主队打出高潮
  const ev = []; let lastT = 0;
  for (let i = 0; i < r.TL.length; i++) {
    const [t, d, per] = r.TL[i]; if (per > 4 || t < lastT + 300) continue;
    for (let j = i - 1; j >= 0 && r.TL[j][0] >= t - 240; j--) {
      const diff = d - r.TL[j][1];
      if (Math.abs(diff) >= N) { ev.push({ t, dir: Math.sign(diff) }); lastT = t; break; }
    }
  }
  return ev;
};
for (const N of [8, 10, 12]) for (const [who, sgn] of [['买被打的一方', -1], ['买打出高潮的一方', 1]]) {
  both(`高潮 ≥${N} 分 · ${who}`, h => { const L = [];
    for (const r of rows) if (r.half === h) for (const e of runs(r, N)) {
      const p0 = pAt(r.S, e.t + 60), p1 = pAt(r.S, e.t + 660); if (p0 === null || p1 === null) continue;
      const side = e.dir * sgn; const q0 = side > 0 ? p0 : 1 - p0, q1 = side > 0 ? p1 : 1 - p1;
      if (q0 < .05 || q0 > .95) continue;
      L.push({ g: r.date + r.tip, v: q1 - q0 - 2 * COST });
    }
    return L; });
}

// ---------- 3) 价格延迟：得分后价格是否继续朝同一方向走 ----------
console.log('\n【3】单次得分 ≥3 分（三分/2+1）后：60 秒成交买得分方，3 分钟 / 6 分钟后卖（看价格是否追得慢）');
for (const hold of [180, 360]) {
  both(`持有 ${hold / 60} 分钟`, h => { const L = [];
    for (const r of rows) if (r.half === h) { let lastT = 0;
      for (let i = 1; i < r.TL.length; i++) { const [t, d, per] = r.TL[i], jump = d - r.TL[i - 1][1];
        if (Math.abs(jump) < 3 || per > 4 || t < lastT + hold) continue; lastT = t;
        const p0 = pAt(r.S, t + 60), p1 = pAt(r.S, t + 60 + hold); if (p0 === null || p1 === null) continue;
        const q0 = jump > 0 ? p0 : 1 - p0, q1 = jump > 0 ? p1 : 1 - p1; if (q0 < .05 || q0 > .95) continue;
        L.push({ g: r.date + r.tip, v: q1 - q0 - 2 * COST }); } }
    return L; });
}
// 不计成本的纯漂移（看有没有方向性）
both('（不计成本）持有 3 分钟的纯漂移', h => { const L = [];
  for (const r of rows) if (r.half === h) { let lastT = 0;
    for (let i = 1; i < r.TL.length; i++) { const [t, d, per] = r.TL[i], jump = d - r.TL[i - 1][1];
      if (Math.abs(jump) < 3 || per > 4 || t < lastT + 180) continue; lastT = t;
      const p0 = pAt(r.S, t + 60), p1 = pAt(r.S, t + 240); if (p0 === null || p1 === null) continue;
      const q0 = jump > 0 ? p0 : 1 - p0, q1 = jump > 0 ? p1 : 1 - p1; if (q0 < .05 || q0 > .95) continue;
      L.push({ g: r.date + r.tip, v: q1 - q0 }); } }
  return L; });

// ---------- 4) 中场漂移 ----------
console.log('\n【4】中场休息：半场结束 60 秒后买入，第3节开球时卖出（比分不变，纯看价格漂移）');
for (const [nm, pick] of [['买半场领先方', 1], ['买半场落后方', -1]]) {
  both(nm, h => { const L = [];
    for (const r of rows) if (r.half === h) { const m = mAt(r.TL, r.q2); if (!m) continue;
      const q3s = r.TL.find(x => x[2] === 3); if (!q3s) continue;
      const p0 = pAt(r.S, r.q2 + 60), p1 = pAt(r.S, q3s[0] - 30); if (p0 === null || p1 === null) continue;
      const side = Math.sign(m) * pick; const a = side > 0 ? p0 : 1 - p0, b = side > 0 ? p1 : 1 - p1; if (a < .05 || a > .95) continue;
      L.push({ g: r.date + r.tip, v: b - a - 2 * COST }); }
    return L; });
}
console.log('\n★ = 该段显著为正，✗ = 显著为负；◆ = 前后两段都为正才值得进一步验证。测试项多，偶然出现一两个 ★ 很正常。');
