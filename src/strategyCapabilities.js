function status(){
  return {
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
