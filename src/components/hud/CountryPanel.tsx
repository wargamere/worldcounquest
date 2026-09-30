'use client';

import { useState } from 'react';
import { DEVELOPMENT, ECONOMY } from '@/game/balance';
import { countryIncome, investmentCost, maxAffordableTroops, netIncome, recruitmentCost } from '@/game/economy';
import type { Contribution } from '@/game/actions';
import { attackPresets, countryRisk, previewAssault, previewAttack, supportOptions } from '@/game/orders';
import { isCapital } from '@/game/capitulation';
import type { CountryId, GameState } from '@/game/types';
import type { Flash } from '@/store/gameStore';
import { compact, pct, signed } from '../ui/format';
import { RiskBadge } from '../ui/RiskBadge';
import { CapitalNote } from './CapitalNote';
import { OrderForm } from './OrderForm';

interface CountryPanelProps {
  game: GameState;
  countryId: CountryId;
  targetId: CountryId | null;
  suggestedTroops: number | null;
  suggestedSupport: Contribution[] | null;
  flash: Flash | null;
  onInvest: (id: CountryId) => void;
  onRecruit: (id: CountryId, troops: number) => void;
  onAttack: (troops: number, support: Contribution[]) => void;
  onMove: (troops: number) => void;
  onOrder: (sourceId: CountryId, targetId: CountryId, troops?: number, support?: Contribution[]) => void;
  onCancelOrder: () => void;
  onJoiningChange: (ids: CountryId[]) => void;
  onShowNation: (nationId: string) => void;
  onClose: () => void;
}

const FLASH_STYLE: Record<Flash['tone'], string> = {
  good: 'border-emerald-800 bg-emerald-950/60 text-emerald-100',
  bad: 'border-rose-800 bg-rose-950/60 text-rose-100',
  info: 'border-slate-700 bg-slate-900 text-slate-200',
};

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded bg-slate-900/70 px-2 py-1">
      <div className="text-[10px] uppercase tracking-wider text-slate-500">{label}</div>
      <div className="text-sm font-semibold tabular-nums text-slate-100">{value}</div>
    </div>
  );
}

export function CountryPanel(props: CountryPanelProps) {
  const { game, countryId, targetId } = props;
  const country = game.countries[countryId];
  if (!country) return null;

  const mine = country.ownerId === game.playerId;
  const owner = game.nations[country.ownerId];
  const ownerCountries = Object.values(game.countries).filter((c) => c.ownerId === country.ownerId).length;

  return (
    <aside className="flex flex-col gap-2.5 p-3" aria-label={`${country.name} details`}>
      <header className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 className="truncate text-base font-semibold text-slate-50">{country.name}</h2>
          <button
            type="button"
            onClick={() => props.onShowNation(country.ownerId)}
            className="flex items-center gap-1.5 text-xs text-slate-400 hover:text-slate-200"
            title="Show this nation on the map"
          >
            <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: owner?.colour }} />
            {mine ? (isCapital(game, countryId) ? '★ Your capital' : 'Your territory') : owner?.name}
            <span className="text-slate-600">· {ownerCountries} {ownerCountries === 1 ? 'country' : 'countries'}</span>
          </button>
        </div>
        <button type="button" onClick={props.onClose} className="text-slate-500 hover:text-slate-200" aria-label="Close panel">
          ✕
        </button>
      </header>

      {props.flash && (
        <p role="status" className={`rounded border px-2 py-1.5 text-xs ${FLASH_STYLE[props.flash.tone]}`}>
          {props.flash.text}
        </p>
      )}

      {!targetId && !mine && <CapitalNote game={game} countryId={countryId} />}

      <div className="grid grid-cols-3 gap-1">
        <Stat label="Troops" value={compact(country.troops)} />
        <Stat label="Develop." value={`${country.development}/${DEVELOPMENT.MAX_LEVEL}`} />
        <Stat label="Income" value={countryIncome(country).toFixed(1)} />
        <Stat label="Tier" value={`${country.economyTier}`} />
        <Stat label="People" value={compact(country.population)} />
        <Stat label="Status" value={country.hasMoved ? 'Acted' : 'Ready'} />
      </div>

      {targetId && mine ? (
        <OrderForm
          key={`${countryId}-${targetId}-${props.suggestedTroops ?? ''}`}
          game={game}
          sourceId={countryId}
          targetId={targetId}
          suggestedTroops={props.suggestedTroops}
          suggestedSupport={props.suggestedSupport}
          onAttack={props.onAttack}
          onMove={props.onMove}
          onCancel={props.onCancelOrder}
          onJoiningChange={props.onJoiningChange}
        />
      ) : mine ? (
        <OwnCountryActions {...props} />
      ) : (
        <ForeignCountryActions {...props} />
      )}
    </aside>
  );
}

