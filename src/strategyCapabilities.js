function status(){
  return {
    intradayTrading:{
      implemented:true,
      executionMode:'gated-demo-compatible',
      timeframes:['15m','30m'],
      markets:String(process.env.INTRADAY_SYMBOLS||'EURUSD,GBPUSD,USDJPY,AUDUSD,USDCAD,XAUUSD').split(',').map(x=>x.trim()).filter(Boolean),
      primaryEdges:[
        'trend continuation with 1H higher-timeframe alignment',
        'range mean-reversion with RSI/Bollinger/momentum reversal confirmation',
        'price-action structure and classical-pattern confirmation'
      ],
      design:{
        probabilityFloor:Number(process.env.INTRADAY_MIN_PROBABILITY||0.60),
        evidenceFloorPct:60,
        targetHoldingWindow:'roughly 4–18 hours depending on selected 15m/30m plan',
        rolloverGuard:'non-crypto entries blocked from 21:00–23:00 UTC',
        costGuard:'intraday ATR must exceed estimated round-trip costs by at least 3x',
        validation:'separate chronological purged models with untouched final holdout and minimum intraday history span'
      },
      limitations:[
        'Historical bid/ask ticks are still unavailable, so spread/slippage costs remain conservative estimates.',
        '15m/30m models must accumulate enough market-specific history and OOS selections before strict approval.',
        'Fallback Yahoo-fed symbols remain research-only and cannot become automatic broker candidates.'
      ]
    },
    ctaTrendFollowing:{
      implemented:true,
      executionMode:'gated-demo-compatible',
      timeframes:['1d'],
      markets:'current ForexBot symbol universe',
      primaryEdge:'time-series momentum / breakout persistence',
      design:{
        winRateTarget:'not optimized',
        payoffProfile:'asymmetric 2.5R-5R targets with wide ATR stops',
        probabilityFloor:Number(process.env.CTA_MIN_PROBABILITY||0.40),
        evidenceFloorPct:60,
        validation:'chronological purged splits, untouched final holdout, positive net expectancy confidence'
      },
      limitations:[
        'Current universe has FX, metals, oil and crypto but not institutional rates/index futures.',
        'Historical costs are conservative estimates until broker-grade bid/ask history is stored.',
        'Daily strategy requires sufficient 1D history before a model can be approved.'
      ]
    },
    marketMaking:{
      implemented:false,
      executionMode:'disabled',
      viableForCurrentArchitecture:false,
      reason:'ForexBot uses periodic market-data polling and an MT5 broker bridge; it has no exchange queue priority or colocated order-book feed.',
      requiredBeforeResearchCouldBeCredible:[
        'venue-native level-2/order-book data with sub-second timestamps',
        'maker/taker fee and rebate schedule',
        'order acknowledgement/cancel latency measurements',
        'queue-position and partial-fill modelling',
        'inventory-risk and adverse-selection controls',
        'broker/venue support for genuine passive two-sided quoting'
      ],
      safeguard:'No market-making order generator exists, so enabling an environment flag cannot accidentally start two-sided quoting.'
    }
  };
}
module.exports={status};
