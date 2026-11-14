// 替补高光 vs 主力在场：一波高潮是谁打出来的，价格反应是否过度？
//   1) collect: 抓 ESPN 逐球记录（含换人），存 bt_pbp
//   2) 还原每一时刻场上 10 人，判断两队“主力”（本季场均得分前二）是否在场
//   3) 一方 4 分钟内打出 ≥N 分净胜高潮后，按“谁在场”分组，测试买被打方 / 买高潮方
// 用法: node --dns-result-order=ipv4first bt-bench.js [season=2025] [--cost 1] [--n 8]
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const db = require('./btdb');
db.exec(`CREATE TABLE IF NOT EXISTS bt_pbp (game_id TEXT PRIMARY KEY, plays TEXT)`); // [[t, period, side(1主/-1客/0), isSub, [ids]], ...]
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : Number(args[i + 1]); };
const season = Number(args.find(a => /^\d{4}$/.test(a))) || 2025;
const COST = opt('cost', 1) / 100, NRUN = opt('n', 8);
const SPLIT = `${season + 1}-01-15`;
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function getJSON(url) {
  for (let i = 0; i < 7; i++) {
    try { const r = await fetch(url, { signal: AbortSignal.timeout(20000) }); if (r.status === 404) return null; if (!r.ok) throw new Error('HTTP ' + r.status); return await r.json(); }
    catch (e) { if (i === 6) throw e; await sleep(1500 * (i + 1)); }
  }
}

async function collect() {
  const todo = db.prepare(`SELECT b.game_id FROM bt_games b JOIN games g ON g.id=b.game_id LEFT JOIN bt_pbp x ON x.game_id=b.game_id
    WHERE b.status='ok' AND g.season=? AND x.game_id IS NULL`).all(season).map(r => r.game_id);
  if (!todo.length) return;
  console.log(`抓逐球记录（含换人）${todo.length} 场...`);
  const ins = db.prepare('INSERT OR REPLACE INTO bt_pbp VALUES (?,?)');
  let i = 0, done = 0, fail = 0;
  await Promise.all(Array.from({ length: 6 }, async () => {
    while (i < todo.length) {
      const id = todo[i++];
      try {
        const s = await getJSON(`https://site.api.espn.com/apis/site/v2/sports/basketball/nba/summary?event=${id}`);
        const comp = s?.header?.competitions?.[0]?.competitors || [];
        const side = {}; for (const c of comp) side[c.team.id] = c.homeAway === 'home' ? 1 : -1;
        const out = [];
        for (const p of s?.plays || []) {
          if (!p.wallclock) continue;
          const ids = (p.participants || []).map(x => x.athlete?.id).filter(Boolean);
          if (!ids.length) continue;
          out.push([Math.floor(Date.parse(p.wallclock) / 1000), p.period?.number || 0, side[p.team?.id] || 0, p.type?.text === 'Substitution' ? 1 : 0, ids]);
        }
        if (out.length > 50) ins.run(id, JSON.stringify(out)); else fail++;
      } catch (e) { fail++; }
      if (++done % 200 === 0) console.log(`  ${done}/${todo.length}`);
    }
  }));
  if (fail) console.log(`  ${fail} 场失败，重跑可补`);
}

