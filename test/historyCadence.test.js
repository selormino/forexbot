process.env.DB_PATH=':memory:';
const test=require('node:test');
const assert=require('node:assert/strict');
const history=require('../src/history');

test('market-hour guard skips closed weekend forex but not crypto',()=>{
  const saturday=Date.parse('2026-10-10T12:00:00Z');
  const monday=Date.parse('2026-10-12T12:00:00Z');
  assert.equal(history.marketLikelyOpen('EURUSD',saturday),false);
  assert.equal(history.marketLikelyOpen('BTCUSD',saturday),true);
  assert.equal(history.marketLikelyOpen('EURUSD',monday),true);
});

test('history timeframe conversion includes five-minute bars',()=>{
  assert.equal(history.timeframeMs('5m'),300000);
  assert.equal(history.timeframeMs('30m'),1800000);
});
