// Polymarket NBA 胜负线 · 每日盘前记录 + 结算台账（nba.db 的 pm_ledger / pm_snap 表）
//
// 用法:
//   node --dns-result-order=ipv4first ledger.js              每天跑：记录美东今天+明天比赛的盘前快照，并结算已打完的比赛
//   node --dns-result-order=ipv4first ledger.js --backfill 2025   补一个赛季的全部比赛（常规赛+季后赛+附加赛）
//   加 --refresh 可重新抓已结算比赛的盘前价格
//
// pm_ledger 每场一行（价格都是“主队赢”的价格，0–1）：
//   open_p  开盘价（市场上线 2 小时后的第一笔，跳过 50¢ 占位价）  listed 市场上线时间  hist 每小时价格序列       h24_p  开赛前 24 小时    h1_p  开赛前 1 小时
//   close_p 开赛前最后一笔（收盘价）     snap_p 最近一次每日快照（未开赛时的买卖中间价）
//   home_won ESPN 终场结果，pm_result Polymarket 实际结算（home/away），status: pending / settled / nopm / noml / mismatch
// pm_snap 每次运行对未开赛比赛记一笔快照，可看盘口在开赛前怎么移动
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const db = new DatabaseSync(path.join(__dirname, 'nba.db'));
db.exec(`CREATE TABLE IF NOT EXISTS pm_ledger (
  game_id TEXT PRIMARY KEY, season INTEGER, stype INTEGER, date TEXT, start TEXT, home TEXT, away TEXT, slug TEXT, status TEXT,
  open_p REAL, open_t TEXT, h24_p REAL, h1_p REAL, close_p REAL, snap_p REAL, snap_t TEXT, volume REAL,
  hf INTEGER, af INTEGER, home_won INTEGER, pm_result TEXT, updated TEXT)`);
for (const [c, ty] of [['listed', 'TEXT'], ['hist', 'TEXT']]) if (!db.prepare('PRAGMA table_info(pm_ledger)').all().some(x => x.name === c)) db.exec(`ALTER TABLE pm_ledger ADD COLUMN ${c} ${ty}`);
db.exec(`CREATE TABLE IF NOT EXISTS pm_snap (slug TEXT, t TEXT, home_p REAL, PRIMARY KEY (slug, t))`);

const MAP = { NY: 'NYK', GS: 'GSW', SA: 'SAS', NO: 'NOP', UTAH: 'UTA', WSH: 'WAS' };
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
const iso = t => new Date(t * 1000).toISOString();
const r3 = x => x === null || x === undefined ? null : Math.round(x * 1000) / 1000;
const etDate = (d = new Date()) => new Date(d.toLocaleString('en-US', { timeZone: 'America/New_York' })).toISOString().slice(0, 10);
const args = process.argv.slice(2);
const bi = args.indexOf('--backfill');
const REFRESH = args.includes('--refresh'); // 重新抓已结算比赛的盘前价格

// 找 PM 事件：slug 日期有时比美东晚一天，试 0 / +1 / -1，并用开赛时间校验
async function findEvent(date, home, away, tipGuess) {
  const shift = k => new Date(Date.parse(date + 'T12:00:00Z') + k * 864e5).toISOString().slice(0, 10);
  let first = '';
  for (const k of [0, 1, -1]) for (const a of alts(away)) for (const h of alts(home)) {
    const s = `nba-${a}-${h}-${shift(k)}`; if (!first) first = s;
    const r = await getJSON(`https://gamma-api.polymarket.com/events?slug=${s}`);
    if (!r || !r[0]) continue;
    const m0 = r[0].markets?.find(x => x.gameStartTime);
    const st = m0 ? ts(m0.gameStartTime.replace(' ', 'T').replace('+00', 'Z')) : null;
    if (!tipGuess || !st || Math.abs(st - tipGuess) < 30 * 3600) return { ev: r[0], slug: s };
  }
  return { ev: null, slug: first };
}
const startOf = (ev, m) => ts(m.gameStartTime ? m.gameStartTime.replace(' ', 'T').replace('+00', 'Z') : ev.startTime);

