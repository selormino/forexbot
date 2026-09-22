const test=require('node:test');
const assert=require('node:assert/strict');
const capabilities=require('../src/strategyCapabilities');

test('CTA is implemented while market making stays explicitly disabled',()=>{
  const s=capabilities.status();
  assert.equal(s.ctaTrendFollowing.implemented,true);
  assert.deepEqual(s.ctaTrendFollowing.timeframes,['1d']);
  assert.equal(s.marketMaking.implemented,false);
  assert.equal(s.marketMaking.executionMode,'disabled');
  assert.equal(s.marketMaking.viableForCurrentArchitecture,false);
});
