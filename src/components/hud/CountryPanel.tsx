'use client';

import { useState } from 'react';
import { DEVELOPMENT, MANPOWER, RECRUITMENT } from '@/game/balance';
import { countryIncome, investmentCost, maxAffordableTroops } from '@/game/economy';
import { defaultCommitment } from '@/game/actions';
import type { CountryId, GameState } from '@/game/types';

interface CountryPanelProps {
  game: GameState;
  countryId: CountryId;
  stagingId: CountryId | null;
  message: string | null;
  onInvest: (id: CountryId) => void;
  onRecruit: (id: CountryId, troops: number) => void;
  onBeginOrder: (id: CountryId | null) => void;
  onMove: (from: CountryId, to: CountryId, troops: number) => void;
  onAttack: (from: CountryId, target: CountryId, troops: number) => void;
  onClose: () => void;
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between py-0.5 text-xs">
      <span className="text-slate-400">{label}</span>
      <span className="font-medium tabular-nums text-slate-100">{value}</span>
    </div>
  );
}

const button =
  'w-full rounded px-3 py-2 text-sm font-semibold transition disabled:cursor-not-allowed disabled:opacity-40';

export function CountryPanel(props: CountryPanelProps) {
  const { game, countryId, stagingId } = props;
  const country = game.countries[countryId];
  const [recruitCount, setRecruitCount] = useState(10);

  if (!country) return null;

  const nation = game.nations[game.playerId];
  const owner = game.nations[country.ownerId];
  const mine = country.ownerId === game.playerId;
  const staging = (stagingId ? game.countries[stagingId] : null) ?? null;
  const canOrderHere =
    staging !== null &&
    staging.id !== countryId &&
    (game.adjacency[staging.id] ?? []).includes(countryId);

  const cost = investmentCost(country.development);
  const affordableTroops = maxAffordableTroops(game, game.playerId);
  const maxedOut = country.development >= DEVELOPMENT.MAX_LEVEL;

  return (
    <aside className="flex flex-col gap-3 border-t border-slate-800 bg-slate-950/95 p-3 md:border-l md:border-t-0">
      <div className="flex items-start justify-between gap-2">
        <div>
          <h2 className="text-base font-semibold text-slate-50">{country.name}</h2>
          <p className="text-xs text-slate-400">
            {mine ? 'Yours' : (owner?.name ?? 'Unclaimed')}
          </p>
        </div>
        <button
          type="button"
          onClick={props.onClose}
          className="text-slate-500 hover:text-slate-200"
          aria-label="Close panel"
        >
          ✕
        </button>
      </div>

      <div className="rounded border border-slate-800 px-2 py-1.5">
        <Row label="Troops" value={`${country.troops}`} />
        <Row label="Development" value={`${country.development} / ${DEVELOPMENT.MAX_LEVEL}`} />
        <Row label="Economy tier" value={`${country.economyTier}`} />
        <Row label="Population" value={`${(country.population / 1_000_000).toFixed(1)}M`} />
        <Row label="Income" value={countryIncome(country).toFixed(1)} />
        {country.hasMoved && <Row label="Status" value="Already acted" />}
      </div>

      {props.message && (
        <p className="rounded border border-rose-900 bg-rose-950/60 px-2 py-1.5 text-xs text-rose-200">
          {props.message}
        </p>
      )}

      {mine ? (
        <div className="flex flex-col gap-2">
          <button
            type="button"
            className={`${button} bg-sky-600 text-white hover:bg-sky-500`}
            disabled={maxedOut || (nation?.treasury ?? 0) < cost}
            onClick={() => props.onInvest(countryId)}
          >
            {maxedOut ? 'Fully developed' : `Invest — ${cost}`}
          </button>

          <div className="flex gap-2">
            <input
              type="number"
              min={1}
              value={recruitCount}
              onChange={(event) => setRecruitCount(Math.max(1, Number(event.target.value) || 1))}
              className="w-20 rounded border border-slate-700 bg-slate-900 px-2 py-2 text-sm tabular-nums text-slate-100"
              aria-label="Troops to recruit"
            />
            <button
              type="button"
              className={`${button} bg-emerald-600 text-white hover:bg-emerald-500`}
              disabled={recruitCount > affordableTroops}
              onClick={() => props.onRecruit(countryId, recruitCount)}
            >
              Recruit — {recruitCount * RECRUITMENT.MONEY_PER_TROOP} +{' '}
              {((recruitCount * MANPOWER.COST_PER_TROOP) / 1000).toFixed(0)}k men
            </button>
          </div>
          <p className="-mt-1 text-[10px] text-slate-500">
            Affordable right now: {affordableTroops} troops
          </p>

          {stagingId === countryId ? (
            <button
              type="button"
              className={`${button} border border-sky-500 text-sky-300`}
              onClick={() => props.onBeginOrder(null)}
            >
              Cancel order — pick a target
            </button>
          ) : (
            <button
              type="button"
              className={`${button} border border-slate-700 text-slate-200 hover:border-slate-500`}
              disabled={country.hasMoved || country.troops < 1}
              onClick={() => props.onBeginOrder(countryId)}
            >
              {country.hasMoved ? 'Already acted this turn' : 'Move or attack from here'}
            </button>
          )}
        </div>
      ) : (
        <p className="text-xs text-slate-500">
          Select one of your countries and choose &ldquo;Move or attack&rdquo; to act against this
          territory.
        </p>
      )}

      {canOrderHere && staging && (
        <div className="flex flex-col gap-2 rounded border border-sky-800 bg-sky-950/40 p-2">
          <p className="text-xs text-sky-200">
            From <strong>{staging.name}</strong> ({staging.troops} troops)
          </p>
          {mine ? (
            <button
              type="button"
              className={`${button} bg-sky-600 text-white hover:bg-sky-500`}
              onClick={() => props.onMove(staging.id, countryId, staging.troops)}
            >
              Move all {staging.troops} here
            </button>
          ) : (
            <button
              type="button"
              className={`${button} bg-rose-600 text-white hover:bg-rose-500`}
              onClick={() =>
                props.onAttack(staging.id, countryId, defaultCommitment(staging.troops))
              }
            >
              Attack with {defaultCommitment(staging.troops)} troops
            </button>
          )}
        </div>
      )}
    </aside>
  );
}
