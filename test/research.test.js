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


test('v38 research costs widen conservatively at rollover and in volatile regimes',()=>{
  const liquid=r.costs('EURUSD',Date.parse('2026-09-21T13:00:00Z'),{regime:'trend'});
  const rollover=r.costs('EURUSD',Date.parse('2026-09-21T22:00:00Z'),{regime:'volatile'});
  assert.ok(rollover.total>liquid.total);
  assert.ok(rollover.spread>liquid.spread);
  assert.ok(rollover.financingBpsPerDay>0);
  assert.equal(rollover.observed,false);
});


test('daily CTA uses a lower probability floor because payoff is asymmetric',()=>{
  const old=process.env.CTA_MIN_PROBABILITY;
  process.env.CTA_MIN_PROBABILITY='0.40';
  assert.equal(r.strategyThreshold('1d'),.40);
  assert.ok(r.strategyThreshold('1h')>=.5);
  if(old===undefined)delete process.env.CTA_MIN_PROBABILITY;else process.env.CTA_MIN_PROBABILITY=old;
});

test('daily continuity allows normal weekend gaps but rejects long missing periods',()=>{
  const fri=Date.parse('2026-09-18T00:00:00Z'),mon=Date.parse('2026-09-21T00:00:00Z');
  assert.equal(r.continuousGap(fri,mon,'1d'),true);
  assert.equal(r.continuousGap(fri,Date.parse('2026-09-25T00:00:00Z'),'1d'),false);
  assert.equal(r.continuousGap(0,14_400_000,'4h'),true);
  assert.equal(r.continuousGap(0,28_800_000,'4h'),false);
});

test('daily features expose CTA momentum, channel and trend-strength evidence',()=>{
  const rows=Array.from({length:120},(_,i)=>({open:100+i*.2,high:101+i*.2,low:99+i*.2,close:100.5+i*.2,volume:1000,provider:'test'}));
  const f=r.features(rows,'EURUSD',Date.parse('2026-09-21T00:00:00Z'));
  assert.ok(Number.isFinite(f.cta.score));
  assert.ok(Number.isFinite(f.cta.momentum20Atr));
  assert.ok(Number.isFinite(f.cta.momentum60Atr));
  assert.ok(f.cta.breakoutPosition<=1&&f.cta.breakoutPosition>=-1);
});
