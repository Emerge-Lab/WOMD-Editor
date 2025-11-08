import {
  ScenarioAgent,
  ScenarioBounds,
  ScenarioFrame,
  ScenarioFrameAgentState,
  TrajectoryPoint,
  WaymoScenario
} from '@/types/scenario';

export interface ScenarioExportPayload {
  version: number;
  exportedAt: string;
  metadata: WaymoScenario['metadata'];
  bounds?: ScenarioBounds;
  agents: ScenarioAgent[];
  tracksToPredict: number[];
  roadEdges: WaymoScenario['roadEdges'];
  frames: ScenarioFrame[];
}

function cloneTrajectory(trajectory: TrajectoryPoint[]): TrajectoryPoint[] {
  return [...trajectory]
    .map((point) => ({ ...point }))
    .sort((a, b) => {
      const aIndex = a.frameIndex ?? 0;
      const bIndex = b.frameIndex ?? 0;
      return aIndex - bIndex;
    });
}

function cloneAgents(agents: ScenarioAgent[]): ScenarioAgent[] {
  return agents.map((agent) => ({
    ...agent,
    trajectory: cloneTrajectory(agent.trajectory)
  }));
}

function cloneRoadEdges(edges: WaymoScenario['roadEdges']): WaymoScenario['roadEdges'] {
  return edges.map((edge) => ({
    ...edge,
    points: edge.points.map((point) => ({
      x: point.x,
      y: point.y,
      ...(typeof point.z === 'number' ? { z: point.z } : {})
    }))
  }));
}

function cloneFrames(frames: ScenarioFrame[]): ScenarioFrame[] {
  return frames.map((frame) => ({
    ...frame,
    agents: frame.agents.map((agentState) => ({ ...agentState })) as ScenarioFrameAgentState[]
  }));
}

type WaymoVector3 = { x: number; y: number; z: number };
type WaymoVelocity = { x: number; y: number; z: number };

interface WaymoExportObject {
  id: number | string;
  type: string;
  length?: number;
  width?: number;
  height?: number;
  position: WaymoVector3[];
  heading: number[];
  velocity: WaymoVelocity[];
  valid: boolean[];
  mark_as_expert?: boolean;
  goalPosition?: WaymoVector3;
}

interface WaymoExportRoad {
  id: number | string;
  map_element_id?: number | string;
  type?: string;
  geometry: WaymoVector3[];
  width?: number;
  length?: number;
  height?: number;
  goalPosition?: WaymoVector3;
  mark_as_expert?: boolean;
}

export interface WaymoScenarioExportPayload {
  name: string;
  scenario_id: number;
  objects: WaymoExportObject[];
  roads: WaymoExportRoad[];
  tracks_to_predict?: Array<{ track_index: number; difficulty: number }>;
  tl_states: unknown[];
  metadata?: Record<string, unknown>;
}

const TRAJECTORY_LENGTH = 91;

const AGENT_TYPE_TO_RAW: Record<string, string> = {
  VEHICLE: 'vehicle',
  PEDESTRIAN: 'pedestrian',
  CYCLIST: 'cyclist',
  OTHER: 'vehicle'
};

const ROAD_TYPE_TO_RAW: Record<string, string> = {
  ROAD_LINE: 'road_line',
  ROAD_EDGE: 'road_edge',
  CROSSWALK: 'crosswalk',
  OTHER: 'other'
};

function toFiniteNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return undefined;
}

function toInteger(value: unknown): number | undefined {
  const maybeNumber = toFiniteNumber(value);
  if (maybeNumber == null) {
    return undefined;
  }

  return Number.isInteger(maybeNumber) ? maybeNumber : undefined;
}

type NumericIdResolver = (sourceId: unknown) => number;

function createNumericIdResolver(): NumericIdResolver {
  const cache = new Map<string, number>();
  const used = new Set<number>();

  const reserve = (value: number) => {
    if (!used.has(value)) {
      used.add(value);
    }
    return value;
  };

  return (rawId: unknown) => {
    const existingInteger = toInteger(rawId);
    if (existingInteger != null) {
      return reserve(existingInteger);
    }

    const key = `${typeof rawId}:${String(rawId)}`;
    const cached = cache.get(key);
    if (cached != null) {
      return cached;
    }

    let generated: number;
    do {
      generated = Math.floor(Math.random() * 1_000_000_000) + 1;
    } while (used.has(generated));

    reserve(generated);
    cache.set(key, generated);
    return generated;
  };
}

