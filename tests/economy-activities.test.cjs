const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {DatabaseSync}=require('node:sqlite');
test('activity ownership defaults once and requires disabling before reassignment',()=>{
 const db=new DatabaseSync(':memory:');db.exec("CREATE TABLE economy_systems(id INTEGER PRIMARY KEY,guild_id TEXT,deleted INTEGER DEFAULT 0,config_json TEXT DEFAULT '{}'); INSERT INTO economy_systems(id,guild_id) VALUES(1,'a'),(2,'a'),(3,'b')");
 const source=fs.readFileSync('src/db.ts','utf8');const start=source.indexOf('db.exec(`UPDATE economy_systems SET config_json=json_set');const end=source.indexOf('`);',start);assert(start>=0);const migration=source.slice(start+9,end);db.exec(migration);
 const owner=()=>db.prepare("SELECT id FROM economy_systems WHERE guild_id='a' AND json_extract(config_json,'$.activityCommandsEnabled') IN (1,'true')").all().map(row=>row.id);
 assert.deepEqual(owner(),[1]);assert.throws(()=>db.prepare('UPDATE economy_systems SET config_json=? WHERE id=?').run(JSON.stringify({"activityCommandsEnabled":true}),2));
 db.prepare('UPDATE economy_systems SET config_json=? WHERE id=?').run(JSON.stringify({"activityCommandsEnabled":false}),1);db.exec(migration);assert.deepEqual(owner(),[]);
 db.prepare('UPDATE economy_systems SET config_json=? WHERE id=?').run(JSON.stringify({"activityCommandsEnabled":"true"}),2);assert.deepEqual(owner(),[2]);db.exec(migration);assert.deepEqual(owner(),[2]);db.close();
});
