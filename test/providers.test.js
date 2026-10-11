process.env.MT5_MARKET_DATA_ENABLED='true';
process.env.MT5_BRIDGE_URL='https://example.invalid';
process.env.MT5_BRIDGE_TOKEN='test-token';
process.env.MT5_MARKET_DATA_TIMEFRAMES='5m,15m,30m,1h,4h,1d';
process.env.MT5_MARKET_DATA_SYMBOLS='EURUSD,GBPUSD,USDJPY,AUDUSD,USDCAD,XAUUSD';
process.env.MARKET_FALLBACK_SYMBOLS='XAGUSD,WTI';
const test=require('node:test');
const assert=require('node:assert/strict');
const providers=require('../src/providers');

test('configured broker-traded forex timeframes route to MT5 market data',()=>{
  assert.equal(providers.marketProviderFor('EURUSD','5m'),'mt5');
  assert.equal(providers.marketProviderFor('XAUUSD','4h'),'mt5');
  assert.equal(providers.marketProviderFor('XAGUSD','1h'),'yahoo');
});
