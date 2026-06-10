import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { unzipSync } from "fflate";
import {
  CELL_ORIGIN_X,
  CELL_ORIGIN_X_INDEX,
  CELL_ORIGIN_Y,
  CELL_ORIGIN_Y_INDEX,
  CELL_SIZE,
  GRAPH_MAGIC,
  GRAPH_VERSION,
  GRID_HEIGHT,
  GRID_WIDTH,
} from "../src/types.js";

interface RawVec3 {
  X: number;
  Y: number;
  Z: number;
}

interface RawNode {
  Id: number;
  IsValidForGps?: boolean;
  IsOnWater?: boolean;
  IsBackroad?: boolean;
  Position: RawVec3;
  ConnectedNodes: Array<{
    Node: RawNode;
    LaneCountForward: number;
    LaneCountBackward: number;
  }> | null;
}

interface RawCell {
  AreaId: number;
  CellX: number;
  CellY: number;
  DimensionMin: RawVec3;
  DimensionMax: RawVec3;
  Nodes: RawNode[];
}

function dist3(a: RawVec3, b: RawVec3): number {
  const dx = a.X - b.X;
  const dy = a.Y - b.Y;
  const dz = a.Z - b.Z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function edgeWeight(a: RawVec3, b: RawVec3): number {
  return Math.hypot(a.X - b.X, a.Y - b.Y);
}

function encodeNodeFlags(node: RawNode): number {
  let flags = 0;
  if (node.IsValidForGps !== false) flags |= 1;
  if (node.IsOnWater) flags |= 2;
  if (node.IsBackroad) flags |= 4;
  return flags;
}

function loadNodesJson(path: string): RawCell[] {
  const filePath = resolve(path);
  let json: string;

  if (filePath.endsWith(".json")) {
    json = readFileSync(filePath, "utf8");
  } else {
    const archive = unzipSync(readFileSync(filePath));
    const entry = archive["nodes.json"];
    if (!entry) {
      throw new Error(`nodes.json not found inside ${filePath}`);
    }
    json = new TextDecoder().decode(entry);
  }

  return JSON.parse(json) as RawCell[];
}

function cellGridIndex(cellX: number, cellY: number): number {
  return (cellY - CELL_ORIGIN_Y_INDEX) * GRID_WIDTH + (cellX - CELL_ORIGIN_X_INDEX);
}

const BRIDGE_MAX_DIST = Number(process.env.BRIDGE_MAX_DIST ?? 30);
const GAP_BRIDGE_MAX_DIST = Number(process.env.GAP_BRIDGE_MAX_DIST ?? 15);
const GAP_BRIDGE_MAX_DEGREE = Number(process.env.GAP_BRIDGE_MAX_DEGREE ?? 2);

function addEdge(
  neighborLists: number[][],
  weightLists: number[][],
  src: number,
  tgt: number,
  weight: number,
): void {
  const srcNeighbors = neighborLists[src] ?? [];
  if (srcNeighbors.includes(tgt)) return;

  neighborLists[src] = [...srcNeighbors, tgt];
  weightLists[src] = [...(weightLists[src] ?? []), weight];
  neighborLists[tgt] = [...(neighborLists[tgt] ?? []), src];
  weightLists[tgt] = [...(weightLists[tgt] ?? []), weight];
}

function bridgeDeadEnds(
  neighborLists: number[][],
  weightLists: number[][],
  positions: Float32Array,
  nodeCount: number,
  sortedCells: RawCell[],
  nodeCellIndex: Int16Array,
): number {
  const cellByCoord = new Map<string, number>();
  for (let i = 0; i < sortedCells.length; i++) {
    const cell = sortedCells[i]!;
    cellByCoord.set(`${cell.CellX}:${cell.CellY}`, i);
  }

  const cellNodeStart = new Uint32Array(sortedCells.length);
  const cellNodeCount = new Uint32Array(sortedCells.length);
  let cursor = 0;
  for (let i = 0; i < sortedCells.length; i++) {
    const count = sortedCells[i]!.Nodes.length;
    cellNodeStart[i] = cursor;
    cellNodeCount[i] = count;
    cursor += count;
  }

  const deadEnds: number[] = [];
  for (let i = 0; i < nodeCount; i++) {
    if ((neighborLists[i]?.length ?? 0) === 1) {
      deadEnds.push(i);
    }
  }

  const maxDistSq = BRIDGE_MAX_DIST * BRIDGE_MAX_DIST;
  let bridges = 0;

  for (const src of deadEnds) {
    const cellIndex = nodeCellIndex[src]!;
    if (cellIndex < 0) continue;

    const cell = sortedCells[cellIndex]!;
    const sx = positions[src * 3]!;
    const sy = positions[src * 3 + 1]!;
    const sz = positions[src * 3 + 2]!;

    const existing = new Set(neighborLists[src] ?? []);
    let bestTarget: number | undefined;
    let bestDistSq = maxDistSq;

    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const neighborCellIndex = cellByCoord.get(`${cell.CellX + dx}:${cell.CellY + dy}`);
        if (neighborCellIndex === undefined) continue;

        const start = cellNodeStart[neighborCellIndex]!;
        const count = cellNodeCount[neighborCellIndex]!;
        for (let offset = 0; offset < count; offset++) {
          const tgt = start + offset;
          if (tgt === src || existing.has(tgt)) continue;

          const tx = positions[tgt * 3]!;
          const ty = positions[tgt * 3 + 1]!;
          const tz = positions[tgt * 3 + 2]!;
          const distSq = (sx - tx) ** 2 + (sy - ty) ** 2 + (sz - tz) ** 2;
          if (distSq < bestDistSq) {
            bestDistSq = distSq;
            bestTarget = tgt;
          }
        }
      }
    }

    if (bestTarget !== undefined) {
      addEdge(
        neighborLists,
        weightLists,
        src,
        bestTarget,
        Math.hypot(sx - positions[bestTarget * 3]!, sy - positions[bestTarget * 3 + 1]!),
      );
      bridges++;
    }
  }

  return bridges;
}

