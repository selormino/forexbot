const test=require('node:test');
const assert=require('node:assert/strict');
const {analyzePriceAction,detectClassicalPatterns}=require('../src/priceAction');

function candles(n=30){
  const a=[];let p=100;
  for(let i=0;i<n;i++){const open=p,close=p+0.4,high=close+0.2,low=open-0.2;a.push({open,high,low,close});p=close;}
  return a;
}
test('detects bullish structure and finite vector',()=>{
  const r=analyzePriceAction(candles(40),1);
  assert.ok(['bullish','mixed'].includes(r.structure));
  assert.equal(r.vector.length,20);
  assert.ok(r.vector.every(Number.isFinite));
});
test('detects inside bar',()=>{
  const a=candles(30);const p=a[a.length-2];
  a[a.length-1]={open:p.open+0.1,close:p.close-0.1,high:p.high-0.05,low:p.low+0.05};
  const r=analyzePriceAction(a,1);
  assert.equal(r.insideBar,true);
});


function flatCandles(n=45){
  return Array.from({length:n},(_,i)=>({open:100,close:100,high:100.6,low:99.4,ts:i}));
}
test('detects and scores a confirmed double top',()=>{
  const a=flatCandles();
  a[15]={...a[15],open:103,close:103.5,high:105,low:102.5};
  a[20]={...a[20],open:99,close:98.2,high:99.5,low:97};
  a[25]={...a[25],open:103.2,close:103.4,high:104.9,low:102.8};
  a[a.length-1]={...a.at(-1),open:97.2,close:96.5,high:97.5,low:96.2};
  const patterns=detectClassicalPatterns(a,2);
  const p=patterns.find(x=>x.type==='double-top');
  assert.ok(p);
  assert.equal(p.bias,-1);
  assert.equal(p.confirmed,true);
  assert.ok(p.confidence>=.6);
  assert.ok(p.points.length>=3);
});
test('detects head and shoulders geometry',()=>{
  const a=flatCandles(50);
  a[12]={...a[12],open:103,close:103.5,high:104,low:102.5};
  a[16]={...a[16],open:100,close:99.6,high:100.5,low:99};
  a[20]={...a[20],open:106,close:106.5,high:108,low:105.5};
  a[24]={...a[24],open:100,close:99.8,high:100.4,low:99.2};
  a[28]={...a[28],open:103,close:103.3,high:104.2,low:102.6};
  a[a.length-1]={...a.at(-1),open:99,close:98.5,high:99.2,low:98.2};
  const patterns=detectClassicalPatterns(a,2);
  const p=patterns.find(x=>x.type==='head-and-shoulders');
  assert.ok(p);
  assert.equal(p.bias,-1);
  assert.ok(p.confidence>=.6);
});
test('classical patterns feed the aggregate price-action bias without changing vector shape',()=>{
  const a=flatCandles();
  a[15]={...a[15],open:103,close:103.5,high:105,low:102.5};
  a[20]={...a[20],open:99,close:98.2,high:99.5,low:97};
  a[25]={...a[25],open:103.2,close:103.4,high:104.9,low:102.8};
  a[a.length-1]={...a.at(-1),open:97.2,close:96.5,high:97.5,low:96.2};
  const r=analyzePriceAction(a,2);
  assert.equal(r.vector.length,20);
  assert.ok(r.classicalPatterns.length>=1);
  assert.ok(r.patternBias<0);
  assert.ok(Number.isFinite(r.bias));
});
