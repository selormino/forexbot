process.env.DB_PATH=':memory:';
const test=require('node:test');
const assert=require('node:assert/strict');
const setup=require('../src/setupModel');
const research=require('../src/research');

function row(futureBars){
  return {
    price:100,atr:1,x:[.2,-.1,.4],priceAction:{bias:.2},
    futureBars
  };
}
test('setup outcome excludes plans whose confirmation entry never triggers',()=>{
  const r=setup.outcome(row([
    {open:100,high:100.05,low:99.95,close:100},
    {open:100,high:100.06,low:99.94,close:100},
    {open:100,high:100.07,low:99.93,close:100},
    {open:100,high:100.08,low:99.92,close:100}
  ]),'EURUSD','LONG',0);
  assert.equal(r.triggered,false);
  assert.equal(r.settled,false);
});
test('setup outcome labels a triggered target hit as success',()=>{
  const bars=[
    {open:100,high:100.2,low:99.9,close:100.15},
    {open:100.15,high:103,low:100,close:102.5},
    {open:102.5,high:102.7,low:102.3,close:102.6},
    {open:102.6,high:102.8,low:102.4,close:102.7},
    {open:102.7,high:102.9,low:102.5,close:102.8},
    {open:102.8,high:103,low:102.6,close:102.9}
  ];
  const r=setup.outcome(row(bars),'EURUSD','LONG',0);
  assert.equal(r.triggered,true);
  assert.equal(r.settled,true);
  assert.equal(r.outcome,'TP');
  assert.equal(r.y,1);
  assert.ok(r.realizedR>1);
});
test('research split purges through full setup outcome window',()=>{
  const rows=Array.from({length:600},(_,i)=>({at:i,end:i+4,setupEnd:i+10}));
  const {train,cal,test}=research.split(rows);
  assert.ok(train.every(x=>x.setupEnd<cal[0].at));
  assert.ok(cal.every(x=>x.setupEnd<test[0].at));
});
test('setup logistic model returns bounded probabilities',()=>{
  const rows=Array.from({length:200},(_,i)=>({z:[i%2,(i%2)*.5],y:i%2}));
  const weights=setup.fit(rows),calibration=setup.calibrate(weights,rows);
  for(const z of [[0,0],[1,.5]]){
    const p=setup.predict({weights,calibration},z);
    assert.ok(p>0&&p<1);
  }
});


test('setup eligibility mirrors live structural gates',()=>{
  const base={
    regime:'trend',trend:1,atr:1,price:100,
    technicalBias:.5,priceAction:{bias:.2},
    context:{macroAvailable:true,macroBias:.2,newsAvailable:false,newsSentiment:0}
  };
  assert.equal(setup.eligible(base,'LONG',5),true);
  assert.equal(setup.eligible({...base,regime:'range'},'LONG',5),false);
  assert.equal(setup.eligible({...base,trend:-1},'LONG',5),false);
  assert.equal(setup.eligible({...base,priceAction:{bias:-.8}},'LONG',5),false);
  assert.equal(setup.eligible({...base,atr:.01},'LONG',5),false);
});


test('pooled setup rows never cross the target test cutoff',()=>{
  const rows=Array.from({length:200},(_,i)=>({at:i*10,end:i*10+4,setupEnd:i*10+9}));
  const cutoff=1500;
  const parts=research.poolSplitRows(rows,cutoff);
  assert.ok(parts.train.length>0);
  assert.ok(parts.cal.length>0);
  assert.ok(parts.train.every(r=>r.setupEnd<parts.cal[0].at));
  assert.ok(parts.cal.every(r=>r.setupEnd<cutoff));
});
test('asset-family pooling stays within related markets',()=>{
  assert.deepEqual(research.assetFamily('EURUSD'),['EURUSD','GBPUSD','USDJPY','AUDUSD','USDCAD']);
  assert.deepEqual(research.assetFamily('XAUUSD'),['XAUUSD','XAGUSD','WTI']);
  assert.deepEqual(research.assetFamily('BTCUSD'),['BTCUSD','ETHUSD','SOLUSD','XRPUSD','LTCUSD']);
});
