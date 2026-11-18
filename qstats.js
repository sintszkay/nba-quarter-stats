// 从 ESPN play-by-play 统计每队每节的技术数据，存入 nba.db 的 qstats 表
// 每节：投篮命中/出手、三分命中/出手、罚球命中/出手、进攻/防守篮板（不含球队篮板）、助攻、失误
// 用法: node qstats.js        -> 只补还没抓过的已完赛比赛（每天几十场）
//       node qstats.js 300    -> 本次最多抓 300 场（首次回补可以分批跑）
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const db = new DatabaseSync(path.join(__dirname, 'nba.db'));
db.exec(`
CREATE TABLE IF NOT EXISTS qstats (
  game_id TEXT, side TEXT, q INTEGER,
  fgm INTEGER, fga INTEGER, tpm INTEGER, tpa INTEGER, ftm INTEGER, fta INTEGER,
  oreb INTEGER, dreb INTEGER, ast INTEGER, tov INTEGER,
  PRIMARY KEY (game_id, side, q)
);
CREATE TABLE IF NOT EXISTS qstats_done (game_id TEXT PRIMARY KEY, ok INTEGER, at TEXT);
`);
const K = ['fgm', 'fga', 'tpm', 'tpa', 'ftm', 'fta', 'oreb', 'dreb', 'ast', 'tov'];
// 旧数据（2021-22）没有 pointsAttempted：进球看 scoreValue；不进看文字里的距离（≥24 尺，或 22–23 尺在底角），没写距离就用投篮坐标
const is3 = p => { if (p.pointsAttempted === 3 || /three point/i.test(p.text)) return true; if (p.pointsAttempted === 2) return false;
  if (p.scoringPlay) return p.scoreValue === 3;
  const m = /(\d+)-foot/.exec(p.text); if (m) { const d = +m[1]; return d >= 24 || (d >= 22 && (p.coordinate?.y ?? 99) <= 9); }
  const c = p.coordinate; if (!c || c.x == null || c.x < 0 || c.y < 0) return false; const dx = c.x - 25, dy = c.y - 5.25;
  return Math.hypot(dx, dy) >= 23.5 || (Math.abs(dx) >= 21.5 && c.y <= 9); };
// 解析一场比赛：返回 { home: {1: {...}, 2: ...}, away: {...} }，只统计第1–4节
function parse(s) {
  const ids = {};
  for (const c of s.header.competitions[0].competitors) ids[c.team.id] = c.homeAway;
  const out = { home: {}, away: {} };
  for (const p of s.plays || []) {
    const side = ids[p.team?.id], q = p.period?.number; if (!side || !(q >= 1 && q <= 4)) continue;
    const o = (out[side][q] ??= Object.fromEntries(K.map(k => [k, 0]))), ty = p.type?.text || '';
    if (/^Free Throw/.test(ty)) { o.fta++; if (p.scoringPlay) o.ftm++; }
    else if (p.shootingPlay) {
      o.fga++; if (p.scoringPlay) o.fgm++;
      if (is3(p)) { o.tpa++; if (p.scoringPlay) o.tpm++; }
      if (p.scoringPlay && / assists\)/.test(p.text)) o.ast++;
    }
    const player = (p.participants || []).length > 0; // 球队篮板没有球员，技术统计里不算
    if (ty === 'Offensive Rebound' && player) o.oreb++; else if (ty === 'Defensive Rebound' && player) o.dreb++;
    if (/Turnover/.test(ty)) o.tov++;
  }
  return out;
}

const limit = Number(process.argv[2]) || Infinity;
const todo = db.prepare(`SELECT id FROM games WHERE id NOT IN (SELECT game_id FROM qstats_done) ORDER BY date DESC`).all().map(r => r.id).slice(0, limit);
const ins = db.prepare(`INSERT OR REPLACE INTO qstats VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
const done = db.prepare(`INSERT OR REPLACE INTO qstats_done VALUES (?,?,?)`);

async function one(id) {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const r = await fetch(`https://site.api.espn.com/apis/site/v2/sports/basketball/nba/summary?event=${id}`, { signal: AbortSignal.timeout(30000) });
      if (r.status === 404) { done.run(id, 0, new Date().toISOString()); return 0; } // ESPN 没有这场的记录，记下来不再重试
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const o = parse(await r.json());
      const ok = [1, 2, 3, 4].every(q => o.home[q] && o.away[q]) ? 1 : 0;
      db.exec('BEGIN');
      if (ok) for (const side of ['home', 'away']) for (let q = 1; q <= 4; q++) ins.run(id, side[0], q, ...K.map(k => o[side][q][k]));
      done.run(id, ok, new Date().toISOString());
      db.exec('COMMIT');
      return ok;
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch (_) {}
      if (attempt === 3) { console.error(id, e.message); return null; }
      await new Promise(r => setTimeout(r, 1500 * (attempt + 1)));
    }
  }
}

(async () => {
  console.log(`每节技术统计：需要抓 ${todo.length} 场`);
  let i = 0, ok = 0, bad = 0;
  const worker = async () => { while (i < todo.length) { const id = todo[i++]; const r = await one(id); r === 1 ? ok++ : r === 0 && bad++; if (i % 200 === 0) console.log(`  ${i}/${todo.length}`); } };
  await Promise.all(Array.from({ length: 6 }, worker));
  console.log(`完成：${ok} 场有数据，${bad} 场缺逐回合记录。`);
})();
