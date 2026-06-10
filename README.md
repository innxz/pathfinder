# GTA Pathfinder

TypeScript microservice for **road distance** between two 3D points in GTA V.

The road graph is built from [DurtyFree/gta-v-data-dumps](https://github.com/DurtyFree/gta-v-data-dumps) (`nodes.zip`). Runtime has **zero production dependencies**; routing uses multi-anchor A*.

> Russian version: [README.ru.md](README.ru.md)

## Why this exists

This is not “yet another A* demo” — it is a **server-side road distance service for GTA V**, aimed at RAGE MP / FiveM and RP servers.

Native `calculateTravelDistanceBetweenPoints` runs inside the game process: awkward to call in bulk from a backend, hard to cache centrally, and unusable in Docker without an online player. Pathfinder exposes **one HTTP contract** for taxi, delivery, quests, anti-cheat, UI, and anything else on your server.

**Two different metrics in one response:**

| Field | Use case |
|---|---|
| `straightDistance` | 3D straight line — same as “Route waypoint (4181m)” on the GTA pause map |
| `distance` | **Road** route length — fares, timers, “how far to drive” |

**Where it helps:**

- server logic without a GTA client (billing, matchmaking, movement validation);
- a single source of truth for distances on a custom server;
- fast lookups with LRU cache and predictable latency.

**Honest limits:**

- **not a 100% native GPS replacement** — typical road error is **~5–7%** (see [Accuracy](#accuracy));
- accuracy ceiling is **data** (`nodes.json`), not the algorithm; for <3% you need **ynd** from CodeWalker;

## Architecture

```
nodes.zip → scripts/build-graph.ts → data/graph.bin (~2.7 MB)
                                      ↓
                              RoadGraph + A*
                                      ↓
                              HTTP API (dist/index.js)
```

When building the Docker image, `nodes.zip` is downloaded automatically and the graph is built inside the container.

## Quick start (Docker)

```bash
docker compose up --build -d
curl http://localhost:3005/health
```

The service listens on **3005** on the host (**3000** inside the container).

## Local development

```bash
npm install

# Download nodes.zip into the project root, then:
npm run build:graph -- nodes.zip data/graph.bin
npm run build
npm start
# or
npm run dev
```

## API

### `GET /health`

Health check and graph stats.

```json
{
  "status": "ok",
  "nodes": 67454,
  "edges": 180176,
  "cells": 513,
  "graphVersion": 2,
  "cacheSize": 0,
  "cacheCapacity": 10000
}
```

### `GET /distance`

Query parameters:

| Parameter | Description |
|---|---|
| `fromX`, `fromY`, `fromZ` | Start point |
| `toX`, `toY`, `toZ` | End point |
| `path=1` | Include route polyline |

Example:

```bash
curl "http://localhost:3005/distance?fromX=215&fromY=-890&fromZ=30&toX=120&toY=-1800&toZ=30"
```

### `POST /distance`

```bash
curl -s -X POST http://localhost:3005/distance \
  -H 'Content-Type: application/json' \
  -d '{
    "from": {"x": 215, "y": -890, "z": 30},
    "to":   {"x": 120, "y": -1800, "z": 30},
    "includePath": true
  }'
```

### Response

```json
{
  "distance": 5669.42,
  "straightDistance": 4182.39,
  "fromNode": 34132,
  "toNode": 54175,
  "pathNodes": 142,
  "computeMs": 12.345,
  "cached": false,
  "path": [{"x": 215, "y": -890, "z": 30}, ...]
}
```

| Field | Meaning |
|---|---|
| `distance` | **Road** route length (meters) |
| `straightDistance` | 3D straight-line distance (meters) |
| `fromNode`, `toNode` | Nearest graph node IDs |
| `pathNodes` | Number of nodes in the route |
| `path` | Polyline if requested: `[from, ...nodes..., to]` |
| `cached` | Result served from LRU cache |
| `computeMs` | Compute time (ms) |

### Errors

- `400` — invalid coordinates or JSON
- `404` — no route found (`{"error": "No route found between the points"}`)
- `405` — method not allowed

## Accuracy

Example route: Los Santos → Sandy Shores

| Source | Value | What it measures |
|---|---|---|
| GTA map (“Route waypoint”) | ~4181 m | **Straight line** to waypoint, not GPS path length |
| `straightDistance` | ~4182 m | Same ✓ |
| GTA native (`calculateTravelDistanceBetweenPoints`) | ~5295 m | By road |
| This service | ~5669 m | By road (~+7%) |

**Straight-line distance** is correct. The ~5–7% gap is only on **road** routes: the JSON dump `nodes.json` is a simplified view of GTA’s nav graph. For <3% you need binary **ynd** files (CodeWalker), not JSON.

For many server use cases (taxi fare ±10%, “quest must be at least N km by road”) the current accuracy is **enough**. Matching native GPS 1:1 requires ynd.

## Environment variables

### Service

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `GRAPH_PATH` | `data/graph.bin` | Path to binary graph |
| `CACHE_SIZE` | `10000` | LRU route cache capacity |

### Graph build (`npm run build:graph`)

| Variable | Default | Description |
|---|---|---|
| `BRIDGE_MAX_DIST` | `30` | Dead-end bridges (m) |
| `GAP_BRIDGE_MAX_DIST` | `15` | Gap bridges between nearby breaks (m) |
| `GAP_BRIDGE_MAX_DEGREE` | `2` | Max node degree for gap bridges |

Example:

```bash
BRIDGE_MAX_DIST=40 GAP_BRIDGE_MAX_DIST=20 npm run build:graph -- nodes.zip data/graph.bin
```

## Compare with GTA (RAGE MP)

`tools/ragemp-compare/` includes client and server packages to compare against native GTA GPS.

**Setup:**

1. Copy `tools/ragemp-compare/packages/pathfinder-compare/` → `<server>/packages/pathfinder-compare/`
2. Copy `tools/ragemp-compare/client_packages/pathfinder-compare/` → `<server>/client_packages/pathfinder-compare/`
3. Require both in `packages/index.js` and `client_packages/index.js`
4. Set `PATHFINDER_URL=http://127.0.0.1:3005/distance` (game server must reach pathfinder)

**In-game commands:**

| Command | Description |
|---|---|
| `/pfcoords` | Player and waypoint coordinates |
| `/pfcompare` | GTA native vs service |
| `/pfshow` | Draw service route (red lines) |
| `/pfhide` | Hide drawn route |

## Project layout

```
src/
  index.ts       — HTTP server
  graph.ts       — graph.bin loader, spatial lookup
  pathfinder.ts  — multi-source/multi-target A*
  cache.ts       — LRU cache by coordinates (0.1 m rounding)
  types.ts       — types and graph constants
scripts/
  build-graph.ts — nodes.json → graph.bin preprocessor
tools/
  ragemp-compare/ — RAGE MP integration
```

## Algorithm

1. Points snap to several nearest graph nodes (multi-anchor snap).
2. A* finds the shortest path across start/end node combinations.
3. Edge weights use 2D `hypot(dx, dy)` (similar to GTA GPS).
4. Graph build adds bridges for dead ends and small gaps in the dump.