const getRow = db.prepare('SELECT * FROM pm_ledger WHERE game_id=?');
const COLS = ['game_id', 'season', 'stype', 'date', 'start', 'home', 'away', 'slug', 'status', 'open_p', 'open_t', 'h24_p', 'h1_p', 'close_p', 'snap_p', 'snap_t', 'volume', 'hf', 'af', 'home_won', 'pm_result', 'updated', 'listed', 'hist'];
const put = db.prepare(`INSERT OR REPLACE INTO pm_ledger VALUES (${COLS.map(() => '?').join(',')})`);
const save = o => put.run(...COLS.map(c => o[c] ?? null));
const snapIns = db.prepare('INSERT OR REPLACE INTO pm_snap VALUES (?,?,?)');

// 处理一场：g = {id, season, stype, date, home, away, homeName?, hf?, af?, tipGuess?}
async function one(g) {
  const old = getRow.get(g.id) || {};
  const row = { ...old, game_id: g.id, season: g.season, stype: g.stype, date: g.date, home: g.home, away: g.away, updated: new Date().toISOString() };
  let ev = null, slug = old.slug;
  if (slug) { const r = await getJSON(`https://gamma-api.polymarket.com/events?slug=${slug}`); ev = r?.[0] || null; }
  if (!ev) ({ ev, slug } = await findEvent(g.date, g.home, g.away, g.tipGuess));
  row.slug = slug;
  if (!ev) { row.status = 'nopm'; return save(row); }
  const m = ev.markets.find(x => x.sportsMarketType === 'moneyline');
  if (!m) { row.status = 'noml'; return save(row); }
  const outs = JSON.parse(m.outcomes), toks = JSON.parse(m.clobTokenIds);
  // 主队位置：优先用队名对应，否则按 “客队 vs. 主队” 惯例取 outcomes[1]
  let hi = g.homeName ? outs.findIndex(o => g.homeName.includes(o) || o.includes(g.homeName)) : -1;
  if (hi < 0) hi = 1;
  const start = startOf(ev, m);
  row.start = iso(start); row.volume = Number(m.volumeNum ?? m.volume) || null;
  const now = Math.floor(Date.now() / 1000);

  if (now < start) { // 未开赛：记快照
    const bid = Number(m.bestBid), ask = Number(m.bestAsk); // 对应 outcomes[0]
    const p0 = bid > 0 && ask > 0 && ask - bid <= 0.05 ? (bid + ask) / 2 : Number(JSON.parse(m.outcomePrices)[0]);
    row.snap_p = r3(hi === 0 ? p0 : 1 - p0); row.snap_t = iso(now); row.status = 'pending';
    snapIns.run(slug, row.snap_t, row.snap_p);
    return save(row);
  }
  // 已开赛：补 开盘 / 24h / 1h / 收盘
  if (row.close_p === null || row.close_p === undefined || REFRESH) {
    const H = await getJSON(`https://clob.polymarket.com/prices-history?market=${toks[hi]}&startTs=${start - 15 * 86400 + 60}&endTs=${start}&fidelity=60`);
    const pts = (H?.history || []).filter(x => x.t <= start);
    const at = t => { let v = null; for (const x of pts) { if (x.t <= t) v = x.p; else break; } return v; };
    const C = await getJSON(`https://clob.polymarket.com/prices-history?market=${toks[hi]}&startTs=${start - 2 * 3600}&endTs=${start}&fidelity=1`);
    const cp = (C?.history || []).filter(x => x.t <= start);
    row.close_p = r3(cp.length ? cp.at(-1).p : pts.length ? pts.at(-1).p : null);
    // 市场刚上线时是 50¢ 占位价，没有意义；“开盘价”取上线 2 小时后的第一笔（上线不足 3 小时就开赛的，取开赛前 1 小时）
    row.listed = pts.length ? iso(pts[0].t) : null;
    if (pts.length) {
      const t0 = pts[0].t, o = pts.find(x => x.t >= t0 + 2 * 3600 && x.t <= start - 3600);
      const op = o || pts.filter(x => x.t <= start - 3600).at(-1) || null;
      row.open_p = op ? r3(op.p) : row.close_p; row.open_t = op ? iso(op.t) : row.start;
      row.h24_p = t0 <= start - 86400 - 2 * 3600 ? r3(at(start - 86400)) : null; // 上线不到 26 小时的没有 24h 价
      row.h1_p = r3(at(start - 3600));
      row.hist = JSON.stringify(pts.map(x => [x.t, r3(x.p)]));
    }
  }
  // 结算
  if (g.hf !== undefined && g.hf !== null) { row.hf = g.hf; row.af = g.af; row.home_won = g.hf > g.af ? 1 : 0; }
  if (m.closed) {
    const px = JSON.parse(m.outcomePrices).map(Number);
    row.pm_result = px[hi] > .99 ? 'home' : px[hi] < .01 ? 'away' : 'other';
  }
  if (row.home_won !== null && row.home_won !== undefined && row.pm_result) {
    row.status = (row.pm_result === 'home') === (row.home_won === 1) ? 'settled' : 'mismatch';
  } else row.status = 'pending';
  save(row);
}

