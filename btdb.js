// 回测数据库：bt_* 大表放在本地 bt.db（不上传 GitHub），比赛/盘口数据在 nba.db
// 用 bt.db 作主库并挂载 nba.db：未加前缀的 games / pm_ledger 等表会自动从 nba.db 读取，新建的 bt_* 表落在 bt.db
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const db = new DatabaseSync(path.join(__dirname, 'bt.db'));
const nba = path.join(__dirname, 'nba.db').split(path.sep).join('/').replace(/'/g, "''");
db.exec(`ATTACH DATABASE '${nba}' AS main_data`);
module.exports = db;
