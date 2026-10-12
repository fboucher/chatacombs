/**
 * Procedural dungeon generator for Chatacombs.
 * Pure generation code: deterministic given a seed/rng and theme.
 */

import { rollDie } from './dice.js';

/**
 * Built-in monster rosters per theme.
 */
const THEME_MONSTERS = {
  'classic fantasy': {
    minions: ['Goblin Raider', 'Skeleton Archer', 'Giant Spider', 'Orc Grunt', 'Hobgoblin Sentry', 'Cave Troll'],
    bosses: ['Ancient Red Dragon', 'Dungeon Archlich', 'Chasm Behemoth', 'Demon Lord']
  },
  'haunted house': {
    minions: ['Creeping Shadow', 'Poltergeist', 'Possessed Marionette', 'Phantom Hound', 'Wailing Spectre', 'Cursed Armor'],
    bosses: ['The Headless Lord', 'Dread Banshee Matron', 'Vengeful Poltergeist King']
  },
  'pirate ship': {
    minions: ['Scurvy Deckhand', 'Ghost Buccaneer', 'Barnacle Golem', 'Vicious Seagull Swarm', 'Cursed Gunner'],
    bosses: ['Captain Davy Jones', 'Abyssal Kraken Tentacle', 'Ghost Galleon Admiral']
  },
  'legacy codebase': {
    minions: ['Spaghetti Routine', 'Merge Conflict', 'Memory Leak', 'Uncaught NullPointer', 'Unpinned Dependency'],
    bosses: ['The Monolithic Technical Debt', 'The Ancient Production Outage', 'The Unrefactored Legacy Core']
  },
  'sky castle': {
    minions: ['Cloud Gryphon', 'Storm Harpy', 'Gale Elemental', 'Thunder Knight', 'Skiff Marauder'],
    bosses: ['Tempest Emperor', 'Celestial Archon', 'Thunderbird Sovereign']
  }
};

/**
 * Fallback monster table for custom/unrecognized themes.
 */
const DEFAULT_MONSTERS = {
  minions: ['Dungeon Creeper', 'Shadow Beast', 'Iron Sentry', 'Feral Hound', 'Crypt Lurker'],
  bosses: ['The Dungeon Overlord', 'Ancient Arch-Fiend', 'Abyssal Titan']
};

/**
 * Direction names for room exits.
 */
const DIRECTIONS = ['north', 'east', 'south', 'west', 'stairs up', 'stairs down', 'trapdoor', 'archway', 'tunnel'];

/**
 * Generates a valid dungeon graph of 10 to 15 rooms.
 * 
 * Invariants:
 * 1. Room 1 is always 'entrance' (depth 0).
 * 2. Room N is always 'boss' (max depth).
 * 3. Every non-boss room has a path that reaches the boss room.
 * 4. Room types: 'entrance', 'empty', 'trap', 'treasure', 'monster', 'boss'.
 * 
 * @param {object} [options={}]
 * @param {string} [options.theme='classic fantasy']
 * @param {number} [options.roomCount] Optional fixed room count (between 10 and 15)
 * @param {() => number} [options.rng=Math.random]
 * @returns {object} { theme, totalRooms, entranceId, bossId, rooms: Map<number, object> | object[] }
 */
