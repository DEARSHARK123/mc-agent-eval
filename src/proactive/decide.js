export const PROACTIVE_PRIMITIVES = Object.freeze(['goToEntity', 'collectDrops']);

// Pure decision: the snapshot is assembled by index.js; nothing here touches the bot.
export function decideProactive(s, c = {}) {
  const followDistance = c.followDistance ?? 6;
  // T28: a stance may widen (keep_distance) or tighten (stay_with_owner) both
  // the trigger distance and the approach range; default behaviour unchanged.
  const followRange = c.followRange ?? 3;
  const pickupRadius = c.pickupRadius ?? 8;
  const idleProposalMs = c.idleProposalMs ?? 180_000;
  const proposalCooldownMs = c.proposalCooldownMs ?? 600_000;
  const last = s.last ?? {};
  const at = kind => last[kind] ?? -Infinity;

  if (s.isSleeping) return null;

  const owner = s.owner;
  if (owner && owner.distance <= 32) {
    if (s.now - s.ownerHurtAt <= 3_000
        && (owner.health == null || owner.health <= 14)
        && s.now - at('owner_hurt') >= 60_000) {
      return { kind: 'remark', reason: 'owner_hurt', health: owner.health ?? null };
    }
    if (s.nightfall) return { kind: 'remark', reason: 'nightfall', bed: s.bed ?? 'none' };
  }
  if (!s.idle) return null;

  const drops = (s.drops ?? []).filter(drop => drop.distance <= pickupRadius);
  if (drops.length
      && !drops.some(drop => drop.ownerDistance !== null && drop.ownerDistance <= 3)
      && s.freeSlots > 0
      && s.now - s.lastGiveAt > 15_000
      && s.now - at('pickup') >= 4_000) {
    return { kind: 'pickup', steps: [{ primitive: 'collectDrops', params: { radius: pickupRadius } }] };
  }

  if (owner && owner.distance > followDistance && owner.distance <= 64
      && s.now - at('stay_near') >= 2_000) {
    return { kind: 'stay_near', steps: [{ primitive: 'goToEntity', params: { uuid: owner.uuid, range: followRange } }] };
  }

  // keep_distance suspends proposals — after owner teasing she goes quiet.
  if (owner && owner.distance <= 8
      && s.proposal
      && s.suppressProposals !== true
      && (s.budget?.remaining ?? 0) >= (s.budget?.reserve ?? 1)
      && s.now - s.quietSince >= idleProposalMs
      && s.now - at('propose') >= proposalCooldownMs
      && !s.openQuestion) {
    return { kind: 'propose', item: s.proposal.item, count: s.proposal.count };
  }
  return null;
}
