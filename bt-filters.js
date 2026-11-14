// 在“强队落后抄底”策略上叠加三个过滤条件，看能否变成正 EV：
//   1) 主客场：强队是主场还是客场
//   2) 对赛往绩：强队在此前（过去三季 + 本季更早）对这个对手的胜率
//   3) 主力阵容：强队本季得分前二的球员是否首发（开赛前就能知道）
// 用法: node --dns-result-order=ipv4first bt-filters.js [season=2025] [--cost 1] [--lag 60]
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const db = require('./btdb');
db.exec(`CREATE TABLE IF NOT EXISTS bt_box (game_id TEXT PRIMARY KEY, box TEXT)`); // {HOME:[[id,name,starter,min,pts]],...}
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : Number(args[i + 1]); };
const season = Number(args.find(a => /^\d{4}$/.test(a))) || 2025;
const COST = opt('cost', 1) / 100, LAG = opt('lag', 60);
const MAP = { NY: 'NYK', GS: 'GSW', SA: 'SAS', NO: 'NOP', UTAH: 'UTA', WSH: 'WAS' };
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function getJSON(url) {
  for (let i = 0; i < 7; i++) {
    try { const r = await fetch(url, { signal: AbortSignal.timeout(20000) }); if (r.status === 404) return null; if (!r.ok) throw new Error('HTTP ' + r.status); return await r.json(); }
    catch (e) { if (i === 6) throw e; await sleep(1500 * (i + 1)); }
  }
}

async function collect() {
  const todo = db.prepare(`SELECT b.game_id FROM bt_games b JOIN games g ON g.id=b.game_id LEFT JOIN bt_box x ON x.game_id=b.game_id
    WHERE b.status='ok' AND g.season=? AND x.game_id IS NULL`).all(season).map(r => r.game_id);
  if (!todo.length) return;
  console.log(`补抓首发与球员数据 ${todo.length} 场...`);
  const ins = db.prepare('INSERT OR REPLACE INTO bt_box VALUES (?,?)');
  let i = 0, done = 0;
  await Promise.all(Array.from({ length: 6 }, async () => {
    while (i < todo.length) {
      const id = todo[i++];
      try {
        const s = await getJSON(`https://site.api.espn.com/apis/site/v2/sports/basketball/nba/summary?event=${id}`);
        const box = {};
        for (const tb of s?.boxscore?.players || []) {
          const ab = MAP[tb.team.abbreviation] || tb.team.abbreviation, st = tb.statistics[0], L = st.labels;
          box[ab] = st.athletes.map(a => [a.athlete.id, a.athlete.shortName, !!a.starter,
            a.stats.length ? parseInt(a.stats[L.indexOf('MIN')]) || 0 : 0, a.stats.length ? Number(a.stats[L.indexOf('PTS')]) || 0 : 0]);
        }
        if (Object.keys(box).length === 2) ins.run(id, JSON.stringify(box));
      } catch (e) { /* 重跑再补 */ }
      if (++done % 200 === 0) console.log(`  ${done}/${todo.length}`);
    }
  }));
}

