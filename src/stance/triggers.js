import { resolveClock } from '../clock.js';

const TEASE_KINDS = ['body.hurt', 'body.ground_lost', 'body.knocked'];
const SLEEP_LABELS = new Set(['survival:sleep', 'survival:place_bed']);
const WINDOW_MS = 600_000;

function sameUuid(value, expected) {
  return typeof value === 'string' && value.toLowerCase() === expected?.toLowerCase();
}

// T28 §1: deterministic conflict detectors. Each poll reads eventlog windows
// plus the latest survival snapshot and returns every trigger whose condition
// currently holds. Per-kind cooldown and single-decision gating live in the
// engine (index.js), not here — a trigger returned twice just means the
// conflict is still present.
//
// Returned shape: { kind, at, detail, continuous, consumeId? }
//   at          — engine-clock timestamp used for "new evidence" refires;
//   continuous  — true for standing conditions (re-fire after cooldown just
//                 refreshes the stance); false for event-count triggers that
//                 need a fresh event since the last decision;
//   consumeId   — items_taken only: rows at/below this id are marked handled.
export function createTriggers({ eventlog, ownerUuid, body, clock = {} } = {}) {
  const now = resolveClock(clock).now;
  const q = (kind, since, limit = 1_000) => {
    try { return eventlog?.query?.({ kind, since, limit }) ?? []; } catch { return []; }
  };
  const byOwner = row => row?.payload?.by === 'owner';

  // An owner chat at/after `ts` (eventlog clock, same base as the engine's now).
  const ownerChatAfter = ts => q('chat', ts)
    .some(row => row.payload?.from_owner === true || sameUuid(row.payload?.uuid, ownerUuid));

  // items_taken evidence is consumed once per decision; anything logged before
  // the engine existed is history, not a fresh conflict.
  const takenRows = at => [
    ...q('body.items_taken', at - WINDOW_MS).filter(byOwner),
    ...q('goal.end', at - WINDOW_MS).filter(row => row?.payload?.reason === 'items_taken'),
  ].sort((a, b) => a.id - b.id);
  const itemsCursor = { value: takenRows(now()).reduce((max, row) => Math.max(max, row.id ?? 0), 0) };

  // Accumulator for the night_pressure "90 s cannot sleep" path: counts only
  // while she is night-awake, sheltered and not busy with an owner task.
  let awakeNightSince = null;

  function poll(at, snapshot = null) {
    const fired = [];
    const disturbed = body?.state?.disturbed?.() === true;

    // owner_tease: >=2 owner-attributed disturbances inside 120 s.
    const tease = TEASE_KINDS.flatMap(kind => q(kind, at - 120_000)).filter(byOwner);
    if (tease.length >= 2) {
      const latest = tease.reduce((m, row) => Math.max(m, row.ts), 0);
      fired.push({ kind: 'owner_tease', at: latest,
        detail: { count: tease.length, disturbed } });
    }

    // items_taken: new owner takes (drops/furnace) or a goal that ended that way.
    const taken = takenRows(at).filter(row => row.id > itemsCursor.value);
    if (taken.length) {
      const last = taken.at(-1);
      fired.push({ kind: 'items_taken', at: last.ts, consumeId: last.id,
        detail: { count: taken.length, item: last.payload?.item ?? null, disturbed } });
    }

    // goal_pressure: >=3 owner-goal suspensions inside 60 s.
    const susp = q('goal.suspended', at - 60_000);
    if (susp.length >= 3) {
      fired.push({ kind: 'goal_pressure', at: susp.at(-1).ts, detail: { count: susp.length } });
    }

    // night_pressure: night with a bed or hut and sleep keeps failing —
    // >=3 sleep/place_bed tasks preempted by fights inside 60 s, or 90 s awake.
    const sheltered = Boolean(snapshot && (snapshot.bedNearby || snapshot.hut
      || snapshot.bedItem || snapshot.bedSpot));
    if (snapshot?.isNight && !snapshot.isSleeping && sheltered) {
      const interrupted = q('arbiter.preempt', at - 60_000)
        .filter(row => SLEEP_LABELS.has(row.payload?.label)
          && row.payload?.by_label === 'survival:fight').length;
      if (snapshot.arbiter?.source === 'owner') {
        // Working on his orders is not "cannot sleep".
        awakeNightSince = null;
      } else {
        awakeNightSince ??= at;
        const awakeMs = at - awakeNightSince;
        if (interrupted >= 3 || awakeMs >= 90_000) {
          fired.push({ kind: 'night_pressure', at, continuous: true,
            detail: { interrupted, awakeMs } });
        }
      }
    } else {
      awakeNightSince = null;
    }

    // owner_far_danger: she is hurt and he is too far to help.
    if (snapshot && Number.isFinite(snapshot.health) && snapshot.health <= 10
        && Number.isFinite(snapshot.ownerDistance) && snapshot.ownerDistance > 24) {
      fired.push({ kind: 'owner_far_danger', at, continuous: true,
        detail: { health: snapshot.health, ownerDistance: snapshot.ownerDistance } });
    }

    // trapped_artificial: a man-made enclosure still reported >=20 s after the
    // first sighting, with no body.freed since. The "still reporting" check
    // keeps a one-shot suffocation log from becoming a permanent trigger.
    const freedAt = q('body.freed', at - WINDOW_MS).at(-1)?.ts ?? -Infinity;
    const traps = q('body.trapped', at - WINDOW_MS)
      .filter(row => row.payload?.kind === 'artificial' && row.ts > freedAt);
    const firstTrap = traps[0];
    const lastTrap = traps.at(-1);
    if (firstTrap && at - firstTrap.ts >= 20_000 && at - lastTrap.ts <= 5_000) {
      fired.push({ kind: 'trapped_artificial', at, continuous: true,
        detail: { forMs: at - firstTrap.ts } });
    }

    return fired;
  }

  return {
    poll,
    ownerChatAfter,
    consumed(trigger) {
      if (trigger?.kind === 'items_taken' && Number.isSafeInteger(trigger.consumeId)) {
        itemsCursor.value = Math.max(itemsCursor.value, trigger.consumeId);
      }
    },
  };
}