function OwnCountryActions({ game, countryId, onInvest, onRecruit }: CountryPanelProps) {
  const country = game.countries[countryId];
  const nation = game.nations[game.playerId];
  const [recruitCount, setRecruitCount] = useState(10);
  if (!country || !nation) return null;

  const risk = countryRisk(game, countryId);
  const threatName = risk.worst ? game.countries[risk.worst.fromId]?.name : undefined;
  const affordable = maxAffordableTroops(game, game.playerId);
  const maxed = country.development >= DEVELOPMENT.MAX_LEVEL;
  const cost = investmentCost(country.development);
  const gain = maxed ? 0 : countryIncome({ ...country, development: country.development + 1 }) - countryIncome(country);
  const payback = gain > 0 ? Math.ceil(cost / gain) : null;
  const wanted = Math.max(1, Math.min(recruitCount, Math.max(1, affordable)));
  const price = recruitmentCost(wanted);
  const netAfter = netIncome(game, game.playerId) - wanted * ECONOMY.TROOP_UPKEEP;

  return (
    <div className="flex flex-col gap-2.5">
      <RiskBadge
        chance={risk.chance}
        label={risk.chance > 0.005 && threatName ? `Falls next turn · worst: ${threatName}` : 'Falls next turn'}
      />

      <section className="flex flex-col gap-1.5">
        <h3 className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">Develop</h3>
        <button
          type="button"
          disabled={maxed || nation.treasury < cost}
          onClick={() => onInvest(countryId)}
          className="rounded bg-sky-700 px-3 py-2 text-left text-sm font-semibold text-white transition hover:bg-sky-600 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {maxed ? 'Fully developed' : (
            <span className="flex items-baseline justify-between gap-2">
              <span>Invest — {compact(cost)}</span>
              <span className="text-[11px] font-normal text-sky-100">
                +{gain.toFixed(1)}/turn{payback !== null && ` · pays back in ${payback}`}
              </span>
            </span>
          )}
        </button>
        {!maxed && <p className="text-[10px] text-slate-500">Also adds 10% combat strength here, in attack and defence.</p>}
      </section>

      <section className="flex flex-col gap-1.5">
        <h3 className="flex items-baseline justify-between text-[10px] font-semibold uppercase tracking-wider text-slate-400">
          Recruit <span className="normal-case tracking-normal text-slate-500">affordable now: {affordable}</span>
        </h3>
        <div className="flex gap-1">
          {[10, 25, 50].map((n) => (
            <button
              key={n}
              type="button"
              onClick={() => setRecruitCount(n)}
              className={`flex-1 rounded border px-2 py-1 text-xs tabular-nums ${recruitCount === n ? 'border-emerald-500 bg-emerald-500/10 text-emerald-100' : 'border-slate-700 text-slate-300 hover:border-slate-500'}`}
            >
              {n}
            </button>
          ))}
          <button
            type="button"
            disabled={affordable < 1}
            onClick={() => setRecruitCount(affordable)}
            className={`flex-1 rounded border px-2 py-1 text-xs ${recruitCount === affordable ? 'border-emerald-500 bg-emerald-500/10 text-emerald-100' : 'border-slate-700 text-slate-300 hover:border-slate-500'} disabled:opacity-40`}
          >
            Max
          </button>
        </div>
        <button
          type="button"
          disabled={affordable < 1}
          onClick={() => onRecruit(countryId, wanted)}
          className="rounded bg-emerald-700 px-3 py-2 text-left text-sm font-semibold text-white transition hover:bg-emerald-600 disabled:cursor-not-allowed disabled:opacity-40"
        >
          <span className="flex items-baseline justify-between gap-2">
            <span>Recruit {wanted}</span>
            <span className="text-[11px] font-normal text-emerald-100">
              {price.money} gold · {compact(price.manpower)} men · −{(wanted * ECONOMY.TROOP_UPKEEP).toFixed(1)}/turn
            </span>
          </span>
        </button>
        <p className={`text-[10px] ${netAfter < 0 ? 'text-rose-300' : 'text-slate-500'}`}>
          Net income after: {signed(netAfter)}/turn
          {netAfter < 0 && ' — the treasury will drain, and troops desert when it is empty'}
        </p>
      </section>

      <p className="rounded border border-dashed border-slate-700 px-2 py-1.5 text-[11px] text-slate-400">
        {country.hasMoved
          ? 'This garrison has already moved or attacked this turn.'
          : <>Click a <span className="text-rose-300">red-outlined</span> neighbour to attack it, or a <span className="text-sky-300">blue-outlined</span> one of yours to move troops.</>}
      </p>
    </div>
  );
}