function analyze() {
  const rows = db.prepare(`SELECT g.date, g.home, g.away, g.hf, g.af, b.tip, b.series, s.timeline, x.box, p.plays
    FROM bt_games b JOIN games g ON g.id=b.game_id JOIN bt_score s ON s.game_id=b.game_id JOIN bt_box x ON x.game_id=b.game_id
    JOIN bt_pbp p ON p.game_id=b.game_id WHERE b.status='ok' AND g.season=? ORDER BY g.date`).all(season);

  // 主力 = 本季场均得分前二（≥20 场），有轻微后见之明
  const P = {};
  for (const r of rows) for (const [t, pl] of Object.entries(JSON.parse(r.box))) for (const [id, , , min, pts] of pl) {
    if (!min) continue; const o = ((P[t] ??= {})[id] ??= { pts: 0, gp: 0 }); o.pts += pts; o.gp++;
  }
  const KEY = {};
  for (const [t, ps] of Object.entries(P)) KEY[t] = new Set(Object.entries(ps).filter(([, o]) => o.gp >= 20)
    .sort((a, b) => b[1].pts / b[1].gp - a[1].pts / a[1].gp).slice(0, 2).map(([id]) => id));

  const pAt = (S, t) => { let v = null; for (const [x, p] of S) { if (x <= t) v = p; else break; } return v; };
  const ev = [];       // 每次高潮
  let checked = 0, bad = 0;
  for (const r of rows) {
    const box = JSON.parse(r.box), plays = JSON.parse(r.plays), S = JSON.parse(r.series), TL = JSON.parse(r.timeline);
    const teamOf = {}; for (const id of (box[r.home] || []).map(p => p[0])) teamOf[id] = 1; for (const id of (box[r.away] || []).map(p => p[0])) teamOf[id] = -1;
    const keyH = KEY[r.home] || new Set(), keyA = KEY[r.away] || new Set();
    if (keyH.size < 2 || keyA.size < 2) continue;
    // 还原场上阵容：每节开始时在场 = 本节第一次出现不是“被换上”的球员
    const segs = []; // [t, keysOnHome, keysOnAway]
    const periods = [...new Set(plays.map(p => p[1]))].filter(x => x >= 1 && x <= 4);
    for (const per of periods) {
      const L = plays.filter(p => p[1] === per);
      const first = {};
      for (const [, , , sub, ids] of L) ids.forEach((id, k) => { if (!(id in first)) first[id] = sub ? (k === 0 ? 'in' : 'out') : 'play'; });
      const on = new Set(Object.entries(first).filter(([, v]) => v !== 'in').map(([id]) => id).filter(id => teamOf[id]));
      const cnt = () => { let h = 0, a = 0; for (const id of on) { if (keyH.has(id)) h++; if (keyA.has(id)) a++; } return [h, a]; };
      const nH = [...on].filter(id => teamOf[id] === 1).length, nA = [...on].filter(id => teamOf[id] === -1).length;
      checked++; if (nH !== 5 || nA !== 5) bad++;
      segs.push([L[0][0], ...cnt()]);
      for (const [t, , , sub, ids] of L) if (sub && ids.length === 2) { on.add(ids[0]); on.delete(ids[1]); segs.push([t, ...cnt()]); }
    }
    const keysAt = t => { let v = null; for (const s of segs) { if (s[0] <= t) v = s; else break; } return v; };
    // 高潮（同 bt-explore：4 分钟真实时间内净胜 ≥N 分，两次之间隔 5 分钟）
    let lastT = 0;
    for (let i = 0; i < TL.length; i++) {
      const [t, d, per] = TL[i]; if (per > 4 || t < lastT + 300) continue;
      for (let j = i - 1; j >= 0 && TL[j][0] >= t - 240; j--) {
        const diff = d - TL[j][1];
        if (Math.abs(diff) < NRUN) continue;
        lastT = t;
        const dir = Math.sign(diff), k0 = keysAt(TL[j][0]), k1 = keysAt(t);
        if (!k0 || !k1) break;
        // 高潮方 / 被打方 在高潮开始和结束时各有几名主力在场（取较多的一次）
        const runK = Math.max(dir > 0 ? k0[1] : k0[2], dir > 0 ? k1[1] : k1[2]);
        const vicK = Math.max(dir > 0 ? k0[2] : k0[1], dir > 0 ? k1[2] : k1[1]);
        const p0 = pAt(S, t + 60), p1 = pAt(S, t + 660);
        if (p0 === null || p1 === null) break;
        const vic0 = dir > 0 ? 1 - p0 : p0, vic1 = dir > 0 ? 1 - p1 : p1;
        if (vic0 < .05 || vic0 > .95) break;
        const vicWon = dir > 0 ? r.af > r.hf : r.hf > r.af;
        ev.push({ g: r.date + r.tip, half: r.date < SPLIT ? 'A' : 'B', per, runK, vicK,
          fade10: vic1 - vic0 - 2 * COST, fadeEnd: (vicWon ? 1 : 0) - vic0 - COST,
          follow10: (1 - vic1) - (1 - vic0) - 2 * COST, followEnd: (vicWon ? 0 : 1) - (1 - vic0) - COST, px: vic0 });
        break;
      }
    }
  }

  function summ(list) {
    const by = new Map(); for (const { g, v } of list) (by.get(g) || by.set(g, []).get(g)).push(v);
    const per = [...by.values()].map(a => a.reduce((x, y) => x + y) / a.length);
    const n = per.length; if (n < 15) return { n, txt: `n=${n}（太少）`.padEnd(22) };
    const m = per.reduce((a, b) => a + b) / n, se = Math.sqrt(per.reduce((a, b) => a + (b - m) ** 2, 0) / (n - 1) / n);
    return { n, m, se, txt: `${(m >= 0 ? '+' : '') + (m * 100).toFixed(1)}¢ ±${(se * 100).toFixed(1)} (n=${n})${Math.abs(m) > 2 * se ? (m > 0 ? ' ★' : ' ✗') : ''}`.padEnd(22) };
  }
  console.log(`${season}-${String(season + 1).slice(2)} 常规赛 ${rows.length} 场 · 高潮 = 4 分钟内净胜 ≥${NRUN} 分 · 60 秒后成交 · 每次进出 ${COST * 100}¢`);
  console.log(`阵容还原：${checked} 个“球队-节”中 ${((1 - bad / checked) * 100).toFixed(0)}% 两边都恰好识别出 5 人（其余为有球员整节没出现在记录里，主力几乎不受影响）`);
  console.log(`共 ${ev.length} 次高潮，被打方平均价格 ${(ev.reduce((a, e) => a + e.px, 0) / ev.length * 100).toFixed(0)}¢`);
  const G = [
    ['全部高潮（基准）', e => true],
    ['替补高光：高潮方 0 名主力在场', e => e.runK === 0],
    ['高潮方 1 名主力在场', e => e.runK === 1],
    ['高潮方 2 名主力都在场', e => e.runK === 2],
    ['被打方 0 名主力在场（打的是对方替补）', e => e.vicK === 0],
    ['被打方 2 名主力都在场', e => e.vicK === 2],
    ['替补打替补（双方都 0 主力）', e => e.runK === 0 && e.vicK === 0],
    ['替补高光 打 对方主力（高潮方 0，被打方 ≥1）', e => e.runK === 0 && e.vicK >= 1],
    ['主力 打 对方替补（高潮方 ≥1，被打方 0）', e => e.runK >= 1 && e.vicK === 0],
  ];
  for (const [col, nm] of [['fade10', '买被打的一方，10 分钟后卖'], ['fadeEnd', '买被打的一方，拿到终场'], ['follow10', '买打出高潮的一方，10 分钟后卖']]) {
    console.log(`\n【${nm}】                                前半季（< ${SPLIT}）       后半季`);
    for (const [name, f] of G) {
      const L = h => ev.filter(e => e.half === h && f(e)).map(e => ({ g: e.g, v: e[col] }));
      const a = summ(L('A')), b = summ(L('B'));
      const ok = a.m > 0 && b.m > 0 && a.m > 2 * a.se && b.m > 1.5 * b.se;
      console.log(`  ${name.padEnd(26, '　')} ${a.txt} ${b.txt}${ok ? ' ◆ 两段都为正' : ''}`);
    }
  }
  console.log('\n★ 显著为正 ✗ 显著为负 ◆ 前后两段都为正。主力 = 全季场均得分前二（有轻微后见之明）。');
}

(async () => { await collect(); analyze(); })();
