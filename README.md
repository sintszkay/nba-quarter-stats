# NBA 分节领先胜率 + Polymarket 台账

网页：https://sintszkay.github.io/nba-quarter-stats/

- **分节统计**：某队在某节结束时领先/落后 X 分，最终赢球的历史概率（2021–22 至今，ESPN 分节比分）
- **盘中公允价计算器**：输入赛前胜率和当前分差，估算公允价
- **PM 台账**：Polymarket 胜负线每场的开盘 / 24h / 1h / 开赛价、结果与结算，含各队实际 vs 市场预期、价格校准

## 投篮命中率均值回归

[计算器 HTML](mean-reversion.html)：输入双方整体 FG%、投中及出手次数，查看各自与双边的标准差偏离；按 σ 门槛筛选相似历史情境，显示回归率、样本数、区间及提前平仓结果。

页面内嵌数据，可独立打开；当前为 2026-11-28 研究快照，数据不会自动刷新。会随既有 GitHub Pages 更新流程发布。

## 交易日志
每日分析与操作复盘：[网页版](https://sintszkay.github.io/nba-quarter-stats/journal/) · [Markdown 原稿](journal/README.md)

## 自动更新
GitHub Actions（`.github/workflows/update.yml`）每天跑 4 次：抓 ESPN 比分 → 记录 Polymarket 盘前快照 → 结算 → 重新生成网页并发布到 GitHub Pages。
数据库 `nba.db` 存在 `data` 分支（每次覆盖，只保留最新一份）。也可在 Actions 页面手动点 “Run workflow”。

## 本地使用（Node 24+，无需安装依赖）
```
update.bat                         # 一键更新并生成 index.html
node query.js NYK --site away --q 1 --trail 5
node ledger-report.js --season 2026 --team NYK
```
取回云端最新数据库：`git fetch origin data && git show origin/data:nba.db > nba.db`

回测脚本 `bt-*.js` 使用本地 `bt.db`（体积大，不上传）。
