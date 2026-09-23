/*
 * 看一眼接收端到底收到了什么。
 *
 * 跑法：node wps-addon/test/peek-db.mjs
 *
 * 排查「插件到底上报成功没有」时，这个比问用户快得多，而且是硬证据：
 * minute_stats 里 char_source='plugin' 的行就是插件上报的结果。
 * 真机上定位「只认出了删除、没认出插入」用的就是它——
 * 那行是 char_input=0 / char_delete=2，一眼指出映射只覆盖了一半。
 *
 * 只读打开：TypeStat 正在跑的时候读也没关系（WAL 模式）。
 */
import { join } from 'node:path';
import { existsSync } from 'node:fs';

const dbPath = join(process.env.APPDATA, 'com.typestat.app', 'typestat.db');
if (!existsSync(dbPath)) {
  console.error('找不到库:', dbPath, '——TypeStat 还没跑过？');
  process.exit(1);
}
const { DatabaseSync } = await import('node:sqlite');
const db = new DatabaseSync(dbPath, { readOnly: true });

console.log('库:', dbPath);
console.log('\n-- 有精确字符数的分钟（最近 15 条）--');
const rows = db.prepare(`
  SELECT datetime(minute*60,'unixepoch','localtime') AS t, app,
         key_input, key_delete, char_input, char_delete, char_source
  FROM minute_stats
  WHERE char_input > 0 OR char_delete > 0
  ORDER BY minute DESC LIMIT 15`).all();
if (!rows.length) console.log('  （一条都没有——精确字数从来没上报成功过）');
for (const r of rows) console.log(' ', JSON.stringify(r));

console.log('\n-- 各应用的按键数（今天）--');
for (const r of db.prepare(`
  SELECT app, SUM(key_input) AS ki, SUM(key_delete) AS kd,
         SUM(char_input) AS ci, SUM(char_delete) AS cd
  FROM minute_stats
  WHERE minute >= strftime('%s','now','localtime','start of day')/60
  GROUP BY app ORDER BY ki DESC LIMIT 10`).all()) {
  console.log(' ', JSON.stringify(r));
}
db.close();