function analyze() {
  const rows = db.prepare(`SELECT g.id, g.date, g.home, g.away, g.hf, g.af, b.tip, b.series, s.timeline, x.box
    FROM bt_games b JOIN games g ON g.id=b.game_id JOIN bt_score s ON s.game_id=b.game_id JOIN bt_box x ON x.game_id=b.game_id
    WHERE b.status='ok' AND g.season=? ORDER BY g.date`).all(season);
  // 每队本季场均得分前二（至少打 20 场）——用全季数据，有轻微后见之明
  const P = {}; // team -> id -> {pts, gp, name}
  for (const r of rows) for (const [t, pl] of Object.entries(JSON.parse(r.box))) for (const [id, name, , min, pts] of pl) {
    if (!min) continue; const o = ((P[t] ??= {})[id] ??= { pts: 0, gp: 0, name }); o.pts += pts; o.gp++;
  }
  const KEY = {};
  for (const [t, ps] of Object.entries(P)) KEY[t] = Object.entries(ps).filter(([, o]) => o.gp >= 20)
    .sort((a, b) => b[1].pts / b[1].gp - a[1].pts / a[1].gp).slice(0, 2).map(([id, o]) => ({ id, name: o.name }));
  console.log('各队主力（场均得分前二）示例：' + ['PHI', 'DET', 'OKC', 'DEN'].map(t => `${t} ${KEY[t]?.map(k => k.name).join('/')}`).join('；'));

  // 对赛往绩：此前三季 + 本季更早的交手（含季后赛）
  const allG = db.prepare(`SELECT date, home, away, hf, af FROM games WHERE season BETWEEN ? AND ?`).all(season - 3, season);
  const h2h = (team, opp, date) => { let w = 0, n = 0; for (const g of allG) if (g.date < date &&
    ((g.home === team && g.away === opp) || (g.home === opp && g.away === team))) { n++; if ((g.home === team) === (g.hf > g.af)) w++; } return { w, n }; };

  const priceAt = (S, t) => { let v = null; for (const [x, p] of S) { if (x <= t) v = p; else break; } return v; };
  // 为每场生成“强队视角”的交易样本（上半场第一次落后 ≥ 5/8/10 分时买入）
  const trades = { 5: [], 8: [], 10: [] };
  for (const r of rows) {
    const S = JSON.parse(r.series), TL = JSON.parse(r.timeline), box = JSON.parse(r.box);
    const preH = priceAt(S, r.tip); if (preH === null) continue;
    const side = preH >= .65 ? 1 : (1 - preH) >= .65 ? -1 : 0; if (!side) continue;
    const fav = side === 1 ? r.home : r.away, opp = side === 1 ? r.away : r.home;
    const won = side === 1 ? r.hf > r.af : r.af > r.hf;
    const starters = t => new Set((box[t] || []).filter(p => p[2]).map(p => p[0]));
    const favSt = starters(fav), oppSt = starters(opp);
    const keysIn = (KEY[fav] || []).filter(k => favSt.has(k.id)).length;
    const oppKeysIn = (KEY[opp] || []).filter(k => oppSt.has(k.id)).length;
    const hh = h2h(fav, opp, r.date);
    const tags = { home: side === 1, h2hGood: hh.n >= 3 && hh.w / hh.n >= .6, h2hBad: hh.n >= 3 && hh.w / hh.n <= .4,
      full: keysIn === 2, missing: keysIn < 2, oppMissing: oppKeysIn < 2, pre: side === 1 ? preH : 1 - preH };
    const px = t => { const p = priceAt(S, t); return p === null ? null : side === 1 ? p : 1 - p; };
    for (const def of [5, 8, 10]) {
      let entry = null, out = null;
      for (const [t, d, per] of TL) {
        const m = d * side;
        if (!entry) { if (per <= 2 && m <= -def) { const p = px(t + LAG); if (p !== null && p > .02) entry = { t, p }; } }
        else if (m >= 0 && t > entry.t) { const p = px(t + LAG); if (p !== null) { out = p; break; } }
      }
      if (!entry) continue;
      const hold = (won ? 1 : 0) - entry.p - COST;
      trades[def].push({ ...tags, buy: entry.p, tie: out !== null, pnl: out !== null ? out - entry.p - 2 * COST : hold, hold });
    }
  }

  const fmt = T => {
    const n = T.length; if (n < 5) return `n=${n}（样本太少）`;
    const mean = a => a.reduce((x, y) => x + y, 0) / n, se = a => { const m = mean(a); return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / (n - 1) / n); };
    const P = T.map(t => t.pnl), H = T.map(t => t.hold), s = v => (v >= 0 ? '+' : '') + (v * 100).toFixed(1) + '¢';
    return `n=${String(n).padStart(3)}  均买${(mean(T.map(t => t.buy)) * 100).toFixed(0)}¢  追平${(T.filter(t => t.tie).length / n * 100).toFixed(0).padStart(3)}%  追平卖 ${s(mean(P)).padStart(7)} ±${(se(P) * 100).toFixed(1)}   拿到终场 ${s(mean(H)).padStart(7)} ±${(se(H) * 100).toFixed(1)}`;
  };
  const F = [
    ['全部（基准）', t => true],
    ['强队主场', t => t.home], ['强队客场', t => !t.home],
    ['对赛往绩好（≥60%，≥3场）', t => t.h2hGood], ['对赛往绩差（≤40%）', t => t.h2hBad],
    ['强队主力两人都首发', t => t.full], ['强队缺至少一名主力', t => t.missing],
    ['对手缺至少一名主力', t => t.oppMissing],
    ['主场 + 主力齐', t => t.home && t.full],
    ['主场 + 主力齐 + 往绩好', t => t.home && t.full && t.h2hGood],
    ['主力齐 + 对手缺主力', t => t.full && t.oppMissing],
    ['主场 + 主力齐 + 对手缺主力', t => t.home && t.full && t.oppMissing],
  ];
  console.log(`\n${season}-${String(season + 1).slice(2)} 常规赛 · 赛前强队 ≥65% · 上半场第一次落后时买入 · ${LAG}s 后成交 · 每次 ${COST * 100}¢ 成本`);
  for (const def of [5, 8, 10]) {
    console.log(`\n【落后 ≥${def} 分买入】`);
    for (const [name, f] of F) console.log(`  ${name.padEnd(16, '　')} ${fmt(trades[def].filter(f))}`);
  }
  console.log('\n注：一共测了 12 种组合 × 3 个分差 = 36 个结果，单靠运气也可能出现一两个 +2 个标准误的“正数”。');
}

(async () => { await collect(); analyze(); })();
