/**
 * RAGE MP server package: pathfinder-compare
 *
 * Install:
 *   1. Copy this folder to <server>/packages/pathfinder-compare/
 *   2. In <server>/packages/index.js add:
 *        require('./pathfinder-compare');
 *   3. Set PATHFINDER_URL below (pathfinder must be reachable from the game server)
 */

const http = require('http');
const https = require('https');

const PATHFINDER_URL = process.env.PATHFINDER_URL || 'http://127.0.0.1:3005/distance';

function requestPathfinder(from, to) {
  return new Promise((resolve, reject) => {
    const url = new URL(PATHFINDER_URL);
    const body = JSON.stringify({
      from,
      to,
      includePath: true,
    });
    const lib = url.protocol === 'https:' ? https : http;

    const req = lib.request(
      {
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
        timeout: 10000,
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            if (res.statusCode !== 200) {
              reject(new Error(parsed.error || `HTTP ${res.statusCode}`));
              return;
            }
            resolve(parsed);
          } catch (error) {
            reject(new Error(`Invalid JSON: ${error.message}`));
          }
        });
      },
    );

    req.on('timeout', () => {
      req.destroy(new Error('Pathfinder request timeout'));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

mp.events.add('pathfinder:requestCompare', async (player, fromJson, toJson) => {
  try {
    const from = JSON.parse(fromJson);
    const to = JSON.parse(toJson);
    const service = await requestPathfinder(from, to);
    player.call('pathfinder:compareResult', [JSON.stringify({ service })]);
  } catch (error) {
    player.call('pathfinder:compareResult', [JSON.stringify({ error: error.message })]);
  }
});

mp.events.addCommand('pfcompare', (player) => {
  player.call('pathfinder:runCompare');
});

mp.events.addCommand('pfcoords', (player) => {
  player.call('pathfinder:printCoords');
});

mp.events.addCommand('pfshow', (player) => {
  player.call('pathfinder:togglePath', [true]);
});

mp.events.addCommand('pfhide', (player) => {
  player.call('pathfinder:togglePath', [false]);
});

console.log(`[pathfinder-compare] loaded, API: ${PATHFINDER_URL}`);