function ForeignCountryActions({ game, countryId, onOrder }: CountryPanelProps) {
  const sources = (game.adjacency[countryId] ?? [])
    .map((id) => game.countries[id])
    .filter((c): c is NonNullable<typeof c> => c !== undefined && c.ownerId === game.playerId)
    .map((c) => {
      const presets = attackPresets(game, c.id, countryId);
      const troops = presets.likely ?? presets.all;
      const chance = troops > 0 ? previewAttack(game, c.id, countryId, troops)?.winChance ?? 0 : 0;
      return { country: c, troops, chance };
    })
    .sort((a, b) => b.chance - a.chance);

  if (sources.length === 0) {
    return <p className="text-xs text-slate-500">None of your countries border this one.</p>;
  }

  // Every bordering country that can still act, each sending what it can spare.
  const lead = sources.find((s) => !s.country.hasMoved);
  const helpers = lead ? supportOptions(game, countryId, lead.country.id).filter((h) => h.spare > 0) : [];
  const leadSpare = lead ? attackPresets(game, lead.country.id, countryId).spare : 0;
  const combined =
    lead && helpers.length > 0 && leadSpare > 0
      ? {
          troops: leadSpare,
          support: helpers.map((h) => ({ fromId: h.fromId, troops: h.spare })),
          chance:
            previewAssault(game, countryId, [
              { fromId: lead.country.id, troops: leadSpare },
              ...helpers.map((h) => ({ fromId: h.fromId, troops: h.spare })),
            ])?.winChance ?? 0,
        }
      : null;

  return (
    <section className="flex flex-col gap-1.5">
      <h3 className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">Attack from</h3>
      {sources.map(({ country, troops, chance }) => (
        <button
          key={country.id}
          type="button"
          disabled={country.hasMoved || troops < 1}
          onClick={() => onOrder(country.id, countryId)}
          className="flex items-center justify-between gap-2 rounded border border-slate-700 px-2 py-1.5 text-left text-xs transition hover:border-rose-600 disabled:cursor-not-allowed disabled:opacity-40"
        >
          <span>
            <span className="font-medium text-slate-100">{country.name}</span>
            <span className="text-slate-500"> · {country.troops} troops{country.hasMoved && ' · acted'}</span>
          </span>
          <span className="tabular-nums text-slate-300">{pct(chance)} with {troops}</span>
        </button>
      ))}
      {combined && lead && (
        <button
          type="button"
          onClick={() => onOrder(lead.country.id, countryId, combined.troops, combined.support)}
          className="flex items-center justify-between gap-2 rounded border border-sky-800 bg-sky-950/30 px-2 py-1.5 text-left text-xs transition hover:border-sky-500"
        >
          <span>
            <span className="font-medium text-sky-100">Combined assault</span>
            <span className="text-slate-400"> · {combined.support.length + 1} countries, spare troops only</span>
          </span>
          <span className="tabular-nums text-slate-200">
            {pct(combined.chance)} with {combined.troops + combined.support.reduce((a, p) => a + p.troops, 0)}
          </span>
        </button>
      )}
    </section>
  );
}
