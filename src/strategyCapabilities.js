function status(){
  return {
    scalping:{
      implemented:true,
      enabled:process.env.SCALP_ENABLED==='true',
      executionMode:process.env.SCALP_DEMO_DISPATCH==='true'?'gated-demo-only':'research-shadow-only',
      timeframes:['5m'],
      markets:String(process.env.SCALP_SYMBOLS||'EURUSD,GBPUSD,USDJPY,XAUUSD').split(',').map(x=>x.trim()).filter(Boolean),
      objective:'positive net expectancy with frequent short-duration opportunities; high win rate alone is not an approval target',
      primaryEdges:[
        '5m trend continuation with 15m directional confirmation',
        '5m range mean-reversion in liquid sessions',
        'price-action and classical-pattern confirmation'
      ],
      design:{
        probabilityFloor:Number(process.env.SCALP_MIN_PROBABILITY||0.65),
        evidenceFloorPct:Number(process.env.SCALP_MIN_EVIDENCE||65),
        targetHoldingWindow:'roughly 40 minutes to 2 hours depending on selected plan',
        observedCostCoverageRequired:Number(process.env.SCALP_MIN_OBSERVED_COST_COVERAGE||0.95),
        minimumOosSelections:Number(process.env.SCALP_MIN_OOS_SELECTIONS||100),
        validation:'broker-native MT5 candles/spreads, chronological purged splits, untouched final holdout, positive net expectancy confidence'
      },
      safeguards:[
        '5m plan eligibility requires broker-observed spread data.',
        '5m ATR must exceed modeled round-trip costs by at least 4x.',
        'Only configured liquid sessions are eligible.',
        'Automatic broker dispatch is disabled unless SCALP_DEMO_DISPATCH=true and remains demo-only.'
      ]
    },
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
        '15m/30m historical costs remain conservative estimates unless MT5 broker-native market data is enabled for those timeframes.',
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
