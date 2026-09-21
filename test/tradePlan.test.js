const test=require('node:test');const assert=require('node:assert/strict');const {buildTradePlan,distanceUnits}=require('../src/tradePlan');
test('EURUSD plan exposes pip distances and positive R',()=>{const s={symbol:'EURUSD',price:1.1,leanDirection:'LONG',features:{atr:.001},priceAction:{}};const p=buildTradePlan(s);assert.equal(p.side,'LONG');assert.ok(p.entry>1.1);assert.ok(p.stop<p.entry);assert.ok(p.target>p.entry);assert.ok(p.stopPips>0);assert.ok(p.targetPips>p.stopPips);assert.ok(p.riskReward>=1);});
test('JPY pip conversion uses 0.01',()=>{assert.ok(Math.abs(distanceUnits('USDJPY',150,150.1)-10)<1e-9);});
test('short plan reverses stop and target correctly',()=>{const s={symbol:'GBPUSD',price:1.25,leanDirection:'SHORT',features:{atr:.0012},priceAction:{}};const p=buildTradePlan(s);assert.ok(p.entry<1.25);assert.ok(p.stop>p.entry);assert.ok(p.target<p.entry);});
test('crypto plan reports USD price movement',()=>{const s={symbol:'BTCUSD',price:100000,leanDirection:'LONG',features:{atr:2000},priceAction:{}};const p=buildTradePlan(s);assert.equal(p.unitLabel,'USD');assert.ok(p.targetPips>1000);assert.ok(p.stopPips>0);});

test('long confirmation entry clears nearby resistance',()=>{
  const s={symbol:'EURUSD',price:1.1,leanDirection:'LONG',features:{atr:.001},priceAction:{resistancePrice:1.102}};
  const p=buildTradePlan(s);
  assert.ok(p.entry>1.102);
});
test('short confirmation entry clears nearby support',()=>{
  const s={symbol:'EURUSD',price:1.1,leanDirection:'SHORT',features:{atr:.001},priceAction:{supportPrice:1.098}};
  const p=buildTradePlan(s);
  assert.ok(p.entry<1.098);
});

test('nearest swing level takes precedence over distant range extreme',()=>{
  const s={symbol:'EURUSD',price:1.1,leanDirection:'LONG',features:{atr:.001},priceAction:{swingResistancePrice:1.101,resistancePrice:1.105}};
  const p=buildTradePlan(s);
  assert.ok(p.entry>1.101);
  assert.ok(p.entry<1.105);
});


test('sub-1R target profiles are preserved for higher-win-rate research',()=>{
  const s={symbol:'XAUUSD',price:2600,leanDirection:'LONG',features:{atr:20},priceAction:{}};
  const p=buildTradePlan(s,{targetR:.8,stopAtr:1});
  assert.ok(Math.abs(p.riskReward-.8)<1e-9);
  assert.ok(p.targetDistance<p.stopDistance);
  assert.ok(p.tp1<=p.target);
});
