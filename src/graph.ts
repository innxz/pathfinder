import { readFileSync } from "node:fs";
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
  type Vec3,
} from "./types.js";

const HEADER_SIZE = 32;

export const NODE_FLAG_VALID_GPS = 1;
export const NODE_FLAG_ON_WATER = 2;
export const NODE_FLAG_BACKROAD = 4;

export interface AnchorCandidate {
  index: number;
  cost: number;
}

export class RoadGraph {
  readonly nodeCount: number;
  readonly cellCount: number;
  readonly edgeCount: number;

  private readonly positions: Float32Array;
  private readonly nodeFlags: Uint8Array;
  private readonly offsets: Uint32Array;
  private readonly neighbors: Uint32Array;
  private readonly weights: Float32Array;
  private readonly spatialGrid: Int16Array;
  private readonly cellMeta: Float32Array;
  private readonly cellNodeStart: Uint32Array;
  private readonly cellNodeCount: Uint32Array;

  private constructor(
    nodeCount: number,
    cellCount: number,
    edgeCount: number,
    positions: Float32Array,
    nodeFlags: Uint8Array,
    offsets: Uint32Array,
    neighbors: Uint32Array,
    weights: Float32Array,
    spatialGrid: Int16Array,
    cellMeta: Float32Array,
    cellNodeStart: Uint32Array,
    cellNodeCount: Uint32Array,
  ) {
    this.nodeCount = nodeCount;
    this.cellCount = cellCount;
    this.edgeCount = edgeCount;
    this.positions = positions;
    this.nodeFlags = nodeFlags;
    this.offsets = offsets;
    this.neighbors = neighbors;
    this.weights = weights;
    this.spatialGrid = spatialGrid;
    this.cellMeta = cellMeta;
    this.cellNodeStart = cellNodeStart;
    this.cellNodeCount = cellNodeCount;
  }

  static load(path: string): RoadGraph {
    const buffer = readFileSync(path);
    const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);

    const magic = view.getUint32(0, true);
    const version = view.getUint32(4, true);
    const nodeCount = view.getUint32(8, true);
    const cellCount = view.getUint32(12, true);
    const edgeCount = view.getUint32(28, true);

    if (magic !== GRAPH_MAGIC) {
      throw new Error(`Invalid graph magic: ${magic.toString(16)}`);
    }
    if (version !== GRAPH_VERSION) {
      throw new Error(`Unsupported graph version: ${version}`);
    }

    let offset = HEADER_SIZE;
    const positions = new Float32Array(nodeCount * 3);
    new Uint8Array(positions.buffer).set(buffer.subarray(offset, offset + positions.byteLength));
    offset += positions.byteLength;

    offset += nodeCount * 2;

    const nodeFlags = new Uint8Array(nodeCount);
    new Uint8Array(nodeFlags.buffer).set(buffer.subarray(offset, offset + nodeFlags.byteLength));
    offset += nodeFlags.byteLength;

    const offsets = new Uint32Array(nodeCount + 1);
    new Uint8Array(offsets.buffer).set(buffer.subarray(offset, offset + offsets.byteLength));
    offset += offsets.byteLength;

    const neighbors = new Uint32Array(edgeCount);
    new Uint8Array(neighbors.buffer).set(buffer.subarray(offset, offset + neighbors.byteLength));
    offset += neighbors.byteLength;

    const weights = new Float32Array(edgeCount);
    new Uint8Array(weights.buffer).set(buffer.subarray(offset, offset + weights.byteLength));
    offset += weights.byteLength;

    const spatialGrid = new Int16Array(GRID_WIDTH * GRID_HEIGHT);
    new Uint8Array(spatialGrid.buffer, spatialGrid.byteOffset, spatialGrid.byteLength).set(
      buffer.subarray(offset, offset + spatialGrid.byteLength),
    );
    offset += spatialGrid.byteLength;

    const cellMeta = new Float32Array(cellCount * 5);
    new Uint8Array(cellMeta.buffer).set(buffer.subarray(offset, offset + cellMeta.byteLength));
    offset += cellMeta.byteLength;

    const cellNodeStart = new Uint32Array(cellCount);
    new Uint8Array(cellNodeStart.buffer).set(buffer.subarray(offset, offset + cellNodeStart.byteLength));
    offset += cellNodeStart.byteLength;

    const cellNodeCount = new Uint32Array(cellCount);
    new Uint8Array(cellNodeCount.buffer).set(buffer.subarray(offset, offset + cellNodeCount.byteLength));

