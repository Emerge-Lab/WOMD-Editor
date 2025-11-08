import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PropsWithChildren
} from 'react';
import { parseScenario } from '@/lib/scenarioParser';
import {
  AgentType,
  RoadEdge,
  ScenarioAgent,
  ScenarioBounds,
  ScenarioFrame,
  ScenarioFrameAgentState,
  TrajectoryPoint,
  WaymoScenario
} from '@/types/scenario';

export type EditingMode = 'trajectory' | 'road';
export type EditingTool = 'select' | 'trajectory-record' | 'trajectory-drive' | 'trajectory-edit' | 'road-add' | 'road-edit';
export type EditingEntityKind = 'agent' | 'roadEdge';

export interface EditingEntityRef {
  kind: EditingEntityKind;
  id: string;
}

export interface RoadHandleRef {
  roadId: string;
  pointIndex: number;
}

export interface RoadSegmentRef {
  roadId: string;
  segmentIndex: number;
  distance?: number;
}

export interface TrajectorySample {
  x: number;
  y: number;
  timestampMs: number;
}

export interface TrajectoryDraft {
  agentId: string;
  startedAtMs: number;
  lastSampledAtMs: number;
  samples: TrajectorySample[];
}

export interface RoadDraftPoint {
  x: number;
  y: number;
  z?: number;
}

export interface RoadDraft {
  id: string;
  scenarioId: string;
  type: RoadEdge['type'];
  points: RoadDraftPoint[];
}

export interface EditingHistoryEntry {
  id: string;
  label: string;
  timestamp: number;
}

interface EditingHistoryState {
  undoStack: EditingHistoryEntry[];
  redoStack: EditingHistoryEntry[];
}

export interface EditingState {
  mode: EditingMode;
  activeTool: EditingTool;
  rotationMode: 'path' | 'pose';
  roadDraftElevation: number;
  colorRoadVerticesByElevation: boolean;
  hoveredEntity?: EditingEntityRef;
  selectedEntity?: EditingEntityRef;
  hoveredRoadHandle?: RoadHandleRef;
  hoveredRoadSegment?: RoadSegmentRef;
  selectedRoadHandle?: RoadHandleRef;
  isRecording: boolean;
  trajectoryDraft?: TrajectoryDraft;
  roadDraft?: RoadDraft;
  history: EditingHistoryState;
}

function createInitialEditingState(): EditingState {
  return {
    mode: 'trajectory',
    activeTool: 'trajectory-edit',
    rotationMode: 'path',
    roadDraftElevation: 0,
    colorRoadVerticesByElevation: false,
    hoveredEntity: undefined,
    selectedEntity: undefined,
    hoveredRoadHandle: undefined,
    hoveredRoadSegment: undefined,
    selectedRoadHandle: undefined,
    isRecording: false,
    trajectoryDraft: undefined,
    roadDraft: undefined,
    history: {
      undoStack: [],
      redoStack: []
    }
  };
}

const MIN_BOUND_SPAN_METERS = 40;

function ensureBoundsSpan(bounds: ScenarioBounds, minSpan = MIN_BOUND_SPAN_METERS): ScenarioBounds {
  let { minX, maxX, minY, maxY } = bounds;
  const spanX = maxX - minX;
  const spanY = maxY - minY;

  if (spanX < minSpan) {
    const centerX = (minX + maxX) / 2;
    minX = centerX - minSpan / 2;
    maxX = centerX + minSpan / 2;
  }

  if (spanY < minSpan) {
    const centerY = (minY + maxY) / 2;
    minY = centerY - minSpan / 2;
    maxY = centerY + minSpan / 2;
  }

  return { minX, maxX, minY, maxY };
}

function computeBoundsFromAgents(agents: ScenarioAgent[]): ScenarioBounds | undefined {
  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  let hasPoints = false;

  agents.forEach((agent) => {
    agent.trajectory.forEach((point) => {
      if (point.valid === false) {
        return;
      }

      hasPoints = true;
      minX = Math.min(minX, point.x);
      maxX = Math.max(maxX, point.x);
      minY = Math.min(minY, point.y);
      maxY = Math.max(maxY, point.y);
    });
  });

  if (!hasPoints) {
    return undefined;
  }

  return ensureBoundsSpan({ minX, maxX, minY, maxY });
}

function normalizeAngle(angle: number): number {
  let next = angle;
  while (next <= -Math.PI) {
    next += Math.PI * 2;
  }
  while (next > Math.PI) {
    next -= Math.PI * 2;
  }
  return next;
}

const REVERSAL_HEADING_THRESHOLD = Math.PI - Math.PI / 18;

function deriveHeadingFromPoints(prevPoint: TrajectoryPoint | undefined, currentPoint: TrajectoryPoint): number | undefined {
  if (!prevPoint) {
    return undefined;
  }

  const dx = currentPoint.x - prevPoint.x;
  const dy = currentPoint.y - prevPoint.y;
  if (Math.abs(dx) < 1e-4 && Math.abs(dy) < 1e-4) {
    return undefined;
  }

  return Math.atan2(dy, dx);
}

function resolveStableHeading(
  point: TrajectoryPoint,
  previousHeading: number | undefined,
  previousPoint: TrajectoryPoint | undefined
): number | undefined {
  const baseHeading = typeof point.heading === 'number'
    ? point.heading
    : deriveHeadingFromPoints(previousPoint, point);

  if (baseHeading === undefined) {
    return previousHeading;
  }

  const normalizedCandidate = normalizeAngle(baseHeading);

  if (previousHeading === undefined) {
    return normalizedCandidate;
  }

  const delta = normalizeAngle(normalizedCandidate - previousHeading);
  if (Math.abs(delta) > REVERSAL_HEADING_THRESHOLD) {
    const flipped = normalizeAngle(normalizedCandidate - Math.PI * Math.sign(delta || 1));
    const flippedDelta = normalizeAngle(flipped - previousHeading);
    if (Math.abs(flippedDelta) < Math.abs(delta)) {
      return flipped;
    }
  }

  return normalizeAngle(previousHeading + delta);
}

function buildFramesFromAgents(
  agents: ScenarioAgent[],
  frameIntervalMicros: number,
  frameCountOverride?: number
): ScenarioFrame[] {
  const computedFrameCount = agents.reduce((max, agent) => {
    const agentFrameCount = agent.trajectory.reduce((innerMax, point) => {
      if (typeof point.frameIndex === 'number') {
        return Math.max(innerMax, point.frameIndex + 1);
      }
      return innerMax;
    }, 0);
    return Math.max(max, agentFrameCount);
  }, 0);

  const frameCount = frameCountOverride != null
    ? Math.max(frameCountOverride, computedFrameCount)
    : computedFrameCount;

  const effectiveFrameCount = frameCount > 0
    ? frameCount
    : Math.max(
        ...agents.map((agent) => {
          const indices = agent.trajectory.map((point) => point.frameIndex ?? 0);
          return indices.length > 0 ? Math.max(...indices) + 1 : 0;
        }),
        0
      );

  if (effectiveFrameCount <= 0) {
    return [];
  }

  const frames: ScenarioFrame[] = Array.from({ length: effectiveFrameCount }, (_, index) => ({
    index,
    timestampMicros: index * frameIntervalMicros,
    agents: [] as ScenarioFrameAgentState[]
  }));

  agents.forEach((agent) => {
    const { id, type, dimensions } = agent;
    const orderedPoints = [...agent.trajectory].sort((a, b) => (a.frameIndex ?? Number.POSITIVE_INFINITY) - (b.frameIndex ?? Number.POSITIVE_INFINITY));
    let previousHeading: number | undefined;
    let previousPoint: TrajectoryPoint | undefined;

    orderedPoints.forEach((point) => {
      if (point.frameIndex === undefined) {
        return;
      }

      const frame = frames[point.frameIndex];
      if (!frame) {
        return;
      }

      const headingForFrame = resolveStableHeading(point, previousHeading, previousPoint);
      if (headingForFrame !== undefined) {
        previousHeading = headingForFrame;
      } else if (typeof point.heading === 'number') {
        previousHeading = normalizeAngle(point.heading);
      }

      if (point.valid !== false) {
        previousPoint = point;
      }

      frame.agents.push({
        id,
        type,
        x: point.x,
        y: point.y,
        z: point.z,
        heading: headingForFrame ?? point.heading,
        width: dimensions?.width,
        length: dimensions?.length,
        height: dimensions?.height,
        speed: point.speed,
        velocityX: point.velocityX,
        velocityY: point.velocityY,
        valid: point.valid !== false
      });
    });
  });

  return frames;
}

function remapTracksToPredict(base: WaymoScenario, nextAgents: ScenarioAgent[]): number[] {
  if (!base.tracksToPredict || base.tracksToPredict.length === 0) {
    return [];
  }

  const baseIdByIndex = base.agents.map((agent) => agent.id);
  const nextIndexById = new Map<string, number>();
  nextAgents.forEach((agent, index) => {
    nextIndexById.set(agent.id, index);
  });

  const remapped = base.tracksToPredict
    .map((index) => baseIdByIndex[index])
    .filter((id): id is string => typeof id === 'string' && nextIndexById.has(id))
    .map((id) => nextIndexById.get(id))
    .filter((index): index is number => typeof index === 'number');

  return Array.from(new Set(remapped)).sort((a, b) => a - b);
}

function withScenarioRebuild(base: WaymoScenario, nextAgents: ScenarioAgent[]): WaymoScenario {
  const frameInterval = base.metadata.frameIntervalMicros ?? DEFAULT_FRAME_INTERVAL_MICROS;
  const fallbackFrameCount = Math.max(base.metadata.frameCount, base.frames.length, 1);
  const overrideFrameCount = nextAgents.length === 0 ? fallbackFrameCount : undefined;
  const frames = buildFramesFromAgents(nextAgents, frameInterval, overrideFrameCount);
  const frameCount = frames.length;
  const computedDurationSeconds = frameCount > 0 ? ((frameCount - 1) * frameInterval) / 1_000_000 : 0;
  const durationSeconds = nextAgents.length === 0
    ? (base.metadata.durationSeconds ?? computedDurationSeconds)
    : computedDurationSeconds;
  const nextBounds = computeBoundsFromAgents(nextAgents) ?? base.bounds;
  const tracksToPredict = remapTracksToPredict(base, nextAgents);

  return {
    ...base,
    agents: nextAgents,
    tracksToPredict,
    frames,
    bounds: nextBounds,
    metadata: {
      ...base.metadata,
      frameCount,
      durationSeconds
    }
  };
}

