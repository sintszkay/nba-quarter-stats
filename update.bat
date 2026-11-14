@echo off
rem 一键更新：分节比分 + Polymarket 赛前盘口 + 盘前/结算台账 + 重新生成 index.html
cd /d "%~dp0"
set NODE_NO_WARNINGS=1
node fetch.js
node --dns-result-order=ipv4first pm.js %*
node --dns-result-order=ipv4first ledger.js
node build.js
