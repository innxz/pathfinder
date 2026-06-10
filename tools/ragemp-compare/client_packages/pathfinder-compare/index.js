/**
 * RAGE MP client package: pathfinder-compare
 *
 * Install:
 *   1. Copy this folder to <server>/client_packages/pathfinder-compare/
 *   2. In <server>/client_packages/index.js add:
 *        require('./pathfinder-compare');
 *
 * Commands (server-side, see packages/pathfinder-compare/index.js):
 *   /pfcoords   - print player + waypoint coordinates
 *   /pfcompare  - compare GTA route vs pathfinder service
 *   /pfshow     - draw service route in world (red lines)
 *   /pfhide     - hide drawn route
 */

const SAMPLE_STEP = 10.0;
const MAX_GPS_SAMPLES = 2000;
const GPS_SLOT_WAYPOINT = 0;
const WAYPOINT_BLIP = 8;

let servicePath = null;
let drawServicePath = false;
let lastComparison = null;

function vec3(v) {
  return { x: v.x + 0.0, y: v.y + 0.0, z: v.z + 0.0 };
}

function chat(msg) {
  mp.gui.chat.push(`!{#7bd389}[pathfinder]!{#ffffff} ${msg}`);
}

function getWaypointCoord() {
  const blip = mp.game.ui.getFirstBlipInfoId(WAYPOINT_BLIP);
  if (!mp.game.ui.doesBlipExist(blip)) {
    return null;
  }
  return mp.game.ui.getBlipInfoIdCoord(blip);
}

function ensureGpsRoute(to) {
  if (typeof mp.game.pathfind.generateDirectionsToCoord === 'function') {
    mp.game.pathfind.generateDirectionsToCoord(to.x, to.y, to.z, true, 0, 0, 0);
  }
}

function getPosAlongGpsRoute(startAtPlayer, distance, slot) {
  if (typeof mp.game.pathfind.getPosAlongGpsTypeRoute !== 'function') {
    return null;
  }

  try {
    const pos = mp.game.pathfind.getPosAlongGpsTypeRoute(
      startAtPlayer ? 1 : 0,
      distance + 0.0,
      slot | 0,
    );
    if (!pos) return null;
    return { x: pos.x + 0.0, y: pos.y + 0.0, z: pos.z + 0.0 };
  } catch (error) {
    return null;
  }
}

function sampleGpsRoute(maxDistance, to) {
  const points = [];
  let total = 0.0;
  let prev = null;
  const limit = Number.isFinite(maxDistance) && maxDistance > 0 ? maxDistance * 1.25 : Infinity;

  ensureGpsRoute(to);

  try {
    for (const startAtPlayer of [1, 0]) {
      points.length = 0;
      total = 0;
      prev = null;

      for (let i = 0; i < MAX_GPS_SAMPLES; i++) {
        const distance = i * SAMPLE_STEP;
        const pos = getPosAlongGpsRoute(startAtPlayer, distance, GPS_SLOT_WAYPOINT);
        if (
          !pos ||
          !Number.isFinite(pos.x) ||
          !Number.isFinite(pos.y) ||
          !Number.isFinite(pos.z) ||
          (pos.x === 0 && pos.y === 0 && pos.z === 0)
        ) {
          break;
        }

        if (prev) {
          const dx = pos.x - prev.x;
          const dy = pos.y - prev.y;
          const dz = pos.z - prev.z;
          const segment = Math.sqrt(dx * dx + dy * dy + dz * dz);
          if (!Number.isFinite(segment) || segment < 0.01) {
            break;
          }
          if (total + segment > limit) {
            break;
          }
          total += segment;
        }

        points.push(pos);
        prev = pos;
      }

      if (points.length > 1 && Number.isFinite(total)) {
        return { points, total, available: true };
      }
    }
  } catch (error) {
    mp.console.logWarning(`[pathfinder] GPS sample failed: ${error.message}`);
  }

  return { points, total, available: false };
}

function straightDistance(from, to) {
  return Math.hypot(from.x - to.x, from.y - to.y, from.z - to.z);
}

