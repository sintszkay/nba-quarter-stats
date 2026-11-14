// 回测“强队落后抄底，追回平手就平仓”策略
// 第一步：补抓每场的比分时间线（ESPN 逐回合，带真实时间）→ bt_score 表
// 第二步：用 Polymarket 分钟价模拟进出场
// 用法: node --dns-result-order=ipv4first bt-revert.js [season=2025] [--cost 1] [--lag 60]
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const db = require('./btdb');
db.exec(`CREATE TABLE IF NOT EXISTS bt_score (game_id TEXT PRIMARY KEY, timeline TEXT)`); // [[unix秒, 主队分差, 节], ...]
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : Number(args[i + 1]); };
const season = Number(args.find(a => /^\d{4}$/.test(a))) || 2025;
const COST = opt('cost', 1) / 100, LAG = opt('lag', 60);
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function getJSON(url) {
  for (let i = 0; i < 7; i++) {
    try { const r = await fetch(url, { signal: AbortSignal.timeout(20000) }); if (r.status === 404) return null; if (!r.ok) throw new Error('HTTP ' + r.status); return await r.json(); }
    catch (e) { if (i === 6) throw e; await sleep(1500 * (i + 1)); }
  }
}

async function collect() {
  const todo = db.prepare(`SELECT b.game_id FROM bt_games b JOIN games g ON g.id=b.game_id LEFT JOIN bt_score s ON s.game_id=b.game_id
    WHERE b.status='ok' AND g.season=? AND s.game_id IS NULL`).all(season).map(r => r.game_id);
  if (!todo.length) return;
  console.log(`补抓比分时间线 ${todo.length} 场...`);
  const ins = db.prepare('INSERT OR REPLACE INTO bt_score VALUES (?,?)');
  let i = 0, done = 0;
  await Promise.all(Array.from({ length: 6 }, async () => {
    while (i < todo.length) {
      const id = todo[i++];
      try {
        const s = await getJSON(`https://site.api.espn.com/apis/site/v2/sports/basketball/nba/summary?event=${id}`);
        const tl = []; let last = null;
        for (const p of s?.plays || []) {
          if (!p.wallclock) continue;
          const d = p.homeScore - p.awayScore;
          if (d !== last) { tl.push([Math.floor(Date.parse(p.wallclock) / 1000), d, p.period?.number || 0]); last = d; }
        }
        if (tl.length) ins.run(id, JSON.stringify(tl));
      } catch (e) { /* 下次重跑再补 */ }
      if (++done % 200 === 0) console.log(`  ${done}/${todo.length}`);
    }
  }));
}

function simulate() {
  const rows = db.prepare(`SELECT g.hf, g.af, b.tip, b.series, s.timeline FROM bt_games b JOIN games g ON g.id=b.game_id
    JOIN bt_score s ON s.game_id=b.game_id WHERE b.status='ok' AND g.season=?`).all(season);
  const priceAt = (S, t) => { let v = null; for (const [x, p] of S) { if (x <= t) v = p; else break; } return v; };
  console.log(`\n${season}-${String(season + 1).slice(2)} 常规赛 ${rows.length} 场 · 看到比分后 ${LAG}s 成交 · 每次买/卖各 ${COST * 100}¢ 成本\n`);

  // 规则：赛前强队（≥preMin），在 maxPeriod 节之前第一次落后 ≥ deficit 分时买入；
  //       之后第一次追到 分差 ≥ exitAt（0 = 平手）时卖出；一直没追回就拿到终场
  const run = (preMin, deficit, maxPeriod, exitAt, priceCap = 1) => {
    const T = [];
    for (const r of rows) {
      const S = JSON.parse(r.series), TL = JSON.parse(r.timeline);
      const preH = priceAt(S, r.tip); if (preH === null) continue;
      const side = preH >= preMin ? 1 : (1 - preH) >= preMin ? -1 : 0; if (!side) continue;
      const won = side === 1 ? r.hf > r.af : r.af > r.hf;
      const px = t => { const p = priceAt(S, t); return p === null ? null : side === 1 ? p : 1 - p; };
      let entry = null;
      for (const [t, d, per] of TL) {
        const m = d * side;
        if (!entry) {
          if (per <= maxPeriod && m <= -deficit) { const p = px(t + LAG); if (p !== null && p > .02 && p <= priceCap) entry = { t, p }; }
        } else if (m >= exitAt && t > entry.t) {
          const p = px(t + LAG); if (p !== null) { T.push({ buy: entry.p, sell: p, exit: 'tie', pnl: p - entry.p - 2 * COST, hold: (won ? 1 : 0) - entry.p - COST }); entry = 'done'; break; }
        }
        if (entry === 'done') break;
      }
      if (entry && entry !== 'done') T.push({ buy: entry.p, sell: won ? 1 : 0, exit: 'end', pnl: (won ? 1 : 0) - entry.p - COST, hold: (won ? 1 : 0) - entry.p - COST });
    }
    return T;
  };
  const fmt = T => {
    const n = T.length; if (!n) return 'n=0';
    const m = a => a.reduce((x, y) => x + y, 0) / n, sd = a => { const mu = m(a); return Math.sqrt(a.reduce((x, y) => x + (y - mu) ** 2, 0) / (n - 1)); };
    const P = T.map(t => t.pnl), H = T.map(t => t.hold), tie = T.filter(t => t.exit === 'tie');
    const endW = T.filter(t => t.exit === 'end' && t.sell === 1).length, endL = T.filter(t => t.exit === 'end' && t.sell === 0).length;
    return `n=${String(n).padStart(4)} 均买${(m(T.map(t => t.buy)) * 100).toFixed(0)}¢ | 追平卖出 ${(tie.length / n * 100).toFixed(0)}%（均卖 ${tie.length ? (tie.reduce((a, t) => a + t.sell, 0) / tie.length * 100).toFixed(0) : '-'}¢） 没追平终场赢${endW}/输${endL} | 每张 ${(m(P) >= 0 ? '+' : '') + (m(P) * 100).toFixed(1)}¢ ±${(sd(P) / Math.sqrt(n) * 100).toFixed(1)} | 对比拿到终场 ${(m(H) >= 0 ? '+' : '') + (m(H) * 100).toFixed(1)}¢`;
  };
  for (const [preMin, label] of [[.65, '赛前≥65%'], [.70, '赛前≥70%'], [.75, '赛前≥75%']]) {
    console.log(label);
    for (const [def, maxP, ex, cap, name] of [
      [5, 2, 0, 1, '上半场落后≥5，追平卖'], [8, 2, 0, 1, '上半场落后≥8，追平卖'], [10, 2, 0, 1, '上半场落后≥10，追平卖'],
      [10, 1, 0, 1, '第1节落后≥10，追平卖'], [10, 2, 0, .50, '上半场落后≥10且价≤50¢'], [8, 3, 0, 1, '前三节落后≥8，追平卖'],
      [10, 2, -3, 1, '上半场落后≥10，追到-3就卖']])
      console.log(`  ${name.padEnd(18)} ${fmt(run(preMin, def, maxP, ex, cap))}`);
  }
}

(async () => { await collect(); simulate(); })();
