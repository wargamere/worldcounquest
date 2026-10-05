import { VICTORY } from '@/next/game/balance';
import type { HudView } from '@/next/game/views';
import { pct, whole } from '../ui/format';

/** The race bar (§7): "You 41 · Russia 212 · 1,534", with you and the leading rival against the goal. */
export function VpRace({ hud, thin = false }: { hud: HudView; thin?: boolean }) {
  const goal = hud.goalVp > 0 ? hud.goalVp : 1;
  const you = Math.min(1, hud.vp / goal);
  const rival = hud.rival === null ? 0 : Math.min(1, hud.rival.vp / goal);
  const text = `You ${whole(hud.vp)}${hud.rival === null ? '' : ` · ${hud.rival.name} ${whole(hud.rival.vp)}`} · ${whole(hud.goalVp)}`;
  const bar = (
    <div className="relative h-1.5 w-full overflow-hidden rounded-full bg-slate-800" aria-hidden>
      {hud.rival !== null && <div className="absolute inset-y-0 left-0 opacity-70" style={{ width: `${rival * 100}%`, background: hud.rival.colour }} />}
      <div className="absolute inset-y-0 left-0 rounded-full" style={{ width: `${you * 100}%`, background: hud.colour }} />
    </div>
  );
  if (thin) {
    return (
      <div className="w-full" role="img" aria-label={`Victory points: ${text}`}>
        {bar}
      </div>
    );
  }
  return (
    <div className="flex min-w-[10rem] flex-col gap-0.5" title={`Hold ${whole(hud.goalVp)} VP, ${pct(VICTORY.VP_SHARE)} of the world, to win`}>
      <span className="truncate text-[11px] tabular-nums text-slate-300">{text}</span>
      {bar}
    </div>
  );
}