function bridgeNearbyGaps(
  neighborLists: number[][],
  weightLists: number[][],
  positions: Float32Array,
  nodeCount: number,
  sortedCells: RawCell[],
  nodeCellIndex: Int16Array,
  maxDegree: number,
  maxDistance: number,
): number {
  const cellByCoord = new Map<string, number>();
  for (let i = 0; i < sortedCells.length; i++) {
    const cell = sortedCells[i]!;
    cellByCoord.set(`${cell.CellX}:${cell.CellY}`, i);
  }

  const cellNodeStart = new Uint32Array(sortedCells.length);
  const cellNodeCount = new Uint32Array(sortedCells.length);
  let cursor = 0;
  for (let i = 0; i < sortedCells.length; i++) {
    const count = sortedCells[i]!.Nodes.length;
    cellNodeStart[i] = cursor;
    cellNodeCount[i] = count;
    cursor += count;
  }

  const maxDistSq = maxDistance * maxDistance;
  let bridges = 0;

  for (let src = 0; src < nodeCount; src++) {
    if ((neighborLists[src]?.length ?? 0) > maxDegree) continue;

    const cellIndex = nodeCellIndex[src]!;
    if (cellIndex < 0) continue;

    const cell = sortedCells[cellIndex]!;
    const sx = positions[src * 3]!;
    const sy = positions[src * 3 + 1]!;
    const sz = positions[src * 3 + 2]!;

    const existing = new Set(neighborLists[src] ?? []);
    let bestTarget: number | undefined;
    let bestDistSq = maxDistSq;

    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const neighborCellIndex = cellByCoord.get(`${cell.CellX + dx}:${cell.CellY + dy}`);
        if (neighborCellIndex === undefined) continue;

        const start = cellNodeStart[neighborCellIndex]!;
        const count = cellNodeCount[neighborCellIndex]!;
        for (let offset = 0; offset < count; offset++) {
          const tgt = start + offset;
          if (tgt === src || tgt < src || existing.has(tgt)) continue;
          if ((neighborLists[tgt]?.length ?? 0) > maxDegree) continue;

          const tx = positions[tgt * 3]!;
          const ty = positions[tgt * 3 + 1]!;
          const tz = positions[tgt * 3 + 2]!;
          const distSq = (sx - tx) ** 2 + (sy - ty) ** 2 + (sz - tz) ** 2;
          if (distSq < bestDistSq) {
            bestDistSq = distSq;
            bestTarget = tgt;
          }
        }
      }
    }

    if (bestTarget !== undefined) {
      addEdge(
        neighborLists,
        weightLists,
        src,
        bestTarget,
        Math.hypot(
          sx - positions[bestTarget * 3]!,
          sy - positions[bestTarget * 3 + 1]!,
        ),
      );
      bridges++;
    }
  }

  return bridges;
}

