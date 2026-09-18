const test=require('node:test');
const assert=require('node:assert/strict');
const {analyzePriceAction}=require('../src/priceAction');

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