function findFirstValidPoint(points: TrajectoryPoint[]): TrajectoryPoint | undefined {
  return points.find((point) => point.valid !== false);
}

const MAX_HISTORY_ENTRIES = 50;
const BASIC_UNDO_LIMIT = 3;

function cloneScenarioState(scenario: WaymoScenario): WaymoScenario {
  let clone: WaymoScenario;
  if (typeof globalThis.structuredClone === 'function') {
    clone = globalThis.structuredClone(scenario);
  } else {
    clone = JSON.parse(JSON.stringify(scenario)) as WaymoScenario;
  }

  if ('raw' in clone) {
    clone.raw = undefined;
  }

  return clone;
}

function serializeScenarioState(scenario: WaymoScenario | undefined): string {
  if (!scenario) {
    return '';
  }

  try {
    return JSON.stringify(scenario);
  } catch (error) {
    console.error('Failed to serialize scenario', error);
    return '';
  }
}

function sanitiseRoadPoint(point: RoadDraftPoint): RoadDraftPoint | undefined {
  const x = Number(point.x);
  const y = Number(point.y);
  const z = typeof point.z === 'number' && Number.isFinite(point.z) ? point.z : undefined;
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    return undefined;
  }
  return typeof z === 'number' ? { x, y, z } : { x, y };
}

function sanitiseRoadPoints(points: RoadDraftPoint[]): RoadDraftPoint[] {
  return points
    .map((point) => sanitiseRoadPoint(point))
    .filter((point): point is RoadDraftPoint => typeof point !== 'undefined');
}

function areRoadPointsEqual(a: RoadDraftPoint[], b: RoadDraftPoint[]) {
  if (a.length !== b.length) {
    return false;
  }

  for (let index = 0; index < a.length; index += 1) {
    const current = a[index];
    const candidate = b[index];
    const zEqual = (() => {
      const hasCurrentZ = typeof current.z === 'number';
      const hasCandidateZ = typeof candidate.z === 'number';
      if (!hasCurrentZ && !hasCandidateZ) {
        return true;
      }
      if (hasCurrentZ && hasCandidateZ) {
        return Math.abs((current.z as number) - (candidate.z as number)) <= 1e-6;
      }
      return false;
    })();
    if (
      Math.abs(current.x - candidate.x) > 1e-6
      || Math.abs(current.y - candidate.y) > 1e-6
      || !zEqual
    ) {
      return false;
    }
  }

  return true;
}

const DEFAULT_AGENT_DIMENSIONS: Record<AgentType, { length: number; width: number; height?: number }> = {
  VEHICLE: { length: 4.5, width: 2.0, height: 1.6 },
  PEDESTRIAN: { length: 0.8, width: 0.8, height: 1.8 },
  CYCLIST: { length: 1.8, width: 0.6, height: 1.6 },
  OTHER: { length: 2.0, width: 1.0, height: 1.5 }
};

function areAgentDimensionsEqual(
  a: ScenarioAgent['dimensions'] | undefined,
  b: ScenarioAgent['dimensions'] | undefined
): boolean {
  if (!a && !b) {
    return true;
  }
  if (!a || !b) {
    return false;
  }

  const epsilon = 1e-6;
  const heightA = typeof a.height === 'number' ? a.height : undefined;
  const heightB = typeof b.height === 'number' ? b.height : undefined;

  const heightEqual = heightA === undefined && heightB === undefined
    ? true
    : heightA !== undefined && heightB !== undefined && Math.abs(heightA - heightB) < epsilon;

  return (
    Math.abs(a.length - b.length) < epsilon
    && Math.abs(a.width - b.width) < epsilon
    && heightEqual
  );
}

function transformAgentTrajectory(
  agent: ScenarioAgent,
  anchorPoint: TrajectoryPoint,
  targetAnchorX: number,
  targetAnchorY: number,
  deltaHeadingRad: number
): ScenarioAgent {
  const cos = Math.cos(deltaHeadingRad);
  const sin = Math.sin(deltaHeadingRad);

  const updatedTrajectory = agent.trajectory.map((point) => {
    const relX = point.x - anchorPoint.x;
    const relY = point.y - anchorPoint.y;
    const rotatedX = relX * cos - relY * sin;
    const rotatedY = relX * sin + relY * cos;

    const nextX = targetAnchorX + rotatedX;
    const nextY = targetAnchorY + rotatedY;

    const nextHeading = typeof point.heading === 'number' ? point.heading + deltaHeadingRad : point.heading;

    let nextVelocityX = point.velocityX;
    let nextVelocityY = point.velocityY;
    if (typeof point.velocityX === 'number' || typeof point.velocityY === 'number') {
      const vx = point.velocityX ?? 0;
      const vy = point.velocityY ?? 0;
      nextVelocityX = vx * cos - vy * sin;
      nextVelocityY = vx * sin + vy * cos;
    }

    return {
      ...point,
      x: nextX,
      y: nextY,
      heading: nextHeading,
      velocityX: nextVelocityX,
      velocityY: nextVelocityY
    };
  });

  return {
    ...agent,
    trajectory: updatedTrajectory
  };
}

function applyPoseOnlyHeading(
  agent: ScenarioAgent,
  anchorHeading: number,
  targetHeading: number
): ScenarioAgent {
  const deltaHeading = normalizeAngle(targetHeading - anchorHeading);
  if (Math.abs(deltaHeading) < 1e-6) {
    return agent;
  }

  const anchorIndex = agent.trajectory.findIndex((point) => point.valid !== false);
  const safeAnchorIndex = anchorIndex === -1 ? 0 : anchorIndex;

  const updatedTrajectory = agent.trajectory.map((point, index) => {
    let nextHeading = point.heading;
    if (typeof point.heading === 'number') {
      nextHeading = normalizeAngle(point.heading + deltaHeading);
    }

    if (index === safeAnchorIndex) {
      nextHeading = normalizeAngle(targetHeading);
    }

    return {
      ...point,
      heading: nextHeading
    };
  });

  return {
    ...agent,
    trajectory: updatedTrajectory
  };
}

function samplesToTrajectoryPoints(samples: TrajectorySample[], frameIntervalMicros: number): TrajectoryPoint[] {
  if (samples.length === 0) {
    return [];
  }

  const sorted = [...samples].sort((a, b) => a.timestampMs - b.timestampMs);
  const normalised = sorted.map((sample, index) => {
    const clampedTime = index === 0 ? 0 : Math.max(0, sample.timestampMs - sorted[0].timestampMs);
    return {
      x: sample.x,
      y: sample.y,
      timeMs: clampedTime
    };
  });

  // Collapse duplicate timestamps keeping the latest position.
  const collapsed: typeof normalised = [];
  normalised.forEach((current) => {
    const last = collapsed[collapsed.length - 1];
    if (!last || Math.abs(last.timeMs - current.timeMs) > 0.0001) {
      collapsed.push(current);
      return;
    }
    collapsed[collapsed.length - 1] = current;
  });

  const points = collapsed;
  const totalDurationMs = points[points.length - 1]?.timeMs ?? 0;
  const frameIntervalMs = frameIntervalMicros / 1000;
  const finalFrameIndex = totalDurationMs > 0 ? Math.ceil(totalDurationMs / frameIntervalMs) : 0;

  const trajectory: TrajectoryPoint[] = [];
  let segmentIndex = 0;
  let lastFrameTimeMs = 0;

  for (let frameIndex = 0; frameIndex <= finalFrameIndex; frameIndex += 1) {
    const targetMs = frameIndex === finalFrameIndex ? totalDurationMs : Math.min(frameIndex * frameIntervalMs, totalDurationMs);

    while (segmentIndex < points.length - 2 && points[segmentIndex + 1].timeMs < targetMs) {
      segmentIndex += 1;
    }

    const current = points[segmentIndex];
    const next = points[Math.min(segmentIndex + 1, points.length - 1)];
    const spanMs = Math.max(next.timeMs - current.timeMs, 0);
    const alpha = spanMs > 0 ? Math.min(Math.max((targetMs - current.timeMs) / spanMs, 0), 1) : 0;

    const x = current.x + (next.x - current.x) * alpha;
    const y = current.y + (next.y - current.y) * alpha;

    let heading = 0;
    const headingDx = next.x - current.x;
    const headingDy = next.y - current.y;
    if (Math.abs(headingDx) > 1e-4 || Math.abs(headingDy) > 1e-4) {
      heading = Math.atan2(headingDy, headingDx);
    } else if (trajectory.length > 0) {
      heading = trajectory[trajectory.length - 1].heading ?? 0;
    }

    let velocityX = 0;
    let velocityY = 0;
    let speed = 0;
    if (trajectory.length > 0) {
      const prev = trajectory[trajectory.length - 1];
      const deltaTimeSec = Math.max((targetMs - lastFrameTimeMs) / 1000, 1e-4);
      velocityX = (x - prev.x) / deltaTimeSec;
      velocityY = (y - prev.y) / deltaTimeSec;
      speed = Math.hypot(velocityX, velocityY);
    }

    trajectory.push({
      frameIndex,
      timestampMicros: Math.round(targetMs * 1000),
      x,
      y,
      heading,
      velocityX,
      velocityY,
      speed,
      valid: true
    });

    lastFrameTimeMs = targetMs;
  }

  smoothTrajectoryHeadings(trajectory);

  return trajectory;
}

