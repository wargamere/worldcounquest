'use client';

import { useCallback } from 'react';
import { MARKET } from '@/next/game/balance';
import { STOCK_LABELS } from '@/next/game/economy';
import type { Good, Sim, TradePolicy } from '@/next/game/types';
import { exchangeView, tradeOptions, type TradeOption } from '@/next/game/views';
import { playerNation, useHeavySimView, useSimView } from '@/next/store/gameStore';
import { act } from '../ui/act';
import { formatRate, whole } from '../ui/format';
import { Icon } from '../ui/Icon';
import { Sparkline } from '../ui/Sparkline';
import { Stepper } from '../ui/Stepper';

const MAX_POLICY_DAYS = 30;

/** The Exchange (X, §3.7, §8.3): per good stock, net, prices, pressure, 14-day history, trades with live quotes and the auto-trade policy. */
export function ExchangePanel() {
  const rows = useHeavySimView(useCallback((sim: Sim) => ({ goods: exchangeView(sim), policy: sim.state.nations[sim.state.player]!.trade }), []));
  if (rows === null) return null;
  const setPolicy = (good: Good, field: keyof TradePolicy, days: number): void => {
    const nation = playerNation();
    if (nation === null) return;
    const policy: TradePolicy = { keepDays: { ...rows.policy.keepDays }, sellAboveDays: { ...rows.policy.sellAboveDays } };
    policy[field][good] = days;
    act().command({ kind: 'tradePolicy', nation, policy });
  };
  return (
    <div className="space-y-3 text-xs">
      <p className="text-slate-400">Buying pushes a price up and selling pushes it down; pressure fades about 20% a day. Each trade moves at most a quarter of the market.</p>
      {rows.goods.map((g) => (
        <section key={g.good} className="space-y-2 rounded border border-slate-800 bg-slate-900/60 p-2">
          <div className="flex items-center justify-between">
            <h3 className="flex items-center gap-1.5 text-sm font-semibold text-slate-100">
              <Icon name={g.good} size={14} className="text-slate-400" />
              {STOCK_LABELS[g.good]}
            </h3>
            <span className="tabular-nums text-slate-300">
              {whole(g.stock)} · <span className={g.netPerDay < -0.5 ? 'text-rose-300' : 'text-emerald-300'}>{formatRate(g.netPerDay)}</span>
            </span>
          </div>
          <div className="flex items-center gap-3">
            <span className="tabular-nums text-slate-300">
              buy {g.buy.toFixed(2)} · sell {g.sell.toFixed(2)}
            </span>
            <PressureBar factor={g.factor} />
            <Sparkline series={[{ values: g.history, colour: '#38bdf8' }]} baseline={1} label={`${STOCK_LABELS[g.good]} price factor, last 14 days`} />
          </div>
          <Trades good={g.good} />
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
            <span className="flex items-center gap-1.5 text-slate-400">
              Keep stocked
              <Stepper value={g.policy.keepDays} min={0} max={MAX_POLICY_DAYS} label={`days of ${STOCK_LABELS[g.good]} to keep`} format={(v) => (v === 0 ? 'off' : `${v} d`)} onChange={(v) => setPolicy(g.good, 'keepDays', v)} />
            </span>
            <span className="flex items-center gap-1.5 text-slate-400">
              Sell above
              <Stepper value={g.policy.sellAboveDays} min={0} max={MAX_POLICY_DAYS} label={`days of ${STOCK_LABELS[g.good]} before selling`} format={(v) => (v === 0 ? 'off' : `${v} d`)} onChange={(v) => setPolicy(g.good, 'sellAboveDays', v)} />
            </span>
          </div>
        </section>
      ))}
      <p className="text-[11px] text-slate-500">Auto-trade runs every {MARKET.AUTO_TRADE_HOURS} h and never sells below {Math.round(MARKET.AUTO_SELL_MIN_FACTOR * 100)}% of the base price.</p>
    </div>
  );
}

function PressureBar({ factor }: { factor: number }) {
  const span = MARKET.MAX_FACTOR - MARKET.MIN_FACTOR;
  const at = (factor - MARKET.MIN_FACTOR) / span;
  const one = (1 - MARKET.MIN_FACTOR) / span;
  return (
    <div className="relative h-2 w-20 rounded-full bg-slate-800" role="meter" aria-label="Price factor" aria-valuenow={Number(factor.toFixed(2))} aria-valuemin={MARKET.MIN_FACTOR} aria-valuemax={MARKET.MAX_FACTOR} title={`Price ×${factor.toFixed(2)}`}>
      <span className="absolute inset-y-0 w-px bg-slate-500" style={{ left: `${one * 100}%` }} />
      <span className="absolute top-1/2 h-3 w-1.5 -translate-y-1/2 rounded-sm bg-sky-400" style={{ left: `calc(${Math.min(1, Math.max(0, at)) * 100}% - 3px)` }} />
    </div>
  );
}

/** Buy/Sell 100 / 1,000 / Max with live quotes; recomputed with the light views so a quote never lags a trade. */
function Trades({ good }: { good: Good }) {
  const options = useSimView(useCallback((sim: Sim) => tradeOptions(sim, good), [good]));
  if (options === null) return null;
  const trade = (o: TradeOption): void => {
    const nation = playerNation();
    if (nation !== null) act().command({ kind: 'trade', nation, good, amount: o.amount });
  };
  const button = (o: TradeOption, buy: boolean) => (
    <button
      key={o.label}
      type="button"
      disabled={o.reason !== null}
      title={o.reason ?? `${buy ? 'Pay' : 'Receive'} ${whole(o.funds)} Funds; price ×${o.factorAfter.toFixed(2)} after`}
      onClick={() => trade(o)}
      className={`flex flex-col items-center rounded border px-1.5 py-1 disabled:opacity-35 ${buy ? 'border-emerald-700 hover:border-emerald-500' : 'border-orange-700 hover:border-orange-500'}`}
    >
      <span className="text-[11px] text-slate-100">{o.label}</span>
      <span className="text-[10px] tabular-nums text-slate-400">
        {o.label.endsWith('max') ? `${whole(Math.abs(o.amount))} · ` : ''}
        {buy ? '−' : '+'}
        {whole(o.funds)}
      </span>
    </button>
  );
  return (
    <div className="grid grid-cols-3 gap-1 sm:grid-cols-6">
      {options.buy.map((o) => button(o, true))}
      {options.sell.map((o) => button(o, false))}
    </div>
  );
}
