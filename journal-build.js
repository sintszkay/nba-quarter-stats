// 把 journal/*.md 转成 HTML（journal/*.html + journal/index.html），无需安装依赖
// 用法: node journal-build.js
const fs = require('fs'), path = require('path');
const DIR = path.join(__dirname, 'journal');
const REPO = 'https://github.com/sintszkay/nba-quarter-stats';
const SITE = 'https://sintszkay.github.io/nba-quarter-stats/';

const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const link = u => u === 'README.md' ? 'index.html' : u === '../README.md' ? REPO + '#readme' : /^\d{4}-\d{2}-\d{2}\.md$/.test(u) ? u.replace(/\.md$/, '.html') : u;
const inline = s => esc(s)
  .replace(/`([^`]+)`/g, '<code>$1</code>')
  .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, t, u) => `<a href="${link(u)}">${t}</a>`);
const numCell = s => /^[−+\-]?[\d.,%¢$]+[¢%]?$|^\d+–\d+$|^\(?n=/.test(s.trim()) || /^[−+]\d/.test(s.trim());

function md2html(md) {
  const L = md.replace(/\r/g, '').split('\n'), out = [];
  let i = 0;
  const para = [];
  const flush = () => { if (para.length) { out.push(`<p>${inline(para.join(' '))}</p>`); para.length = 0; } };
  while (i < L.length) {
    const l = L[i];
    if (!l.trim()) { flush(); i++; continue; }
    let m;
    if ((m = l.match(/^(#{1,4})\s+(.*)$/))) { flush(); const n = m[1].length; out.push(`<h${n}>${inline(m[2])}</h${n}>`); i++; continue; }
    if (/^---+\s*$/.test(l)) { flush(); out.push('<hr>'); i++; continue; }
    if (l.startsWith('>')) { flush(); const q = []; while (i < L.length && L[i].startsWith('>')) q.push(L[i++].replace(/^>\s?/, '')); out.push(`<blockquote>${q.map(inline).join('<br>')}</blockquote>`); continue; }
    if (l.trim().startsWith('|') && L[i + 1] && /^\s*\|[\s:|-]+\|\s*$/.test(L[i + 1])) {
      flush();
      const cells = r => r.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim());
      const head = cells(l); i += 2; const body = [];
      while (i < L.length && L[i].trim().startsWith('|')) body.push(cells(L[i++]));
      out.push(`<div class="tw"><table><thead><tr>${head.map(h => `<th>${inline(h)}</th>`).join('')}</tr></thead><tbody>` +
        body.map(r => `<tr>${r.map(c => `<td${numCell(c) ? ' class="n"' : ''}>${inline(c)}</td>`).join('')}</tr>`).join('') + '</tbody></table></div>');
      continue;
    }
    if (/^\s*[-*]\s+/.test(l) || /^\s*\d+\.\s+/.test(l)) {
      flush(); const ordered = /^\s*\d+\./.test(l), items = [];
      while (i < L.length && (ordered ? /^\s*\d+\.\s+/ : /^\s*[-*]\s+/).test(L[i])) items.push(L[i++].replace(/^\s*(?:[-*]|\d+\.)\s+/, ''));
      out.push(`<${ordered ? 'ol' : 'ul'}>${items.map(x => `<li>${inline(x)}</li>`).join('')}</${ordered ? 'ol' : 'ul'}>`);
      continue;
    }
    para.push(l.trim()); i++;
  }
  flush();
  return out.join('\n');
}

const page = (title, body, nav) => `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
:root { --bg: #F6F7F9; --panel: #FFFFFF; --ink: #17202B; --muted: #5B6675; --line: #DCE2EA; --accent: #D9560B; --win: #1F8A5B; --lose: #C23B3B; --mid: #EEF1F5;
  --body: "Noto Sans SC", system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; --mono: ui-monospace, "SF Mono", Consolas, monospace; color-scheme: light }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { --bg: #0E141C; --panel: #151D28; --ink: #E7ECF2; --muted: #93A0B0; --line: #253244; --accent: #F27A2E; --win: #3DBE85; --lose: #E86464; --mid: #1C2838; color-scheme: dark } }
:root[data-theme="dark"] { --bg: #0E141C; --panel: #151D28; --ink: #E7ECF2; --muted: #93A0B0; --line: #253244; --accent: #F27A2E; --win: #3DBE85; --lose: #E86464; --mid: #1C2838; color-scheme: dark }
* { box-sizing: border-box }
body { margin: 0; background: var(--bg); color: var(--ink); font: 15px/1.7 var(--body); padding: 20px max(16px, env(safe-area-inset-left, 0px)) 56px }
main { max-width: 900px; margin: 0 auto; background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 24px clamp(16px, 4vw, 40px) }
nav { max-width: 900px; margin: 0 auto 12px; display: flex; gap: 16px; flex-wrap: wrap; font-size: 14px }
a { color: var(--accent) } a:hover { text-decoration: none }
h1 { font-size: 28px; line-height: 1.2; margin: 0 0 12px } h2 { font-size: 21px; margin: 32px 0 10px; padding-top: 4px } h3 { font-size: 17px; margin: 22px 0 8px }
p, ul, ol { margin: 8px 0 } li { margin: 3px 0 }
blockquote { margin: 12px 0; padding: 8px 14px; border-left: 3px solid var(--accent); background: var(--mid); color: var(--muted); border-radius: 0 6px 6px 0 }
hr { border: 0; border-top: 1px solid var(--line); margin: 28px 0 }
code { font-family: var(--mono); font-size: .9em; background: var(--mid); padding: 1px 5px; border-radius: 4px }
.tw { overflow-x: auto; margin: 10px 0; border: 1px solid var(--line); border-radius: 8px }
table { border-collapse: collapse; width: 100%; font-size: 14px }
th, td { padding: 7px 10px; border-bottom: 1px solid var(--line); text-align: left; white-space: nowrap }
th { background: var(--mid); font-weight: 600; color: var(--muted); font-size: 13px }
tbody tr:last-child td { border-bottom: 0 }
td.n { font-family: var(--mono); font-variant-numeric: tabular-nums }
strong { font-weight: 700 }
.list a { display: block; padding: 12px 0; border-bottom: 1px solid var(--line); text-decoration: none; color: var(--ink) }
.list a b { color: var(--accent); font-family: var(--mono); margin-right: 12px }
.list a span { color: var(--muted) }
</style></head><body>
<nav>${nav}</nav>
<main>
${body}
</main>
</body></html>
`;

const files = fs.readdirSync(DIR).filter(f => /^\d{4}-\d{2}-\d{2}\.md$/.test(f)).sort().reverse();
const nav = `<a href="index.html">交易日志</a><a href="${SITE}">数据网页</a><a href="${REPO}">GitHub</a>`;
for (const f of files) {
  const md = fs.readFileSync(path.join(DIR, f), 'utf8');
  const title = (md.match(/^#\s+(.*)$/m) || [, f])[1];
  fs.writeFileSync(path.join(DIR, f.replace(/\.md$/, '.html')), page(title, md2html(md), nav));
}
// 目录：用 README.md 的表格描述
const idx = fs.existsSync(path.join(DIR, 'README.md')) ? fs.readFileSync(path.join(DIR, 'README.md'), 'utf8') : '';
const desc = {}; for (const m of idx.matchAll(/\|\s*\[(\d{4}-\d{2}-\d{2})\]\([^)]*\)\s*\|\s*([^|]+)\|/g)) desc[m[1]] = m[2].trim();
const list = files.map(f => { const d = f.slice(0, 10); return `<a href="${d}.html"><b>${d}</b><span>${esc(desc[d] || '')}</span></a>`; }).join('\n');
fs.writeFileSync(path.join(DIR, 'index.html'), page('交易日志', `<h1>交易日志</h1><p>每日赛事分析、操作复盘与次日预判（香港时间日期）。</p><div class="list">${list}</div>`, nav));
console.log(`日志 HTML 已生成：${files.length} 篇 + 目录`);
