// 从 ESPN 公开 scoreboard 抓取 NBA 每场比赛的分节比分，存入 SQLite（nba.db）
// 用法: node fetch.js            -> 增量更新（默认从 2021-22 赛季起）
//       node fetch.js 2019       -> 从 2019-20 赛季起补数据（默认 2021-22 起）
const { DatabaseSync } = require('node:sqlite');
const path = require('path');

const db = new DatabaseSync(path.join(__dirname, 'nba.db'));
db.exec(`
CREATE TABLE IF NOT EXISTS games (
  id TEXT PRIMARY KEY, season INTEGER, stype INTEGER, date TEXT,
  home TEXT, away TEXT,
  h1 INTEGER, h2 INTEGER, h3 INTEGER, h4 INTEGER,
  a1 INTEGER, a2 INTEGER, a3 INTEGER, a4 INTEGER,
  hf INTEGER, af INTEGER, ot INTEGER
);
CREATE TABLE IF NOT EXISTS fetched (day TEXT PRIMARY KEY);
`);

// ESPN 缩写 -> 常用缩写
const MAP = { NY: 'NYK', GS: 'GSW', SA: 'SAS', NO: 'NOP', UTAH: 'UTA', WSH: 'WAS' };
const TEAMS = new Set(['ATL','BOS','BKN','CHA','CHI','CLE','DAL','DEN','DET','GSW','HOU','IND','LAC','LAL','MEM','MIA','MIL','MIN','NOP','NYK','OKC','ORL','PHI','PHX','POR','SAC','SAS','TOR','UTA','WAS']);
const norm = a => MAP[a] || a;

const startSeason = Number(process.argv[2]) || 2021; // 2021 = 2021-22 赛季（过去五季）
const today = new Date();
const fmt = d => d.toISOString().slice(0, 10).replace(/-/g, '');

// 生成要抓的日期：每个赛季 10/01 ~ 次年 06/30，截至今天
const days = [];
for (let y = startSeason; y <= today.getUTCFullYear(); y++) {
  for (let d = new Date(Date.UTC(y, 9, 1)); d <= new Date(Date.UTC(y + 1, 5, 30)) && d <= today; d.setUTCDate(d.getUTCDate() + 1)) {
    days.push({ day: fmt(d), season: y });
  }
}
const isFetched = db.prepare('SELECT 1 FROM fetched WHERE day=?');
const recentCutoff = fmt(new Date(today.getTime() - 3 * 864e5)); // 最近 3 天总是重抓
const todo = days.filter(x => x.day >= recentCutoff || !isFetched.get(x.day));

const ins = db.prepare(`INSERT OR REPLACE INTO games VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
const mark = db.prepare('INSERT OR IGNORE INTO fetched VALUES (?)');

async function getDay({ day, season }) {
  const url = `https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates=${day}&limit=100`;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const r = await fetch(url);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const d = await r.json();
      let n = 0, allFinal = true;
      for (const e of d.events || []) {
        const st = e.season?.type; // 2 常规赛, 3 季后赛, 5 附加赛
        if (![2, 3, 5].includes(st)) continue;
        const c = e.competitions[0];
        if (c.status.type.name !== 'STATUS_FINAL') { allFinal = false; continue; }
        const h = c.competitors.find(x => x.homeAway === 'home');
        const a = c.competitors.find(x => x.homeAway === 'away');
        const ht = norm(h.team.abbreviation), at = norm(a.team.abbreviation);
        if (!TEAMS.has(ht) || !TEAMS.has(at)) continue; // 排除全明星等
        const q = t => [1, 2, 3, 4].map(p => (t.linescores || []).find(l => l.period === p)?.value ?? null);
        const hq = q(h), aq = q(a);
        if (hq.includes(null) || aq.includes(null)) continue;
        const etDate = `${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6)}`; // 查询日即美东比赛日
        ins.run(e.id, season, st, etDate, ht, at, ...hq, ...aq,
          Number(h.score), Number(a.score), Math.max(0, c.status.period - 4));
        n++;
      }
      if (allFinal && day < fmt(today)) mark.run(day);
      return n;
    } catch (err) {
      if (attempt === 3) { console.error(day, err.message); return 0; }
      await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
    }
  }
}

(async () => {
  console.log(`需要抓取 ${todo.length} 天...`);
  let i = 0, total = 0;
  const worker = async () => {
    while (i < todo.length) {
      const x = todo[i++];
      const n = await getDay(x);
      total += n;
      if (i % 100 === 0) console.log(`  ${i}/${todo.length}`);
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  const c = db.prepare('SELECT season, COUNT(*) n FROM games GROUP BY season').all();
  console.log(`本次写入 ${total} 场。数据库：`, c.map(r => `${r.season}-${String(r.season + 1).slice(2)}: ${r.n}`).join(' | '));
})();