function main(): void {
  const input = process.argv[2] ?? "nodes.zip";
  const output = process.argv[3] ?? "data/graph.bin";

  console.log(`Loading ${input}...`);
  const cells = loadNodesJson(input);

  const cellByArea = new Map<number, RawCell>();
  for (const cell of cells) {
    cellByArea.set(cell.AreaId, cell);
  }

  const nodeCount = cells.reduce((sum, cell) => sum + cell.Nodes.length, 0);
  const positions = new Float32Array(nodeCount * 3);
  const nodeFlags = new Uint8Array(nodeCount);
  const cellIndices = new Uint16Array(nodeCount);
  const localIds = new Uint16Array(nodeCount);
  const nodeCellNodeIndex = new Uint32Array(nodeCount);

  const globalIdToIndex = new Map<number, number>();
  const areaNodeLists = new Map<number, Array<{ index: number; pos: RawVec3; localId: number }>>();

  let nodeIndex = 0;
  const sortedCells = [...cells].sort((a, b) => a.AreaId - b.AreaId);

  for (const cell of sortedCells) {
    const list: Array<{ index: number; pos: RawVec3; localId: number }> = [];
    for (const node of cell.Nodes) {
      const globalId = cell.AreaId * 65536 + node.Id;
      globalIdToIndex.set(globalId, nodeIndex);

      positions[nodeIndex * 3] = node.Position.X;
      positions[nodeIndex * 3 + 1] = node.Position.Y;
      positions[nodeIndex * 3 + 2] = node.Position.Z;
      nodeFlags[nodeIndex] = encodeNodeFlags(node);
      cellIndices[nodeIndex] = cell.AreaId;
      localIds[nodeIndex] = node.Id;
      nodeCellNodeIndex[nodeIndex] = list.length;

      list.push({ index: nodeIndex, pos: node.Position, localId: node.Id });
      nodeIndex++;
    }
    areaNodeLists.set(cell.AreaId, list);
  }

  function findCellByPos(pos: RawVec3): RawCell | undefined {
    for (const cell of cells) {
      if (
        pos.X >= cell.DimensionMin.X &&
        pos.X < cell.DimensionMax.X &&
        pos.Y >= cell.DimensionMin.Y &&
        pos.Y < cell.DimensionMax.Y
      ) {
        return cell;
      }
    }
    return undefined;
  }

  function resolveTargetIndex(conn: RawNode): number | undefined {
    const targetCell = findCellByPos(conn.Position);
    if (!targetCell) return undefined;

    const globalId = targetCell.AreaId * 65536 + conn.Id;
    const direct = globalIdToIndex.get(globalId);
    if (direct !== undefined) return direct;

    const nodesInCell = areaNodeLists.get(targetCell.AreaId);
    if (!nodesInCell) return undefined;

    let best: number | undefined;
    let bestDist = Infinity;
    for (const candidate of nodesInCell) {
      const d = dist3(conn.Position, candidate.pos);
      if (d < bestDist) {
        bestDist = d;
        best = candidate.index;
      }
    }
    return best;
  }

  const neighborLists: number[][] = [];
  const weightLists: number[][] = [];
  const nodeCellIndex = new Int16Array(nodeCount);
  nodeCellIndex.fill(-1);

  for (let cellIndex = 0; cellIndex < sortedCells.length; cellIndex++) {
    const cell = sortedCells[cellIndex]!;
    for (const node of cell.Nodes) {
      const srcIndex = globalIdToIndex.get(cell.AreaId * 65536 + node.Id)!;
      nodeCellIndex[srcIndex] = cellIndex;
    }
  }

  for (const cell of sortedCells) {
    for (const node of cell.Nodes) {
      const srcIndex = globalIdToIndex.get(cell.AreaId * 65536 + node.Id)!;
      const neighbors: number[] = [];
      const weights: number[] = [];
      const seen = new Set<number>();

      for (const conn of node.ConnectedNodes ?? []) {
        const targetIndex = resolveTargetIndex(conn.Node);
        if (targetIndex === undefined || targetIndex === srcIndex || seen.has(targetIndex)) {
          continue;
        }
        seen.add(targetIndex);
        neighbors.push(targetIndex);
        weights.push(edgeWeight(node.Position, conn.Node.Position));
      }

      neighborLists[srcIndex] = neighbors;
      weightLists[srcIndex] = weights;
    }
  }

  const bridges = bridgeDeadEnds(
    neighborLists,
    weightLists,
    positions,
    nodeCount,
    sortedCells,
    nodeCellIndex,
  );
  console.log(`Bridged ${bridges} dead-end gaps (max ${BRIDGE_MAX_DIST}m)`);

  const gapBridges =
    GAP_BRIDGE_MAX_DIST > 0
      ? bridgeNearbyGaps(
          neighborLists,
          weightLists,
          positions,
          nodeCount,
          sortedCells,
          nodeCellIndex,
          GAP_BRIDGE_MAX_DEGREE,
          GAP_BRIDGE_MAX_DIST,
        )
      : 0;
  if (gapBridges > 0) {
    console.log(
      `Bridged ${gapBridges} nearby gaps (max ${GAP_BRIDGE_MAX_DIST}m, degree<=${GAP_BRIDGE_MAX_DEGREE})`,
    );
  }

  const offsets = new Uint32Array(nodeCount + 1);
  let edgeCount = 0;
  for (let i = 0; i < nodeCount; i++) {
    offsets[i] = edgeCount;
    edgeCount += neighborLists[i]?.length ?? 0;
  }
  offsets[nodeCount] = edgeCount;

  const neighbors = new Uint32Array(edgeCount);
  const weights = new Float32Array(edgeCount);
  let edgeOffset = 0;
  for (let i = 0; i < nodeCount; i++) {
    const nbrs = neighborLists[i] ?? [];
    const wts = weightLists[i] ?? [];
    for (let j = 0; j < nbrs.length; j++) {
      neighbors[edgeOffset] = nbrs[j]!;
      weights[edgeOffset] = wts[j]!;
      edgeOffset++;
    }
  }

  const spatialGrid = new Int16Array(GRID_WIDTH * GRID_HEIGHT);
  spatialGrid.fill(-1);
  const cellMeta = new Float32Array(sortedCells.length * 5);
  const cellNodeStart = new Uint32Array(sortedCells.length);
  const cellNodeCount = new Uint32Array(sortedCells.length);
  const cellAreaIds = new Uint16Array(sortedCells.length);

  const areaToCellMetaIndex = new Map<number, number>();
  for (let i = 0; i < sortedCells.length; i++) {
    const cell = sortedCells[i]!;
    areaToCellMetaIndex.set(cell.AreaId, i);
    cellMeta[i * 5] = cell.DimensionMin.X;
    cellMeta[i * 5 + 1] = cell.DimensionMin.Y;
    cellMeta[i * 5 + 2] = cell.DimensionMax.X;
    cellMeta[i * 5 + 3] = cell.DimensionMax.Y;
    cellMeta[i * 5 + 4] = cell.AreaId;
    cellAreaIds[i] = cell.AreaId;

    const gridIdx = cellGridIndex(cell.CellX, cell.CellY);
    spatialGrid[gridIdx] = i;

    if (cell.Nodes.length > 0) {
      const start = globalIdToIndex.get(cell.AreaId * 65536 + cell.Nodes[0]!.Id)!;
      cellNodeStart[i] = start;
      cellNodeCount[i] = cell.Nodes.length;
    }
  }

  const headerSize = 8 * 4;
  const totalSize =
    headerSize +
    positions.byteLength +
    cellIndices.byteLength +
    nodeFlags.byteLength +
    offsets.byteLength +
    neighbors.byteLength +
    weights.byteLength +
    spatialGrid.byteLength +
    cellMeta.byteLength +
    cellNodeStart.byteLength +
    cellNodeCount.byteLength +
    cellAreaIds.byteLength;

  const buffer = Buffer.alloc(totalSize);
  let offset = 0;

  buffer.writeUInt32LE(GRAPH_MAGIC, offset);
  offset += 4;
  buffer.writeUInt32LE(GRAPH_VERSION, offset);
  offset += 4;
  buffer.writeUInt32LE(nodeCount, offset);
  offset += 4;
  buffer.writeUInt32LE(sortedCells.length, offset);
  offset += 4;
  buffer.writeFloatLE(CELL_ORIGIN_X, offset);
  offset += 4;
  buffer.writeFloatLE(CELL_ORIGIN_Y, offset);
  offset += 4;
  buffer.writeFloatLE(CELL_SIZE, offset);
  offset += 4;
  buffer.writeUInt32LE(edgeCount, offset);
  offset += 4;

  Buffer.from(positions.buffer).copy(buffer, offset);
  offset += positions.byteLength;
  Buffer.from(cellIndices.buffer).copy(buffer, offset);
  offset += cellIndices.byteLength;
  Buffer.from(nodeFlags.buffer).copy(buffer, offset);
  offset += nodeFlags.byteLength;
  Buffer.from(offsets.buffer).copy(buffer, offset);
  offset += offsets.byteLength;
  Buffer.from(neighbors.buffer).copy(buffer, offset);
  offset += neighbors.byteLength;
  Buffer.from(weights.buffer).copy(buffer, offset);
  offset += weights.byteLength;
  Buffer.from(spatialGrid.buffer, spatialGrid.byteOffset, spatialGrid.byteLength).copy(buffer, offset);
  offset += spatialGrid.byteLength;
  Buffer.from(cellMeta.buffer).copy(buffer, offset);
  offset += cellMeta.byteLength;
  Buffer.from(cellNodeStart.buffer).copy(buffer, offset);
  offset += cellNodeStart.byteLength;
  Buffer.from(cellNodeCount.buffer).copy(buffer, offset);
  offset += cellNodeCount.byteLength;
  Buffer.from(cellAreaIds.buffer).copy(buffer, offset);

  writeFileSync(output, buffer);
  console.log(`Graph written to ${output}`);
  console.log(`Nodes: ${nodeCount}, edges: ${edgeCount}, cells: ${sortedCells.length}, size: ${totalSize} bytes`);
}

main();
