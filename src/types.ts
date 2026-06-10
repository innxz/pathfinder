export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface DistanceRequest {
  from: Vec3;
  to: Vec3;
  includePath?: boolean;
}

export interface DistanceResponse {
  distance: number;
  straightDistance: number;
  fromNode: number;
  toNode: number;
  pathNodes: number;
  computeMs: number;
  cached: boolean;
  path?: Vec3[];
}

export interface ErrorResponse {
  error: string;
}

export const GRAPH_MAGIC = 0x47544e56; // "GTNV"
export const GRAPH_VERSION = 2;
export const CELL_SIZE = 512;
export const CELL_ORIGIN_X = -3584;
export const CELL_ORIGIN_Y = -512;
export const CELL_ORIGIN_X_INDEX = 9;
export const CELL_ORIGIN_Y_INDEX = 15;
export const GRID_WIDTH = 19;
export const GRID_HEIGHT = 27;
