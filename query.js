// 查询：某队在某节结束时（主/客场）领先或落后 X 分，最终赢球概率
//
// 用法:
//   node query.js PHI                      -> 76人 全景表（Q1/半场/Q3 × 分差区间）
//   node query.js PHI --site home          -> 只看主场
//   node query.js PHI --q 3 --lead 10      -> 第3节结束领先 ≥10 分
//   node query.js PHI --q 2 --trail 5      -> 半场落后 ≥5 分
//   node query.js PHI --q 3 --margin -4:4  -> 第3节结束分差在 -4~+4 之间（队伍视角）
//   node query.js ALL --q 3 --lead 15      -> 全联盟
// 其它参数:
//   --vs DAL            只看对阵某队
//   --seasons 2023,2024,2025   赛季（起始年；默认最近五个完整赛季 2021-22 ~ 2025-26）
//   --cur               加入当前赛季 2026-27
//   --type reg|po|all   常规赛/季后赛（含附加赛）/全部（默认 all）
//   --list              列出命中的比赛
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const db = new DatabaseSync(path.join(__dirname, 'nba.db'), { readOnly: true });

const args = process.argv.slice(2);
const team = (args[0] || 'ALL').toUpperCase();
const opt = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : (args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true); };

const site = opt('site', 'all');            // home | away | all
const q = Number(opt('q', 0));              // 1, 2(半场), 3
const vs = opt('vs', null);
let seasons = String(opt('seasons', '2021,2022,2023,2024,2025')).split(',').map(Number);
if (opt('cur', false)) seasons.push(2026);
const type = opt('type', 'all');
const list = !!opt('list', false);

let lo = -999, hi = 999;
if (opt('lead', null) !== null) lo = Number(opt('lead'));
if (opt('trail', null) !== null) hi = -Number(opt('trail'));
if (opt('margin', null) !== null) [lo, hi] = String(opt('margin')).split(':').map(Number);

// 把每场比赛展开成两条“队伍视角”记录
const rows = db.prepare(`SELECT * FROM games WHERE season IN (${seasons.join(',')})`).all()
  .filter(g => type === 'all' || (type === 'reg' ? g.stype === 2 : g.stype !== 2));
const persp = [];
for (const g of rows) {
  const hc = [g.h1, g.h1 + g.h2, g.h1 + g.h2 + g.h3], ac = [g.a1, g.a1 + g.a2, g.a1 + g.a2 + g.a3];
  persp.push({ g, team: g.home, opp: g.away, site: 'home', m: hc.map((v, i) => v - ac[i]), win: g.hf > g.af });
  persp.push({ g, team: g.away, opp: g.home, site: 'away', m: ac.map((v, i) => v - hc[i]), win: g.af > g.hf });
}
const base = persp.filter(p =>
  (site === 'all' || p.site === site) && (!vs || p.opp === vs.toUpperCase()));
const mine = team === 'ALL' ? base : base.filter(p => p.team === team);

const stat = (arr, qi, a, b) => {
  const s = arr.filter(p => p.m[qi] >= a && p.m[qi] <= b);
  const w = s.filter(p => p.win).length;
  return { n: s.length, w, l: s.length - w, pct: s.length ? w / s.length : null, s };
};
const pct = x => x === null ? '  -  ' : (x * 100).toFixed(1).padStart(5) + '%';
const QN = ['第1节', '半场', '第3节'];
const seasonTxt = seasons.map(s => `${s}-${String(s + 1).slice(2)}`).join(', ');
const siteTxt = { home: '主场', away: '客场', all: '主客场' }[site];

console.log(`\n${team === 'ALL' ? '全联盟' : team} | ${siteTxt}${vs ? ' vs ' + vs.toUpperCase() : ''} | ${seasonTxt} | ${type} | 样本 ${mine.length} 场（${mine.filter(p => p.win).length}胜）\n`);

if (q) {
  const r = stat(mine, q - 1, lo, hi), lg = stat(base, q - 1, lo, hi);
  const cond = lo === -999 ? `落后 ≥${-hi}` : hi === 999 ? `领先 ≥${lo}` : `分差 ${lo}~${hi}`;
  console.log(`${QN[q - 1]}结束 ${cond}：`);
  console.log(`  ${team.padEnd(4)}  ${r.w}胜 ${r.l}负  胜率 ${pct(r.pct)}  (n=${r.n})`);
  if (team !== 'ALL') console.log(`  联盟  ${lg.w}胜 ${lg.l}负  胜率 ${pct(lg.pct)}  (n=${lg.n})  ← 同条件全联盟基准`);
  if (list) for (const p of r.s.sort((a, b) => a.g.date < b.g.date ? 1 : -1))
    console.log(`   ${p.g.date} ${p.site === 'home' ? 'vs' : '@ '} ${p.opp}  ${QN[q - 1]}${p.m[q - 1] > 0 ? '+' : ''}${p.m[q - 1]}  终场 ${p.site === 'home' ? p.g.hf + '-' + p.g.af : p.g.af + '-' + p.g.hf}  ${p.win ? 'W' : 'L'}${p.g.ot ? ' (OT)' : ''}`);
} else {
  const B = [[15, 999, '领先 15+'], [10, 14, '领先 10-14'], [5, 9, '领先 5-9'], [1, 4, '领先 1-4'], [0, 0, '平'],
             [-4, -1, '落后 1-4'], [-9, -5, '落后 5-9'], [-14, -10, '落后 10-14'], [-999, -15, '落后 15+']];
  console.log('分差区间      ' + QN.map(x => x.padEnd(16)).join(''));
  for (const [a, b, name] of B) {
    const cells = [0, 1, 2].map(qi => { const r = stat(mine, qi, a, b); return `${pct(r.pct)} (${r.w}-${r.l})`.padEnd(18); });
    console.log(name.padEnd(10) + cells.join(''));
  }
  console.log('\n提示：加 --q 3 --lead 10 查具体条件，并对比全联盟基准');
}