type NormalisedTrajectoryPoint = TrajectoryPoint & { frameIndex: number };

function normaliseTrajectoryPoints(points: TrajectoryPoint[]): NormalisedTrajectoryPoint[] {
  const normalised = points.map((point, index) => {
    const fallbackIndex = index;
    const normalisedIndex = typeof point.frameIndex === 'number' && Number.isFinite(point.frameIndex)
      ? Math.max(0, Math.floor(point.frameIndex))
      : fallbackIndex;

    return {
      ...point,
      frameIndex: normalisedIndex
    };
  }).sort((a, b) => a.frameIndex - b.frameIndex);

  return normalised;
}

function mapAgentToWaymoObject(agent: ScenarioAgent, resolveNumericId: NumericIdResolver): WaymoExportObject {
  const trajectory = normaliseTrajectoryPoints(agent.trajectory);

  const position: WaymoVector3[] = trajectory.map((point) => ({
    x: point.x,
    y: point.y,
    z: typeof point.z === 'number' && Number.isFinite(point.z) ? point.z : 0
  }));

  const heading: number[] = trajectory.map((point) => (
    typeof point.heading === 'number' && Number.isFinite(point.heading)
      ? point.heading
      : 0
  ));

  const velocity: WaymoVelocity[] = trajectory.map((point) => ({
    x: typeof point.velocityX === 'number' && Number.isFinite(point.velocityX)
      ? point.velocityX
      : (typeof point.speed === 'number' && typeof point.heading === 'number'
          ? point.speed * Math.cos(point.heading)
          : 0),
    y: typeof point.velocityY === 'number' && Number.isFinite(point.velocityY)
      ? point.velocityY
      : (typeof point.speed === 'number' && typeof point.heading === 'number'
          ? point.speed * Math.sin(point.heading)
          : 0),
    z: 0
  }));

  const valid: boolean[] = trajectory.map((point) => point.valid !== false);

  const id = resolveNumericId(agent.id);
  const length = toFiniteNumber(agent.dimensions?.length);
  const width = toFiniteNumber(agent.dimensions?.width);
  const height = toFiniteNumber(agent.dimensions?.height);
  const type = AGENT_TYPE_TO_RAW[agent.type] ?? 'vehicle';
  const lastValidPoint = [...trajectory].reverse().find((point) => point.valid !== false);

  return {
    id,
    type,
    length: length ?? undefined,
    width: width ?? undefined,
    height: height ?? undefined,
    position,
    heading,
    velocity,
    valid,
    mark_as_expert: agent.isExpert === true,
    goalPosition: lastValidPoint
      ? {
          x: lastValidPoint.x,
          y: lastValidPoint.y,
          z: typeof lastValidPoint.z === 'number' && Number.isFinite(lastValidPoint.z) ? lastValidPoint.z : 0
        }
      : undefined
  };
}

function mapRoadToWaymoRoad(edge: WaymoScenario['roadEdges'][number], resolveNumericId: NumericIdResolver): WaymoExportRoad {
  const mapElementId = toInteger(edge.id);
  const id = resolveNumericId(edge.id);
  const type = edge.type ? ROAD_TYPE_TO_RAW[edge.type] ?? 'other' : undefined;
  const road: WaymoExportRoad = {
    id,
    geometry: edge.points.map((point) => ({
      x: point.x,
      y: point.y,
      z: typeof point.z === 'number' && Number.isFinite(point.z) ? point.z : 0
    }))
  };

  if (mapElementId != null) {
    road.map_element_id = mapElementId;
  }
  if (type) {
    road.type = type;
  }

  return road;
}

function buildTrackPredictionEntries(indices: number[]): Array<{ track_index: number; difficulty: number }> | undefined {
  if (!Array.isArray(indices) || indices.length === 0) {
    return undefined;
  }

  return indices.map((trackIndex) => ({
    track_index: trackIndex,
    difficulty: 0
  }));
}

function cloneIfObject<T>(value: T): T {
  if (!value || typeof value !== 'object') {
    return value;
  }

  try {
    return JSON.parse(JSON.stringify(value)) as T;
  } catch (_error) {
    return value;
  }
}

