process.env.DB_PATH=':memory:';
const test=require('node:test'),assert=require('node:assert/strict');
const r=require('../src/research'),db=require('../src/db');
test('context cannot see future snapshots or newly discovered old news',()=>{
  r.snapshot('macro','USD',{FEDFUNDS:{level:5,change:.1}},10000);
  r.recordNews('EURUSD',[{headline:'growth',time:1000,sentiment:1}],10000);
  assert.equal(r.context('EURUSD',9999).newsAvailable,false);
  assert.equal(r.context('EURUSD',9999).x.at(-1),0);
  assert.equal(r.context('EURUSD',10000).newsAvailable,true);
});
test('deduplication preserves first known timestamp',()=>{
  r.recordNews('EURUSD',[{headline:'growth',time:1000,sentiment:1}],20000);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM news_history').get().n,1);
  assert.equal(db.prepare('SELECT known_at FROM news_history').get().known_at,10000);
});
test('purged splits exclude overlapping label outcomes',()=>{
  const rows=Array.from({length:600},(_,i)=>({at:i,end:i+4}));
  const {train,cal,test}=r.split(rows);
  assert.ok(train.every(x=>x.end<cal[0].at));assert.ok(cal.every(x=>x.end<test[0].at));
});
test('costs lower returns and trades never overlap',()=>{
  const m={weights:[3,0],calibration:{a:1,b:0}};
  const rows=Array.from({length:20},(_,i)=>({x:[0],y:1,ret:.001,at:i+1,end:i+5,regime:'trend',trend:1,atr:2,price:100}));
  const free=r.evaluate(m,rows,0),paid=r.evaluate(m,rows,20);
  assert.equal(paid.trades,5);assert.ok(paid.netReturn<free.netReturn);assert.ok(paid.expectancy<0);
});
test('calibration produces finite bounded probabilities',()=>{
  const rows=Array.from({length:200},(_,i)=>({x:[i%2],y:i%2}));
  const weights=r.fit(rows),calibration=r.calibrate(weights,rows);
  for(const x of [[0],[1]]){const p=r.predict({weights,calibration},x);assert.ok(p>0&&p<1);}
});
test('cost configuration rejects negative estimates',()=>{
  process.env.SLIPPAGE_BPS='-1';assert.throws(()=>r.costs('EURUSD'));delete process.env.SLIPPAGE_BPS;
});

test('ALFRED vintages return only revisions known by the as-of date',()=>{
  const macro=require('../src/macro');
  process.env.ALFRED_AVAILABILITY_LAG_DAYS='0';
  const ins=db.prepare('INSERT INTO macro_vintages(series_id,observation_date,realtime_start,realtime_end,value,ingested_at) VALUES(?,?,?,?,?,?)');
  ins.run('DGS10','2026-01-01','2026-01-05','2026-01-09',4.1,1);
  ins.run('DGS10','2026-01-01','2026-01-10','9999-12-31',4.2,1);
  assert.equal(macro.pointInTimeSeries('DGS10',Date.parse('2026-01-07T12:00:00Z'),1)[0].value,4.1);
  assert.equal(macro.pointInTimeSeries('DGS10',Date.parse('2026-01-11T12:00:00Z'),1)[0].value,4.2);
  delete process.env.ALFRED_AVAILABILITY_LAG_DAYS;
});
