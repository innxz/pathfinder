import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { resolve } from "node:path";
import { RouteCache } from "./cache.js";
import { RoadGraph } from "./graph.js";
import { findRouteBetweenPoints } from "./pathfinder.js";
import type { DistanceRequest, DistanceResponse, ErrorResponse, Vec3 } from "./types.js";

const PORT = Number(process.env.PORT ?? 3000);
const GRAPH_PATH = resolve(process.env.GRAPH_PATH ?? "data/graph.bin");
const CACHE_SIZE = Number(process.env.CACHE_SIZE ?? 10_000);

const graph = RoadGraph.load(GRAPH_PATH);
const routeCache = new RouteCache(CACHE_SIZE);

function sendJson(
  res: ServerResponse,
  status: number,
  body: DistanceResponse | ErrorResponse | Record<string, unknown>,
): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function parseVec3(value: unknown): Vec3 | null {
  if (!value || typeof value !== "object") return null;
  const obj = value as Record<string, unknown>;
  const x = Number(obj.x);
  const y = Number(obj.y);
  const z = Number(obj.z);
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null;
  return { x, y, z };
}

function parseBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolvePromise(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function parseQueryPoint(searchParams: URLSearchParams, prefix: string): Vec3 | null {
  const x = Number(searchParams.get(`${prefix}x`));
  const y = Number(searchParams.get(`${prefix}y`));
  const z = Number(searchParams.get(`${prefix}z`) ?? 0);
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null;
  return { x, y, z };
}

function straightDistance(from: Vec3, to: Vec3): number {
  return Math.hypot(from.x - to.x, from.y - to.y, from.z - to.z);
}

function buildPolyline(from: Vec3, to: Vec3, nodeIndices: number[]): Vec3[] {
  const path: Vec3[] = [from];
  for (const nodeIndex of nodeIndices) {
    path.push(graph.getPosition(nodeIndex));
  }
  path.push(to);
  return path;
}

function computeDistance(
  from: Vec3,
  to: Vec3,
  includePath: boolean,
): DistanceResponse | ErrorResponse {
  const started = performance.now();
  const cached = routeCache.get(from, to);
  const path = cached ?? findRouteBetweenPoints(graph, from, to);
  const computeMs = performance.now() - started;

  if (!path) {
    return { error: "No route found between the points" };
  }

  if (!cached) {
    routeCache.set(from, to, path);
  }

  const response: DistanceResponse = {
    distance: path.distance,
    straightDistance: straightDistance(from, to),
    fromNode: path.fromNode,
    toNode: path.toNode,
    pathNodes: path.pathNodes,
    computeMs: Number(computeMs.toFixed(3)),
    cached: Boolean(cached),
  };

  if (includePath) {
    response.path = buildPolyline(from, to, path.nodeIndices);
  }

  return response;
}

async function handleDistance(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  let from: Vec3 | null = null;
  let to: Vec3 | null = null;
  let includePath = false;

  if (req.method === "GET") {
    from = parseQueryPoint(url.searchParams, "from");
    to = parseQueryPoint(url.searchParams, "to");
    includePath = url.searchParams.get("path") === "1" || url.searchParams.get("path") === "true";
  } else if (req.method === "POST") {
    try {
      const raw = await parseBody(req);
      const body = JSON.parse(raw) as DistanceRequest;
      from = parseVec3(body.from);
      to = parseVec3(body.to);
      includePath = Boolean(body.includePath);
    } catch {
      sendJson(res, 400, { error: "Invalid JSON body" });
      return;
    }
  } else {
    sendJson(res, 405, { error: "Method not allowed" });
    return;
  }

  if (!from || !to) {
    sendJson(res, 400, { error: "Expected from/to points with numeric x, y, z" });
    return;
  }

  const result = computeDistance(from, to, includePath);
  if ("error" in result) {
    sendJson(res, 404, result);
    return;
  }

  sendJson(res, 200, result);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

  if (url.pathname === "/health") {
    sendJson(res, 200, {
      status: "ok",
      nodes: graph.nodeCount,
      edges: graph.edgeCount,
      cells: graph.cellCount,
      graphVersion: 2,
      cacheSize: routeCache.size,
      cacheCapacity: CACHE_SIZE,
    });
    return;
  }

  if (url.pathname === "/distance") {
    await handleDistance(req, res, url);
    return;
  }

  sendJson(res, 404, { error: "Not found" });
});

server.listen(PORT, () => {
  console.log(`GTA pathfinder listening on :${PORT}`);
  console.log(`Loaded graph: ${graph.nodeCount} nodes, ${graph.edgeCount} edges`);
  console.log(`Route cache capacity: ${CACHE_SIZE}`);
});