function smoothTrajectoryHeadings(points: TrajectoryPoint[]): void {
  if (points.length === 0) {
    return;
  }

  const windowRadius = 2;
  const smoothedHeadings: number[] = Array(points.length).fill(0);

  for (let index = 0; index < points.length; index += 1) {
    let sumX = 0;
    let sumY = 0;
    let count = 0;

    for (let offset = -windowRadius; offset <= windowRadius; offset += 1) {
      const neighbor = points[index + offset];
      if (!neighbor) {
        continue;
      }

      const vx = neighbor.velocityX ?? 0;
      const vy = neighbor.velocityY ?? 0;
      const magnitude = Math.hypot(vx, vy);
      if (magnitude < 1e-3) {
        continue;
      }

      sumX += vx / magnitude;
      sumY += vy / magnitude;
      count += 1;
    }

    if (count === 0) {
      const previousHeading = index > 0 ? smoothedHeadings[index - 1] : points[index].heading ?? 0;
      smoothedHeadings[index] = previousHeading;
    } else {
      smoothedHeadings[index] = Math.atan2(sumY / count, sumX / count);
    }
  }

  for (let index = 0; index < points.length; index += 1) {
    points[index].heading = smoothedHeadings[index];
  }
}

export type ScenarioSource = 'example' | 'uploaded' | 'blank';

const DEFAULT_FRAME_INTERVAL_MICROS = 100_000;

export type AgentLabelMode = 'id' | 'index';

interface ScenarioHistoryState {
  undo: WaymoScenario[];
  redo: WaymoScenario[];
}

interface BasicUndoSnapshot {
  serialized: string;
  name: string;
  source: ScenarioSource;
}

interface BasicUndoBucket {
  history: BasicUndoSnapshot[];
  lastSerialized?: string;
  lastName?: string;
  lastSource?: ScenarioSource;
}

export interface ScenarioResource {
  id: string;
  name: string;
  source: ScenarioSource;
  scenario: WaymoScenario;
  baseline?: WaymoScenario;
}

export interface EditingStoreValue {
  state: EditingState;
  setMode: (mode: EditingMode) => void;
  setTool: (tool: EditingTool) => void;
  setRotationMode: (mode: 'path' | 'pose') => void;
  setRoadDraftElevation: (value: number) => void;
  setColorRoadVerticesByElevation: (enabled: boolean) => void;
  hoverEntity: (ref?: EditingEntityRef) => void;
  selectEntity: (ref?: EditingEntityRef) => void;
  clearSelection: () => void;
  setHoveredRoadHandle: (ref?: RoadHandleRef) => void;
  setHoveredRoadSegment: (ref?: RoadSegmentRef) => void;
  setSelectedRoadHandle: (ref?: RoadHandleRef) => void;
  beginTrajectoryRecording: (input: { agentId: string; startedAtMs?: number }) => void;
  appendTrajectorySample: (sample: TrajectorySample) => void;
  completeTrajectoryRecording: (options?: { label?: string }) => EditingHistoryEntry | undefined;
  cancelTrajectoryRecording: () => void;
  beginRoadDraft: (input: { scenarioId: string; type?: RoadEdge['type']; startPoint?: RoadDraftPoint }) => void;
  appendRoadDraftPoint: (point: RoadDraftPoint) => void;
  updateRoadDraftPoint: (index: number, point: RoadDraftPoint) => void;
  removeRoadDraftPoint: (index?: number) => void;
  completeRoadDraft: () => RoadDraft | undefined;
  cancelRoadDraft: () => void;
  pushHistoryEntry: (entry: EditingHistoryEntry) => void;
  undo: () => EditingHistoryEntry | undefined;
  redo: () => EditingHistoryEntry | undefined;
  canUndo: boolean;
  canRedo: boolean;
  reset: () => void;
}

interface ScenarioStoreValue {
  scenarios: ScenarioResource[];
  activeScenarioId?: string;
  activeScenario?: WaymoScenario;
  activeScenarioBaseline?: WaymoScenario;
  activeFrameIndex: number;
  activeFrame?: ScenarioFrame;
  isPlaying: boolean;
  playbackSpeed: number;
  visibleTrajectoryIds: ReadonlySet<string>;
  showAgentLabels: boolean;
  agentLabelMode: AgentLabelMode;
  selectScenario: (id: string) => void;
  setActiveFrameIndex: (index: number) => void;
  play: () => void;
  pause: () => void;
  setPlaybackSpeed: (speed: number) => void;
  toggleTrajectoryVisibility: (id: string) => void;
  showAllTrajectories: () => void;
  hideAllTrajectories: () => void;
  toggleAgentLabels: () => void;
  setAgentLabelMode: (mode: AgentLabelMode) => void;
  toggleAgentExpert: (scenarioId: string, agentId: string) => boolean;
  setAgentTrackPrediction: (scenarioId: string, agentId: string, shouldInclude: boolean) => boolean;
  updateAgentAttributes: (
    scenarioId: string,
    agentId: string,
    updates: {
      type?: AgentType;
      dimensions?: {
        length?: number;
        width?: number;
        height?: number | null;
      };
    }
  ) => boolean;
  removeAllAgents: (scenarioId: string) => boolean;
  spawnVehicleAgent: (scenarioId: string) => ScenarioAgent | undefined;
  removeScenario: (id: string) => void;
  loadScenarioFromJson: (payload: {
    json: unknown;
    name?: string;
    source?: ScenarioSource;
    preserveBasicUndoHistory?: boolean;
  }) => ScenarioResource;
  createBlankScenario: (name?: string) => ScenarioResource;
  updateScenario: (id: string, updater: (current: WaymoScenario) => WaymoScenario) => void;
  updateAgentStartPose: (
    scenarioId: string,
    agentId: string,
    next: { x?: number; y?: number; headingRadians?: number },
    options?: { rotationMode?: 'path' | 'pose' }
  ) => void;
  applyRecordedTrajectory: (
    scenarioId: string,
    agentId: string,
    samples: TrajectorySample[]
  ) => boolean;
  addRoadEdge: (
    scenarioId: string,
    input: { id?: string; type?: RoadEdge['type']; points: RoadDraftPoint[] }
  ) => RoadEdge | undefined;
  updateRoadEdgePoints: (
    scenarioId: string,
    roadId: string,
    points: RoadDraftPoint[]
  ) => boolean;
  updateRoadEdgePoint: (
    scenarioId: string,
    roadId: string,
    pointIndex: number,
    point: RoadDraftPoint
  ) => boolean;
  insertRoadEdgePoint: (
    scenarioId: string,
    roadId: string,
    point: RoadDraftPoint,
    options?: { afterIndex?: number }
  ) => number | undefined;
  splitRoadEdge: (
    scenarioId: string,
    roadId: string,
    splitIndex: number
  ) => {
    retained: RoadEdge;
    created: RoadEdge;
    createdIndex: number;
  } | undefined;
  removeRoadEdgePoint: (
    scenarioId: string,
    roadId: string,
    pointIndex: number
  ) => boolean;
  setRoadEdgeType: (
    scenarioId: string,
    roadId: string,
    type: RoadEdge['type']
  ) => boolean;
  removeRoadEdge: (scenarioId: string, roadId: string) => boolean;
  basicUndoStepsRemaining: number;
  basicUndo: () => boolean;
  editing: EditingStoreValue;
}

const ScenarioStoreContext = createContext<ScenarioStoreValue | undefined>(undefined);

function createResourceId(prefix = 'scenario'): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }

  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

