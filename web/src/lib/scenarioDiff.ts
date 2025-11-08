import { buildScenarioExportPayload, type ScenarioExportPayload } from '@/lib/scenarioExporter';
import type {
  AgentType,
  RoadEdge,
  ScenarioAgent,
  ScenarioBounds,
  ScenarioMetadata,
  TrajectoryPoint,
  WaymoScenario
} from '@/types/scenario';

const NUMBER_EPSILON = 1e-6;

export interface MetadataChangeSummary {
  field: keyof ScenarioMetadata;
  label: string;
  before: string | number | undefined;
  after: string | number | undefined;
}

export interface AgentIdentitySummary {
  id: string;
  type: AgentType;
  displayName?: string;
}

export interface AgentChangeSummary extends AgentIdentitySummary {
  changes: string[];
}

export interface RoadEdgeSummary {
  id: string;
  type?: RoadEdge['type'];
}

export interface RoadEdgeChangeSummary extends RoadEdgeSummary {
  changes: string[];
}

export interface TracksToPredictChangeSummary {
  added: number[];
  removed: number[];
}

export interface BoundsChangeSummary {
  changed: boolean;
  before?: ScenarioBounds;
  after?: ScenarioBounds;
}

export interface FrameChangeSummary {
  beforeCount: number;
  afterCount: number;
  countChanged: boolean;
  dataChanged: boolean;
}

export interface ScenarioDiffSummary {
  hasBaseline: boolean;
  metadataChanges: MetadataChangeSummary[];
  agentChanges: {
    added: AgentIdentitySummary[];
    removed: AgentIdentitySummary[];
    updated: AgentChangeSummary[];
  };
  roadEdgeChanges: {
    added: RoadEdgeSummary[];
    removed: RoadEdgeSummary[];
    updated: RoadEdgeChangeSummary[];
  };
  tracksToPredictChanges: TracksToPredictChangeSummary;
  bounds: BoundsChangeSummary;
  frames: FrameChangeSummary;
  totalChangeCount: number;
  hasChanges: boolean;
}

export interface ScenarioExportComparison {
  before?: ScenarioExportPayload;
  after: ScenarioExportPayload;
  diff: ScenarioDiffSummary;
}

const METADATA_FIELDS: Array<{ key: keyof ScenarioMetadata; label: string }> = [
  { key: 'name', label: 'Name' },
  { key: 'description', label: 'Description' },
  { key: 'frameCount', label: 'Frame Count' },
  { key: 'durationSeconds', label: 'Duration (s)' },
  { key: 'frameIntervalMicros', label: 'Frame Interval (μs)' }
];

function isApproxEqualNumber(a: number | undefined, b: number | undefined): boolean {
  if (typeof a !== 'number' || typeof b !== 'number') {
    return a === b;
  }
  if (!Number.isFinite(a) || !Number.isFinite(b)) {
    return a === b;
  }
  return Math.abs(a - b) <= NUMBER_EPSILON;
}

function summariseMetadataChanges(before: ScenarioMetadata | undefined, after: ScenarioMetadata): MetadataChangeSummary[] {
  if (!before) {
    return [];
  }

  return METADATA_FIELDS.reduce<MetadataChangeSummary[]>((acc, { key, label }) => {
    const previousValue = before[key];
    const nextValue = after[key];

    const equal = typeof previousValue === 'number' || typeof nextValue === 'number'
      ? isApproxEqualNumber(previousValue as number | undefined, nextValue as number | undefined)
      : previousValue === nextValue;

    if (!equal) {
      acc.push({
        field: key,
        label,
        before: typeof previousValue === 'number' ? previousValue : previousValue ?? undefined,
        after: typeof nextValue === 'number' ? nextValue : nextValue ?? undefined
      });
    }

    return acc;
  }, []);
}

