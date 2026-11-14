// 回测数据收集：每场比赛的 ESPN 节末真实时间 + Polymarket 胜负线分钟级价格
// 用法: node --dns-result-order=ipv4first bt-collect.js [season=2025]
// 可中断，重跑会跳过已完成的比赛
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const db = require('./btdb');
db.exec(`CREATE TABLE IF NOT EXISTS bt_games (
  game_id TEXT PRIMARY KEY, slug TEXT, status TEXT,
  tip INTEGER, q1 INTEGER, q2 INTEGER, q3 INTEGER,   -- unix 秒（ESPN wallclock）
  home_out TEXT, volume REAL, series TEXT)             -- series: 主队胜的价格 [[t,p],...]`);

const season = Number(process.argv[2]) || 2025;
const ALT = { NOP: ['nop', 'no'], NYK: ['nyk', 'ny'], GSW: ['gsw', 'gs'], SAS: ['sas', 'sa'], UTA: ['uta', 'utah'], WAS: ['was', 'wsh'], BKN: ['bkn', 'bk'] };
const alts = t => ALT[t] || [t.toLowerCase()];
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function getJSON(url) {
  for (let i = 0; i < 7; i++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(20000) });
      if (r.status === 404) return null;
      if (r.status === 429) { await sleep(5000 * (i + 1)); continue; }
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.json();
    } catch (e) { if (i === 6) throw e; await sleep(1500 * (i + 1)); }
  }
}
const ts = s => Math.floor(Date.parse(s) / 1000);

const todo = db.prepare(`SELECT g.* FROM games g LEFT JOIN bt_games b ON b.game_id = g.id
  WHERE g.season = ? AND g.stype = 2 AND (b.game_id IS NULL OR b.status IN ('error', 'nopm')) ORDER BY g.date`).all(season);
const save = db.prepare(`INSERT OR REPLACE INTO bt_games VALUES (?,?,?,?,?,?,?,?,?,?)`);

async function one(g) {
  // 1) ESPN 节末时间
  const s = await getJSON(`https://site.api.espn.com/apis/site/v2/sports/basketball/nba/summary?event=${g.id}`);
  const plays = s?.plays || [];
  const tip = plays[0]?.wallclock ? ts(plays[0].wallclock) : null;
  const endOf = n => { const p = plays.find(x => x.type?.text === 'End Period' && x.period?.number === n); return p?.wallclock ? ts(p.wallclock) : null; };
  const q = [endOf(1), endOf(2), endOf(3)];
  // 2) Polymarket 事件
  // PM 的 slug 日期有时比美东日期晚一天，尝试 当天 / +1 / -1，并用开赛时间校验（±18 小时）
  let ev = null, slug = '';
  const shift = k => new Date(Date.parse(g.date + 'T12:00:00Z') + k * 864e5).toISOString().slice(0, 10);
  for (const k of [0, 1, -1]) for (const a of alts(g.away)) for (const h of alts(g.home)) {
    if (ev) break; const s = `nba-${a}-${h}-${shift(k)}`;
    const r = await getJSON(`https://gamma-api.polymarket.com/events?slug=${s}`);
    const m0 = r?.[0]?.markets?.find(x => x.gameStartTime);
    const st = m0 ? ts(m0.gameStartTime.replace(' ', 'T').replace('+00', 'Z')) : null;
    if (r && r[0] && (!tip || !st || Math.abs(st - tip) < 18 * 3600)) { ev = r[0]; slug = s; }
    else if (!slug) slug = s;
  }
  if (!ev) return save.run(g.id, slug, 'nopm', tip, ...q, null, null, null);
  const m = ev.markets.find(x => x.sportsMarketType === 'moneyline');
  if (!m) return save.run(g.id, slug, 'noml', tip, ...q, null, null, null);
  const outs = JSON.parse(m.outcomes), toks = JSON.parse(m.clobTokenIds);
  // 标题是 “客队 vs. 主队”，outcomes[1] 为主队；下面再用结算价校验
  const start = tip || ts(m.gameStartTime.replace(' ', 'T').replace('+00', 'Z'));
  const h = await getJSON(`https://clob.polymarket.com/prices-history?market=${toks[1]}&startTs=${start - 2 * 3600}&endTs=${start + 4 * 3600}&fidelity=1`);
  const series = (h?.history || []).map(x => [x.t, x.p]);
  if (!series.length) return save.run(g.id, slug, 'nohist', tip, ...q, outs[1], Number(m.volumeNum ?? m.volume) || null, null);
  const last = series.at(-1)[1], homeWon = g.hf > g.af;
  const ok = (homeWon && last > 0.9) || (!homeWon && last < 0.1);
  save.run(g.id, slug, ok ? 'ok' : 'mismatch', tip, ...q, outs[1], Number(m.volumeNum ?? m.volume) || null, JSON.stringify(series));
}

(async () => {
  console.log(`${season}-${String(season + 1).slice(2)} 待收集 ${todo.length} 场`);
  let i = 0, done = 0, errs = 0;
  const worker = async () => {
    while (i < todo.length) {
      const g = todo[i++];
      try { await one(g); } catch (e) { if (errs++ < 3) console.log(`  ${g.date} ${g.away}@${g.home} 失败: ${e.message}`); save.run(g.id, '', 'error', null, null, null, null, null, null, null); }
      if (++done % 50 === 0) console.log(`  ${done}/${todo.length}`);
    }
  };
  await Promise.all(Array.from({ length: 5 }, worker));
  console.log(db.prepare(`SELECT status, COUNT(*) n FROM bt_games GROUP BY status`).all().map(r => `${r.status}:${r.n}`).join(' '));
})();