async function pool(list, n, label) {
  let i = 0, done = 0, errs = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < list.length) { const g = list[i++];
      try { await one(g); } catch (e) { if (errs++ < 3) console.log(`  ${g.date} ${g.away}@${g.home} 失败: ${e.message}（重跑可补）`); }
      if (++done % 100 === 0) console.log(`  ${label} ${done}/${list.length}`); }
  }));
}

(async () => {
  const fin = db.prepare(`SELECT id, season, stype, date, home, away, hf, af FROM games WHERE id=?`);
  if (bi >= 0) {
    const season = Number(args[bi + 1]);
    const todo = db.prepare(`SELECT g.id, g.season, g.stype, g.date, g.home, g.away, g.hf, g.af FROM games g LEFT JOIN pm_ledger l ON l.game_id=g.id
      WHERE g.season=? AND (l.game_id IS NULL OR l.status IN ('pending','nopm') OR ${REFRESH ? 1 : 0}) ORDER BY g.date`).all(season)
      .map(g => ({ ...g, tipGuess: ts(g.date + 'T23:00:00Z') }));
    console.log(`补录 ${season}-${String(season + 1).slice(2)} 赛季 ${todo.length} 场...`);
    await pool(todo, 5, '补录');
  } else {
    // 1) 今天 + 明天（美东）的比赛：记盘前快照
    for (const date of [etDate(), etDate(new Date(Date.now() + 864e5))]) {
      const sb = await getJSON(`https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates=${date.replace(/-/g, '')}&limit=100`);
      const evs = sb?.events || [];
      for (const e of evs) {
        const c = e.competitions[0], h = c.competitors.find(x => x.homeAway === 'home'), a = c.competitors.find(x => x.homeAway === 'away');
        const n = t => MAP[t.team.abbreviation] || t.team.abbreviation;
        const done = e.status?.type?.completed;
        const g = { id: e.id, season: Number(date.slice(5, 7)) >= 8 ? Number(date.slice(0, 4)) : Number(date.slice(0, 4)) - 1, stype: sb.season?.type ?? 2, date, home: n(h), away: n(a),
          homeName: h.team.shortDisplayName || h.team.name, tipGuess: ts(e.date), ...(done ? { hf: Number(h.score), af: Number(a.score) } : {}) };
        try { await one(g); } catch (err) { console.log(`  ${g.away}@${g.home} 失败: ${err.message}`); }
      }
      console.log(`${date}（美东）记录 ${evs.length} 场`);
    }
    // 2) 结算所有还没结算的比赛（终场比分来自 games 表，先跑 fetch.js）
    const pend = db.prepare(`SELECT game_id FROM pm_ledger WHERE status='pending' AND start < ?`).all(new Date(Date.now() - 3 * 3600e3).toISOString());
    const list = pend.map(r => fin.get(r.game_id)).filter(Boolean);
    if (list.length) { console.log(`结算 ${list.length} 场...`); await pool(list, 4, '结算'); }
  }
  // 小结
  const s = db.prepare(`SELECT status, COUNT(*) n FROM pm_ledger GROUP BY status`).all().map(r => `${r.status} ${r.n}`).join(' · ');
  console.log(`台账：${s}`);
  const up = db.prepare(`SELECT date, away, home, snap_p, close_p, status FROM pm_ledger WHERE status='pending' ORDER BY start`).all();
  for (const r of up.slice(0, 20)) console.log(`  ${r.date} ${r.away} @ ${r.home}  主队 ${((r.snap_p ?? r.close_p ?? 0) * 100).toFixed(1)}¢  [${r.status}]`);
})();