function summariseAgentIdentity(agent: ScenarioAgent): AgentIdentitySummary {
  return {
    id: agent.id,
    type: agent.type,
    displayName: agent.displayName
  };
}

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

  return (
    isApproxEqualNumber(a.length, b.length)
    && isApproxEqualNumber(a.width, b.width)
    && isApproxEqualNumber(
      typeof a.height === 'number' ? a.height : undefined,
      typeof b.height === 'number' ? b.height : undefined
    )
  );
}

function areTrajectoriesEqual(a: TrajectoryPoint[], b: TrajectoryPoint[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  return JSON.stringify(a) === JSON.stringify(b);
}

function summariseAgentChanges(before: ScenarioAgent, after: ScenarioAgent): string[] {
  const changes: string[] = [];

  if (before.type !== after.type) {
    changes.push('type');
  }

  if (!areAgentDimensionsEqual(before.dimensions, after.dimensions)) {
    changes.push('dimensions');
  }

  if ((before.displayName ?? '') !== (after.displayName ?? '')) {
    changes.push('label');
  }

  if ((before.colour ?? '') !== (after.colour ?? '')) {
    changes.push('colour');
  }

  if (Boolean(before.isExpert) !== Boolean(after.isExpert)) {
    changes.push('expert flag');
  }

  if (!areTrajectoriesEqual(before.trajectory, after.trajectory)) {
    changes.push('trajectory');
  }

  return changes;
}

function diffAgents(beforeAgents: ScenarioAgent[] | undefined, afterAgents: ScenarioAgent[]) {
  const beforeMap = new Map<string, ScenarioAgent>();
  beforeAgents?.forEach((agent) => {
    beforeMap.set(agent.id, agent);
  });

  const added: AgentIdentitySummary[] = [];
  const removed: AgentIdentitySummary[] = [];
  const updated: AgentChangeSummary[] = [];

  afterAgents.forEach((agent) => {
    const previous = beforeMap.get(agent.id);
    if (!previous) {
      added.push(summariseAgentIdentity(agent));
      return;
    }

    const changes = summariseAgentChanges(previous, agent);
    if (changes.length > 0) {
      updated.push({
        ...summariseAgentIdentity(agent),
        changes
      });
    }
    beforeMap.delete(agent.id);
  });

  beforeMap.forEach((agent) => {
    removed.push(summariseAgentIdentity(agent));
  });

  return { added, removed, updated };
}

function areRoadPointsEqual(aPoints: RoadEdge['points'], bPoints: RoadEdge['points']): boolean {
  if (aPoints.length !== bPoints.length) {
    return false;
  }
  return JSON.stringify(aPoints) === JSON.stringify(bPoints);
}

function summariseRoadEdge(edge: RoadEdge): RoadEdgeSummary {
  return { id: edge.id, type: edge.type };
}

function summariseRoadEdgeChanges(before: RoadEdge, after: RoadEdge): string[] {
  const changes: string[] = [];

  if ((before.type ?? 'OTHER') !== (after.type ?? 'OTHER')) {
    changes.push('type');
  }

  if (!areRoadPointsEqual(before.points, after.points)) {
    changes.push('geometry');
  }

  return changes;
}

function diffRoadEdges(beforeEdges: RoadEdge[] | undefined, afterEdges: RoadEdge[]) {
  const beforeMap = new Map<string, RoadEdge>();
  beforeEdges?.forEach((edge) => {
    beforeMap.set(edge.id, edge);
  });

  const added: RoadEdgeSummary[] = [];
  const removed: RoadEdgeSummary[] = [];
  const updated: RoadEdgeChangeSummary[] = [];

  afterEdges.forEach((edge) => {
    const previous = beforeMap.get(edge.id);
    if (!previous) {
      added.push(summariseRoadEdge(edge));
      return;
    }

    const changes = summariseRoadEdgeChanges(previous, edge);
    if (changes.length > 0) {
      updated.push({
        ...summariseRoadEdge(edge),
        changes
      });
    }
    beforeMap.delete(edge.id);
  });

  beforeMap.forEach((edge) => {
    removed.push(summariseRoadEdge(edge));
  });

  return { added, removed, updated };
}

function diffTracksToPredict(
  beforeTracks: number[] | undefined,
  afterTracks: number[]
): TracksToPredictChangeSummary {
  const beforeSet = new Set(beforeTracks ?? []);
  const afterSet = new Set(afterTracks);

  const added: number[] = [];
  afterSet.forEach((track) => {
    if (!beforeSet.has(track)) {
      added.push(track);
    }
  });
  added.sort((a, b) => a - b);

  const removed: number[] = [];
  beforeSet.forEach((track) => {
    if (!afterSet.has(track)) {
      removed.push(track);
    }
  });
  removed.sort((a, b) => a - b);

  return { added, removed };
}

function areBoundsEqual(a: ScenarioBounds | undefined, b: ScenarioBounds | undefined): boolean {
  if (!a && !b) {
    return true;
  }
  if (!a || !b) {
    return false;
  }

  return (
    isApproxEqualNumber(a.minX, b.minX)
    && isApproxEqualNumber(a.maxX, b.maxX)
    && isApproxEqualNumber(a.minY, b.minY)
    && isApproxEqualNumber(a.maxY, b.maxY)
  );
}

function summariseFrameChanges(
  beforeFrames: ScenarioExportPayload['frames'] | undefined,
  afterFrames: ScenarioExportPayload['frames']
): FrameChangeSummary {
  const beforeCount = beforeFrames?.length ?? 0;
  const afterCount = afterFrames.length;
  const countChanged = beforeCount !== afterCount;

  let dataChanged = false;
  if (beforeFrames) {
    dataChanged = countChanged ? true : JSON.stringify(beforeFrames) !== JSON.stringify(afterFrames);
  } else if (afterFrames.length > 0) {
    dataChanged = true;
  }

  return {
    beforeCount,
    afterCount,
    countChanged,
    dataChanged
  };
}

export function compareScenarioForExport(before: WaymoScenario | undefined, after: WaymoScenario): ScenarioExportComparison {
  const beforeSnapshot = before ? buildScenarioExportPayload(before) : undefined;
  const afterSnapshot = buildScenarioExportPayload(after);

  const metadataChanges = summariseMetadataChanges(beforeSnapshot?.metadata, afterSnapshot.metadata);
  const agentChanges = diffAgents(beforeSnapshot?.agents, afterSnapshot.agents);
  const roadEdgeChanges = diffRoadEdges(beforeSnapshot?.roadEdges, afterSnapshot.roadEdges);
  const tracksToPredictChanges = diffTracksToPredict(beforeSnapshot?.tracksToPredict, afterSnapshot.tracksToPredict);
  const boundsChanged = !areBoundsEqual(beforeSnapshot?.bounds, afterSnapshot.bounds);
  const frames = summariseFrameChanges(beforeSnapshot?.frames, afterSnapshot.frames);

  const totalChangeCount =
    metadataChanges.length
    + agentChanges.added.length
    + agentChanges.removed.length
    + agentChanges.updated.length
    + roadEdgeChanges.added.length
    + roadEdgeChanges.removed.length
    + roadEdgeChanges.updated.length
    + tracksToPredictChanges.added.length
    + tracksToPredictChanges.removed.length
    + (boundsChanged ? 1 : 0)
    + (frames.countChanged ? 1 : 0)
    + (!frames.countChanged && frames.dataChanged ? 1 : 0);

  const diff: ScenarioDiffSummary = {
    hasBaseline: Boolean(beforeSnapshot),
    metadataChanges,
    agentChanges,
    roadEdgeChanges,
    tracksToPredictChanges,
    bounds: {
      changed: boundsChanged,
      before: beforeSnapshot?.bounds,
      after: afterSnapshot.bounds
    },
    frames,
    totalChangeCount,
    hasChanges: totalChangeCount > 0
  };

  return {
    before: beforeSnapshot,
    after: afterSnapshot,
    diff
  };
}