export function ScenarioStoreProvider({ children }: PropsWithChildren<unknown>) {
  const [scenarios, setScenarios] = useState<ScenarioResource[]>([]);
  const [activeScenarioId, setActiveScenarioId] = useState<string | undefined>();
  const [activeFrameIndex, internalSetActiveFrameIndex] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [playbackSpeed, setPlaybackSpeedState] = useState(1);
  const [visibleTrajectoryIds, setVisibleTrajectoryIds] = useState<Set<string>>(new Set());
  const [showAgentLabels, setShowAgentLabels] = useState(true);
  const [agentLabelMode, setAgentLabelModeState] = useState<AgentLabelMode>('index');
  const [editingState, setEditingState] = useState<EditingState>(() => createInitialEditingState());
  const [scenarioHistory, setScenarioHistory] = useState<Record<string, ScenarioHistoryState>>({});
  const [basicUndoBuckets, setBasicUndoBuckets] = useState<Record<string, BasicUndoBucket>>({});
  const isApplyingHistoryRef = useRef(false);
  const isApplyingBasicUndoRef = useRef(false);

  const restoreScenarioSnapshot = useCallback((scenarioId: string, snapshot: WaymoScenario) => {
    const nextScenario = cloneScenarioState(snapshot);
    isApplyingHistoryRef.current = true;
    setScenarios((prev) => prev.map((resource) => (
      resource.id === scenarioId
        ? { ...resource, scenario: nextScenario }
        : resource
    )));
    isApplyingHistoryRef.current = false;

    setVisibleTrajectoryIds(new Set(nextScenario.agents.map((agent) => agent.id)));
    internalSetActiveFrameIndex((current) => {
      const frameCount = nextScenario.frames.length;
      if (frameCount === 0) {
        return 0;
      }
      return Math.min(Math.max(current, 0), frameCount - 1);
    });
    setIsPlaying(false);
  }, [setScenarios, setVisibleTrajectoryIds, internalSetActiveFrameIndex]);

  const applyScenarioUpdate = useCallback((scenarioId: string, mutator: (scenario: WaymoScenario) => WaymoScenario | undefined | null) => {
    let previousSnapshot: WaymoScenario | undefined;
    let previousSnapshotMeta: { name: string; source: ScenarioSource } | undefined;
    let didUpdate = false;

    setScenarios((prev) => prev.map((resource) => {
      if (resource.id !== scenarioId) {
        return resource;
      }

      const currentScenario = resource.scenario;
      const nextScenario = mutator(currentScenario);

      if (!nextScenario || nextScenario === currentScenario) {
        return resource;
      }

      if (!isApplyingHistoryRef.current) {
        if (!previousSnapshot) {
          previousSnapshot = cloneScenarioState(currentScenario);
          previousSnapshotMeta = {
            name: resource.name,
            source: resource.source
          };
        }
      }

      didUpdate = true;
      return {
        ...resource,
        scenario: nextScenario
      };
    }));

    if (previousSnapshot) {
      const snapshotCopy = previousSnapshot;
      setScenarioHistory((prev) => {
        const history = prev[scenarioId] ?? { undo: [], redo: [] };
        const undo = [...history.undo, snapshotCopy];
        if (undo.length > MAX_HISTORY_ENTRIES) {
          undo.shift();
        }
        return {
          ...prev,
          [scenarioId]: {
            undo,
            redo: []
          }
        };
      });

    }

    return didUpdate;
  }, [setScenarios, setScenarioHistory]);

  const undoScenarioState = useCallback((scenarioId: string) => {
    let snapshot: WaymoScenario | undefined;
    let didFind = false;

    setScenarioHistory((prev) => {
      const history = prev[scenarioId];
      if (!history || history.undo.length === 0) {
        return prev;
      }

      snapshot = history.undo[history.undo.length - 1];
      const undo = history.undo.slice(0, -1);
      const redo = [...history.redo];
      const currentScenarioState = scenarios.find((resource) => resource.id === scenarioId)?.scenario;
      if (currentScenarioState) {
        const currentClone = cloneScenarioState(currentScenarioState);
        redo.push(currentClone);
      }

      didFind = true;
      return {
        ...prev,
        [scenarioId]: {
          undo,
          redo
        }
      };
    });

    if (!didFind || !snapshot) {
      return false;
    }

    restoreScenarioSnapshot(scenarioId, snapshot);
    return true;
  }, [restoreScenarioSnapshot, scenarios, setScenarioHistory]);

  const redoScenarioState = useCallback((scenarioId: string) => {
    let snapshot: WaymoScenario | undefined;
    let didFind = false;

    setScenarioHistory((prev) => {
      const history = prev[scenarioId];
      if (!history || history.redo.length === 0) {
        return prev;
      }

      snapshot = history.redo[history.redo.length - 1];
      const redo = history.redo.slice(0, -1);
      const undo = [...history.undo];
      const currentScenarioState = scenarios.find((resource) => resource.id === scenarioId)?.scenario;
      if (currentScenarioState) {
        const currentClone = cloneScenarioState(currentScenarioState);
        undo.push(currentClone);
        if (undo.length > MAX_HISTORY_ENTRIES) {
          undo.shift();
        }
      }

      didFind = true;
      return {
        ...prev,
        [scenarioId]: {
          undo,
          redo
        }
      };
    });

    if (!didFind || !snapshot) {
      return false;
    }

    restoreScenarioSnapshot(scenarioId, snapshot);
    return true;
  }, [restoreScenarioSnapshot, scenarios, setScenarioHistory]);

  const selectScenario = useCallback((id: string) => {
    setActiveScenarioId(id);
  }, []);

  const upsertScenario = useCallback((resource: ScenarioResource) => {
    setScenarios((prev) => {
      const existingIndex = prev.findIndex((item) => item.id === resource.id);
      if (existingIndex === -1) {
        return [...prev, resource];
      }

      const next = [...prev];
      next.splice(existingIndex, 1, resource);
      return next;
    });
  }, []);

  const applyLoadedScenarioResource = useCallback((resource: ScenarioResource, options?: { preserveBasicUndoHistory?: boolean }) => {
    upsertScenario(resource);
    setActiveScenarioId(resource.id);
    internalSetActiveFrameIndex(0);
    setVisibleTrajectoryIds(new Set(resource.scenario.agents.map((agent) => agent.id)));
    setIsPlaying(false);
    setShowAgentLabels(true);
    setScenarioHistory((prev) => ({
      ...prev,
      [resource.id]: {
        undo: [],
        redo: []
      }
    }));
    const serialized = serializeScenarioState(resource.scenario);
    setBasicUndoBuckets((prev) => {
      const existing = prev[resource.id];
      const history = options?.preserveBasicUndoHistory ? existing?.history ?? [] : [];
      return {
        ...prev,
        [resource.id]: {
          history,
          lastSerialized: serialized,
          lastName: resource.name,
          lastSource: resource.source
        }
      };
    });
    setEditingState(() => createInitialEditingState());
  }, [
    upsertScenario,
    setActiveScenarioId,
    internalSetActiveFrameIndex,
    setVisibleTrajectoryIds,
    setIsPlaying,
    setShowAgentLabels,
    setScenarioHistory,
    setBasicUndoBuckets,
    setEditingState
  ]);

  const loadScenarioFromJson = useCallback<ScenarioStoreValue['loadScenarioFromJson']>(({ json, name, source = 'uploaded', preserveBasicUndoHistory = false }) => {
    const parsed = parseScenario(json);
    const baselineSnapshot = cloneScenarioState(parsed);

    const resource: ScenarioResource = {
      id: parsed.metadata.id || createResourceId('scenario'),
      name: name || parsed.metadata.name || 'Imported Scenario',
      source,
      scenario: parsed,
      baseline: baselineSnapshot
    };

    applyLoadedScenarioResource(resource, { preserveBasicUndoHistory });
    return resource;
  }, [applyLoadedScenarioResource]);

  const createBlankScenario = useCallback<ScenarioStoreValue['createBlankScenario']>((name) => {
    const scenario: WaymoScenario = {
      metadata: {
        id: createResourceId('blank'),
        name: name || 'Blank Scenario',
        frameCount: 0,
        durationSeconds: 0,
        frameIntervalMicros: undefined
      },
      agents: [],
      tracksToPredict: [],
      roadEdges: [],
      frames: [],
      bounds: undefined,
      raw: undefined
    };

    const resource: ScenarioResource = {
      id: scenario.metadata.id,
      name: scenario.metadata.name,
      source: 'blank',
      scenario,
      baseline: cloneScenarioState(scenario)
    };

    upsertScenario(resource);
    setActiveScenarioId(resource.id);
    internalSetActiveFrameIndex(0);
    setVisibleTrajectoryIds(new Set(scenario.agents.map((agent) => agent.id)));
    setIsPlaying(false);
    setShowAgentLabels(true);
    setScenarioHistory((prev) => ({
      ...prev,
      [resource.id]: {
        undo: [],
        redo: []
      }
    }));

    return resource;
  }, [upsertScenario]);

  const updateScenario = useCallback<ScenarioStoreValue['updateScenario']>((id, updater) => {
    applyScenarioUpdate(id, (scenario) => updater(scenario));
  }, [applyScenarioUpdate]);

  const removeScenario = useCallback<ScenarioStoreValue['removeScenario']>((id) => {
    setScenarios((prev) => prev.filter((resource) => resource.id !== id));
    setActiveScenarioId((current) => (current === id ? undefined : current));
    setVisibleTrajectoryIds(new Set());
    setIsPlaying(false);
    setShowAgentLabels(false);
    setScenarioHistory((prev) => {
      if (!(id in prev)) {
        return prev;
      }
      const { [id]: _removed, ...rest } = prev;
      return rest;
    });
    setBasicUndoBuckets((prev) => {
      if (!(id in prev)) {
        return prev;
      }
      const { [id]: _removed, ...rest } = prev;
      return rest;
    });
  }, []);

  const activeScenarioResource = useMemo(
    () => scenarios.find((resource) => resource.id === activeScenarioId),
    [scenarios, activeScenarioId]
  );
  const activeScenario = activeScenarioResource?.scenario;
  const activeScenarioBaseline = activeScenarioResource?.baseline;
  const activeScenarioName = activeScenarioResource?.name;
  const activeScenarioSource = activeScenarioResource?.source;
  const activeScenarioHistory = scenarioHistory[activeScenarioId ?? ''];
  const canUndo = (activeScenarioHistory?.undo.length ?? 0) > 0 && editingState.history.undoStack.length > 0;
  const canRedo = (activeScenarioHistory?.redo.length ?? 0) > 0 && editingState.history.redoStack.length > 0;
  const basicUndoStepsRemaining = activeScenarioId ? (basicUndoBuckets[activeScenarioId]?.history.length ?? 0) : 0;

  useEffect(() => {
    internalSetActiveFrameIndex(0);
    setVisibleTrajectoryIds((prev) => {
      if (!activeScenario) {
        return new Set();
      }

      if (prev.size === activeScenario.agents.length) {
        return prev;
      }

      return new Set(activeScenario.agents.map((agent) => agent.id));
    });
    setIsPlaying(false);
    setShowAgentLabels(Boolean(activeScenario));
  }, [activeScenarioId, activeScenario]);

  useEffect(() => {
    if (!activeScenarioId || !activeScenario) {
      return undefined;
    }

    const handlePointerCommit = () => {
      if (isApplyingBasicUndoRef.current) {
        return;
      }

      const currentSerialized = serializeScenarioState(activeScenario);
      if (!currentSerialized) {
        return;
      }

      const scenarioName = activeScenarioName ?? activeScenario.metadata.name ?? 'Scenario';
      const scenarioSource = activeScenarioSource ?? 'uploaded';

      setBasicUndoBuckets((prev) => {
        const bucket = prev[activeScenarioId];
        if (!bucket) {
          return {
            ...prev,
            [activeScenarioId]: {
              history: [],
              lastSerialized: currentSerialized,
              lastName: scenarioName,
              lastSource: scenarioSource
            }
          };
        }

        if (!bucket.lastSerialized) {
          return {
            ...prev,
            [activeScenarioId]: {
              history: bucket.history,
              lastSerialized: currentSerialized,
              lastName: scenarioName,
              lastSource: scenarioSource
            }
          };
        }

        if (bucket.lastSerialized === currentSerialized) {
          return prev;
        }

        const snapshot: BasicUndoSnapshot = {
          serialized: bucket.lastSerialized,
          name: bucket.lastName ?? scenarioName,
          source: bucket.lastSource ?? scenarioSource
        };
        const history = [...bucket.history, snapshot];
        if (history.length > BASIC_UNDO_LIMIT) {
          history.shift();
        }

        return {
          ...prev,
          [activeScenarioId]: {
            history,
            lastSerialized: currentSerialized,
            lastName: scenarioName,
            lastSource: scenarioSource
          }
        };
      });
    };

    window.addEventListener('mouseup', handlePointerCommit);
    return () => window.removeEventListener('mouseup', handlePointerCommit);
  }, [activeScenarioId, activeScenario, activeScenarioName, activeScenarioSource, setBasicUndoBuckets]);

  useEffect(() => {
    const frameCount = activeScenario?.frames.length ?? 0;
    internalSetActiveFrameIndex((current) => {
      if (frameCount === 0) {
        return 0;
      }
      return Math.min(Math.max(current, 0), frameCount - 1);
    });
  }, [activeScenario?.frames.length]);

  const setActiveFrameIndex = useCallback<ScenarioStoreValue['setActiveFrameIndex']>((index) => {
    internalSetActiveFrameIndex(() => {
      const frameCount = activeScenario?.frames.length ?? 0;
      if (frameCount === 0) {
        return 0;
      }
      return Math.min(Math.max(index, 0), frameCount - 1);
    });
  }, [activeScenario?.frames.length]);

  const activeFrame = useMemo(() => {
    if (!activeScenario) {
      return undefined;
    }

    return activeScenario.frames[activeFrameIndex];
  }, [activeScenario, activeFrameIndex]);

  useEffect(() => {
    if (!isPlaying || !activeScenario) {
      return undefined;
    }

    const frameIntervalMicros = activeScenario.metadata.frameIntervalMicros ?? DEFAULT_FRAME_INTERVAL_MICROS;
    const baseIntervalMs = frameIntervalMicros / 1000;
    const intervalMs = Math.max(baseIntervalMs / playbackSpeed, 16);

    const timer = window.setInterval(() => {
      internalSetActiveFrameIndex((current) => {
        const frameCount = activeScenario.frames.length;
        if (frameCount === 0) {
          return 0;
        }

        const next = current + 1;
        if (next >= frameCount) {
          setIsPlaying(false);
          return frameCount - 1;
        }

        return next;
      });
    }, intervalMs);

    return () => window.clearInterval(timer);
  }, [isPlaying, playbackSpeed, activeScenario]);

  const play = useCallback(() => {
    if (!activeScenario || activeScenario.frames.length === 0) {
      return;
    }

    internalSetActiveFrameIndex((current) => {
      const frameCount = activeScenario.frames.length;
      if (frameCount === 0) {
        return current;
      }

      if (current >= frameCount - 1) {
        return 0;
      }

      return current;
    });

    setIsPlaying(true);
  }, [activeScenario]);

  const pause = useCallback(() => {
    setIsPlaying(false);
  }, []);

  const handleSetPlaybackSpeed = useCallback((speed: number) => {
    setPlaybackSpeedState(Math.max(speed, 0.1));
  }, []);

  const toggleTrajectoryVisibility = useCallback<ScenarioStoreValue['toggleTrajectoryVisibility']>((id) => {
    setVisibleTrajectoryIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  const showAllTrajectories = useCallback(() => {
    if (!activeScenario) {
      setVisibleTrajectoryIds(new Set());
      return;
    }
    setVisibleTrajectoryIds(new Set(activeScenario.agents.map((agent) => agent.id)));
  }, [activeScenario]);

  const hideAllTrajectories = useCallback(() => {
    setVisibleTrajectoryIds(new Set());
  }, []);

  const toggleAgentLabels = useCallback(() => {
    setShowAgentLabels((prev) => !prev);
  }, []);

  const setAgentLabelMode = useCallback((mode: AgentLabelMode) => {
    setAgentLabelModeState(mode);
  }, []);

  const setAgentTrackPrediction = useCallback<ScenarioStoreValue['setAgentTrackPrediction']>((scenarioId, agentId, shouldInclude) => {
    let didUpdate = false;

    applyScenarioUpdate(scenarioId, (scenario) => {
      const agentIndex = scenario.agents.findIndex((agent) => agent.id === agentId);
      if (agentIndex === -1) {
        return scenario;
      }

      const next = new Set(scenario.tracksToPredict);
      const currentlyIncluded = next.has(agentIndex);

      if (shouldInclude === currentlyIncluded) {
        return scenario;
      }

      if (shouldInclude) {
        next.add(agentIndex);
      } else {
        next.delete(agentIndex);
      }

      didUpdate = true;

      return {
        ...scenario,
        tracksToPredict: Array.from(next).sort((a, b) => a - b)
      };
    });

    return didUpdate;
  }, [applyScenarioUpdate]);

  const toggleAgentExpert = useCallback<ScenarioStoreValue['toggleAgentExpert']>((scenarioId, agentId) => {
    let didUpdate = false;

    applyScenarioUpdate(scenarioId, (scenario) => {
      const targetIndex = scenario.agents.findIndex((agent) => agent.id === agentId);
      if (targetIndex === -1) {
        return scenario;
      }

      didUpdate = true;

      const nextAgents = scenario.agents.map((agent, index) => (
        index === targetIndex
          ? { ...agent, isExpert: !agent.isExpert }
          : agent
      ));

      return {
        ...scenario,
        agents: nextAgents
      };
    });

    return didUpdate;
  }, [applyScenarioUpdate]);

  const updateAgentAttributes = useCallback<ScenarioStoreValue['updateAgentAttributes']>((scenarioId, agentId, updates) => {
    let didUpdate = false;

    applyScenarioUpdate(scenarioId, (scenario) => {
      const targetIndex = scenario.agents.findIndex((agent) => agent.id === agentId);
      if (targetIndex === -1) {
        return scenario;
      }

      const agent = scenario.agents[targetIndex];
      const nextType = updates.type ?? agent.type;

      let nextDimensions = agent.dimensions;
      if (updates.dimensions) {
        const baseDimensions = agent.dimensions ?? DEFAULT_AGENT_DIMENSIONS[nextType];
        const { length, width, height } = updates.dimensions;

        const resolvePositive = (value: number | undefined, fallback?: number) => {
          if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
            return value;
          }
          return fallback;
        };

        const resolveOptional = (value: number | null | undefined, fallback?: number) => {
          if (value === null) {
            return undefined;
          }
          return resolvePositive(value ?? undefined, fallback);
        };

        const resolvedLength = resolvePositive(length, baseDimensions?.length);
        const resolvedWidth = resolvePositive(width, baseDimensions?.width);
        const resolvedHeight = resolveOptional(height, baseDimensions?.height);

        if (resolvedLength !== undefined && resolvedWidth !== undefined) {
          nextDimensions = {
            length: resolvedLength,
            width: resolvedWidth,
            ...(resolvedHeight !== undefined ? { height: resolvedHeight } : {})
          };
        }
      }

      const typeChanged = agent.type !== nextType;
      const dimensionsChanged = !areAgentDimensionsEqual(agent.dimensions, nextDimensions);
      if (!typeChanged && !dimensionsChanged) {
        return scenario;
      }

      didUpdate = true;

      const nextAgents = scenario.agents.map((item, index) => (
        index === targetIndex
          ? {
              ...item,
              type: nextType,
              dimensions: nextDimensions
            }
          : item
      ));

      return withScenarioRebuild(scenario, nextAgents);
    });

    return didUpdate;
  }, [applyScenarioUpdate]);

  const removeAllAgents = useCallback<ScenarioStoreValue['removeAllAgents']>((scenarioId) => {
    let didRemove = false;

    applyScenarioUpdate(scenarioId, (scenario) => {
      if (scenario.agents.length === 0) {
        return scenario;
      }

      didRemove = true;
      return withScenarioRebuild(scenario, []);
    });

    if (didRemove && activeScenarioId === scenarioId) {
      setVisibleTrajectoryIds(new Set());
    }

    return didRemove;
  }, [activeScenarioId, applyScenarioUpdate, setVisibleTrajectoryIds]);

  const spawnVehicleAgent = useCallback<ScenarioStoreValue['spawnVehicleAgent']>((scenarioId) => {
    let createdAgent: ScenarioAgent | undefined;

    applyScenarioUpdate(scenarioId, (scenario) => {
      const existingAgents = scenario.agents;
      const bounds = scenario.bounds ?? computeBoundsFromAgents(existingAgents) ?? {
        minX: -20,
        maxX: 20,
        minY: -20,
        maxY: 20
      };
      const centerX = (bounds.minX + bounds.maxX) / 2;
      const centerY = (bounds.minY + bounds.maxY) / 2;
      const spanX = bounds.maxX - bounds.minX;
      const spanY = bounds.maxY - bounds.minY;
      const radius = Math.max(Math.hypot(spanX, spanY) / 8, 6);
      const angle = (existingAgents.length * Math.PI) / 4;
      const spawnX = centerX + Math.cos(angle) * radius;
      const spawnY = centerY + Math.sin(angle) * radius;
      const frameInterval = scenario.metadata.frameIntervalMicros ?? DEFAULT_FRAME_INTERVAL_MICROS;

      let trajectory: TrajectoryPoint[];
      if (scenario.frames.length > 0) {
        trajectory = scenario.frames.map((frame) => ({
          frameIndex: frame.index,
          timestampMicros: frame.timestampMicros,
          x: spawnX,
          y: spawnY,
          heading: 0,
          velocityX: 0,
          velocityY: 0,
          speed: 0,
          valid: true
        }));
      } else {
        const frameCount = scenario.metadata.frameCount > 0 ? scenario.metadata.frameCount : 60;
        trajectory = Array.from({ length: frameCount }, (_, index) => ({
          frameIndex: index,
          timestampMicros: index * frameInterval,
          x: spawnX,
          y: spawnY,
          heading: 0,
          velocityX: 0,
          velocityY: 0,
          speed: 0,
          valid: true
        }));
      }

      const nextAgent: ScenarioAgent = {
        id: createResourceId('agent'),
        type: 'VEHICLE',
        displayName: `Vehicle ${existingAgents.length + 1}`,
        dimensions: { ...DEFAULT_AGENT_DIMENSIONS.VEHICLE },
        trajectory
      };

      createdAgent = nextAgent;

      const nextAgents = [...existingAgents, nextAgent];
      return withScenarioRebuild(scenario, nextAgents);
    });

    if (createdAgent && activeScenarioId === scenarioId) {
      setVisibleTrajectoryIds((prev) => {
        const next = new Set(prev);
        next.add(createdAgent!.id);
        return next;
      });
    }

    return createdAgent;
  }, [activeScenarioId, applyScenarioUpdate, setVisibleTrajectoryIds]);

  const resetEditing = useCallback(() => {
    setEditingState(() => createInitialEditingState());
  }, []);

  const setEditingMode = useCallback((mode: EditingMode) => {
    setEditingState((prev) => ({
      ...prev,
      mode,
      roadDraft: mode === 'road' ? prev.roadDraft : undefined
    }));
  }, []);

  const setEditingTool = useCallback((tool: EditingTool) => {
    setEditingState((prev) => {
      if (prev.activeTool === tool) {
        if (tool === 'road-add' || !prev.roadDraft) {
          return prev;
        }
      }

      return {
        ...prev,
        activeTool: tool,
        roadDraft: tool === 'road-add' ? prev.roadDraft : undefined
      };
    });
  }, []);

  const setRotationMode = useCallback((mode: 'path' | 'pose') => {
    setEditingState((prev) => ({
      ...prev,
      rotationMode: mode
    }));
  }, []);

  const setRoadDraftElevation = useCallback((value: number) => {
    if (!Number.isFinite(value)) {
      return;
    }
    setEditingState((prev) => {
      if (Math.abs(prev.roadDraftElevation - value) < 1e-6) {
        return prev;
      }
      return {
        ...prev,
        roadDraftElevation: value
      };
    });
  }, []);

  const setColorRoadVerticesByElevation = useCallback((enabled: boolean) => {
    setEditingState((prev) => {
      if (prev.colorRoadVerticesByElevation === enabled) {
        return prev;
      }
      return {
        ...prev,
        colorRoadVerticesByElevation: enabled
      };
    });
  }, []);

  const hoverEntity = useCallback((ref?: EditingEntityRef) => {
    setEditingState((prev) => ({
      ...prev,
      hoveredEntity: ref
    }));
  }, []);

  const selectEntity = useCallback((ref?: EditingEntityRef) => {
    setEditingState((prev) => {
      let selectedRoadHandle: RoadHandleRef | undefined;
      if (ref?.kind === 'roadEdge' && prev.selectedRoadHandle?.roadId === ref.id) {
        selectedRoadHandle = prev.selectedRoadHandle;
      } else if (ref?.kind === 'roadEdge') {
        selectedRoadHandle = undefined;
      } else {
        selectedRoadHandle = undefined;
      }

      return {
        ...prev,
        selectedEntity: ref,
        selectedRoadHandle
      };
    });
  }, []);

  const clearSelection = useCallback(() => {
    setEditingState((prev) => ({
      ...prev,
      selectedEntity: undefined,
      selectedRoadHandle: undefined
    }));
  }, []);

  const setHoveredRoadHandle = useCallback((ref?: RoadHandleRef) => {
    setEditingState((prev) => {
      const current = prev.hoveredRoadHandle;
      if (
        (!ref && !current)
        || (ref && current && ref.roadId === current.roadId && ref.pointIndex === current.pointIndex)
      ) {
        return prev;
      }

      return {
        ...prev,
        hoveredRoadHandle: ref
      };
    });
  }, []);

  const setHoveredRoadSegment = useCallback((ref?: RoadSegmentRef) => {
    setEditingState((prev) => {
      const current = prev.hoveredRoadSegment;
      if (
        (!ref && !current)
        || (
          ref
          && current
          && ref.roadId === current.roadId
          && ref.segmentIndex === current.segmentIndex
        )
      ) {
        return prev;
      }

      return {
        ...prev,
        hoveredRoadSegment: ref
      };
    });
  }, []);

  const setSelectedRoadHandle = useCallback((ref?: RoadHandleRef) => {
    setEditingState((prev) => {
      const current = prev.selectedRoadHandle;
      if (
        (!ref && !current)
        || (
          ref
          && current
          && ref.roadId === current.roadId
          && ref.pointIndex === current.pointIndex
        )
      ) {
        return prev;
      }

      return {
        ...prev,
        selectedRoadHandle: ref
      };
    });
  }, []);

  const beginRoadDraft = useCallback((input: { scenarioId: string; type?: RoadEdge['type']; startPoint?: RoadDraftPoint }) => {
    setEditingState((prev) => {
      const defaultZ = Number.isFinite(prev.roadDraftElevation) ? prev.roadDraftElevation : 0;
      const makePoint = (point: RoadDraftPoint): RoadDraftPoint => {
        const z = typeof point.z === 'number' && Number.isFinite(point.z) ? point.z : defaultZ;
        return Number.isFinite(z) ? { x: point.x, y: point.y, z } : { x: point.x, y: point.y };
      };

      return {
        ...prev,
        mode: 'road',
        activeTool: 'road-add',
        roadDraft: {
          id: createResourceId('road-draft'),
          scenarioId: input.scenarioId,
          type: input.type ?? 'ROAD_EDGE',
          points: input.startPoint ? [makePoint(input.startPoint)] : []
        }
      };
    });
  }, []);

  const appendRoadDraftPoint = useCallback((point: RoadDraftPoint) => {
    setEditingState((prev) => {
      if (!prev.roadDraft) {
        return prev;
      }

      const defaultZ = Number.isFinite(prev.roadDraftElevation) ? prev.roadDraftElevation : 0;
      const z = typeof point.z === 'number' && Number.isFinite(point.z) ? point.z : defaultZ;
      const nextPoint = Number.isFinite(z) ? { x: point.x, y: point.y, z } : { x: point.x, y: point.y };

      return {
        ...prev,
        roadDraft: {
          ...prev.roadDraft,
          points: [...prev.roadDraft.points, nextPoint]
        }
      };
    });
  }, []);

  const updateRoadDraftPoint = useCallback((index: number, point: RoadDraftPoint) => {
    setEditingState((prev) => {
      if (!prev.roadDraft || index < 0 || index >= prev.roadDraft.points.length) {
        return prev;
      }

      const points = [...prev.roadDraft.points];
      points.splice(index, 1, point);
      return {
        ...prev,
        roadDraft: {
          ...prev.roadDraft,
          points
        }
      };
    });
  }, []);

  const removeRoadDraftPoint = useCallback((index?: number) => {
    setEditingState((prev) => {
      if (!prev.roadDraft || prev.roadDraft.points.length === 0) {
        return prev;
      }

      const targetIndex = typeof index === 'number'
        ? index
        : prev.roadDraft.points.length - 1;

      if (targetIndex < 0 || targetIndex >= prev.roadDraft.points.length) {
        return prev;
      }

      const points = [...prev.roadDraft.points];
      points.splice(targetIndex, 1);

      return {
        ...prev,
        roadDraft: {
          ...prev.roadDraft,
          points
        }
      };
    });
  }, []);

  const completeRoadDraft = useCallback(() => {
    let resolvedDraft: RoadDraft | undefined;
    setEditingState((prev) => {
      if (!prev.roadDraft) {
        return prev;
      }

      resolvedDraft = prev.roadDraft;
      return {
        ...prev,
        roadDraft: undefined
      };
    });

    return resolvedDraft;
  }, []);

  const cancelRoadDraft = useCallback(() => {
    setEditingState((prev) => ({
      ...prev,
      roadDraft: undefined
    }));
  }, []);

  const beginTrajectoryRecording = useCallback((input: { agentId: string; startedAtMs?: number }) => {
    const now = input.startedAtMs ?? (typeof performance !== 'undefined' ? performance.now() : Date.now());
    setEditingState((prev) => ({
      ...prev,
      mode: 'trajectory',
      activeTool: 'trajectory-record',
      selectedEntity: { kind: 'agent', id: input.agentId },
      isRecording: true,
      trajectoryDraft: {
        agentId: input.agentId,
        startedAtMs: now,
        lastSampledAtMs: now,
        samples: []
      }
    }));
  }, []);

  const appendTrajectorySample = useCallback((sample: TrajectorySample) => {
    setEditingState((prev) => {
      if (!prev.isRecording || !prev.trajectoryDraft) {
        return prev;
      }

      return {
        ...prev,
        trajectoryDraft: {
          ...prev.trajectoryDraft,
          lastSampledAtMs: sample.timestampMs,
          samples: [...prev.trajectoryDraft.samples, sample]
        }
      };
    });
  }, []);

  const completeTrajectoryRecording = useCallback((options?: { label?: string }) => {
    let createdEntry: EditingHistoryEntry | undefined;
    setEditingState((prev) => {
      if (!prev.isRecording || !prev.trajectoryDraft) {
        return prev;
      }

      const label = options?.label?.trim();
      if (label) {
        createdEntry = {
          id: createResourceId('edit'),
          label,
          timestamp: Date.now()
        };
      }

      return {
        ...prev,
        activeTool: prev.activeTool === 'trajectory-record' || prev.activeTool === 'trajectory-drive'
          ? 'trajectory-edit'
          : prev.activeTool,
        isRecording: false,
        trajectoryDraft: undefined,
        history: createdEntry
          ? {
              undoStack: [...prev.history.undoStack, createdEntry],
              redoStack: []
            }
          : prev.history
      };
    });

    return createdEntry;
  }, []);

  const cancelTrajectoryRecording = useCallback(() => {
    setEditingState((prev) => ({
      ...prev,
      isRecording: false,
      trajectoryDraft: undefined,
      activeTool: prev.activeTool === 'trajectory-record'
        ? 'select'
        : prev.activeTool === 'trajectory-drive'
          ? 'trajectory-edit'
          : prev.activeTool
    }));
  }, []);

  const pushHistoryEntry = useCallback((entry: EditingHistoryEntry) => {
    setEditingState((prev) => ({
      ...prev,
      history: {
        undoStack: [...prev.history.undoStack, entry],
        redoStack: []
      }
    }));
  }, []);

  const undo = useCallback(() => {
    if (!activeScenarioId) {
      return undefined;
    }

    const reverted = undoScenarioState(activeScenarioId);
    if (!reverted) {
      return undefined;
    }

    let entry: EditingHistoryEntry | undefined;
    setEditingState((prev) => {
      if (prev.history.undoStack.length === 0) {
        return prev;
      }

      entry = prev.history.undoStack[prev.history.undoStack.length - 1];

      return {
        ...prev,
        history: {
          undoStack: prev.history.undoStack.slice(0, -1),
          redoStack: entry ? [entry, ...prev.history.redoStack] : prev.history.redoStack
        }
      };
    });

    return entry;
  }, [activeScenarioId, undoScenarioState]);

  const redo = useCallback(() => {
    if (!activeScenarioId) {
      return undefined;
    }

    const reapplied = redoScenarioState(activeScenarioId);
    if (!reapplied) {
      return undefined;
    }

    let entry: EditingHistoryEntry | undefined;
    setEditingState((prev) => {
      if (prev.history.redoStack.length === 0) {
        return prev;
      }

      entry = prev.history.redoStack[0];

      return {
        ...prev,
        history: {
          undoStack: entry ? [...prev.history.undoStack, entry] : prev.history.undoStack,
          redoStack: prev.history.redoStack.slice(1)
        }
      };
    });

    return entry;
  }, [activeScenarioId, redoScenarioState]);

  const updateAgentStartPose = useCallback<ScenarioStoreValue['updateAgentStartPose']>((scenarioId, agentId, next, options) => {
    const rotationMode = options?.rotationMode ?? 'path';

    applyScenarioUpdate(scenarioId, (scenario) => {
      const agent = scenario.agents.find((item) => item.id === agentId);
      if (!agent) {
        return scenario;
      }

      const anchorPoint = findFirstValidPoint(agent.trajectory) ?? agent.trajectory[0];
      if (!anchorPoint) {
        return scenario;
      }

      const anchorHeading = anchorPoint.heading ?? 0;
      const targetX = typeof next.x === 'number' ? next.x : anchorPoint.x;
      const targetY = typeof next.y === 'number' ? next.y : anchorPoint.y;
      const hasHeadingUpdate = typeof next.headingRadians === 'number';
      const targetHeading = hasHeadingUpdate ? (next.headingRadians as number) : anchorHeading;
      const deltaHeadingForPath = rotationMode === 'path' && hasHeadingUpdate
        ? targetHeading - anchorHeading
        : 0;

      const requiresTransform =
        Math.abs(targetX - anchorPoint.x) > 1e-6
        || Math.abs(targetY - anchorPoint.y) > 1e-6
        || Math.abs(deltaHeadingForPath) > 1e-6;

      let workingAgent = requiresTransform
        ? transformAgentTrajectory(agent, anchorPoint, targetX, targetY, deltaHeadingForPath)
        : agent;

      if (rotationMode === 'pose' && hasHeadingUpdate) {
        workingAgent = applyPoseOnlyHeading(workingAgent, anchorHeading, targetHeading);
      }

      if (workingAgent === agent) {
        return scenario;
      }

      const nextAgents = scenario.agents.map((item) => (item.id === agentId ? workingAgent : item));
      return withScenarioRebuild(scenario, nextAgents);
    });
  }, [applyScenarioUpdate]);

  const applyRecordedTrajectory = useCallback<ScenarioStoreValue['applyRecordedTrajectory']>((scenarioId, agentId, samples) => {
    if (samples.length === 0) {
      return false;
    }

    let didUpdate = false;

    applyScenarioUpdate(scenarioId, (scenario) => {
      const agentIndex = scenario.agents.findIndex((agent) => agent.id === agentId);
      if (agentIndex === -1) {
        return scenario;
      }

      const frameInterval = scenario.metadata.frameIntervalMicros ?? DEFAULT_FRAME_INTERVAL_MICROS;
      const trajectory = samplesToTrajectoryPoints(samples, frameInterval);
      if (trajectory.length === 0) {
        return scenario;
      }

      didUpdate = true;

      const nextAgents = scenario.agents.map((agent) => (
        agent.id === agentId
          ? { ...agent, trajectory }
          : agent
      ));

      return withScenarioRebuild(scenario, nextAgents);
    });

    return didUpdate;
  }, [applyScenarioUpdate]);

  const addRoadEdge = useCallback<ScenarioStoreValue['addRoadEdge']>((scenarioId, input) => {
    let createdEdge: RoadEdge | undefined;

    applyScenarioUpdate(scenarioId, (scenario) => {
      const points = sanitiseRoadPoints(input.points);
      if (points.length < 2) {
        return scenario;
      }

      const edge: RoadEdge = {
        id: input.id ?? createResourceId('road'),
        type: input.type,
        points
      };

      createdEdge = edge;

      return {
        ...scenario,
        roadEdges: [...scenario.roadEdges, edge]
      };
    });

    return createdEdge;
  }, [applyScenarioUpdate]);

  const updateRoadEdgePoints = useCallback<ScenarioStoreValue['updateRoadEdgePoints']>((scenarioId, roadId, points) => {
    let didUpdate = false;

    applyScenarioUpdate(scenarioId, (scenario) => {
      const index = scenario.roadEdges.findIndex((edge) => edge.id === roadId);
      if (index === -1) {
        return scenario;
      }

      const nextPoints = sanitiseRoadPoints(points);
      if (nextPoints.length < 2) {
        return scenario;
      }

      const existing = scenario.roadEdges[index];
      if (areRoadPointsEqual(existing.points, nextPoints)) {
        return scenario;
      }

      const nextEdges = [...scenario.roadEdges];
      nextEdges.splice(index, 1, {
        ...existing,
        points: nextPoints
      });

      didUpdate = true;

      return {
        ...scenario,
        roadEdges: nextEdges
      };
    });

    return didUpdate;
  }, [applyScenarioUpdate]);

  const updateRoadEdgePoint = useCallback<ScenarioStoreValue['updateRoadEdgePoint']>((scenarioId, roadId, pointIndex, point) => {
    let didUpdate = false;

    applyScenarioUpdate(scenarioId, (scenario) => {
      const edgeIndex = scenario.roadEdges.findIndex((edge) => edge.id === roadId);
      if (edgeIndex === -1) {
        return scenario;
      }

      const existing = scenario.roadEdges[edgeIndex];
      if (pointIndex < 0 || pointIndex >= existing.points.length) {
        return scenario;
      }

      const sanitisedPoint = sanitiseRoadPoint(point);
      if (!sanitisedPoint) {
        return scenario;
      }

      const currentPoint = existing.points[pointIndex];
      const epsilon = 1e-6;
      const hasCurrentZ = typeof currentPoint.z === 'number';
      const hasNextZ = typeof sanitisedPoint.z === 'number';
      const zUnchanged = !hasCurrentZ && !hasNextZ
        ? true
        : hasCurrentZ && hasNextZ
          ? Math.abs((currentPoint.z as number) - (sanitisedPoint.z as number)) < epsilon
          : false;
      if (
        Math.abs(currentPoint.x - sanitisedPoint.x) < epsilon
        && Math.abs(currentPoint.y - sanitisedPoint.y) < epsilon
        && zUnchanged
      ) {
        return scenario;
      }

      const nextPoints = [...existing.points];
      nextPoints.splice(pointIndex, 1, sanitisedPoint);

      const sanitisedPoints = sanitiseRoadPoints(nextPoints);
      if (sanitisedPoints.length !== nextPoints.length || sanitisedPoints.length < 2) {
        return scenario;
      }

      const nextEdges = [...scenario.roadEdges];
      nextEdges.splice(edgeIndex, 1, {
        ...existing,
        points: sanitisedPoints
      });

      didUpdate = true;

      return {
        ...scenario,
        roadEdges: nextEdges
      };
    });

    return didUpdate;
  }, [applyScenarioUpdate]);

  const insertRoadEdgePoint = useCallback<ScenarioStoreValue['insertRoadEdgePoint']>((scenarioId, roadId, point, options) => {
    let insertedIndex: number | undefined;

    applyScenarioUpdate(scenarioId, (scenario) => {
      const edgeIndex = scenario.roadEdges.findIndex((edge) => edge.id === roadId);
      if (edgeIndex === -1) {
        return scenario;
      }

      const existing = scenario.roadEdges[edgeIndex];
      const sanitisedPoint = sanitiseRoadPoint(point);
      if (!sanitisedPoint) {
        return scenario;
      }

      const afterIndexRaw = options?.afterIndex ?? existing.points.length - 1;
      const afterIndex = Math.min(Math.max(afterIndexRaw, -1), existing.points.length - 1);
      const insertAt = afterIndex + 1;

      const nextPoints = [...existing.points];
      nextPoints.splice(insertAt, 0, sanitisedPoint);

      const sanitisedPoints = sanitiseRoadPoints(nextPoints);
      if (sanitisedPoints.length !== nextPoints.length || sanitisedPoints.length < 2) {
        return scenario;
      }

      insertedIndex = insertAt;

      const nextEdges = [...scenario.roadEdges];
      nextEdges.splice(edgeIndex, 1, {
        ...existing,
        points: sanitisedPoints
      });

      return {
        ...scenario,
        roadEdges: nextEdges
      };
    });

    return insertedIndex;
  }, [applyScenarioUpdate]);

  const splitRoadEdge = useCallback<ScenarioStoreValue['splitRoadEdge']>((scenarioId, roadId, splitIndex) => {
    let result: ReturnType<ScenarioStoreValue['splitRoadEdge']>;

    applyScenarioUpdate(scenarioId, (scenario) => {
      const edgeIndex = scenario.roadEdges.findIndex((edge) => edge.id === roadId);
      if (edgeIndex === -1) {
        return scenario;
      }

      if (!Number.isInteger(splitIndex)) {
        return scenario;
      }

      const existing = scenario.roadEdges[edgeIndex];
      if (splitIndex <= 0 || splitIndex >= existing.points.length) {
        return scenario;
      }

      const firstPoints = existing.points.slice(0, splitIndex);
      const secondPoints = existing.points.slice(splitIndex);
      const sanitisedFirst = sanitiseRoadPoints(firstPoints);
      const sanitisedSecond = sanitiseRoadPoints(secondPoints);

      if (
        sanitisedFirst.length !== firstPoints.length
        || sanitisedSecond.length !== secondPoints.length
        || sanitisedFirst.length < 2
        || sanitisedSecond.length < 2
      ) {
        return scenario;
      }

      const retained: RoadEdge = {
        ...existing,
        points: sanitisedFirst
      };

      const created: RoadEdge = {
        id: createResourceId('road'),
        type: existing.type,
        points: sanitisedSecond
      };

      const nextEdges = [...scenario.roadEdges];
      nextEdges.splice(edgeIndex, 1, retained);
      nextEdges.splice(edgeIndex + 1, 0, created);

      result = {
        retained,
        created,
        createdIndex: edgeIndex + 1
      };

      return {
        ...scenario,
        roadEdges: nextEdges
      };
    });

    return result;
  }, [applyScenarioUpdate]);

  const removeRoadEdgePoint = useCallback<ScenarioStoreValue['removeRoadEdgePoint']>((scenarioId, roadId, pointIndex) => {
    let didRemove = false;

    applyScenarioUpdate(scenarioId, (scenario) => {
      const edgeIndex = scenario.roadEdges.findIndex((edge) => edge.id === roadId);
      if (edgeIndex === -1) {
        return scenario;
      }

      const existing = scenario.roadEdges[edgeIndex];
      if (existing.points.length <= 2 || pointIndex < 0 || pointIndex >= existing.points.length) {
        return scenario;
      }

      const nextPoints = existing.points.filter((_, index) => index !== pointIndex);
      const sanitisedPoints = sanitiseRoadPoints(nextPoints);
      if (sanitisedPoints.length !== nextPoints.length || sanitisedPoints.length < 2) {
        return scenario;
      }

      const nextEdges = [...scenario.roadEdges];
      nextEdges.splice(edgeIndex, 1, {
        ...existing,
        points: sanitisedPoints
      });

      didRemove = true;

      return {
        ...scenario,
        roadEdges: nextEdges
      };
    });

    return didRemove;
  }, [applyScenarioUpdate]);

  const setRoadEdgeType = useCallback<ScenarioStoreValue['setRoadEdgeType']>((scenarioId, roadId, type) => {
    let didUpdate = false;

    applyScenarioUpdate(scenarioId, (scenario) => {
      const index = scenario.roadEdges.findIndex((edge) => edge.id === roadId);
      if (index === -1) {
        return scenario;
      }

      const existing = scenario.roadEdges[index];
      if (existing.type === type) {
        return scenario;
      }

      const nextEdges = [...scenario.roadEdges];
      nextEdges.splice(index, 1, {
        ...existing,
        type
      });

      didUpdate = true;

      return {
        ...scenario,
        roadEdges: nextEdges
      };
    });

    return didUpdate;
  }, [applyScenarioUpdate]);

  const removeRoadEdge = useCallback<ScenarioStoreValue['removeRoadEdge']>((scenarioId, roadId) => {
    let didRemove = false;

    applyScenarioUpdate(scenarioId, (scenario) => {
      const nextEdges = scenario.roadEdges.filter((edge) => edge.id !== roadId);
      if (nextEdges.length === scenario.roadEdges.length) {
        return scenario;
      }

      didRemove = true;

      return {
        ...scenario,
        roadEdges: nextEdges
      };
    });

    return didRemove;
  }, [applyScenarioUpdate]);

  const basicUndo = useCallback(() => {
    if (!activeScenarioId) {
      return false;
    }

    const preservedMode = editingState.mode;

    let snapshot: BasicUndoSnapshot | undefined;
    setBasicUndoBuckets((prev) => {
      const bucket = prev[activeScenarioId];
      if (!bucket || bucket.history.length === 0) {
        return prev;
      }
      snapshot = bucket.history[bucket.history.length - 1];
      const nextHistory = bucket.history.slice(0, -1);
      return {
        ...prev,
        [activeScenarioId]: {
          history: nextHistory,
          lastSerialized: snapshot!.serialized,
          lastName: snapshot!.name,
          lastSource: snapshot!.source
        }
      };
    });

    if (!snapshot) {
      return false;
    }

    let parsedScenario: WaymoScenario | undefined;
    try {
      parsedScenario = JSON.parse(snapshot.serialized) as WaymoScenario;
    } catch (error) {
      console.error('Failed to parse undo snapshot', error);
      return false;
    }

    const scenarioClone = cloneScenarioState(parsedScenario);
    const resource: ScenarioResource = {
      id: activeScenarioId,
      name: snapshot.name,
      source: snapshot.source,
      scenario: scenarioClone,
      baseline: cloneScenarioState(scenarioClone)
    };

    isApplyingBasicUndoRef.current = true;
    try {
      applyLoadedScenarioResource(resource, { preserveBasicUndoHistory: true });
    } finally {
      isApplyingBasicUndoRef.current = false;
    }

    setEditingState((prev) => {
      if (prev.mode === preservedMode) {
        return prev;
      }
      return {
        ...prev,
        mode: preservedMode
      };
    });

    return true;
  }, [activeScenarioId, applyLoadedScenarioResource, editingState.mode, setBasicUndoBuckets, setEditingState]);

  useEffect(() => {
    resetEditing();
  }, [activeScenarioId, resetEditing]);

  const editingValue = useMemo<EditingStoreValue>(() => ({
    state: editingState,
    setMode: setEditingMode,
    setTool: setEditingTool,
    setRotationMode,
    setRoadDraftElevation,
    setColorRoadVerticesByElevation,
    hoverEntity,
    selectEntity,
    clearSelection,
    setHoveredRoadHandle,
    setHoveredRoadSegment,
    setSelectedRoadHandle,
    beginTrajectoryRecording,
    appendTrajectorySample,
    completeTrajectoryRecording,
    cancelTrajectoryRecording,
    beginRoadDraft,
    appendRoadDraftPoint,
    updateRoadDraftPoint,
    removeRoadDraftPoint,
    completeRoadDraft,
    cancelRoadDraft,
    pushHistoryEntry,
    undo,
    redo,
    canUndo,
    canRedo,
    reset: resetEditing
  }), [
    editingState,
    setEditingMode,
    setEditingTool,
    setRotationMode,
    setRoadDraftElevation,
    setColorRoadVerticesByElevation,
    hoverEntity,
    selectEntity,
    clearSelection,
    setHoveredRoadHandle,
    setHoveredRoadSegment,
    setSelectedRoadHandle,
    beginTrajectoryRecording,
    appendTrajectorySample,
    completeTrajectoryRecording,
    cancelTrajectoryRecording,
    beginRoadDraft,
    appendRoadDraftPoint,
    updateRoadDraftPoint,
    removeRoadDraftPoint,
    completeRoadDraft,
    cancelRoadDraft,
    pushHistoryEntry,
    undo,
    redo,
    canUndo,
    canRedo,
    resetEditing
  ]);

  const value = useMemo<ScenarioStoreValue>(() => ({
    scenarios,
    activeScenarioId,
    activeScenario,
    activeScenarioBaseline,
    activeFrameIndex,
    activeFrame,
    isPlaying,
    playbackSpeed,
    visibleTrajectoryIds,
    showAgentLabels,
    agentLabelMode,
    selectScenario,
    setActiveFrameIndex,
    play,
    pause,
    setPlaybackSpeed: handleSetPlaybackSpeed,
    toggleTrajectoryVisibility,
    showAllTrajectories,
    hideAllTrajectories,
    toggleAgentLabels,
    setAgentLabelMode,
    toggleAgentExpert,
    setAgentTrackPrediction,
    updateAgentAttributes,
    removeAllAgents,
    spawnVehicleAgent,
    removeScenario,
    loadScenarioFromJson,
    createBlankScenario,
    updateScenario,
    updateAgentStartPose,
    applyRecordedTrajectory,
    addRoadEdge,
    updateRoadEdgePoints,
    updateRoadEdgePoint,
    insertRoadEdgePoint,
    splitRoadEdge,
    removeRoadEdgePoint,
    setRoadEdgeType,
    removeRoadEdge,
    basicUndoStepsRemaining,
    basicUndo,
    editing: editingValue
  }), [
    scenarios,
    activeScenarioId,
    activeScenario,
    activeScenarioBaseline,
    activeFrameIndex,
    activeFrame,
    isPlaying,
    playbackSpeed,
    visibleTrajectoryIds,
    showAgentLabels,
    agentLabelMode,
    selectScenario,
    setActiveFrameIndex,
    play,
    pause,
    handleSetPlaybackSpeed,
    toggleTrajectoryVisibility,
    showAllTrajectories,
    hideAllTrajectories,
    toggleAgentLabels,
    setAgentLabelMode,
    toggleAgentExpert,
    setAgentTrackPrediction,
    updateAgentAttributes,
    removeAllAgents,
    spawnVehicleAgent,
    removeScenario,
    loadScenarioFromJson,
    createBlankScenario,
    updateScenario,
    updateAgentStartPose,
    applyRecordedTrajectory,
    addRoadEdge,
    updateRoadEdgePoints,
    updateRoadEdgePoint,
    insertRoadEdgePoint,
    splitRoadEdge,
    removeRoadEdgePoint,
    setRoadEdgeType,
    removeRoadEdge,
    basicUndoStepsRemaining,
    basicUndo,
    editingValue
  ]);

  return <ScenarioStoreContext.Provider value={value}>{children}</ScenarioStoreContext.Provider>;
}

export function useScenarioStore() {
  const context = useContext(ScenarioStoreContext);
  if (!context) {
    throw new Error('useScenarioStore must be used within ScenarioStoreProvider');
  }

  return context;
}