function buildWaymoMetadata(
  scenario: WaymoScenario,
  exportedAt: string,
  scenarioId: number
): Record<string, unknown> | undefined {
  const raw = cloneIfObject(scenario.raw) as Record<string, unknown> | undefined;
  const baseMetadata = raw && typeof raw.metadata === 'object'
    ? { ...(raw.metadata as Record<string, unknown>) }
    : {};

  const tracksToPredict = buildTrackPredictionEntries(scenario.tracksToPredict);
  if (tracksToPredict) {
    baseMetadata.tracks_to_predict = tracksToPredict;
  }

  if (scenario.bounds) {
    baseMetadata.bounds = { ...scenario.bounds };
  }

  baseMetadata.scenario_id = scenarioId;

  if (baseMetadata.scenario && typeof baseMetadata.scenario === 'object') {
    baseMetadata.scenario = {
      ...(baseMetadata.scenario as Record<string, unknown>),
      id: scenarioId,
      scenario_id: scenarioId
    };
  }

  if (scenario.metadata.frameIntervalMicros != null) {
    baseMetadata.frame_interval_micros = scenario.metadata.frameIntervalMicros;
  }

  baseMetadata.frame_count = scenario.metadata.frameCount;
  baseMetadata.duration_seconds = scenario.metadata.durationSeconds;
  baseMetadata.editor_exported_at = exportedAt;

  return Object.keys(baseMetadata).length > 0 ? baseMetadata : undefined;
}

export function buildWaymoScenarioExportPayload(scenario: WaymoScenario, options?: { exportedAt?: string }): WaymoScenarioExportPayload {
  const exportedAt = options?.exportedAt ?? new Date().toISOString();
  const resolveNumericId = createNumericIdResolver();
  const scenarioIdSource = scenario.metadata.id ?? 'scenario';
  const scenarioId = toInteger(scenarioIdSource) ?? resolveNumericId(scenarioIdSource);

  const tlStates = (() => {
    const raw = cloneIfObject(scenario.raw) as Record<string, unknown> | undefined;
    if (raw && Array.isArray(raw.tl_states)) {
      return cloneIfObject(raw.tl_states) as unknown[];
    }
    return [];
  })();

  return {
    name: scenario.metadata.name ?? 'Scenario',
    scenario_id: scenarioId,
    objects: scenario.agents.map((agent) => mapAgentToWaymoObject(agent, resolveNumericId)),
    roads: scenario.roadEdges.map((edge) => mapRoadToWaymoRoad(edge, resolveNumericId)),
    tracks_to_predict: buildTrackPredictionEntries(scenario.tracksToPredict),
    tl_states: tlStates,
    metadata: buildWaymoMetadata(scenario, exportedAt, scenarioId)
  };
}

export function buildScenarioExportPayload(scenario: WaymoScenario): ScenarioExportPayload {
  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    metadata: { ...scenario.metadata },
    bounds: scenario.bounds ? { ...scenario.bounds } : undefined,
    agents: cloneAgents(scenario.agents),
    tracksToPredict: [...scenario.tracksToPredict],
    roadEdges: cloneRoadEdges(scenario.roadEdges),
    frames: cloneFrames(scenario.frames)
  };
}

type BinaryWriter = {
  writeInt(value: number): void;
  writeFloat(value: number): void;
  toUint8Array(): Uint8Array;
};

function createBinaryWriter(): BinaryWriter {
  const bytes: number[] = [];
  const scratch = new ArrayBuffer(4);
  const scratchView = new DataView(scratch);
  const scratchBytes = new Uint8Array(scratch);

  return {
    writeInt(value: number) {
      scratchView.setInt32(0, Math.trunc(value) || 0, true);
      bytes.push(scratchBytes[0], scratchBytes[1], scratchBytes[2], scratchBytes[3]);
    },
    writeFloat(value: number) {
      scratchView.setFloat32(0, Number.isFinite(value) ? value : 0, true);
      bytes.push(scratchBytes[0], scratchBytes[1], scratchBytes[2], scratchBytes[3]);
    },
    toUint8Array() {
      return new Uint8Array(bytes);
    }
  };
}

function calculateTriangleArea(p1: WaymoVector3, p2: WaymoVector3, p3: WaymoVector3): number {
  return 0.5 * Math.abs((p1.x - p3.x) * (p2.y - p1.y) - (p1.x - p2.x) * (p3.y - p1.y));
}

