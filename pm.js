// 抓 Polymarket NBA 胜负线赛前价格，存入 nba.db 的 pm_odds 表
// 用法: node pm.js                 -> 美东今天 + 明天的比赛
//       node pm.js 2026-11-12 ...  -> 指定日期（美东）
// 规则：未开赛 = 当前买卖中间价；已开赛 = 开赛前最后一笔价格（price history）
// 注：本机网络连 Polymarket 偶尔超时，内置重试；如仍失败可加 --dns-result-order=ipv4first
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const db = new DatabaseSync(path.join(__dirname, 'nba.db'));
db.exec(`CREATE TABLE IF NOT EXISTS pm_odds (
  slug TEXT PRIMARY KEY, date TEXT, start TEXT, home TEXT, away TEXT,
  home_p REAL, away_p REAL, kind TEXT, as_of TEXT)`);

const MAP = { NY: 'NYK', GS: 'GSW', SA: 'SAS', NO: 'NOP', UTAH: 'UTA', WSH: 'WAS' };
// Polymarket slug 里可能用到的缩写（按顺序尝试）
const ALT = { NOP: ['nop', 'no'], NYK: ['nyk', 'ny'], GSW: ['gsw', 'gs'], SAS: ['sas', 'sa'], UTA: ['uta', 'utah'], WAS: ['was', 'wsh'], BKN: ['bkn', 'bk'] };
const alts = t => ALT[t] || [t.toLowerCase()];

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function getJSON(url) {
  for (let i = 0; i < 6; i++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
      if (r.ok) return r.json();
      if (r.status === 404) return null;
      throw new Error('HTTP ' + r.status);
    } catch (e) { if (i === 5) throw e; await sleep(1500 * (i + 1)); }
  }
}

const etDate = (d = new Date()) => new Date(d.toLocaleString('en-US', { timeZone: 'America/New_York' })).toISOString().slice(0, 10);
const argDates = process.argv.slice(2).filter(a => /^\d{4}-\d{2}-\d{2}$/.test(a));
const dates = argDates.length ? argDates : [etDate(), etDate(new Date(Date.now() + 864e5))];

const ins = db.prepare(`INSERT OR REPLACE INTO pm_odds VALUES (?,?,?,?,?,?,?,?,?)`);

async function oneGame(date, g) {
  let ev = null, slug = '';
  for (const a of alts(g.away)) for (const h of alts(g.home)) {
    if (ev) break;
    slug = `nba-${a}-${h}-${date}`;
    const r = await getJSON(`https://gamma-api.polymarket.com/events?slug=${slug}`);
    if (r && r[0]) ev = r[0];
  }
  if (!ev) return console.log(`  ${g.away} @ ${g.home}: Polymarket 上没找到`);
  const m = ev.markets.find(x => x.sportsMarketType === 'moneyline');
  if (!m) return console.log(`  ${slug}: 没有胜负线市场`);
  const outs = JSON.parse(m.outcomes), toks = JSON.parse(m.clobTokenIds), px = JSON.parse(m.outcomePrices).map(Number);
  const hi = outs.findIndex(o => g.homeName.includes(o) || o.includes(g.homeName));
  if (hi < 0) return console.log(`  ${slug}: 无法对应主队名 ${g.homeName} / ${outs}`);
  const start = Date.parse(ev.startTime || m.gameStartTime.replace(' ', 'T').replace('+00', 'Z'));
  let homeP, kind, asOf;
  if (Date.now() < start) {
    const bid = Number(m.bestBid), ask = Number(m.bestAsk); // bestBid/Ask 对应 outcomes[0]
    let p0 = bid > 0 && ask > 0 && ask - bid <= 0.05 ? (bid + ask) / 2 : px[0];
    homeP = hi === 0 ? p0 : 1 - p0; kind = '开赛前实时'; asOf = new Date().toISOString();
  } else {
    const st = Math.floor(start / 1000);
    const h = await getJSON(`https://clob.polymarket.com/prices-history?market=${toks[hi]}&startTs=${st - 4 * 3600}&endTs=${st}&fidelity=5`);
    const pts = (h?.history || []).filter(x => x.t <= st);
    if (pts.length) { homeP = pts.at(-1).p; kind = '开赛价'; asOf = new Date(pts.at(-1).t * 1000).toISOString(); }
    else { homeP = px[hi]; kind = '最新价（可能已含比赛进程）'; asOf = new Date().toISOString(); }
  }
  homeP = Math.round(homeP * 1000) / 1000;
  ins.run(slug, date, new Date(start).toISOString(), g.home, g.away, homeP, Math.round((1 - homeP) * 1000) / 1000, kind, asOf);
  console.log(`  ${g.away} @ ${g.home}: ${g.home} ${(homeP * 100).toFixed(1)}¢ / ${g.away} ${((1 - homeP) * 100).toFixed(1)}¢  [${kind}]`);
}

(async () => {
  for (const date of dates) {
    const sb = await getJSON(`https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates=${date.replace(/-/g, '')}&limit=100`);
    const games = (sb?.events || []).map(e => {
      const c = e.competitions[0], h = c.competitors.find(x => x.homeAway === 'home'), a = c.competitors.find(x => x.homeAway === 'away');
      const n = t => MAP[t.team.abbreviation] || t.team.abbreviation;
      return { home: n(h), away: n(a), homeName: h.team.shortDisplayName || h.team.name };
    });
    console.log(`${date}（美东）${games.length} 场`);
    for (const g of games) { try { await oneGame(date, g); } catch (e) { console.log(`  ${g.away} @ ${g.home}: 抓取失败 ${e.message}`); } }
  }
})();