function printComparison(from, to, gtaNative, gpsSample, service) {
  const direct = straightDistance(from, to);
  const deltaNative = Math.abs(gtaNative - service.distance);
  const deltaNativePct = (deltaNative / Math.max(gtaNative, 1.0)) * 100.0;
  const deltaSample =
    gpsSample.available && gpsSample.total > 0
      ? Math.abs(gpsSample.total - service.distance)
      : null;

  lastComparison = {
    from,
    to,
    gtaNative,
    gpsSampleTotal: gpsSample.total,
    gpsSamplePoints: gpsSample.points.length,
    service,
  };

  chat('========== COMPARE ==========');
  chat(`FROM ${from.x.toFixed(2)}, ${from.y.toFixed(2)}, ${from.z.toFixed(2)}`);
  chat(`TO   ${to.x.toFixed(2)}, ${to.y.toFixed(2)}, ${to.z.toFixed(2)}`);
  chat(`Straight (map): ${direct.toFixed(2)} m`);
  chat(`GTA native:      ${gtaNative.toFixed(2)} m`);
  if (gpsSample.available) {
    chat(
      `GTA GPS sample:  ${gpsSample.total.toFixed(2)} m (${gpsSample.points.length} pts, step ${SAMPLE_STEP}m)`,
    );
  } else {
    chat('GTA GPS sample:  unavailable (waypoint route not sampled)');
  }
  chat(`Service:         ${service.distance.toFixed(2)} m (${service.pathNodes} nodes)`);
  chat(`Delta native:    ${deltaNative.toFixed(2)} m (${deltaNativePct.toFixed(1)}%)`);
  if (deltaSample !== null) {
    chat(`Delta GPS sample:${deltaSample.toFixed(2)} m`);
  }
  chat('Use /pfshow to draw service route in world');
  chat('=============================');

  mp.console.logInfo('[pathfinder] compare complete');
}

mp.events.add('pathfinder:printCoords', () => {
  const pos = mp.players.local.position;
  chat(`Player: {"x":${pos.x.toFixed(2)},"y":${pos.y.toFixed(2)},"z":${pos.z.toFixed(2)}}`);

  const waypoint = getWaypointCoord();
  if (waypoint) {
    chat(
      `Waypoint: {"x":${waypoint.x.toFixed(2)},"y":${waypoint.y.toFixed(2)},"z":${waypoint.z.toFixed(2)}}`,
    );
  } else {
    chat('Waypoint not set (press M and place marker)');
  }
});

mp.events.add('pathfinder:runCompare', () => {
  const from = vec3(mp.players.local.position);
  const toRaw = getWaypointCoord();

  if (!toRaw) {
    chat('Set a waypoint on the map first (M).');
    return;
  }

  const to = vec3(toRaw);

  const gtaNative = mp.game.pathfind.calculateTravelDistanceBetweenPoints(
    from.x,
    from.y,
    from.z,
    to.x,
    to.y,
    to.z,
  );

  if (!Number.isFinite(gtaNative) || gtaNative >= 99999.0) {
    chat('GTA native returned failure (100000). Path nodes may not be loaded here.');
    return;
  }

  const gpsSample = sampleGpsRoute(gtaNative, to);
  chat('Requesting pathfinder service...');
  mp.events.callRemote('pathfinder:requestCompare', JSON.stringify(from), JSON.stringify(to));
  mp.events.pathfinderPending = { from, to, gtaNative, gpsSample };
});

mp.events.add('pathfinder:compareResult', (payloadJson) => {
  let payload;
  try {
    payload = JSON.parse(payloadJson);
  } catch (error) {
    chat(`Bad response: ${error.message}`);
    return;
  }

  if (payload.error) {
    chat(`Service error: ${payload.error}`);
    chat('Check docker compose / PATHFINDER_URL on the server machine.');
    mp.events.pathfinderPending = null;
    return;
  }

  const pending = mp.events.pathfinderPending;
  if (!pending) {
    chat('Unexpected service response (no pending compare).');
    return;
  }

  const service = payload.service;
  if (!service || service.error) {
    chat(`Service error: ${service ? service.error : 'empty response'}`);
    mp.events.pathfinderPending = null;
    return;
  }

  servicePath = Array.isArray(service.path) ? service.path : null;
  printComparison(pending.from, pending.to, pending.gtaNative, pending.gpsSample, service);
  mp.events.pathfinderPending = null;
});

mp.events.add('pathfinder:togglePath', (enabled) => {
  drawServicePath = Boolean(enabled);
  if (drawServicePath && (!servicePath || servicePath.length < 2)) {
    chat('No service path yet. Run /pfcompare first.');
    drawServicePath = false;
    return;
  }
  chat(drawServicePath ? 'Service route visible (red lines)' : 'Service route hidden');
});

mp.events.add('render', () => {
  if (!drawServicePath || !servicePath || servicePath.length < 2) {
    return;
  }

  for (let i = 0; i < servicePath.length - 1; i++) {
    const a = servicePath[i];
    const b = servicePath[i + 1];
    mp.game.graphics.drawLine(
      a.x,
      a.y,
      a.z + 1.0,
      b.x,
      b.y,
      b.z + 1.0,
      255,
      60,
      60,
      220,
    );
  }
});
