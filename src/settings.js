const db=require('./db');

db.exec(`
CREATE TABLE IF NOT EXISTS app_settings(
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
`);

function numberSetting(key,fallback,{min=-Infinity,max=Infinity}={}){
  const row=db.prepare('SELECT value FROM app_settings WHERE key=?').get(key);
  const raw=row?row.value:fallback;
  const n=Number(raw);
  if(!Number.isFinite(n))return Number(fallback);
  return Math.max(min,Math.min(max,n));
}
function setNumber(key,value,{min=-Infinity,max=Infinity}={}){
  const n=Number(value);
  if(!Number.isFinite(n)||n<min||n>max)throw new Error(`${key} must be between ${min} and ${max}`);
  db.prepare(`INSERT INTO app_settings(key,value,updated_at) VALUES(?,?,?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`).run(key,String(n),Date.now());
  return n;
}
function signalMinProbability(){
  return numberSetting('signal_min_probability',process.env.SIGNAL_MIN_PROBABILITY||0.70,{min:.50,max:.95});
}
function setSignalMinProbability(value){
  return setNumber('signal_min_probability',value,{min:.50,max:.95});
}
function status(){
  const row=db.prepare('SELECT updated_at FROM app_settings WHERE key=?').get('signal_min_probability');
  return {signalMinProbability:signalMinProbability(),source:row?'database':'environment',updatedAt:row?.updated_at||null,minAllowed:.50,maxAllowed:.95};
}
module.exports={numberSetting,setNumber,signalMinProbability,setSignalMinProbability,status};