function simplifyPolylineForBinary(points: WaymoVector3[], threshold: number): WaymoVector3[] {
  const numPoints = points.length;
  if (numPoints < 3) {
    return points;
  }

  const skip = new Array<boolean>(numPoints).fill(false);
  let skipChanged = true;

  while (skipChanged) {
    skipChanged = false;
    let k = 0;

    while (k < numPoints - 1) {
      let k1 = k + 1;
      while (k1 < numPoints - 1 && skip[k1]) {
        k1 += 1;
      }
      if (k1 >= numPoints - 1) {
        break;
      }

      let k2 = k1 + 1;
      while (k2 < numPoints && skip[k2]) {
        k2 += 1;
      }
      if (k2 >= numPoints) {
        break;
      }

      const area = calculateTriangleArea(points[k], points[k1], points[k2]);
      if (area < threshold) {
        skip[k1] = true;
        skipChanged = true;
        k = k2;
      } else {
        k = k1;
      }
    }
  }

  return points.filter((_, index) => !skip[index]);
}

function getComponent(
  items: Array<{ [key in 'x' | 'y' | 'z']?: number }> | undefined,
  index: number,
  component: 'x' | 'y' | 'z'
): number {
  if (!Array.isArray(items) || index >= items.length) {
    return 0;
  }

  const value = items[index]?.[component];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function getHeadingValue(headings: number[] | undefined, index: number): number {
  if (!Array.isArray(headings) || index >= headings.length) {
    return 0;
  }

  const value = headings[index];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function getBooleanFlag(values: Array<boolean | number> | undefined, index: number): number {
  if (!Array.isArray(values) || index >= values.length) {
    return 0;
  }

  const value = values[index];
  if (typeof value === 'boolean') {
    return value ? 1 : 0;
  }
  if (typeof value === 'number') {
    return value !== 0 ? 1 : 0;
  }
  return 0;
}

function toFiniteOrZero(value: unknown): number {
  const numeric = toFiniteNumber(value);
  return numeric ?? 0;
}

function mapAgentTypeToBinary(type: unknown): number {
  if (typeof type === 'number' && Number.isFinite(type)) {
    return Math.trunc(type);
  }

  switch (typeof type === 'string' ? type.toLowerCase() : '') {
    case 'vehicle':
      return 1;
    case 'pedestrian':
      return 2;
    case 'cyclist':
      return 3;
    default:
      return 1;
  }
}

function normaliseRoadTypeSource(value: unknown): number {
  const numeric = toFiniteNumber(value);
  return numeric != null ? Math.trunc(numeric) : 0;
}

function mapRoadTypeCategory(rawType: number): number {
  let type = rawType;
  if (type >= 0 && type <= 3) {
    type = 4;
  } else if (type >= 5 && type <= 13) {
    type = 5;
  } else if (type >= 14 && type <= 16) {
    type = 6;
  } else if (type === 17) {
    type = 7;
  } else if (type === 18) {
    type = 8;
  } else if (type === 19) {
    type = 9;
  } else if (type === 20) {
    type = 10;
  }
  return type;
}

function buildWaymoBinaryFromPayload(payload: WaymoScenarioExportPayload): Uint8Array {
  const writer = createBinaryWriter();
  const objects = Array.isArray(payload.objects) ? payload.objects : [];
  const roads = Array.isArray(payload.roads) ? payload.roads : [];

  writer.writeInt(objects.length);
  writer.writeInt(roads.length);

  objects.forEach((object) => {
    const typeCode = mapAgentTypeToBinary(object.type);
    writer.writeInt(typeCode);
    writer.writeInt(TRAJECTORY_LENGTH);

    const positions = Array.isArray(object.position) ? object.position : [];
    const velocities = Array.isArray(object.velocity) ? object.velocity : [];
    const headings = Array.isArray(object.heading) ? object.heading : [];
    const valids = Array.isArray(object.valid) ? object.valid : [];

    (['x', 'y', 'z'] as const).forEach((axis) => {
      for (let i = 0; i < TRAJECTORY_LENGTH; i += 1) {
        writer.writeFloat(getComponent(positions, i, axis));
      }
    });

    (['x', 'y', 'z'] as const).forEach((axis) => {
      for (let i = 0; i < TRAJECTORY_LENGTH; i += 1) {
        writer.writeFloat(getComponent(velocities, i, axis));
      }
    });

    for (let i = 0; i < TRAJECTORY_LENGTH; i += 1) {
      writer.writeFloat(getHeadingValue(headings, i));
    }

    for (let i = 0; i < TRAJECTORY_LENGTH; i += 1) {
      writer.writeInt(getBooleanFlag(valids, i));
    }

    writer.writeFloat(toFiniteOrZero(object.width));
    writer.writeFloat(toFiniteOrZero(object.length));
    writer.writeFloat(toFiniteOrZero(object.height));

    const goal = object.goalPosition ?? { x: 0, y: 0, z: 0 };
    writer.writeFloat(toFiniteOrZero(goal.x));
    writer.writeFloat(toFiniteOrZero(goal.y));
    writer.writeFloat(toFiniteOrZero(goal.z));

    writer.writeInt(object.mark_as_expert ? 1 : 0);
  });

  roads.forEach((road) => {
    let geometry = Array.isArray(road.geometry)
      ? road.geometry.map((point) => ({
          x: toFiniteOrZero(point.x),
          y: toFiniteOrZero(point.y),
          z: toFiniteOrZero(point.z)
        }))
      : [];

    let roadType = normaliseRoadTypeSource(road.map_element_id);
    const roadTypeWord = typeof road.type === 'string' ? road.type.toLowerCase() : '';

    if (roadTypeWord === 'lane') {
      roadType = 2;
    } else if (roadTypeWord === 'road_edge') {
      roadType = 15;
    }

    if (geometry.length > 10 && roadType <= 16) {
      geometry = simplifyPolylineForBinary(geometry, 0.1);
    }

    const encodedRoadType = mapRoadTypeCategory(roadType);
    writer.writeInt(encodedRoadType);
    writer.writeInt(geometry.length);

    (['x', 'y', 'z'] as const).forEach((axis) => {
      geometry.forEach((point) => {
        writer.writeFloat(point[axis]);
      });
    });

    writer.writeFloat(toFiniteOrZero(road.width));
    writer.writeFloat(toFiniteOrZero(road.length));
    writer.writeFloat(toFiniteOrZero(road.height));

    const goal = road.goalPosition ?? { x: 0, y: 0, z: 0 };
    writer.writeFloat(toFiniteOrZero(goal.x));
    writer.writeFloat(toFiniteOrZero(goal.y));
    writer.writeFloat(toFiniteOrZero(goal.z));

    writer.writeInt(road.mark_as_expert ? 1 : 0);
  });

  return writer.toUint8Array();
}

export function buildScenarioBinary(scenario: WaymoScenario, options?: { exportedAt?: string }): Uint8Array {
  const exportedAt = options?.exportedAt ?? new Date().toISOString();
  const payload = buildWaymoScenarioExportPayload(scenario, { exportedAt });
  return buildWaymoBinaryFromPayload(payload);
}

export function downloadScenarioAsBinary(
  scenario: WaymoScenario,
  options?: { fileName?: string }
): void {
  if (typeof window === 'undefined') {
    return;
  }

  const exportedAt = new Date().toISOString();
  const binary = buildScenarioBinary(scenario, { exportedAt });
  const buffer = new ArrayBuffer(binary.byteLength);
  new Uint8Array(buffer).set(binary);
  const blob = new Blob([buffer], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  const fileName = sanitizeFileName(options?.fileName ?? scenario.metadata.name ?? 'scenario');

  anchor.href = url;
  anchor.download = `${fileName}.bin`;
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);

  window.setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 1000);
}

function sanitizeFileName(name: string): string {
  return name
    .trim()
    .replace(/\s+/g, '_')
    .replace(/[^a-zA-Z0-9_.-]/g, '')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    || 'scenario';
}

export function downloadScenarioAsJson(
  scenario: WaymoScenario,
  options?: { fileName?: string }
): void {
  if (typeof window === 'undefined') {
    return;
  }

  const exportedAt = new Date().toISOString();
  const payload = buildWaymoScenarioExportPayload(scenario, { exportedAt });
  const json = JSON.stringify(payload, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  const fileName = sanitizeFileName(options?.fileName ?? scenario.metadata.name ?? 'scenario');

  anchor.href = url;
  anchor.download = `${fileName}.json`;
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);

  window.setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 1000);
}