export function generateDungeon({
  theme = 'classic fantasy',
  roomCount = null,
  rng = Math.random
} = {}) {
  const normTheme = theme.toLowerCase().trim();
  const themeData = THEME_MONSTERS[normTheme] || DEFAULT_MONSTERS;

  // Total rooms: 10 to 15
  let totalRooms = roomCount;
  if (!totalRooms || totalRooms < 10 || totalRooms > 15) {
    totalRooms = 10 + Math.floor(rng() * 6); // 10..15
  }

  // Determine depths: entrance is depth 0, boss is max depth (depthLevels - 1)
  // Divide intermediate rooms across depth levels
  const depthLevels = Math.min(6, Math.max(4, Math.floor(totalRooms / 2.2)));
  const roomsByDepth = Array.from({ length: depthLevels }, () => []);

  // Room 1: Entrance at depth 0
  const rooms = [];
  const entrance = {
    id: 1,
    roomNumber: 1,
    type: 'entrance',
    depth: 0,
    name: 'Dungeon Entrance',
    exits: [],
    monster: null,
    exploration: {
      searched: false,
      hasLoot: false,
      loot: null,
      hasTrap: false,
      trap: null,
      secretExit: null
    }
  };
  rooms.push(entrance);
  roomsByDepth[0].push(entrance);

  // Distribute intermediate rooms (2 to totalRooms - 1) across depths 1 to depthLevels - 2
  const intermediateCount = totalRooms - 2;
  const availableDepths = depthLevels - 2;
  for (let i = 0; i < intermediateCount; i++) {
    const depth = 1 + (i % availableDepths);
    const roomNumber = i + 2;
    const room = {
      id: roomNumber,
      roomNumber,
      type: 'empty', // assigned below
      depth,
      name: `Chamber ${roomNumber}`,
      exits: [],
      monster: null,
      exploration: {
        searched: false,
        hasLoot: false,
        loot: null,
        hasTrap: false,
        trap: null,
        secretExit: null
      }
    };
    rooms.push(room);
    roomsByDepth[depth].push(room);
  }

  // Final Room: Boss at depth depthLevels - 1
  const bossRoom = {
    id: totalRooms,
    roomNumber: totalRooms,
    type: 'boss',
    depth: depthLevels - 1,
    name: 'Boss Sanctum',
    exits: [],
    monster: null,
    exploration: {
      searched: false,
      hasLoot: false,
      loot: null,
      hasTrap: false,
      trap: null,
      secretExit: null
    }
  };
  rooms.push(bossRoom);
  roomsByDepth[depthLevels - 1].push(bossRoom);

  // Assign Room Types to intermediate rooms
  // Ensure diversity: at least one monster, treasure, trap, empty
  const intermediateRooms = rooms.slice(1, totalRooms - 1);
  const typePool = ['monster', 'treasure', 'trap', 'empty'];
  
  // Shuffle intermediate rooms to randomize distribution
  const shuffledIndices = intermediateRooms.map((_, idx) => idx).sort(() => rng() - 0.5);
  
  // Guarantee each type appears at least once
  for (let i = 0; i < typePool.length && i < shuffledIndices.length; i++) {
    intermediateRooms[shuffledIndices[i]].type = typePool[i];
  }

  // Fill remaining intermediate rooms with weighted probabilities:
  // 40% monster, 20% treasure, 20% trap, 20% empty
  for (let i = typePool.length; i < shuffledIndices.length; i++) {
    const r = rng();
    if (r < 0.40) intermediateRooms[shuffledIndices[i]].type = 'monster';
    else if (r < 0.60) intermediateRooms[shuffledIndices[i]].type = 'treasure';
    else if (r < 0.80) intermediateRooms[shuffledIndices[i]].type = 'trap';
    else intermediateRooms[shuffledIndices[i]].type = 'empty';
  }

  // Populate Monsters and Loot for each room
  for (const room of rooms) {
    if (room.type === 'monster') {
      const minionName = themeData.minions[Math.floor(rng() * themeData.minions.length)];
      // Scale with depth (depth 1..depthLevels-2)
      const depthFactor = room.depth;
      const hp = 15 + depthFactor * 8 + Math.floor(rng() * 6);
      const attack = 2 + Math.floor(depthFactor * 1.2);
      const defense = 10 + Math.floor(depthFactor * 0.8);
      const xp = 25 + depthFactor * 20;
      const gold = 10 + depthFactor * 15 + Math.floor(rng() * 10);

      room.monster = {
        name: minionName,
        hp,
        maxHp: hp,
        attack,
        defense,
        xp,
        gold,
        loot: rng() > 0.5 ? 'potion' : null
      };
    } else if (room.type === 'boss') {
      const bossName = themeData.bosses[Math.floor(rng() * themeData.bosses.length)];
      const hp = 80 + Math.floor(rng() * 25); // 80..105 HP
      const attack = 7 + Math.floor(rng() * 3);
      const defense = 14 + Math.floor(rng() * 2);
      const xp = 250;
      const gold = 150 + Math.floor(rng() * 50);

      room.monster = {
        name: bossName,
        hp,
        maxHp: hp,
        attack,
        defense,
        xp,
        gold,
        loot: 'legendary_relic'
      };
    } else if (room.type === 'treasure') {
      const gold = 20 + room.depth * 15 + Math.floor(rng() * 20);
      room.exploration.hasLoot = true;
      room.exploration.loot = {
        gold,
        item: rng() > 0.4 ? 'potion' : 'greater_potion'
      };
    } else if (room.type === 'trap') {
      room.exploration.hasTrap = true;
      room.exploration.trap = {
        name: ['Poison Darts', 'Spiked Pit', 'Falling Rubble', 'Arcane Sigil'][Math.floor(rng() * 4)],
        dc: 11 + Math.floor(room.depth * 0.5),
        damage: 4 + room.depth * 2
      };
    } else if (room.type === 'empty') {
      // 30% chance of small hidden pouch
      if (rng() < 0.3) {
        room.exploration.hasLoot = true;
        room.exploration.loot = {
          gold: 5 + Math.floor(rng() * 10),
          item: null
        };
      }
    }
  }

  // Connect Rooms to form a guaranteed forward-reachable graph to Boss
  // Every room at depth D must connect forward to at least one room at depth D+1
  const usedDirectionsByRoom = new Map();
  function getNextDirection(fromRoomId) {
    let used = usedDirectionsByRoom.get(fromRoomId);
    if (!used) {
      used = new Set();
      usedDirectionsByRoom.set(fromRoomId, used);
    }
    for (const dir of DIRECTIONS) {
      if (!used.has(dir)) {
        used.add(dir);
        return dir;
      }
    }
    // Fallback if all standard directions used
    const fallback = `passage ${used.size + 1}`;
    used.add(fallback);
    return fallback;
  }

  // 1. Forward backbone: connect every room at depth D to depth D+1
  for (let d = 0; d < depthLevels - 1; d++) {
    const currentLayer = roomsByDepth[d];
    const nextLayer = roomsByDepth[d + 1];

    // Ensure every room in currentLayer has at least one forward exit to nextLayer
    for (let i = 0; i < currentLayer.length; i++) {
      const fromRoom = currentLayer[i];
      // Target at least one room in nextLayer
      const targetRoom = nextLayer[i % nextLayer.length];
      const dir = getNextDirection(fromRoom.id);
      fromRoom.exits.push({
        direction: dir,
        targetRoomId: targetRoom.id
      });
    }

    // Ensure every room in nextLayer is targeted by at least one room in currentLayer
    for (const toRoom of nextLayer) {
      const alreadyTargeted = currentLayer.some(r => r.exits.some(e => e.targetRoomId === toRoom.id));
      if (!alreadyTargeted) {
        const fromRoom = currentLayer[Math.floor(rng() * currentLayer.length)];
        const dir = getNextDirection(fromRoom.id);
        fromRoom.exits.push({
          direction: dir,
          targetRoomId: toRoom.id
        });
      }
    }

    // Optional cross-links / alternate branching if currentLayer has multiple rooms
    if (currentLayer.length > 1 && nextLayer.length > 1) {
      for (const fromRoom of currentLayer) {
        if (rng() > 0.5 && fromRoom.exits.length < 3) {
          const alternateTarget = nextLayer.find(r => !fromRoom.exits.some(e => e.targetRoomId === r.id));
          if (alternateTarget) {
            fromRoom.exits.push({
              direction: getNextDirection(fromRoom.id),
              targetRoomId: alternateTarget.id
            });
          }
        }
      }
    }
  }

  return {
    theme: normTheme,
    totalRooms,
    entranceId: entrance.id,
    bossId: bossRoom.id,
    rooms
  };
}

/**
 * Validates graph reachability: checks if targetId is reachable from startId via exits.
 * @param {Array<object>} rooms 
 * @param {number} startId 
 * @param {number} targetId 
 * @returns {boolean}
 */
export function canReach(rooms, startId, targetId) {
  const roomMap = new Map(rooms.map(r => [r.id, r]));
  const visited = new Set();
  const queue = [startId];

  while (queue.length > 0) {
    const currentId = queue.shift();
    if (currentId === targetId) return true;
    if (visited.has(currentId)) continue;
    visited.add(currentId);

    const room = roomMap.get(currentId);
    if (!room) continue;

    for (const exit of room.exits) {
      if (!visited.has(exit.targetRoomId)) {
        queue.push(exit.targetRoomId);
      }
    }
  }

  return false;
}