    return new RoadGraph(
      nodeCount,
      cellCount,
      edgeCount,
      positions,
      nodeFlags,
      offsets,
      neighbors,
      weights,
      spatialGrid,
      cellMeta,
      cellNodeStart,
      cellNodeCount,
    );
  }

  getPosition(nodeIndex: number): Vec3 {
    const base = nodeIndex * 3;
    return {
      x: this.positions[base]!,
      y: this.positions[base + 1]!,
      z: this.positions[base + 2]!,
    };
  }

  snapCost(x: number, y: number, z: number, nodeIndex: number): number {
    const base = nodeIndex * 3;
    const dx = this.positions[base]! - x;
    const dy = this.positions[base + 1]! - y;
    const dz = this.positions[base + 2]! - z;
    const flags = this.nodeFlags[nodeIndex]!;

    let cost = Math.hypot(dx, dy) + Math.abs(dz) * 0.25;
    if ((flags & NODE_FLAG_ON_WATER) !== 0) cost += 50;
    if ((flags & NODE_FLAG_BACKROAD) !== 0) cost += 15;
    if ((flags & NODE_FLAG_VALID_GPS) === 0) cost += 30;
    return cost;
  }

  private coordToGrid(x: number, y: number): { gx: number; gy: number } | null {
    const cellX = Math.floor((x - CELL_ORIGIN_X) / CELL_SIZE) + CELL_ORIGIN_X_INDEX;
    const cellY = Math.floor((y - CELL_ORIGIN_Y) / CELL_SIZE) + CELL_ORIGIN_Y_INDEX;

    if (
      cellX < CELL_ORIGIN_X_INDEX ||
      cellY < CELL_ORIGIN_Y_INDEX ||
      cellX >= CELL_ORIGIN_X_INDEX + GRID_WIDTH ||
      cellY >= CELL_ORIGIN_Y_INDEX + GRID_HEIGHT
    ) {
      return null;
    }

    return {
      gx: cellX - CELL_ORIGIN_X_INDEX,
      gy: cellY - CELL_ORIGIN_Y_INDEX,
    };
  }

  private collectCandidatesInCell(
    cellIndex: number,
    x: number,
    y: number,
    maxRadiusSq: number,
    out: AnchorCandidate[],
  ): void {
    if (cellIndex < 0) return;

    const start = this.cellNodeStart[cellIndex]!;
    const count = this.cellNodeCount[cellIndex]!;
    for (let i = 0; i < count; i++) {
      const nodeIndex = start + i;
      const base = nodeIndex * 3;
      const dx = this.positions[base]! - x;
      const dy = this.positions[base + 1]! - y;
      if (dx * dx + dy * dy > maxRadiusSq) continue;
      out.push({ index: nodeIndex, cost: this.snapCost(x, y, this.positions[base + 2]!, nodeIndex) });
    }
  }

  findNearestCandidates(
    x: number,
    y: number,
    z: number,
    maxCount = 12,
    maxRadius = 150,
  ): AnchorCandidate[] {
    const maxRadiusSq = maxRadius * maxRadius;
    const collected: AnchorCandidate[] = [];
    const grid = this.coordToGrid(x, y);

    if (grid) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = grid.gx + dx;
          const ny = grid.gy + dy;
          if (nx < 0 || ny < 0 || nx >= GRID_WIDTH || ny >= GRID_HEIGHT) continue;
          this.collectCandidatesInCell(this.spatialGrid[ny * GRID_WIDTH + nx]!, x, y, maxRadiusSq, collected);
        }
      }
    }

    if (collected.length === 0) {
      for (let cellIndex = 0; cellIndex < this.cellCount; cellIndex++) {
        this.collectCandidatesInCell(cellIndex, x, y, maxRadiusSq, collected);
      }
    }

    collected.sort((a, b) => a.cost - b.cost);

    const unique: AnchorCandidate[] = [];
    const seen = new Set<number>();
    for (const candidate of collected) {
      if (seen.has(candidate.index)) continue;
      seen.add(candidate.index);
      unique.push(candidate);
      if (unique.length >= maxCount) break;
    }

    return unique;
  }

  findNearestNode(x: number, y: number, z: number): number {
    const candidates = this.findNearestCandidates(x, y, z, 1, 150);
    return candidates[0]?.index ?? -1;
  }

  getNeighborRange(nodeIndex: number): { start: number; end: number } {
    return {
      start: this.offsets[nodeIndex]!,
      end: this.offsets[nodeIndex + 1]!,
    };
  }

  getNeighbor(edgeIndex: number): number {
    return this.neighbors[edgeIndex]!;
  }

  getWeight(edgeIndex: number): number {
    return this.weights[edgeIndex]!;
  }
}
