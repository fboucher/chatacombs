/**
 * Builds the JSON-safe snapshot the OBS overlay renders.
 * The raw engine state holds Maps, resolver instances and future rooms; the overlay
 * only gets what it shows on screen, so it can never leak spoilers or crash on
 * non-serializable values.
 */

/**
 * Summarizes the currently open vote/round window, if any.
 * @param {object} state Engine snapshot from `engine.getState()`
 * @returns {{ kind: string, label: string, remainingMs: number, durationMs: number, tallies?: Array<{ choice: string, votes: number }> } | null}
 */
export function buildTimerView(state) {
  if (state.status === 'voting' && state.themeVote) {
    const vote = state.themeVote;
    return {
      kind: 'theme_vote',
      label: 'Theme vote',
      remainingMs: Math.max(0, vote.durationMs - vote.elapsedMs),
      durationMs: vote.durationMs,
      tallies: tallyVotes(vote.votes, vote.choices.map((_, i) => i)).map(t => ({
        choice: vote.choices[t.choice],
        votes: t.votes
      }))
    };
  }

  if (state.status === 'active' && state.combat && state.currentRoom?.monster) {
    const combat = state.combat;
    return {
      kind: 'combat_round',
      label: `Round ${combat.round}`,
      remainingMs: Math.max(0, combat.roundDurationMs - combat.elapsedMs),
      durationMs: combat.roundDurationMs
    };
  }

  if (state.status === 'active' && state.exitVote) {
    const vote = state.exitVote;
    return {
      kind: 'exit_vote',
      label: 'Exit vote',
      remainingMs: Math.max(0, vote.durationMs - vote.elapsedMs),
      durationMs: vote.durationMs,
      tallies: tallyVotes(vote.votes, vote.voteOrder || [])
    };
  }

  return null;
}

/**
 * Counts votes per choice, keeping the given order for choices.
 * @param {Map<string, any>} votes
 * @param {Array<any>} order
 * @returns {Array<{ choice: any, votes: number }>}
 */
function tallyVotes(votes, order) {
  const counts = new Map(order.map(choice => [choice, 0]));
  if (votes) {
    for (const choice of votes.values()) {
      counts.set(choice, (counts.get(choice) || 0) + 1);
    }
  }
  return [...counts.entries()].map(([choice, count]) => ({ choice, votes: count }));
}

/**
 * Builds the overlay snapshot.
 * @param {object} state Engine snapshot from `engine.getState()`
 * @param {Array<object>} activeParty Members inside the 15-minute party window
 * @returns {object}
 */
export function buildOverlayView(state, activeParty = []) {
  const room = state.currentRoom || null;
  const dungeon = state.dungeon || null;

  const party = activeParty.map(m => ({
    username: m.username,
    displayName: m.displayName || m.username,
    hp: m.hp,
    maxHp: m.maxHp,
    isKnockedOut: Boolean(m.isKnockedOut || m.hp <= 0)
  }));

  const monster = room?.monster || null;

  return {
    status: state.status,
    theme: state.theme || null,
    currentRoom: room ? {
      roomNumber: room.roomNumber,
      type: room.type,
      name: room.name,
      cleared: Boolean(room.cleared),
      searched: Boolean(room.exploration?.searched)
    } : null,
    progress: {
      roomNumber: room ? room.roomNumber : 0,
      totalRooms: dungeon ? dungeon.totalRooms : 0
    },
    encounter: monster ? {
      name: monster.name,
      hp: monster.hp,
      maxHp: monster.maxHp,
      isBoss: room.type === 'boss',
      defeated: monster.hp <= 0
    } : null,
    party,
    partyCount: party.length,
    koCount: party.filter(m => m.isKnockedOut).length,
    timer: buildTimerView(state),
    outcome: state.outcomeSnapshot || null
  };
}
