import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import {
  useScenarioStore,
  type AgentLabelMode,
  type EditingEntityRef,
  type EditingMode,
  type EditingTool,
  type RoadDraft,
  type RoadHandleRef,
  type RoadSegmentRef
} from '@/state/scenarioStore';
import { RoadEdge, ScenarioAgent, ScenarioBounds, ScenarioFrameAgentState, TrajectoryPoint } from '@/types/scenario';
import { TOOLBAR_ICONS } from './toolbarIcons';

type CameraState = {
  zoom: number;
  panX: number;
  panY: number;
  rotation: number;
};

interface CanvasTransform {
  scale: number;
  offsetX: number;
  offsetY: number;
  height: number;
}

interface CanvasDims {
  width: number;
  height: number;
}

type TrajectoryDrawOptions = {
  highlight?: 'selected' | 'hovered';
  variant?: 'ghost';
};

interface RoadDrawOptions {
  selectedId?: string;
  hoveredId?: string;
  showVertices?: boolean;
  selectedVertex?: RoadHandleRef;
  hoveredVertex?: RoadHandleRef;
  hoveredSegment?: RoadSegmentRef;
  colorByElevation?: boolean;
  elevationRange?: { min: number; max: number };
}

type DragMode = 'pan' | 'record' | 'gizmo-translate-x' | 'gizmo-translate-y' | 'gizmo-rotate' | 'road-handle';

interface DragGizmoState {
  kind: 'translate' | 'rotate';
  axis?: 'x' | 'y';
  startAnchor: { x: number; y: number };
  startHeading: number;
  startPointerWorld: { x: number; y: number };
  startPointerAngle?: number;
  changed: boolean;
}

interface DragRoadHandleState {
  roadId: string;
  pointIndex: number;
  originalPoints: RoadEdge['points'];
  changed: boolean;
}

interface DragState {
  active: boolean;
  pointerId: number | null;
  lastX: number;
  lastY: number;
  hasMoved: boolean;
  mode: DragMode;
  gizmo?: DragGizmoState;
  roadHandle?: DragRoadHandleState;
}

type AgentHighlightState = {
  selected?: boolean;
  hovered?: boolean;
  driving?: boolean;
};

type AgentRenderOptions = {
  showLabel?: boolean;
  labelMode?: AgentLabelMode;
  agentIndex?: number;
  highlight?: AgentHighlightState;
  isTrackToPredict?: boolean;
};

interface BaseTransformContext {
  transform: CanvasTransform;
  width: number;
  height: number;
}

interface RoadHandleHit {
  edge: RoadEdge;
  pointIndex: number;
  distance: number;
}

interface RoadSegmentHit {
  edge: RoadEdge;
  segmentIndex: number;
  distance: number;
}

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 8;
const INITIAL_ZOOM = 1.25;
const DEFAULT_FRAME_INTERVAL_MICROS = 100_000;
const DRIVE_SETTINGS_DEFAULT: DriveSettings = {
  maxSpeed: 38,
  maxReverseSpeed: 12,
  acceleration: 24,
  reverseAcceleration: 11,
  brakeDeceleration: 20,
  drag: 0.85,
  steerRate: 8.0
};

const DRIVE_KEY_CODES = new Set([
  'ArrowUp',
  'KeyW',
  'ArrowDown',
  'KeyS',
  'ArrowLeft',
  'KeyA',
  'ArrowRight',
  'KeyD',
  'Space'
]);

interface DriveSession {
  agentId: string;
  startTimestampMs: number;
  lastTimestampMs: number;
  nextSampleTimestampMs: number;
  position: { x: number; y: number };
  heading: number;
  speed: number;
}

interface DriveControlsState {
  forward: boolean;
  backward: boolean;
  left: boolean;
  right: boolean;
  brake: boolean;
}

type DriveModeStopper = (commit: boolean) => void;

interface DriveSettings {
  maxSpeed: number;
  maxReverseSpeed: number;
  acceleration: number;
  reverseAcceleration: number;
  brakeDeceleration: number;
  drag: number;
  steerRate: number;
}

const TYPE_COLOURS: Record<string, string> = {
  VEHICLE: '#38bdf8',
  PEDESTRIAN: '#f97316',
  CYCLIST: '#facc15',
  OTHER: '#e2e8f0'
};

const VEHICLE_COLOURS = {
  expert: '#facc15',
  nonExpert: '#38bdf8'
};

const INACTIVE_AGENT_COLOUR = {
  fill: 'rgba(148, 163, 184, 0.55)',
  stroke: 'rgba(100, 116, 139, 0.8)'
};

const DEFAULT_AGENT_DIMENSIONS: Record<string, { length: number; width: number; height?: number }> = {
  VEHICLE: { length: 4.5, width: 2.0, height: 1.6 },
  PEDESTRIAN: { length: 0.8, width: 0.8, height: 1.8 },
  CYCLIST: { length: 1.8, width: 0.6, height: 1.6 },
  OTHER: { length: 2.0, width: 1.0, height: 1.5 }
};

const ROAD_STYLES: Record<string, { stroke: string; width: number; dash?: number[] }> = {
  ROAD_LINE: { stroke: 'rgba(148, 163, 184, 0.65)', width: 1.5, dash: [6, 8] },
  ROAD_EDGE: { stroke: 'rgba(203, 213, 225, 0.9)', width: 2.2 },
  CROSSWALK: { stroke: 'rgba(248, 113, 113, 0.5)', width: 1.2, dash: [4, 6] },
  OTHER: { stroke: 'rgba(148, 163, 184, 0.35)', width: 1.0 }
};

const ROAD_VERTEX_HIT_RADIUS_METERS = 1.25;
const ROAD_SEGMENT_HIT_RADIUS_METERS = 1.5;
const ROAD_HANDLE_BASE_RADIUS_PX = 6;

const GIZMO_TRANSLATE_LENGTH = 3;
const GIZMO_ROTATION_RADIUS = 4;
const GIZMO_HANDLE_HIT_RADIUS = 18;
const GIZMO_ROTATION_HIT_TOLERANCE = 14;

function computeTransform(bounds: ScenarioBounds | undefined, width = 1, height = 1): CanvasTransform {
  const padding = 40;
  const spanX = bounds ? bounds.maxX - bounds.minX : 100;
  const spanY = bounds ? bounds.maxY - bounds.minY : 100;

  const safeSpanX = spanX === 0 ? 1 : spanX;
  const safeSpanY = spanY === 0 ? 1 : spanY;

  const scaleX = (width - padding * 2) / safeSpanX;
  const scaleY = (height - padding * 2) / safeSpanY;
  const scale = Math.max(Math.min(scaleX, scaleY), 0.0001);

  const offsetX = bounds ? bounds.minX : -safeSpanX / 2;
  const offsetY = bounds ? bounds.minY : -safeSpanY / 2;

  return { scale, offsetX, offsetY, height };
}

function worldToAnchor(point: { x: number; y: number }, base: CanvasTransform, dims: CanvasDims) {
  const anchorX = (point.x - base.offsetX) * base.scale;
  const anchorY = dims.height - (point.y - base.offsetY) * base.scale;
  return { x: anchorX, y: anchorY };
}

function worldToCanvas(
  point: { x: number; y: number },
  base: CanvasTransform,
  camera: CameraState,
  dims: CanvasDims
) {
  const { width, height } = dims;
  const anchor = worldToAnchor(point, base, dims);
  const centerX = width / 2;
  const centerY = height / 2;

  const dx = anchor.x - centerX;
  const dy = anchor.y - centerY;
  const cos = Math.cos(camera.rotation);
  const sin = Math.sin(camera.rotation);
  const rotatedX = dx * cos - dy * sin;
  const rotatedY = dx * sin + dy * cos;

  const zoomedX = rotatedX * camera.zoom + centerX + camera.panX;
  const zoomedY = rotatedY * camera.zoom + centerY + camera.panY;

  return { x: zoomedX, y: zoomedY };
}

function canvasToWorld(
  canvasX: number,
  canvasY: number,
  base: CanvasTransform,
  camera: CameraState,
  dims: CanvasDims
) {
  const { width, height } = dims;
  const centerX = width / 2;
  const centerY = height / 2;

  const dx = (canvasX - centerX - camera.panX) / camera.zoom;
  const dy = (canvasY - centerY - camera.panY) / camera.zoom;
  const cos = Math.cos(camera.rotation);
  const sin = Math.sin(camera.rotation);
  const rotatedX = dx * cos + dy * sin;
  const rotatedY = -dx * sin + dy * cos;

  const anchorX = rotatedX + centerX;
  const anchorY = rotatedY + centerY;

  const worldX = anchorX / base.scale + base.offsetX;
  const worldY = base.offsetY + (height - anchorY) / base.scale;

  return { x: worldX, y: worldY };
}

function drawRoadEdges(
  ctx: CanvasRenderingContext2D,
  edges: RoadEdge[],
  base: CanvasTransform,
  camera: CameraState,
  dims: CanvasDims,
  options: RoadDrawOptions = {}
) {
  ctx.save();
  const {
    selectedId,
    hoveredId,
    showVertices,
    selectedVertex,
    hoveredVertex,
    hoveredSegment,
    colorByElevation,
    elevationRange
  } = options;

  edges.forEach((edge) => {
    if (!edge.points || edge.points.length < 2) {
      return;
    }

    const style = edge.type ? ROAD_STYLES[edge.type] ?? ROAD_STYLES.OTHER : ROAD_STYLES.OTHER;
    const isSelected = edge.id === selectedId;
    const isHovered = edge.id === hoveredId && !isSelected;
    const selectedVertexIndex = selectedVertex?.roadId === edge.id ? selectedVertex.pointIndex : undefined;
    const hoveredVertexIndex = hoveredVertex?.roadId === edge.id ? hoveredVertex.pointIndex : undefined;
    const highlightedSegmentIndex =
      hoveredSegment?.roadId === edge.id ? hoveredSegment.segmentIndex : undefined;
    const strokeColour = isSelected
      ? 'rgba(250, 204, 21, 0.95)'
      : isHovered
        ? 'rgba(34, 211, 238, 0.92)'
        : style.stroke;
    const width = isSelected
      ? style.width * 1.4
      : isHovered
        ? style.width * 1.15
        : style.width;

    ctx.strokeStyle = strokeColour;
    ctx.lineWidth = Math.max(width, width / camera.zoom);
    ctx.setLineDash(isSelected ? [] : style.dash ?? []);

    const first = worldToCanvas(edge.points[0], base, camera, dims);
    ctx.beginPath();
    ctx.moveTo(first.x, first.y);
    for (let i = 1; i < edge.points.length; i += 1) {
      const { x, y } = worldToCanvas(edge.points[i], base, camera, dims);
      ctx.lineTo(x, y);
    }
    ctx.stroke();

    if (typeof highlightedSegmentIndex === 'number') {
      const segmentIndex = highlightedSegmentIndex;
      if (segmentIndex >= 0 && segmentIndex < edge.points.length - 1) {
        const start = worldToCanvas(edge.points[segmentIndex], base, camera, dims);
        const end = worldToCanvas(edge.points[segmentIndex + 1], base, camera, dims);
        ctx.save();
        ctx.strokeStyle = 'rgba(45, 212, 191, 0.95)';
        const highlightWidth = Math.max(width * 1.8, 3.6 / camera.zoom);
        ctx.lineWidth = highlightWidth;
        ctx.setLineDash([12 / camera.zoom, 10 / camera.zoom]);
        ctx.beginPath();
        ctx.moveTo(start.x, start.y);
        ctx.lineTo(end.x, end.y);
        ctx.stroke();
        ctx.restore();
      }
    }

    const shouldShowVertices = showVertices && (
      isSelected
      || typeof hoveredVertexIndex === 'number'
      || typeof highlightedSegmentIndex === 'number'
    );

    if (shouldShowVertices) {
      drawRoadVertexHandles(ctx, edge, base, camera, dims, {
        selectedIndex: selectedVertexIndex,
        hoveredIndex: hoveredVertexIndex,
        colorByElevation,
        elevationRange
      });
    }
  });

  ctx.restore();
}

function drawRoadVertexHandles(
  ctx: CanvasRenderingContext2D,
  edge: RoadEdge,
  base: CanvasTransform,
  camera: CameraState,
  dims: CanvasDims,
  options: {
    selectedIndex?: number;
    hoveredIndex?: number;
    colorByElevation?: boolean;
    elevationRange?: { min: number; max: number };
  } = {}
) {
  const { selectedIndex, hoveredIndex, colorByElevation, elevationRange } = options;

  const baseRadius = Math.max(ROAD_HANDLE_BASE_RADIUS_PX, ROAD_HANDLE_BASE_RADIUS_PX / camera.zoom);
  const lineWidth = Math.max(1.4, 1.4 / camera.zoom);
  ctx.save();
  ctx.lineWidth = lineWidth;
  edge.points.forEach((point, index) => {
    const { x, y } = worldToCanvas(point, base, camera, dims);
    const isSelected = typeof selectedIndex === 'number' && index === selectedIndex;
    const isHovered = !isSelected && typeof hoveredIndex === 'number' && index === hoveredIndex;
    const radius = isSelected
      ? baseRadius * 1.35
      : isHovered
        ? baseRadius * 1.15
        : baseRadius;
    let fillStyle = 'rgba(248, 250, 252, 0.95)';
    let strokeStyle = 'rgba(15, 23, 42, 0.85)';

    const elevationColour = colorByElevation && !isSelected && !isHovered
      ? getElevationColour(point.z, elevationRange)
      : undefined;

    if (isSelected) {
      fillStyle = 'rgba(250, 204, 21, 0.95)';
      strokeStyle = 'rgba(113, 63, 18, 0.95)';
    } else if (isHovered) {
      fillStyle = 'rgba(34, 211, 238, 0.92)';
      strokeStyle = 'rgba(8, 145, 178, 0.95)';
    } else if (elevationColour) {
      fillStyle = elevationColour;
      strokeStyle = 'rgba(15, 23, 42, 0.9)';
    } else if (index === 0) {
      fillStyle = 'rgba(14, 165, 233, 0.95)';
      strokeStyle = 'rgba(14, 116, 144, 0.9)';
    }

    ctx.beginPath();
    ctx.fillStyle = fillStyle;
    ctx.strokeStyle = strokeStyle;
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    const fontSize = Math.max(10, 12 / camera.zoom);
    ctx.font = `${fontSize}px "Segoe UI", sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = isSelected ? '#1f2937' : '#0f172a';
    ctx.fillText(index.toString(), x, y);
    const showElevation = typeof hoveredIndex === 'number' && index === hoveredIndex;
    if (showElevation) {
      const hasZ = typeof point.z === 'number' && Number.isFinite(point.z);
      const zLabel = hasZ ? `z ${(point.z as number).toFixed(2)}` : 'z —';
      const labelFontSize = Math.max(16, 20 / camera.zoom);
      const labelOffset = radius + Math.max(10, 14 / camera.zoom);
      const paddingX = Math.max(6, 8 / camera.zoom);
      const paddingY = Math.max(4, 6 / camera.zoom);

      ctx.save();
      ctx.font = `${labelFontSize}px "Segoe UI", sans-serif`;
      ctx.textBaseline = 'top';
      ctx.textAlign = 'center';

      const metrics = ctx.measureText(zLabel);
      const rectWidth = metrics.width + paddingX * 2;
      const rectHeight = labelFontSize + paddingY * 2;
      const rectX = x - rectWidth / 2;
      const rectY = y + labelOffset;

      ctx.fillStyle = 'rgba(15, 23, 42, 0.92)';
      ctx.fillRect(rectX, rectY, rectWidth, rectHeight);

      ctx.fillStyle = '#f8fafc';
      ctx.fillText(zLabel, x, rectY + paddingY);
      ctx.restore();
    }
  });
  ctx.restore();
}

function drawRoadDraft(
  ctx: CanvasRenderingContext2D,
  draft: RoadDraft,
  base: CanvasTransform,
  camera: CameraState,
  dims: CanvasDims
) {
  if (draft.points.length === 0) {
    return;
  }

  ctx.save();
  const dash = Math.max(10, 14 / camera.zoom);
  ctx.lineWidth = Math.max(2.4, 2.4 / camera.zoom);
  ctx.strokeStyle = 'rgba(14, 165, 233, 0.9)';
  ctx.setLineDash([dash, dash]);

  const start = worldToCanvas(draft.points[0], base, camera, dims);
  ctx.beginPath();
  ctx.moveTo(start.x, start.y);
  for (let i = 1; i < draft.points.length; i += 1) {
    const { x, y } = worldToCanvas(draft.points[i], base, camera, dims);
    ctx.lineTo(x, y);
  }
  ctx.stroke();
  ctx.setLineDash([]);

  draft.points.forEach((point, index) => {
    const { x, y } = worldToCanvas(point, base, camera, dims);
    ctx.beginPath();
    ctx.fillStyle = index === draft.points.length - 1
      ? 'rgba(248, 250, 252, 0.95)'
      : 'rgba(14, 165, 233, 0.95)';
    ctx.strokeStyle = 'rgba(15, 23, 42, 0.85)';
    ctx.lineWidth = Math.max(1.2, 1.2 / camera.zoom);
    ctx.arc(x, y, Math.max(5, 7 / camera.zoom), 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  });

  ctx.restore();
}

function getTrajectoryColour(agent: ScenarioAgent) {
  if (agent.type === 'VEHICLE') {
    return agent.isExpert ? 'rgba(34, 197, 94, 0.6)' : 'rgba(56, 189, 248, 0.65)';
  }

  return {
    PEDESTRIAN: 'rgba(249, 115, 22, 0.5)',
    CYCLIST: 'rgba(250, 204, 21, 0.5)',
    OTHER: 'rgba(226, 232, 240, 0.35)'
  }[agent.type] ?? 'rgba(226, 232, 240, 0.35)';
}

function drawTrajectory(
  ctx: CanvasRenderingContext2D,
  agent: ScenarioAgent,
  base: CanvasTransform,
  camera: CameraState,
  dims: CanvasDims,
  options: TrajectoryDrawOptions = {}
) {
  if (!agent.trajectory.length) {
    return;
  }

  ctx.save();
  const highlight = options.highlight;
  const isGhost = options.variant === 'ghost';
  if (isGhost) {
    const dash = 10;
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.45)';
    ctx.lineWidth = 2.1;
    ctx.setLineDash([dash, dash]);
  } else {
    const baseColour = getTrajectoryColour(agent);
    ctx.strokeStyle = highlight === 'selected'
      ? 'rgba(250, 204, 21, 0.95)'
      : highlight === 'hovered'
        ? 'rgba(34, 211, 238, 0.9)'
        : baseColour;
    ctx.lineWidth = highlight === 'selected'
      ? 3.4
      : highlight === 'hovered'
        ? 2.8
        : 2.25;
    ctx.setLineDash(highlight === 'hovered' ? [10, 12] : []);
  }

  let hasStarted = false;
  let lastPoint: { x: number; y: number } | null = null;

  agent.trajectory.forEach((point) => {
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
      hasStarted = false;
      lastPoint = null;
      return;
    }

    if (point.valid === false) {
      if (hasStarted) {
        ctx.stroke();
      }
      hasStarted = false;
      lastPoint = null;
      return;
    }

    if (Math.abs(point.x) > 1e4 || Math.abs(point.y) > 1e4) {
      if (hasStarted) {
        ctx.stroke();
      }
      hasStarted = false;
      lastPoint = null;
      return;
    }

    if (lastPoint) {
      const dx = point.x - lastPoint.x;
      const dy = point.y - lastPoint.y;
      const distance = Math.hypot(dx, dy);
      if (distance > 150) {
        if (hasStarted) {
          ctx.stroke();
        }
        hasStarted = false;
        lastPoint = null;
      }
    }

    const { x, y } = worldToCanvas(point, base, camera, dims);

    if (!hasStarted) {
      ctx.beginPath();
      ctx.moveTo(x, y);
      hasStarted = true;
    } else {
      ctx.lineTo(x, y);
    }

    lastPoint = { x: point.x, y: point.y };
  });

  if (hasStarted) {
    ctx.stroke();
  }

  ctx.restore();
}

function getAgentColours(agentState: ScenarioFrameAgentState, agentInfo?: ScenarioAgent) {
  if (agentState.valid === false) {
    return INACTIVE_AGENT_COLOUR;
  }

  if (agentState.type === 'VEHICLE') {
    const fill = agentInfo?.isExpert ? VEHICLE_COLOURS.expert : VEHICLE_COLOURS.nonExpert;
    return {
      fill,
      stroke: agentInfo?.isExpert ? '#a16207' : '#0f172a'
    };
  }

  const fill = TYPE_COLOURS[agentState.type] ?? TYPE_COLOURS.OTHER;
  return {
    fill,
    stroke: '#0f172a'
  };
}

function resolveAgentDimensions(agentState: ScenarioFrameAgentState, agentInfo?: ScenarioAgent) {
  const fallbackDims = DEFAULT_AGENT_DIMENSIONS[agentState.type] ?? DEFAULT_AGENT_DIMENSIONS.OTHER;
  const dimensions = agentInfo?.dimensions ?? fallbackDims;

  return {
    length: agentState.length ?? dimensions.length ?? fallbackDims.length,
    width: agentState.width ?? dimensions.width ?? fallbackDims.width,
    height: agentState.height ?? dimensions.height
  };
}

function isPointInsideAgent(
  point: { x: number; y: number },
  agentState: ScenarioFrameAgentState,
  agentInfo?: ScenarioAgent
) {
  const { length, width } = resolveAgentDimensions(agentState, agentInfo);
  if (length <= 0 || width <= 0) {
    return false;
  }

  const heading = agentState.heading ?? 0;
  const cos = Math.cos(heading);
  const sin = Math.sin(heading);
  const dx = point.x - agentState.x;
  const dy = point.y - agentState.y;

  const localX = cos * dx + sin * dy;
  const localY = -sin * dx + cos * dy;

  return Math.abs(localX) <= length / 2 && Math.abs(localY) <= width / 2;
}

function distanceToSegment(
  point: { x: number; y: number },
  start: { x: number; y: number },
  end: { x: number; y: number }
) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq === 0) {
    return Math.hypot(point.x - start.x, point.y - start.y);
  }

  const t = Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSq));
  const projX = start.x + t * dx;
  const projY = start.y + t * dy;
  return Math.hypot(point.x - projX, point.y - projY);
}

function projectPointRatioOntoSegment(
  point: { x: number; y: number },
  start: { x: number; y: number },
  end: { x: number; y: number }
): number {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq === 0) {
    return 0;
  }
  const t = ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSq;
  return Math.max(0, Math.min(1, t));
}

function interpolateRoadZ(
  start: { z?: number },
  end: { z?: number },
  ratio: number
): number | undefined {
  const startHasZ = typeof start.z === 'number' && Number.isFinite(start.z);
  const endHasZ = typeof end.z === 'number' && Number.isFinite(end.z);
  if (startHasZ && endHasZ) {
    return (start.z as number) + ((end.z as number) - (start.z as number)) * ratio;
  }
  if (startHasZ) {
    return start.z as number;
  }
  if (endHasZ) {
    return end.z as number;
  }
  return undefined;
}

function getElevationColour(value: number | undefined, range?: { min: number; max: number }): string | undefined {
  if (!range || typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined;
  }
  const span = Math.max(range.max - range.min, 1e-6);
  const t = Math.min(Math.max((value - range.min) / span, 0), 1);
  const hue = 220 - t * 220;
  return `hsl(${hue}, 85%, 55%)`;
}

function distanceToTrajectory(point: { x: number; y: number }, agent: ScenarioAgent) {
  let best = Number.POSITIVE_INFINITY;

  for (let i = 1; i < agent.trajectory.length; i += 1) {
    const prev = agent.trajectory[i - 1];
    const current = agent.trajectory[i];

    if (prev.valid === false || current.valid === false) {
      continue;
    }

    const segmentDistance = distanceToSegment(point, prev, current);
    if (segmentDistance < best) {
      best = segmentDistance;
    }
  }

  return best;
}

function findRoadHandleHit(point: { x: number; y: number }, edges: RoadEdge[], threshold: number): RoadHandleHit | undefined {
  let closest: RoadHandleHit | undefined;

  edges.forEach((edge) => {
    edge.points.forEach((vertex, index) => {
      const distance = Math.hypot(point.x - vertex.x, point.y - vertex.y);
      if (distance <= threshold && (!closest || distance < closest.distance)) {
        closest = {
          edge,
          pointIndex: index,
          distance
        };
      }
    });
  });

  return closest;
}

function findRoadSegmentHit(point: { x: number; y: number }, edges: RoadEdge[], threshold: number): RoadSegmentHit | undefined {
  let closest: RoadSegmentHit | undefined;

  edges.forEach((edge) => {
    if (edge.points.length < 2) {
      return;
    }

    for (let index = 1; index < edge.points.length; index += 1) {
      const start = edge.points[index - 1];
      const end = edge.points[index];
      const distance = distanceToSegment(point, start, end);
      if (distance <= threshold && (!closest || distance < closest.distance)) {
        closest = {
          edge,
          segmentIndex: index - 1,
          distance
        };
      }
    }
  });

  return closest;
}

function isGizmoMode(mode: DragMode): boolean {
  return mode === 'gizmo-translate-x' || mode === 'gizmo-translate-y' || mode === 'gizmo-rotate';
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

function drawTransformGizmo(
  ctx: CanvasRenderingContext2D,
  base: CanvasTransform,
  camera: CameraState,
  dims: CanvasDims,
  anchor: TrajectoryPoint
) {
  const anchorScreen = worldToCanvas(anchor, base, camera, dims);
  const xHandleWorld = { x: anchor.x + GIZMO_TRANSLATE_LENGTH, y: anchor.y };
  const yHandleWorld = { x: anchor.x, y: anchor.y + GIZMO_TRANSLATE_LENGTH };
  const xHandle = worldToCanvas(xHandleWorld, base, camera, dims);
  const yHandle = worldToCanvas(yHandleWorld, base, camera, dims);
  const rotationRef = worldToCanvas({ x: anchor.x + GIZMO_ROTATION_RADIUS, y: anchor.y }, base, camera, dims);
  const rotationRadius = Math.hypot(rotationRef.x - anchorScreen.x, rotationRef.y - anchorScreen.y);
  const lineWidth = Math.max(2.2, 3 / camera.zoom);

  ctx.save();
  ctx.lineWidth = lineWidth;
  ctx.lineCap = 'round';

  // X axis handle (right / east)
  ctx.strokeStyle = 'rgba(59, 130, 246, 0.95)';
  ctx.beginPath();
  ctx.moveTo(anchorScreen.x, anchorScreen.y);
  ctx.lineTo(xHandle.x, xHandle.y);
  ctx.stroke();
  const arrowSizeX = Math.max(6, 10 / camera.zoom);
  const dirX = Math.atan2(xHandle.y - anchorScreen.y, xHandle.x - anchorScreen.x);
  ctx.beginPath();
  ctx.moveTo(xHandle.x, xHandle.y);
  ctx.lineTo(xHandle.x - Math.cos(dirX - Math.PI / 6) * arrowSizeX, xHandle.y - Math.sin(dirX - Math.PI / 6) * arrowSizeX);
  ctx.lineTo(xHandle.x - Math.cos(dirX + Math.PI / 6) * arrowSizeX, xHandle.y - Math.sin(dirX + Math.PI / 6) * arrowSizeX);
  ctx.closePath();
  ctx.fillStyle = 'rgba(59, 130, 246, 0.9)';
  ctx.fill();

  // Y axis handle (up / north)
  ctx.strokeStyle = 'rgba(249, 115, 22, 0.95)';
  ctx.beginPath();
  ctx.moveTo(anchorScreen.x, anchorScreen.y);
  ctx.lineTo(yHandle.x, yHandle.y);
  ctx.stroke();
  const arrowSizeY = arrowSizeX;
  const dirY = Math.atan2(yHandle.y - anchorScreen.y, yHandle.x - anchorScreen.x);
  ctx.beginPath();
  ctx.moveTo(yHandle.x, yHandle.y);
  ctx.lineTo(yHandle.x - Math.cos(dirY - Math.PI / 6) * arrowSizeY, yHandle.y - Math.sin(dirY - Math.PI / 6) * arrowSizeY);
  ctx.lineTo(yHandle.x - Math.cos(dirY + Math.PI / 6) * arrowSizeY, yHandle.y - Math.sin(dirY + Math.PI / 6) * arrowSizeY);
  ctx.closePath();
  ctx.fillStyle = 'rgba(249, 115, 22, 0.85)';
  ctx.fill();

  // Rotation ring
  ctx.setLineDash([12 / Math.max(camera.zoom, 0.001), 10 / Math.max(camera.zoom, 0.001)]);
  ctx.strokeStyle = 'rgba(236, 72, 153, 0.8)';
  ctx.beginPath();
  ctx.arc(anchorScreen.x, anchorScreen.y, rotationRadius, 0, Math.PI * 2);
  ctx.stroke();
  ctx.setLineDash([]);

  // Rotation handle indicator at 0° (east)
  ctx.beginPath();
  ctx.fillStyle = 'rgba(236, 72, 153, 0.9)';
  ctx.arc(anchorScreen.x + rotationRadius, anchorScreen.y, Math.max(5, 7 / camera.zoom), 0, Math.PI * 2);
  ctx.fill();

  ctx.restore();
}

function hitTestGizmo(
  canvasX: number,
  canvasY: number,
  base: CanvasTransform,
  camera: CameraState,
  dims: CanvasDims,
  anchor: TrajectoryPoint
): DragMode | undefined {
  const anchorScreen = worldToCanvas(anchor, base, camera, dims);
  const xHandle = worldToCanvas({ x: anchor.x + GIZMO_TRANSLATE_LENGTH, y: anchor.y }, base, camera, dims);
  const yHandle = worldToCanvas({ x: anchor.x, y: anchor.y + GIZMO_TRANSLATE_LENGTH }, base, camera, dims);
  const rotationRef = worldToCanvas({ x: anchor.x + GIZMO_ROTATION_RADIUS, y: anchor.y }, base, camera, dims);
  const rotationRadius = Math.hypot(rotationRef.x - anchorScreen.x, rotationRef.y - anchorScreen.y);
  const distanceToAnchor = Math.hypot(canvasX - anchorScreen.x, canvasY - anchorScreen.y);

  if (Math.hypot(canvasX - xHandle.x, canvasY - xHandle.y) <= GIZMO_HANDLE_HIT_RADIUS) {
    return 'gizmo-translate-x';
  }

  if (Math.hypot(canvasX - yHandle.x, canvasY - yHandle.y) <= GIZMO_HANDLE_HIT_RADIUS) {
    return 'gizmo-translate-y';
  }

  if (Math.abs(distanceToAnchor - rotationRadius) <= GIZMO_ROTATION_HIT_TOLERANCE) {
    return 'gizmo-rotate';
  }

  return undefined;
}

function drawAgent(
  ctx: CanvasRenderingContext2D,
  agentState: ScenarioFrameAgentState,
  base: CanvasTransform,
  camera: CameraState,
  dims: CanvasDims,
  agentInfo: ScenarioAgent | undefined,
  options: AgentRenderOptions = {}
) {
  const {
    showLabel,
    labelMode = 'id',
    agentIndex,
    highlight,
    isTrackToPredict
  } = options;
  const dimensions = resolveAgentDimensions(agentState, agentInfo);
  const lengthMeters = dimensions.length;
  const widthMeters = dimensions.width;

  const lengthPx = lengthMeters * base.scale * camera.zoom;
  const widthPx = widthMeters * base.scale * camera.zoom;

  const { x, y } = worldToCanvas({ x: agentState.x, y: agentState.y }, base, camera, dims);

  const colours = getAgentColours(agentState, agentInfo);
  const highlightState = highlight ?? {};
  const isDriving = Boolean(highlightState.driving);
  const fillColour = isDriving ? '#f97316' : colours.fill;
  const strokeColour = isDriving ? '#fb923c' : colours.stroke;

  const baseLabel = showLabel
    ? labelMode === 'index'
      ? agentIndex != null
        ? `#${agentIndex}`
        : agentState.id
      : agentInfo?.displayName ?? agentState.id
    : undefined;
  const labelText = baseLabel
    ? isTrackToPredict
      ? `P ${baseLabel}`
      : baseLabel
    : undefined;

  ctx.save();
  ctx.translate(x, y);
  const headingValue = agentState.heading ?? 0;
  const rotation = -headingValue;
  ctx.rotate(rotation);
  ctx.fillStyle = fillColour;
  ctx.strokeStyle = strokeColour;
  ctx.lineWidth = 1.5;

  const halfLength = lengthPx / 2;
  const halfWidth = widthPx / 2;

  ctx.beginPath();
  ctx.rect(-halfLength, -halfWidth, lengthPx, widthPx);
  ctx.fill();
  ctx.stroke();

  if (agentState.valid !== false) {
    ctx.beginPath();
    ctx.moveTo(halfLength * 0.2, 0);
    ctx.lineTo(halfLength * 0.6, 0);
    ctx.strokeStyle = 'rgba(15, 23, 42, 0.65)';
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  if (isTrackToPredict) {
    const haloPadding = Math.max(5, 7 / camera.zoom);
    const haloLineWidth = Math.max(3.2, 3.6 / camera.zoom);
    const glow = Math.max(18, 24 / camera.zoom);

    ctx.save();
    ctx.setLineDash([]);
    ctx.lineWidth = haloLineWidth;
    ctx.strokeStyle = 'rgba(56, 189, 248, 0.95)';
    ctx.shadowColor = 'rgba(56, 189, 248, 0.65)';
    ctx.shadowBlur = glow;
    ctx.strokeRect(
      -halfLength - haloPadding,
      -halfWidth - haloPadding,
      lengthPx + haloPadding * 2,
      widthPx + haloPadding * 2
    );
    ctx.restore();

    ctx.save();
    ctx.fillStyle = 'rgba(56, 189, 248, 0.2)';
    ctx.fillRect(-halfLength, -halfWidth, lengthPx, widthPx);
    ctx.restore();
  }

  if (highlightState.selected || highlightState.hovered) {
    const isSelected = Boolean(highlightState.selected);
    ctx.lineWidth = Math.max(isSelected ? 3.2 : 2.2, (isSelected ? 3.2 : 2.2) / camera.zoom);
    const selectedStroke = agentInfo?.isExpert
      ? 'rgba(14, 165, 233, 0.95)'
      : 'rgba(250, 204, 21, 0.92)';
    ctx.strokeStyle = isSelected ? selectedStroke : 'rgba(94, 234, 212, 0.9)';
    ctx.setLineDash(isSelected ? [] : [12 / camera.zoom, 12 / camera.zoom]);
    ctx.strokeRect(-halfLength, -halfWidth, lengthPx, widthPx);
    ctx.setLineDash([]);
  }

  ctx.restore();

  if (labelText) {
    const fontSize = Math.max(9, 11 / camera.zoom);
    const verticalGap = Math.max(6, 10 / camera.zoom);
    const anchorY = y - halfWidth - verticalGap;

    ctx.save();
    ctx.font = `${fontSize}px "Segoe UI", sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const metrics = ctx.measureText(labelText);
    const paddingX = 4;
    const paddingY = 2;
    const rectWidth = metrics.width + paddingX * 2;
    const rectHeight = fontSize + paddingY * 2;
    const rectX = x - rectWidth / 2;
    const rectY = anchorY - rectHeight;
    const textY = rectY + rectHeight / 2;

    const labelFill = isTrackToPredict ? 'rgba(45, 212, 191, 0.92)' : 'rgba(15, 23, 42, 0.82)';
    const labelTextColour = isTrackToPredict ? '#022c22' : '#f8fafc';
    ctx.fillStyle = labelFill;
    ctx.fillRect(rectX, rectY, rectWidth, rectHeight);

    ctx.fillStyle = labelTextColour;
    ctx.fillText(labelText, x, textY);
    ctx.restore();
  }
}

function ScenarioViewer() {
  const {
    activeScenario,
    activeScenarioId,
    activeFrame,
    activeFrameIndex,
    visibleTrajectoryIds,
    showAgentLabels,
    agentLabelMode,
    pause,
    play,
    isPlaying,
    setActiveFrameIndex,
    applyRecordedTrajectory,
    updateAgentStartPose,
    addRoadEdge,
    updateRoadEdgePoints,
    updateRoadEdgePoint,
    insertRoadEdgePoint,
    splitRoadEdge,
    removeRoadEdgePoint,
    removeRoadEdge,
    editing
  } = useScenarioStore();
  const {
    state: editingState,
    setMode: setEditingMode,
    setTool: setEditingTool,
    setColorRoadVerticesByElevation,
    hoverEntity,
    selectEntity,
    clearSelection,
    setHoveredRoadHandle,
    setHoveredRoadSegment,
    setSelectedRoadHandle,
    cancelTrajectoryRecording,
    beginTrajectoryRecording,
    appendTrajectorySample,
    completeTrajectoryRecording,
    pushHistoryEntry,
    beginRoadDraft,
    appendRoadDraftPoint,
    removeRoadDraftPoint,
    completeRoadDraft,
    cancelRoadDraft
  } = editing;
  const rotationMode = editingState.rotationMode;
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const baseTransformRef = useRef<BaseTransformContext | null>(null);
  const lastScenarioIdRef = useRef<string | undefined>(undefined);
  const dragStateRef = useRef<DragState>({
    active: false,
    pointerId: null,
    lastX: 0,
    lastY: 0,
    hasMoved: false,
    mode: 'pan',
    gizmo: undefined,
    roadHandle: undefined
  });

  const [camera, setCamera] = useState<CameraState>({ zoom: INITIAL_ZOOM, panX: 0, panY: 0, rotation: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const [isDriveActive, setIsDriveActive] = useState(false);
  const driveSessionRef = useRef<DriveSession | null>(null);
  const driveAnimationRef = useRef<number | null>(null);
  const driveControlsRef = useRef<DriveControlsState>({
    forward: false,
    backward: false,
    left: false,
    right: false,
    brake: false
  });
  const drivePressedKeysRef = useRef<Set<string>>(new Set());
  const stopDriveModeRef = useRef<DriveModeStopper | null>(null);
  const [driveSettings, setDriveSettings] = useState<DriveSettings>(DRIVE_SETTINGS_DEFAULT);
  const driveSettingsRef = useRef<DriveSettings>(driveSettings);
  const wasPlayingRef = useRef(false);
  useEffect(() => {
    driveSettingsRef.current = driveSettings;
  }, [driveSettings]);
  const editingMode = editingState.mode;
  const activeTool = editingState.activeTool;
  const isRecording = editingState.isRecording;
  const selectedAgentId = editingState.selectedEntity?.kind === 'agent' ? editingState.selectedEntity.id : undefined;
  const hoveredAgentId = editingState.hoveredEntity?.kind === 'agent' ? editingState.hoveredEntity.id : undefined;
  const isEditMode = editingMode === 'trajectory' || editingMode === 'road';
  const isTrajectoryMode = editingMode === 'trajectory';
  const isRoadMode = editingMode === 'road';
  const isPointerRecordTool = activeTool === 'trajectory-record';
  const isDriveToolSelected = activeTool === 'trajectory-drive';
  const isPointerRecordActive = isPointerRecordTool && !isDriveActive;
  const isPointerRecording = isRecording && !isDriveActive;
  const trajectoryDraft = editingState.trajectoryDraft;
  const roadDraft = editingState.roadDraft;
  const selectedRoadId = editingState.selectedEntity?.kind === 'roadEdge' ? editingState.selectedEntity.id : undefined;
  const hoveredRoadId = editingState.hoveredEntity?.kind === 'roadEdge' ? editingState.hoveredEntity.id : undefined;
  const selectedRoadHandle = editingState.selectedRoadHandle;
  const hoveredRoadHandle = editingState.hoveredRoadHandle;
  const hoveredRoadSegment = editingState.hoveredRoadSegment;
  const roadElevationRange = useMemo(() => {
    if (!activeScenario) {
      return undefined;
    }

    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;

    activeScenario.roadEdges.forEach((edge) => {
      edge.points.forEach((point) => {
        if (typeof point.z === 'number' && Number.isFinite(point.z)) {
          min = Math.min(min, point.z);
          max = Math.max(max, point.z);
        }
      });
    });

    if (!Number.isFinite(min) || !Number.isFinite(max)) {
      return undefined;
    }

    return { min, max };
  }, [activeScenario]);
  const colorRoadVerticesByElevation = editingState.colorRoadVerticesByElevation;
  const selectedRoadEdge = useMemo(() => {
    if (!selectedRoadId || !activeScenario) {
      return undefined;
    }
    return activeScenario.roadEdges.find((edge) => edge.id === selectedRoadId);
  }, [activeScenario, selectedRoadId]);

  const summary = useMemo(() => {
    if (!activeScenario) {
      return null;
    }

    const agentCount = activeScenario.agents.length;
    const roadEdgeCount = activeScenario.roadEdges.length;

    return {
      agentCount,
      roadEdgeCount,
      frameCount: activeScenario.metadata.frameCount,
      durationSeconds: activeScenario.metadata.durationSeconds
    };
  }, [activeScenario]);

  const agentById = useMemo(() => {
    if (!activeScenario) {
      return new Map<string, ScenarioAgent>();
    }

    return new Map(activeScenario.agents.map((agent) => [agent.id, agent]));
  }, [activeScenario]);

  const agentIndexById = useMemo(() => {
    if (!activeScenario) {
      return new Map<string, number>();
    }

    return new Map(activeScenario.agents.map((agent, index) => [agent.id, index] as const));
  }, [activeScenario]);

  const trajectoryAgents = useMemo(() => {
    if (!activeScenario) {
      return [] as ScenarioAgent[];
    }

    const ids = new Set(visibleTrajectoryIds);
    if (selectedAgentId) {
      ids.add(selectedAgentId);
    }
    if (hoveredAgentId) {
      ids.add(hoveredAgentId);
    }

    if (ids.size === 0) {
      return [] as ScenarioAgent[];
    }

    return activeScenario.agents.filter((agent) => ids.has(agent.id));
  }, [activeScenario, visibleTrajectoryIds, selectedAgentId, hoveredAgentId]);

  const tracksToPredictSet = useMemo(() => {
    if (!activeScenario) {
      return new Set<number>();
    }

    return new Set(activeScenario.tracksToPredict);
  }, [activeScenario]);

  const selectedAgentInfo = useMemo(() => {
    if (!selectedAgentId) {
      return undefined;
    }
    return agentById.get(selectedAgentId);
  }, [agentById, selectedAgentId]);

  const selectedAnchorPoint = useMemo(() => {
    if (!selectedAgentInfo) {
      return undefined;
    }

    return selectedAgentInfo.trajectory.find((point) => point.valid !== false) ?? selectedAgentInfo.trajectory[0];
  }, [selectedAgentInfo]);

  useEffect(() => {
    if (!isRoadMode) {
      if (selectedRoadHandle) {
        setSelectedRoadHandle(undefined);
      }
      return;
    }

    if (!selectedRoadId) {
      if (selectedRoadHandle) {
        setSelectedRoadHandle(undefined);
      }
      return;
    }

    const edge = activeScenario?.roadEdges.find((candidate) => candidate.id === selectedRoadId);
    if (!edge || edge.points.length === 0) {
      if (selectedRoadHandle) {
        setSelectedRoadHandle(undefined);
      }
      return;
    }

    if (
      !selectedRoadHandle
      || selectedRoadHandle.roadId !== selectedRoadId
      || selectedRoadHandle.pointIndex < 0
      || selectedRoadHandle.pointIndex >= edge.points.length
    ) {
      const safeIndex = Math.min(
        Math.max(selectedRoadHandle?.pointIndex ?? 0, 0),
        edge.points.length - 1
      );
      setSelectedRoadHandle({ roadId: selectedRoadId, pointIndex: safeIndex });
    }
  }, [
    activeScenario?.roadEdges,
    isRoadMode,
    selectedRoadHandle,
    selectedRoadId,
    setSelectedRoadHandle
  ]);

  const updateDriveCamera = useCallback((position: { x: number; y: number }) => {
    const baseContext = baseTransformRef.current;
    if (!baseContext) {
      return;
    }

    const { width, height } = baseContext;
    if (width === 0 || height === 0) {
      return;
    }

    const dims: CanvasDims = { width, height };
    const centerX = width / 2;
    const centerY = height / 2;
    const anchor = worldToAnchor(position, baseContext.transform, dims);
    const dx = anchor.x - centerX;
    const dy = anchor.y - centerY;

    setCamera((prev) => {
      const zoom = prev.zoom;
      return {
        zoom,
        panX: -(dx * zoom),
        panY: -(dy * zoom),
        rotation: 0
      };
    });
  }, [setCamera]);

  const resetCameraOrientation = useCallback(() => {
    setCamera((prev) => ({
      zoom: prev.zoom,
      panX: 0,
      panY: 0,
      rotation: 0
    }));
  }, [setCamera]);

  const applySelection = useCallback((entity?: EditingEntityRef) => {
    if (!entity) {
      clearSelection();
      return;
    }

    selectEntity(entity);

    if (entity.kind === 'agent' && activeTool.startsWith('road')) {
      setEditingTool('trajectory-edit');
    }

    if (entity.kind === 'roadEdge' && editingMode === 'road' && activeTool !== 'road-edit') {
      setEditingTool('road-edit');
    }
  }, [
    clearSelection,
    selectEntity,
    activeTool,
    setEditingTool,
    editingMode
  ]);

  const getEntityAtCanvasXY = useCallback((canvasX: number, canvasY: number): EditingEntityRef | undefined => {
    const baseContext = baseTransformRef.current;
    if (!baseContext || !activeScenario) {
      return undefined;
    }

    const dims: CanvasDims = { width: baseContext.width, height: baseContext.height };
    const worldPoint = canvasToWorld(canvasX, canvasY, baseContext.transform, camera, dims);

    if (activeFrame) {
      for (let index = activeFrame.agents.length - 1; index >= 0; index -= 1) {
        const agentState = activeFrame.agents[index];
        if (agentState.valid === false) {
          continue;
        }
        const agentInfo = agentById.get(agentState.id);
        if (!agentInfo) {
          continue;
        }
        if (isPointInsideAgent(worldPoint, agentState, agentInfo)) {
          return { kind: 'agent', id: agentState.id };
        }
      }
    }

    const proximityThresholdMeters = 1.6;
    let closest: { id: string; distance: number } | undefined;

    trajectoryAgents.forEach((agent) => {
      if (agent.trajectory.length < 2) {
        return;
      }

      const distance = distanceToTrajectory(worldPoint, agent);
      if (distance <= proximityThresholdMeters && (!closest || distance < closest.distance)) {
        closest = { id: agent.id, distance };
      }
    });

    if (closest) {
      return { kind: 'agent', id: closest.id };
    }

    if (isRoadMode) {
      const handleHit = findRoadHandleHit(worldPoint, activeScenario.roadEdges, ROAD_VERTEX_HIT_RADIUS_METERS);
      if (handleHit) {
        return { kind: 'roadEdge', id: handleHit.edge.id };
      }

      const segmentHit = findRoadSegmentHit(worldPoint, activeScenario.roadEdges, ROAD_SEGMENT_HIT_RADIUS_METERS);
      if (segmentHit) {
        return { kind: 'roadEdge', id: segmentHit.edge.id };
      }
    }

    return undefined;
  }, [activeScenario, activeFrame, agentById, trajectoryAgents, camera, isRoadMode]);

  const updateHoverFromEvent = useCallback((event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!canvasRef.current) {
      return;
    }

    const dragState = dragStateRef.current;
    if (dragState.active && dragState.pointerId === event.pointerId && dragState.hasMoved) {
      return;
    }

    const rect = canvasRef.current.getBoundingClientRect();
    const canvasX = event.clientX - rect.left;
    const canvasY = event.clientY - rect.top;
    const baseContext = baseTransformRef.current;

    if (!isRoadMode || !baseContext || !activeScenario) {
      setHoveredRoadHandle(undefined);
      setHoveredRoadSegment(undefined);
    } else {
      const dims: CanvasDims = { width: baseContext.width, height: baseContext.height };
      const worldPoint = canvasToWorld(canvasX, canvasY, baseContext.transform, camera, dims);

      const handleHit = findRoadHandleHit(worldPoint, activeScenario.roadEdges, ROAD_VERTEX_HIT_RADIUS_METERS);
      if (handleHit) {
        setHoveredRoadHandle({ roadId: handleHit.edge.id, pointIndex: handleHit.pointIndex });
        setHoveredRoadSegment(undefined);
      } else {
        const segmentHit = findRoadSegmentHit(worldPoint, activeScenario.roadEdges, ROAD_SEGMENT_HIT_RADIUS_METERS);
        if (segmentHit) {
          setHoveredRoadSegment({
            roadId: segmentHit.edge.id,
            segmentIndex: segmentHit.segmentIndex,
            distance: segmentHit.distance
          });
          setHoveredRoadHandle(undefined);
        } else {
          setHoveredRoadHandle(undefined);
          setHoveredRoadSegment(undefined);
        }
      }
    }

    const hit = getEntityAtCanvasXY(canvasX, canvasY);

    if (!hit) {
      if (editingState.hoveredEntity) {
        hoverEntity(undefined);
      }
      return;
    }

    if (
      !editingState.hoveredEntity
      || editingState.hoveredEntity.id !== hit.id
      || editingState.hoveredEntity.kind !== hit.kind
    ) {
      hoverEntity(hit);
    }
  }, [
    getEntityAtCanvasXY,
    hoverEntity,
    editingState.hoveredEntity,
    isRoadMode,
    activeScenario,
    setHoveredRoadHandle,
    setHoveredRoadSegment,
    camera
  ]);

  const syncDriveControls = useCallback(() => {
    const pressed = drivePressedKeysRef.current;
    const controls: DriveControlsState = {
      forward: pressed.has('ArrowUp') || pressed.has('KeyW'),
      backward: pressed.has('ArrowDown') || pressed.has('KeyS'),
      left: pressed.has('ArrowLeft') || pressed.has('KeyA'),
      right: pressed.has('ArrowRight') || pressed.has('KeyD'),
      brake: pressed.has('Space')
    };
    driveControlsRef.current = controls;
    return controls;
  }, []);

  const runDriveLoop = useCallback((timestamp: number) => {
    const session = driveSessionRef.current;
    if (!session) {
      driveAnimationRef.current = null;
      return;
    }

    if (timestamp < session.lastTimestampMs) {
      session.lastTimestampMs = timestamp;
    }

    const deltaMs = timestamp - session.lastTimestampMs;
    const dt = Math.max(deltaMs, 0) / 1000;
    session.lastTimestampMs = timestamp;

    const controls = syncDriveControls();
    const settings = driveSettingsRef.current;
    const throttleInput = (controls.forward ? 1 : 0) + (controls.backward ? -1 : 0);

    const steerInput = (controls.right ? 1 : 0) - (controls.left ? 1 : 0);

    // Update speed (longitudinal motion)
    let nextSpeed = session.speed;
    if (controls.brake) {
      if (nextSpeed > 0) {
        nextSpeed = Math.max(0, nextSpeed - settings.brakeDeceleration * dt);
      } else if (nextSpeed < 0) {
        nextSpeed = Math.min(0, nextSpeed + settings.brakeDeceleration * dt);
      }
    } else if (throttleInput > 0) {
      const speedAbs = Math.abs(nextSpeed);
      const launchBoost = 1 + Math.max(0, 4 - speedAbs) * 0.25;
      nextSpeed = Math.min(
        settings.maxSpeed,
        nextSpeed + settings.acceleration * throttleInput * launchBoost * dt
      );
    } else if (throttleInput < 0) {
      const speedAbs = Math.abs(nextSpeed);
      const reverseBoost = 1 + Math.max(0, 3 - speedAbs) * 0.2;
      nextSpeed = Math.max(
        -settings.maxReverseSpeed,
        nextSpeed + settings.reverseAcceleration * throttleInput * reverseBoost * dt
      );
    } else if (Math.abs(nextSpeed) < 0.02) {
      nextSpeed = 0;
    }
    session.speed = nextSpeed;

    // Update heading (lateral motion)
    if (steerInput !== 0) {
      const speedAbs = Math.abs(session.speed);
      const speedRatio = settings.maxSpeed > 0 ? Math.min(speedAbs / settings.maxSpeed, 1) : 0;
      const hasThrottle = Math.abs(throttleInput) > 0;
      const hasBrake = controls.brake;
      const baseMin = hasThrottle ? 0.75 : hasBrake ? 0.5 : 0;
      const effectiveRatio = Math.max(speedRatio, baseMin);
      const steerDelta = -steerInput * settings.steerRate * effectiveRatio * dt;
      session.heading += steerDelta;
    }

    const distance = session.speed * dt;
    if (distance !== 0) {
      session.position.x += Math.cos(session.heading) * distance;
      session.position.y += Math.sin(session.heading) * distance;
    }

    const frameIntervalMicros = activeScenario?.metadata.frameIntervalMicros ?? DEFAULT_FRAME_INTERVAL_MICROS;
    const frameIntervalMs = Math.max(frameIntervalMicros / 1000, 1);

    while (timestamp >= session.nextSampleTimestampMs) {
      appendTrajectorySample({
        x: session.position.x,
        y: session.position.y,
        timestampMs: session.nextSampleTimestampMs
      });
      session.nextSampleTimestampMs += frameIntervalMs;
    }

    const frameCount = activeScenario?.metadata.frameCount ?? 0;
    if (frameIntervalMs > 0 && frameCount > 0) {
      const elapsedMs = timestamp - session.startTimestampMs;
      const targetFrame = Math.min(
        Math.floor(elapsedMs / frameIntervalMs),
        Math.max(frameCount - 1, 0)
      );
      setActiveFrameIndex(targetFrame);
    }

    updateDriveCamera(session.position);

    if (driveSessionRef.current) {
      driveAnimationRef.current = requestAnimationFrame(runDriveLoop);
    } else {
      driveAnimationRef.current = null;
    }
  }, [
    activeScenario?.metadata.frameCount,
    activeScenario?.metadata.frameIntervalMicros,
    appendTrajectorySample,
    setActiveFrameIndex,
    updateDriveCamera,
    syncDriveControls
  ]);

  const stopDriveMode = useCallback((commit: boolean) => {
    const session = driveSessionRef.current;
    if (driveAnimationRef.current !== null) {
      cancelAnimationFrame(driveAnimationRef.current);
      driveAnimationRef.current = null;
    }

    driveSessionRef.current = null;
    driveControlsRef.current = {
      forward: false,
      backward: false,
      left: false,
      right: false,
      brake: false
    };
    drivePressedKeysRef.current.clear();
    syncDriveControls();

    if (isDriveActive) {
      setIsDriveActive(false);
    }
    resetCameraOrientation();

    const draftSamples = editingState.trajectoryDraft?.samples ?? [];
    const samples = [...draftSamples];

    if (commit && session) {
      const finalTimestamp = typeof performance !== 'undefined' ? performance.now() : Date.now();
      const lastSample = samples[samples.length - 1];
      if (!lastSample || finalTimestamp - lastSample.timestampMs > 5) {
        samples.push({
          x: session.position.x,
          y: session.position.y,
          timestampMs: finalTimestamp
        });
      }

      if (activeScenarioId && samples.length >= 2) {
        const applied = applyRecordedTrajectory(activeScenarioId, session.agentId, samples);
        if (applied) {
          const agentInfo = agentById.get(session.agentId);
          const label = `Recorded drive for ${agentInfo?.displayName ?? session.agentId}`;
          completeTrajectoryRecording({ label });
        } else {
          cancelTrajectoryRecording();
        }
      } else {
        cancelTrajectoryRecording();
      }
    } else {
      cancelTrajectoryRecording();
    }

    setActiveFrameIndex(0);
    setEditingTool('trajectory-edit');
  }, [
    activeScenarioId,
    agentById,
    applyRecordedTrajectory,
    cancelTrajectoryRecording,
    completeTrajectoryRecording,
    editingState.trajectoryDraft?.samples,
    isDriveActive,
    syncDriveControls,
    resetCameraOrientation,
    setActiveFrameIndex,
    setEditingTool
  ]);

  useEffect(() => {
    stopDriveModeRef.current = stopDriveMode;
  }, [stopDriveMode]);

  const startDriveMode = useCallback(() => {
    if (isDriveActive || !selectedAgentId || !activeScenario) {
      return;
    }

    const agentInfo = agentById.get(selectedAgentId);
    if (!agentInfo || agentInfo.trajectory.length === 0) {
      return;
    }

    const anchorPoint = agentInfo.trajectory.find((point) => point.valid !== false) ?? agentInfo.trajectory[0];
    if (!anchorPoint) {
      return;
    }

    const frameIntervalMicros = activeScenario.metadata.frameIntervalMicros ?? DEFAULT_FRAME_INTERVAL_MICROS;
    const frameIntervalMs = Math.max(frameIntervalMicros / 1000, 1);
    const startTimestamp = typeof performance !== 'undefined' ? performance.now() : Date.now();

    pause();
    setEditingMode('trajectory');
    selectEntity({ kind: 'agent', id: selectedAgentId });
    setActiveFrameIndex(0);

    beginTrajectoryRecording({ agentId: selectedAgentId, startedAtMs: startTimestamp });
    setEditingTool('trajectory-drive');
    appendTrajectorySample({ x: anchorPoint.x, y: anchorPoint.y, timestampMs: startTimestamp });

    driveSessionRef.current = {
      agentId: selectedAgentId,
      startTimestampMs: startTimestamp,
      lastTimestampMs: startTimestamp,
      nextSampleTimestampMs: startTimestamp + frameIntervalMs,
      position: { x: anchorPoint.x, y: anchorPoint.y },
      heading: anchorPoint.heading ?? 0,
      speed: 0
    };

    driveControlsRef.current = {
      forward: false,
      backward: false,
      left: false,
      right: false,
      brake: false
    };
    drivePressedKeysRef.current.clear();
    syncDriveControls();

    setIsDriveActive(true);
    updateDriveCamera({ x: anchorPoint.x, y: anchorPoint.y });
    driveAnimationRef.current = requestAnimationFrame(runDriveLoop);
    // Give keyboard focus to the canvas for reliable multi-key input
    setTimeout(() => {
      try {
        canvasRef.current?.focus?.();
      } catch {}
    }, 0);
  }, [
    activeScenario,
    agentById,
    appendTrajectorySample,
    beginTrajectoryRecording,
    pause,
    runDriveLoop,
    selectEntity,
    setActiveFrameIndex,
    setEditingMode,
    setEditingTool,
    selectedAgentId,
    updateDriveCamera,
    isDriveActive,
    syncDriveControls
  ]);

  const handleDriveToggle = useCallback(() => {
    if (isDriveActive) {
      stopDriveMode(true);
    } else {
      startDriveMode();
    }
  }, [isDriveActive, startDriveMode, stopDriveMode]);

  const handleDriveSettingChange = useCallback((key: keyof DriveSettings, value: number) => {
    setDriveSettings((prev) => {
      const next = { ...prev, [key]: value };
      if (key === 'maxSpeed') {
        next.maxReverseSpeed = Math.max(4, value * 0.32);
      }
      if (key === 'acceleration') {
        next.reverseAcceleration = Math.max(3, value * 0.7);
        next.brakeDeceleration = Math.max(value * 1.05, prev.brakeDeceleration);
      }
      if (key === 'steerRate') {
        next.steerRate = Math.max(0.6, value);
      }
      return next;
    });
  }, []);

  useEffect(() => {
    if (!isDriveActive) {
      return undefined;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      const session = driveSessionRef.current;
      if (!session) {
        return;
      }

      if (event.code === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        if (typeof event.stopImmediatePropagation === 'function') {
          event.stopImmediatePropagation();
        }
        stopDriveMode(false);
        return;
      }

      if (event.code === 'Enter') {
        event.preventDefault();
        event.stopPropagation();
        if (typeof event.stopImmediatePropagation === 'function') {
          event.stopImmediatePropagation();
        }
        stopDriveMode(true);
        return;
      }

      if (!DRIVE_KEY_CODES.has(event.code)) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      if (typeof event.stopImmediatePropagation === 'function') {
        event.stopImmediatePropagation();
      }

      drivePressedKeysRef.current.add(event.code);
      syncDriveControls();
    };

    const handleKeyUp = (event: KeyboardEvent) => {
      if (!DRIVE_KEY_CODES.has(event.code)) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      if (typeof event.stopImmediatePropagation === 'function') {
        event.stopImmediatePropagation();
      }

      drivePressedKeysRef.current.delete(event.code);
      syncDriveControls();
    };

    window.addEventListener('keydown', handleKeyDown, { passive: false, capture: true });
    window.addEventListener('keyup', handleKeyUp, { passive: false, capture: true });

    return () => {
      window.removeEventListener('keydown', handleKeyDown, { capture: true } as any);
      window.removeEventListener('keyup', handleKeyUp, { capture: true } as any);
      drivePressedKeysRef.current.clear();
      driveControlsRef.current = {
        forward: false,
        backward: false,
        left: false,
        right: false,
        brake: false
      };
      syncDriveControls();
    };
  }, [isDriveActive, stopDriveMode, syncDriveControls]);

  useEffect(() => {
    if (!isDriveActive) {
      return;
    }

    const session = driveSessionRef.current;
    if (!session) {
      stopDriveMode(false);
      return;
    }

    if (!activeScenario) {
      stopDriveMode(false);
      return;
    }

    if (selectedAgentId && session.agentId !== selectedAgentId) {
      stopDriveMode(false);
    }
  }, [isDriveActive, activeScenario?.metadata.id, selectedAgentId, stopDriveMode]);

  useEffect(() => () => {
    if (driveAnimationRef.current !== null) {
      cancelAnimationFrame(driveAnimationRef.current);
      driveAnimationRef.current = null;
    }
    if (driveSessionRef.current) {
      const stopper = stopDriveModeRef.current;
      if (stopper) {
        stopper(false);
      } else {
        driveSessionRef.current = null;
        driveControlsRef.current = {
          forward: false,
          backward: false,
          left: false,
          right: false,
          brake: false
        };
        drivePressedKeysRef.current.clear();
        syncDriveControls();
      }
    }
  }, [syncDriveControls]);

  const handleModeChange = useCallback((mode: EditingMode) => {
    if (mode === editingMode) {
      return;
    }

    setEditingMode(mode);

    if (mode === 'trajectory' && (activeTool === 'select' || activeTool.startsWith('road'))) {
      setEditingTool('trajectory-edit');
    }

    if (mode === 'road') {
      if (activeTool === 'select' || activeTool.startsWith('trajectory')) {
        setEditingTool('road-edit');
      }
      if (isRecording) {
        cancelTrajectoryRecording();
      }
      if (isDriveActive) {
        stopDriveMode(false);
      }
    }
  }, [
    editingMode,
    setEditingMode,
    setEditingTool,
    activeTool,
    isRecording,
    cancelTrajectoryRecording,
    isDriveActive,
    stopDriveMode
  ]);

  const handleToolChange = useCallback((tool: EditingTool) => {
    if (tool !== activeTool) {
      setEditingTool(tool);
    }

    if (tool !== 'trajectory-record' && isRecording) {
      cancelTrajectoryRecording();
    }
    if (tool !== 'trajectory-drive' && isDriveActive) {
      stopDriveMode(false);
    }
  }, [activeTool, setEditingTool, isRecording, cancelTrajectoryRecording, isDriveActive, stopDriveMode]);

  const handleToggleRoadElevationColor = useCallback(() => {
    setColorRoadVerticesByElevation(!colorRoadVerticesByElevation);
  }, [colorRoadVerticesByElevation, setColorRoadVerticesByElevation]);

  const finalizeRoadDraft = useCallback(() => {
    if (!activeScenarioId) {
      return false;
    }

    const draft = completeRoadDraft();
    if (!draft || draft.points.length < 2) {
      return false;
    }

    const created = addRoadEdge(activeScenarioId, {
      id: draft.id,
      type: draft.type,
      points: draft.points
    });

    if (!created) {
      return false;
    }

    selectEntity({ kind: 'roadEdge', id: created.id });
    const now = Date.now();
    pushHistoryEntry({
      id: `road-add-${created.id}-${now.toString(36)}`,
      label: `Drew ${created.type ?? 'road edge'}`,
      timestamp: now
    });

    return true;
  }, [
    activeScenarioId,
    completeRoadDraft,
    addRoadEdge,
    selectEntity,
    pushHistoryEntry
  ]);

  useEffect(() => {
    if (!isRoadMode || activeTool !== 'road-add') {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        finalizeRoadDraft();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        cancelRoadDraft();
      } else if ((event.key === 'Backspace' || event.key === 'Delete') && (roadDraft?.points.length ?? 0) > 0) {
        event.preventDefault();
        removeRoadDraftPoint();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [
    isRoadMode,
    activeTool,
    finalizeRoadDraft,
    cancelRoadDraft,
    removeRoadDraftPoint,
    roadDraft?.points.length
  ]);

  useEffect(() => {
    if (!isRoadMode || activeTool !== 'road-edit') {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (!activeScenarioId) {
        return;
      }

      const isDeleteKey = event.key === 'Backspace' || event.key === 'Delete';

      if (event.shiftKey && event.key.toLowerCase() === 's') {
        if (!selectedRoadEdge || !selectedRoadHandle || selectedRoadHandle.roadId !== selectedRoadEdge.id) {
          return;
        }

        const pointIndex = selectedRoadHandle.pointIndex;
        const firstSegmentLength = pointIndex;
        const secondSegmentLength = selectedRoadEdge.points.length - pointIndex;
        if (firstSegmentLength >= 2 && secondSegmentLength >= 2) {
          event.preventDefault();
          const result = splitRoadEdge(activeScenarioId, selectedRoadEdge.id, pointIndex);
          if (result) {
            selectEntity({ kind: 'roadEdge', id: result.created.id });
            setSelectedRoadHandle({
              roadId: result.created.id,
              pointIndex: 0
            });
            const now = Date.now();
            pushHistoryEntry({
              id: `road-split-${selectedRoadEdge.id}-${pointIndex}-${now.toString(36)}`,
              label: `Split road segment ${selectedRoadEdge.id} at vertex ${pointIndex}`,
              timestamp: now
            });
          }
        }
        return;
      }

      if (isDeleteKey) {
        if (event.shiftKey && selectedRoadHandle) {
          const edge = activeScenario?.roadEdges.find((candidate) => candidate.id === selectedRoadHandle.roadId);
          if (!edge) {
            return;
          }

          event.preventDefault();
          const removed = removeRoadEdgePoint(activeScenarioId, selectedRoadHandle.roadId, selectedRoadHandle.pointIndex);
          if (removed) {
            const fallbackIndex = Math.max(
              0,
              Math.min(selectedRoadHandle.pointIndex, edge.points.length - 2)
            );
            setSelectedRoadHandle({
              roadId: selectedRoadHandle.roadId,
              pointIndex: fallbackIndex
            });
            const now = Date.now();
            pushHistoryEntry({
              id: `road-vertex-delete-${selectedRoadHandle.roadId}-${now.toString(36)}`,
              label: `Removed vertex from ${edge.type ?? 'road edge'}`,
              timestamp: now
            });
          }
          return;
        }

        if (selectedRoadId && selectedRoadEdge) {
          event.preventDefault();
          const removed = removeRoadEdge(activeScenarioId, selectedRoadId);
          if (removed) {
            clearSelection();
            setSelectedRoadHandle(undefined);
            const now = Date.now();
            pushHistoryEntry({
              id: `road-delete-${selectedRoadId}-${now.toString(36)}`,
              label: `Deleted road segment ${selectedRoadId}`,
              timestamp: now
            });
          }
          return;
        }
      }

      if ((event.key === '[' || event.key === ']') && selectedRoadHandle) {
        const edge = activeScenario?.roadEdges.find((candidate) => candidate.id === selectedRoadHandle.roadId);
        if (!edge) {
          return;
        }

        event.preventDefault();
        const delta = event.key === ']' ? 1 : -1;
        const nextIndex = Math.min(
          Math.max(selectedRoadHandle.pointIndex + delta, 0),
          edge.points.length - 1
        );
        setSelectedRoadHandle({
          roadId: selectedRoadHandle.roadId,
          pointIndex: nextIndex
        });
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [
    isRoadMode,
    activeTool,
    activeScenario,
    activeScenarioId,
    selectedRoadId,
    selectedRoadEdge,
    selectedRoadHandle,
    removeRoadEdgePoint,
    splitRoadEdge,
    removeRoadEdge,
    setSelectedRoadHandle,
    clearSelection,
    selectEntity,
    pushHistoryEntry
  ]);


  useEffect(() => {
    setCamera({ zoom: INITIAL_ZOOM, panX: 0, panY: 0, rotation: 0 });
  }, [activeScenario?.metadata.id, setCamera]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }

    const ctx = canvas.getContext('2d');
    if (!ctx) {
      return;
    }

    const dpr = window.devicePixelRatio || 1;
    const { clientWidth, clientHeight } = canvas;
    const width = Math.max(clientWidth, 1);
    const height = Math.max(clientHeight, 1);

    if (canvas.width !== width * dpr || canvas.height !== height * dpr) {
      canvas.width = width * dpr;
      canvas.height = height * dpr;
    }

    if (typeof ctx.resetTransform === 'function') {
      ctx.resetTransform();
    } else {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
    }
    ctx.scale(dpr, dpr);

    ctx.fillStyle = 'rgba(15, 23, 42, 0.95)';
    ctx.fillRect(0, 0, width, height);

    const prevBaseContext = baseTransformRef.current;
    const previousScenarioId = lastScenarioIdRef.current;
    const currentScenarioId = activeScenario?.metadata.id;

    if (!activeScenario) {
      baseTransformRef.current = null;
      lastScenarioIdRef.current = currentScenarioId;
      return;
    }

    const dims: CanvasDims = { width, height };
    const baseTransform = computeTransform(activeScenario.bounds, width, height);
    baseTransformRef.current = { transform: baseTransform, width, height };

    if (
      prevBaseContext
      && previousScenarioId
      && previousScenarioId === currentScenarioId
    ) {
      const prevTransform = prevBaseContext.transform;
      const prevDims: CanvasDims = { width: prevBaseContext.width, height: prevBaseContext.height };
      const resizeChanged = prevBaseContext.width !== width || prevBaseContext.height !== height;
      const transformChanged =
        Math.abs(prevTransform.scale - baseTransform.scale) > 1e-6
        || Math.abs(prevTransform.offsetX - baseTransform.offsetX) > 1e-6
        || Math.abs(prevTransform.offsetY - baseTransform.offsetY) > 1e-6
        || resizeChanged;

      if (transformChanged) {
        const focusWorld = canvasToWorld(prevDims.width / 2, prevDims.height / 2, prevTransform, camera, prevDims);
        const targetScale = prevTransform.scale * camera.zoom;
        const nextScale = baseTransform.scale;
        const rawZoom = nextScale > 1e-9 ? targetScale / nextScale : camera.zoom;
        const clampedZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, rawZoom));

        const newDims: CanvasDims = { width, height };
        const centerX = width / 2;
        const centerY = height / 2;
        const anchor = worldToAnchor(focusWorld, baseTransform, newDims);
        const dx = anchor.x - centerX;
        const dy = anchor.y - centerY;
        const cos = Math.cos(camera.rotation);
        const sin = Math.sin(camera.rotation);
        const rotatedX = dx * cos - dy * sin;
        const rotatedY = dx * sin + dy * cos;
        const nextPanX = -(rotatedX * clampedZoom);
        const nextPanY = -(rotatedY * clampedZoom);

        const zoomDelta = Math.abs(clampedZoom - camera.zoom);
        const panXDelta = Math.abs(nextPanX - camera.panX);
        const panYDelta = Math.abs(nextPanY - camera.panY);

        if (zoomDelta > 1e-4 || panXDelta > 0.5 || panYDelta > 0.5) {
          setCamera((prevCamera) => ({
            zoom: clampedZoom,
            panX: nextPanX,
            panY: nextPanY,
            rotation: prevCamera.rotation
          }));
        }
      }
    }

    lastScenarioIdRef.current = currentScenarioId;

    drawRoadEdges(ctx, activeScenario.roadEdges, baseTransform, camera, dims, {
      selectedId: selectedRoadId,
      hoveredId: hoveredRoadId,
      showVertices: isRoadMode && activeTool === 'road-edit',
      selectedVertex: selectedRoadHandle,
      hoveredVertex: hoveredRoadHandle,
      hoveredSegment: hoveredRoadSegment,
      colorByElevation: colorRoadVerticesByElevation,
      elevationRange: roadElevationRange
    });

    if (roadDraft) {
      drawRoadDraft(ctx, roadDraft, baseTransform, camera, dims);
    }

    const drivingAgentId = driveSessionRef.current?.agentId;

    const recordingAgentId = isPointerRecording ? trajectoryDraft?.agentId : undefined;
    trajectoryAgents.forEach((agent) => {
      const isDrivingAgent = isDriveActive && drivingAgentId === agent.id;
      const isRecordingAgent = recordingAgentId === agent.id;
      const highlight = isDrivingAgent
        ? 'selected'
        : agent.id === selectedAgentId
          ? 'selected'
          : agent.id === hoveredAgentId
            ? 'hovered'
            : undefined;

      if (isRecordingAgent) {
        drawTrajectory(ctx, agent, baseTransform, camera, dims, { variant: 'ghost' });
      } else {
        drawTrajectory(ctx, agent, baseTransform, camera, dims, { highlight });
      }
    });

    if (trajectoryDraft && trajectoryDraft.samples.length > 0) {
      ctx.save();
      const dashLength = 8 / Math.max(camera.zoom, 0.0001);
      ctx.lineWidth = Math.max(2.4, 2.4 / camera.zoom);
      ctx.strokeStyle = 'rgba(250, 204, 21, 0.85)';
      ctx.setLineDash([dashLength, dashLength]);

      const first = worldToCanvas(trajectoryDraft.samples[0], baseTransform, camera, dims);
      ctx.beginPath();
      ctx.moveTo(first.x, first.y);
      for (let i = 1; i < trajectoryDraft.samples.length; i += 1) {
        const point = worldToCanvas(trajectoryDraft.samples[i], baseTransform, camera, dims);
        ctx.lineTo(point.x, point.y);
      }
      ctx.stroke();

      ctx.setLineDash([]);
      const tipPoint = worldToCanvas(
        trajectoryDraft.samples[trajectoryDraft.samples.length - 1],
        baseTransform,
        camera,
        dims
      );
      const tipRadius = Math.max(4, 6 / camera.zoom);
      ctx.beginPath();
      ctx.fillStyle = 'rgba(250, 204, 21, 0.9)';
      ctx.arc(tipPoint.x, tipPoint.y, tipRadius, 0, Math.PI * 2);
      ctx.fill();

      ctx.restore();
    }

    if (activeFrame) {
      activeFrame.agents.forEach((agentState) => {
        const agentInfo = agentById.get(agentState.id);
        const isDrivingAgent = isDriveActive && drivingAgentId === agentState.id;
        let renderState = agentState;
        if (isDrivingAgent) {
          const session = driveSessionRef.current;
          renderState = {
            ...agentState,
            x: session?.position.x ?? agentState.x,
            y: session?.position.y ?? agentState.y,
            heading: session?.heading ?? agentState.heading,
            speed: session?.speed ?? agentState.speed
          };
        }
        const highlight = {
          selected: renderState.id === selectedAgentId || isDrivingAgent,
          hovered: renderState.id === hoveredAgentId && renderState.id !== selectedAgentId,
          driving: isDrivingAgent
        };
        const agentIndex = agentIndexById.get(agentState.id);
        const isTrackToPredict = typeof agentIndex === 'number' && tracksToPredictSet.has(agentIndex);
        drawAgent(ctx, renderState, baseTransform, camera, dims, agentInfo, {
          showLabel: showAgentLabels,
          labelMode: agentLabelMode,
          agentIndex,
          highlight,
          isTrackToPredict
        });
      });
    }

    if (selectedAnchorPoint && selectedAgentInfo && !isDriveActive) {
      drawTransformGizmo(ctx, baseTransform, camera, dims, selectedAnchorPoint);
    }
  }, [
    activeScenario,
    activeFrame,
    activeFrameIndex,
    trajectoryAgents,
    agentById,
    agentIndexById,
    camera,
    setCamera,
    selectedAgentId,
    hoveredAgentId,
    showAgentLabels,
    agentLabelMode,
    isDriveActive,
    tracksToPredictSet,
    trajectoryDraft,
    selectedAnchorPoint,
    selectedAgentInfo,
    selectedRoadId,
    hoveredRoadId,
    selectedRoadHandle,
    hoveredRoadHandle,
    hoveredRoadSegment,
    isRoadMode,
    activeTool,
    roadDraft,
    colorRoadVerticesByElevation,
    roadElevationRange
  ]);

  const handlePointerDown = useCallback((event: ReactPointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }

    const baseContext = baseTransformRef.current;
    const rect = canvas.getBoundingClientRect();
    const canvasX = event.clientX - rect.left;
    const canvasY = event.clientY - rect.top;
    const isPrimaryButton = event.button === 0;

    if (isPrimaryButton && isRoadMode && baseContext) {
      const dims: CanvasDims = { width: baseContext.width, height: baseContext.height };
      const worldPoint = canvasToWorld(canvasX, canvasY, baseContext.transform, camera, dims);

      if (activeTool === 'road-add' && activeScenarioId) {
        if (!roadDraft) {
          beginRoadDraft({ scenarioId: activeScenarioId, startPoint: worldPoint });
        } else {
          appendRoadDraftPoint(worldPoint);
        }
        updateHoverFromEvent(event);
        return;
      }

      if (activeTool === 'road-edit' && activeScenario) {
        const handleHit = findRoadHandleHit(worldPoint, activeScenario.roadEdges, ROAD_VERTEX_HIT_RADIUS_METERS);
        if (handleHit) {
          if ((event.altKey || event.metaKey) && activeScenarioId) {
            const removed = removeRoadEdgePoint(activeScenarioId, handleHit.edge.id, handleHit.pointIndex);
            if (removed) {
              const nextIndex = Math.max(0, Math.min(handleHit.pointIndex, handleHit.edge.points.length - 2));
              setSelectedRoadHandle({ roadId: handleHit.edge.id, pointIndex: nextIndex });
              applySelection({ kind: 'roadEdge', id: handleHit.edge.id });
              const now = Date.now();
              pushHistoryEntry({
                id: `road-vertex-delete-${handleHit.edge.id}-${now.toString(36)}`,
                label: `Removed vertex from ${handleHit.edge.type ?? 'road edge'}`,
                timestamp: now
              });
              updateHoverFromEvent(event);
            }
            return;
          }

          canvas.setPointerCapture(event.pointerId);
          dragStateRef.current = {
            active: true,
            pointerId: event.pointerId,
            lastX: event.clientX,
            lastY: event.clientY,
            hasMoved: false,
            mode: 'road-handle',
            gizmo: undefined,
            roadHandle: {
              roadId: handleHit.edge.id,
              pointIndex: handleHit.pointIndex,
              originalPoints: [...handleHit.edge.points],
              changed: false
            }
          };
          setIsDragging(false);
          applySelection({ kind: 'roadEdge', id: handleHit.edge.id });
          setSelectedRoadHandle({ roadId: handleHit.edge.id, pointIndex: handleHit.pointIndex });
          return;
        }

        if ((event.shiftKey || event.ctrlKey) && activeScenarioId) {
          const segmentHit = findRoadSegmentHit(worldPoint, activeScenario.roadEdges, ROAD_SEGMENT_HIT_RADIUS_METERS);
          if (segmentHit) {
            const start = segmentHit.edge.points[segmentHit.segmentIndex];
            const end = segmentHit.edge.points[segmentHit.segmentIndex + 1];
            const ratio = projectPointRatioOntoSegment(worldPoint, start, end);
            const interpolatedZ = interpolateRoadZ(start, end, ratio);
            const insertPoint = typeof interpolatedZ === 'number'
              ? { x: worldPoint.x, y: worldPoint.y, z: interpolatedZ }
              : { x: worldPoint.x, y: worldPoint.y };
            const insertedIndex = insertRoadEdgePoint(activeScenarioId, segmentHit.edge.id, insertPoint, {
              afterIndex: segmentHit.segmentIndex
            });
            if (typeof insertedIndex === 'number') {
              applySelection({ kind: 'roadEdge', id: segmentHit.edge.id });
              setSelectedRoadHandle({ roadId: segmentHit.edge.id, pointIndex: insertedIndex });
              const now = Date.now();
              pushHistoryEntry({
                id: `road-vertex-insert-${segmentHit.edge.id}-${now.toString(36)}`,
                label: `Inserted vertex on ${segmentHit.edge.type ?? 'road edge'}`,
                timestamp: now
              });
              updateHoverFromEvent(event);
            }
            return;
          }
        }
      }
    }

    if (
      isPrimaryButton &&
      baseContext &&
      selectedAgentId &&
      selectedAnchorPoint &&
      !isPointerRecordActive
    ) {
      const dims: CanvasDims = { width: baseContext.width, height: baseContext.height };
      const gizmoMode = hitTestGizmo(canvasX, canvasY, baseContext.transform, camera, dims, selectedAnchorPoint);
      if (gizmoMode) {
        canvas.setPointerCapture(event.pointerId);
        const pointerWorld = canvasToWorld(canvasX, canvasY, baseContext.transform, camera, dims);
        const pointerAngle = Math.atan2(pointerWorld.y - selectedAnchorPoint.y, pointerWorld.x - selectedAnchorPoint.x);
        dragStateRef.current = {
          active: true,
          pointerId: event.pointerId,
          lastX: event.clientX,
          lastY: event.clientY,
          hasMoved: false,
          mode: gizmoMode,
          gizmo: {
            kind: gizmoMode === 'gizmo-rotate' ? 'rotate' : 'translate',
            axis: gizmoMode === 'gizmo-translate-x' ? 'x' : gizmoMode === 'gizmo-translate-y' ? 'y' : undefined,
            startAnchor: { x: selectedAnchorPoint.x, y: selectedAnchorPoint.y },
            startHeading: selectedAnchorPoint.heading ?? 0,
            startPointerWorld: pointerWorld,
            startPointerAngle: gizmoMode === 'gizmo-rotate' ? pointerAngle : undefined,
            changed: false
          }
        };
        setIsDragging(false);
        return;
      }
    }

    let interactionMode: 'pan' | 'record' = 'pan';
    let targetAgentId = selectedAgentId;

    if (isPrimaryButton && isPointerRecordActive) {
      if (!targetAgentId) {
        const hit = getEntityAtCanvasXY(canvasX, canvasY);
        if (hit?.kind === 'agent') {
          applySelection(hit);
          targetAgentId = hit.id;
        }
      }

      if (targetAgentId && activeScenarioId) {
        interactionMode = 'record';
      }
    }

    canvas.setPointerCapture(event.pointerId);

    dragStateRef.current = {
      active: true,
      pointerId: event.pointerId,
      lastX: event.clientX,
      lastY: event.clientY,
      hasMoved: false,
      mode: interactionMode,
      gizmo: undefined
    };

    if (interactionMode === 'record' && targetAgentId && activeScenarioId) {
      if (!baseContext) {
        dragStateRef.current.mode = 'pan';
        setIsDragging(false);
        updateHoverFromEvent(event);
        return;
      }

      wasPlayingRef.current = isPlaying;
      if (!isPlaying) {
        play();
      }

      const dims: CanvasDims = { width: baseContext.width, height: baseContext.height };
      const worldPoint = canvasToWorld(canvasX, canvasY, baseContext.transform, camera, dims);
      const timestampMs = typeof performance !== 'undefined' ? performance.now() : Date.now();

      beginTrajectoryRecording({ agentId: targetAgentId, startedAtMs: timestampMs });
      appendTrajectorySample({
        x: worldPoint.x,
        y: worldPoint.y,
        timestampMs
      });
    } else {
      setIsDragging(false);
      updateHoverFromEvent(event);
    }
  }, [
    activeScenario,
    activeScenarioId,
    activeTool,
    appendRoadDraftPoint,
    appendTrajectorySample,
    applySelection,
    beginRoadDraft,
    beginTrajectoryRecording,
    camera,
    getEntityAtCanvasXY,
    insertRoadEdgePoint,
    isPointerRecordActive,
    isPlaying,
    isRoadMode,
    play,
    pushHistoryEntry,
    removeRoadEdgePoint,
    roadDraft,
    selectedAgentId,
    selectedAnchorPoint,
    setIsDragging,
    setSelectedRoadHandle,
    updateHoverFromEvent
  ]);

  const handlePointerMove = useCallback((event: ReactPointerEvent<HTMLCanvasElement>) => {
    const state = dragStateRef.current;

    if (!state.active || state.pointerId !== event.pointerId) {
      updateHoverFromEvent(event);
      return;
    }

    if (state.mode === 'record') {
      const baseContext = baseTransformRef.current;
      const canvas = canvasRef.current;
      if (!baseContext || !canvas) {
        return;
      }

      const rect = canvas.getBoundingClientRect();
      const canvasX = event.clientX - rect.left;
      const canvasY = event.clientY - rect.top;
      const dims: CanvasDims = { width: baseContext.width, height: baseContext.height };
      const worldPoint = canvasToWorld(canvasX, canvasY, baseContext.transform, camera, dims);
      const timestampMs = typeof performance !== 'undefined' ? performance.now() : Date.now();

      const lastSample = editingState.trajectoryDraft?.samples?.[editingState.trajectoryDraft.samples.length - 1];
      const distance = lastSample ? Math.hypot(worldPoint.x - lastSample.x, worldPoint.y - lastSample.y) : Infinity;
      const elapsedMs = lastSample ? timestampMs - lastSample.timestampMs : Infinity;

      if (distance > 0.05 || elapsedMs > 30) {
        appendTrajectorySample({
          x: worldPoint.x,
          y: worldPoint.y,
          timestampMs
        });
        state.hasMoved = true;
      }

      return;
    }

    if (isGizmoMode(state.mode)) {
      const baseContext = baseTransformRef.current;
      const canvas = canvasRef.current;
      const gizmo = state.gizmo;
      if (!baseContext || !canvas || !gizmo || !activeScenarioId || !selectedAgentId) {
        return;
      }

      const rect = canvas.getBoundingClientRect();
      const canvasX = event.clientX - rect.left;
      const canvasY = event.clientY - rect.top;
      const dims: CanvasDims = { width: baseContext.width, height: baseContext.height };
      const pointerWorld = canvasToWorld(canvasX, canvasY, baseContext.transform, camera, dims);

      if (gizmo.kind === 'translate' && gizmo.axis) {
        const dx = pointerWorld.x - gizmo.startPointerWorld.x;
        const dy = pointerWorld.y - gizmo.startPointerWorld.y;
        const delta = gizmo.axis === 'x' ? dx : dy;
        const nextX = gizmo.startAnchor.x + (gizmo.axis === 'x' ? delta : 0);
        const nextY = gizmo.startAnchor.y + (gizmo.axis === 'y' ? delta : 0);
        updateAgentStartPose(activeScenarioId, selectedAgentId, {
          x: nextX,
          y: nextY
        });
        state.gizmo = {
          ...gizmo,
          changed: true
        };
      } else if (gizmo.kind === 'rotate') {
        const anchor = gizmo.startAnchor;
        const angle = Math.atan2(pointerWorld.y - anchor.y, pointerWorld.x - anchor.x);
        const deltaAngle = normalizeAngle(angle - (gizmo.startPointerAngle ?? angle));
        const nextHeading = normalizeAngle(gizmo.startHeading + deltaAngle);
        updateAgentStartPose(activeScenarioId, selectedAgentId, {
          headingRadians: nextHeading
        }, { rotationMode });
        state.gizmo = {
          ...gizmo,
          changed: true
        };
      }

      return;
    }

    if (state.mode === 'road-handle') {
      const baseContext = baseTransformRef.current;
      const canvas = canvasRef.current;
      const handle = state.roadHandle;
      if (!baseContext || !canvas || !handle || !activeScenarioId) {
        return;
      }

      const rect = canvas.getBoundingClientRect();
      const canvasX = event.clientX - rect.left;
      const canvasY = event.clientY - rect.top;
      const dims: CanvasDims = { width: baseContext.width, height: baseContext.height };
      const pointerWorld = canvasToWorld(canvasX, canvasY, baseContext.transform, camera, dims);

      const nextPoints = handle.originalPoints.map((point, index) => (
        index === handle.pointIndex
          ? {
              x: pointerWorld.x,
              y: pointerWorld.y,
              ...(typeof point.z === 'number' ? { z: point.z } : {})
            }
          : point
      ));

      updateRoadEdgePoints(activeScenarioId, handle.roadId, nextPoints);

      state.roadHandle = {
        ...handle,
        changed: true
      };
      state.hasMoved = true;
      setIsDragging(true);
      return;
    }

    const dx = event.clientX - state.lastX;
    const dy = event.clientY - state.lastY;
    state.lastX = event.clientX;
    state.lastY = event.clientY;

    if (!state.hasMoved) {
      const travel = Math.abs(dx) + Math.abs(dy);
      if (travel > 2) {
        state.hasMoved = true;
        setIsDragging(true);
      }
    }

    if (state.hasMoved) {
      setCamera((prev) => ({
        zoom: prev.zoom,
        panX: prev.panX + dx,
        panY: prev.panY + dy,
        rotation: prev.rotation
      }));
    }

    updateHoverFromEvent(event);
  }, [
    appendTrajectorySample,
    camera,
    editingState.trajectoryDraft,
    setCamera,
    updateHoverFromEvent,
    activeScenarioId,
    selectedAgentId,
    updateAgentStartPose,
    rotationMode,
    updateRoadEdgePoints
  ]);

  const releasePointerCapture = useCallback((pointerId: number) => {
    const canvas = canvasRef.current;
    if (canvas && canvas.hasPointerCapture(pointerId)) {
      canvas.releasePointerCapture(pointerId);
    }
  }, []);

  const resetDragState = useCallback(() => {
    dragStateRef.current = {
      active: false,
      pointerId: null,
      lastX: 0,
      lastY: 0,
      hasMoved: false,
      mode: 'pan',
      gizmo: undefined,
      roadHandle: undefined
    };
    setIsDragging(false);
  }, []);

  const handlePointerUp = useCallback((event: ReactPointerEvent<HTMLCanvasElement>) => {
    const state = dragStateRef.current;

    if (state.pointerId !== event.pointerId) {
      releasePointerCapture(event.pointerId);
      resetDragState();
      return;
    }

    if (state.mode === 'record') {
      const draft = editingState.trajectoryDraft;
      const baseContext = baseTransformRef.current;
      const canvas = canvasRef.current;

      if (draft && baseContext && canvas) {
        const rect = canvas.getBoundingClientRect();
        const canvasX = event.clientX - rect.left;
        const canvasY = event.clientY - rect.top;
        const dims: CanvasDims = { width: baseContext.width, height: baseContext.height };
        const worldPoint = canvasToWorld(canvasX, canvasY, baseContext.transform, camera, dims);
        const lastSample = draft.samples[draft.samples.length - 1];
        const finalSample = {
          x: worldPoint.x,
          y: worldPoint.y,
          timestampMs: typeof performance !== 'undefined' ? performance.now() : Date.now()
        };

        const distanceToLast = lastSample
          ? Math.hypot(finalSample.x - lastSample.x, finalSample.y - lastSample.y)
          : Infinity;
        const recordedSamples =
          lastSample && distanceToLast < 0.02
            ? draft.samples
            : [...draft.samples, finalSample];

        if (activeScenarioId && draft.agentId && recordedSamples.length >= 2) {
          const didUpdate = applyRecordedTrajectory(activeScenarioId, draft.agentId, recordedSamples);
          if (didUpdate) {
            const agentInfo = agentById.get(draft.agentId);
            const label = `Recorded path for ${agentInfo?.displayName ?? draft.agentId}`;
            completeTrajectoryRecording({ label });
          } else {
            cancelTrajectoryRecording();
          }
        } else {
          cancelTrajectoryRecording();
        }
      } else {
        cancelTrajectoryRecording();
      }

      if (!wasPlayingRef.current) {
        pause();
      }
      wasPlayingRef.current = false;

      releasePointerCapture(event.pointerId);
      resetDragState();
      return;
    }

    if (isGizmoMode(state.mode)) {
      const gizmo = state.gizmo;
      if (gizmo?.changed && activeScenarioId && selectedAgentId) {
        const agentInfo = agentById.get(selectedAgentId);
        const now = Date.now();
        const actionLabel = gizmo.kind === 'rotate'
          ? `Rotated start pose`
          : gizmo.axis === 'x'
            ? `Moved start pose (X)`
            : `Moved start pose (Y)`;
        pushHistoryEntry({
          id: `gizmo-${selectedAgentId}-${now.toString(36)}`,
          label: `${actionLabel} for ${agentInfo?.displayName ?? selectedAgentId}`,
          timestamp: now
        });
      }

      releasePointerCapture(event.pointerId);
      resetDragState();
      return;
    }

    if (state.mode === 'road-handle') {
      const handle = state.roadHandle;
      if (handle?.changed && activeScenarioId) {
        const now = Date.now();
        const roadInfo = activeScenario?.roadEdges.find((edge) => edge.id === handle.roadId);
        pushHistoryEntry({
          id: `road-handle-${handle.roadId}-${now.toString(36)}`,
          label: `Adjusted ${roadInfo?.type ?? 'road edge'} vertex`,
          timestamp: now
        });
      }

      releasePointerCapture(event.pointerId);
      resetDragState();
      return;
    }

    if (!state.hasMoved && event.button === 0) {
      if (canvasRef.current) {
        const rect = canvasRef.current.getBoundingClientRect();
        const canvasX = event.clientX - rect.left;
        const canvasY = event.clientY - rect.top;
        const hit = getEntityAtCanvasXY(canvasX, canvasY);
        if (hit) {
          applySelection(hit);
        } else {
          applySelection(undefined);
          hoverEntity(undefined);
        }
      }
    }

    releasePointerCapture(event.pointerId);
    resetDragState();
  }, [
    editingState.trajectoryDraft,
    activeScenarioId,
    applyRecordedTrajectory,
    agentById,
    completeTrajectoryRecording,
    pause,
    cancelTrajectoryRecording,
    camera,
    getEntityAtCanvasXY,
    applySelection,
    hoverEntity,
    wasPlayingRef,
    releasePointerCapture,
    resetDragState,
    selectedAgentId,
    pushHistoryEntry,
    activeScenario
  ]);

  const handlePointerLeave = useCallback((event: ReactPointerEvent<HTMLCanvasElement>) => {
    const state = dragStateRef.current;
    if (state.pointerId === event.pointerId) {
      if (state.mode === 'record' && editingState.isRecording) {
        cancelTrajectoryRecording();
        if (!wasPlayingRef.current) {
          pause();
        }
        wasPlayingRef.current = false;
      } else if (isGizmoMode(state.mode)) {
        const gizmo = state.gizmo;
        if (gizmo?.changed && activeScenarioId && selectedAgentId) {
          const agentInfo = agentById.get(selectedAgentId);
          const now = Date.now();
          const actionLabel = gizmo.kind === 'rotate'
            ? `Rotated start pose`
            : gizmo.axis === 'x'
              ? `Moved start pose (X)`
              : `Moved start pose (Y)`;
          pushHistoryEntry({
            id: `gizmo-${selectedAgentId}-${now.toString(36)}`,
            label: `${actionLabel} for ${agentInfo?.displayName ?? selectedAgentId}`,
            timestamp: now
          });
        }
      } else if (state.mode === 'road-handle') {
        const handle = state.roadHandle;
        if (handle?.changed && activeScenarioId) {
          const now = Date.now();
          const roadInfo = activeScenario?.roadEdges.find((edge) => edge.id === handle.roadId);
          pushHistoryEntry({
            id: `road-handle-${handle.roadId}-${now.toString(36)}`,
            label: `Adjusted ${roadInfo?.type ?? 'road edge'} vertex`,
            timestamp: now
          });
        }
      }
      releasePointerCapture(event.pointerId);
      resetDragState();
    }
    setHoveredRoadHandle(undefined);
    setHoveredRoadSegment(undefined);
    hoverEntity(undefined);
  }, [
    editingState.isRecording,
    cancelTrajectoryRecording,
    pause,
    releasePointerCapture,
    resetDragState,
    hoverEntity,
    activeScenarioId,
    selectedAgentId,
    agentById,
    pushHistoryEntry,
    activeScenario,
    setHoveredRoadHandle,
    setHoveredRoadSegment
  ]);

  const handlePointerCancel = useCallback((event: ReactPointerEvent<HTMLCanvasElement>) => {
    const state = dragStateRef.current;
    if (state.pointerId === event.pointerId) {
      if (state.mode === 'record' && editingState.isRecording) {
        cancelTrajectoryRecording();
      } else if (isGizmoMode(state.mode)) {
        const gizmo = state.gizmo;
        if (gizmo?.changed && activeScenarioId && selectedAgentId) {
          const agentInfo = agentById.get(selectedAgentId);
          const now = Date.now();
          const actionLabel = gizmo.kind === 'rotate'
            ? `Rotated start pose`
            : gizmo.axis === 'x'
              ? `Moved start pose (X)`
              : `Moved start pose (Y)`;
          pushHistoryEntry({
            id: `gizmo-${selectedAgentId}-${now.toString(36)}`,
            label: `${actionLabel} for ${agentInfo?.displayName ?? selectedAgentId}`,
            timestamp: now
          });
        }
      } else if (state.mode === 'road-handle') {
        const handle = state.roadHandle;
        if (handle?.changed && activeScenarioId) {
          const now = Date.now();
          const roadInfo = activeScenario?.roadEdges.find((edge) => edge.id === handle.roadId);
          pushHistoryEntry({
            id: `road-handle-${handle.roadId}-${now.toString(36)}`,
            label: `Adjusted ${roadInfo?.type ?? 'road edge'} vertex`,
            timestamp: now
          });
        }
      }
      releasePointerCapture(event.pointerId);
      resetDragState();
    }
    setHoveredRoadHandle(undefined);
    setHoveredRoadSegment(undefined);
    hoverEntity(undefined);
  }, [
    editingState.isRecording,
    cancelTrajectoryRecording,
    releasePointerCapture,
    resetDragState,
    hoverEntity,
    activeScenarioId,
    selectedAgentId,
    agentById,
    pushHistoryEntry,
    activeScenario,
    setHoveredRoadHandle,
    setHoveredRoadSegment
  ]);

  const handleWheel = useCallback(
    (event: React.WheelEvent<HTMLCanvasElement>) => {
      event.preventDefault();
      event.stopPropagation();

      const canvas = canvasRef.current;
      const baseContext = baseTransformRef.current;
      if (!canvas || !baseContext) {
        return;
      }

      const rect = canvas.getBoundingClientRect();
      const pointerX = event.clientX - rect.left;
      const pointerY = event.clientY - rect.top;

      const zoomFactor = event.deltaY < 0 ? 1.1 : 0.9;

      setCamera((prev) => {
        const nextZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, prev.zoom * zoomFactor));
        if (Math.abs(nextZoom - prev.zoom) < 0.0001) {
          return prev;
        }

        const { transform, width, height } = baseContext;
        const dims: CanvasDims = { width, height };
        const worldPoint = canvasToWorld(pointerX, pointerY, transform, prev, dims);
        const anchor = worldToAnchor(worldPoint, transform, dims);
        const centerX = width / 2;
        const centerY = height / 2;

        const panX = pointerX - ((anchor.x - centerX) * nextZoom + centerX);
        const panY = pointerY - ((anchor.y - centerY) * nextZoom + centerY);

        return {
          zoom: nextZoom,
          panX,
          panY,
          rotation: prev.rotation
        };
      });
    },
    []
  );

  const stageClassName = [
    'viewer__stage',
    isDragging ? 'viewer__stage--dragging' : '',
    isEditMode ? 'viewer__stage--editing' : ''
  ].filter(Boolean).join(' ');

  return (
    <section className="viewer">
      <header className="viewer__header">
        <h2>Top-Down Preview</h2>
        {summary && (
          <div className="viewer__summary">
            <span>{summary.agentCount} agents</span>
            <span>{summary.roadEdgeCount} road edges</span>
            <span>{summary.frameCount} frames</span>
            <span>{summary.durationSeconds.toFixed(1)}s</span>
          </div>
        )}
      </header>

      <div className={stageClassName}>
        <canvas
          ref={canvasRef}
          className="viewer__canvas"
          tabIndex={0}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerLeave={handlePointerLeave}
          onPointerCancel={handlePointerCancel}
          onWheel={handleWheel}
        />
        <div className="viewer__toolbar">
          <div className="viewer__toolbar-row">
            <span className="viewer__toolbar-label">Mode</span>
            <div className="viewer__toolbar-buttons">
              <button
                type="button"
                className="button button--secondary viewer__toolbar-button"
                aria-pressed={editingMode === 'trajectory'}
                onClick={() => handleModeChange('trajectory')}
              >
                <span className="viewer__toolbar-button-icon" aria-hidden="true">{TOOLBAR_ICONS.trajectory}</span>
                <span>Trajectory</span>
              </button>
              <button
                type="button"
                className="button button--secondary viewer__toolbar-button"
                aria-pressed={editingMode === 'road'}
                onClick={() => handleModeChange('road')}
              >
                <span className="viewer__toolbar-button-icon" aria-hidden="true">{TOOLBAR_ICONS.road}</span>
                <span>Road</span>
              </button>
            </div>
          </div>

          {isTrajectoryMode && (
            <div className="viewer__toolbar-row">
              <span className="viewer__toolbar-label">Trajectory</span>
              <div className="viewer__toolbar-buttons">
                <button
                  type="button"
                  className="button button--secondary viewer__toolbar-button"
                  aria-pressed={activeTool === 'trajectory-edit'}
                  onClick={() => handleToolChange('trajectory-edit')}
                >
                  <span className="viewer__toolbar-button-icon" aria-hidden="true">{TOOLBAR_ICONS.adjust}</span>
                  <span>Adjust Path</span>
                </button>
                <button
                  type="button"
                  className="button button--secondary viewer__toolbar-button"
                  aria-pressed={isPointerRecordActive || isPointerRecording}
                  onClick={() => handleToolChange('trajectory-record')}
                  disabled={isDriveActive}
                >
                  <span className="viewer__toolbar-button-icon" aria-hidden="true">{TOOLBAR_ICONS.record}</span>
                  <span>{isPointerRecording ? 'Recording…' : 'Record Path'}</span>
                </button>
                <button
                  type="button"
                  className="button button--secondary viewer__toolbar-button"
                  aria-pressed={isDriveActive}
                  onClick={handleDriveToggle}
                  disabled={!selectedAgentId}
                >
                  <span className="viewer__toolbar-button-icon" aria-hidden="true">{TOOLBAR_ICONS.drive}</span>
                  <span className="viewer__toolbar-button-text">
                    <span>{isDriveActive ? 'Stop Drive' : 'Drive Agent'}</span>
                    <span className="viewer__toolbar-button-note">Experimental · clunky</span>
                  </span>
                </button>
              </div>
            </div>
          )}

          {isTrajectoryMode && (isDriveToolSelected || isDriveActive) && (
            <div className="viewer__toolbar-row viewer__toolbar-row--settings">
              <span className="viewer__toolbar-label">Drive Tune</span>
              <div className="viewer__toolbar-settings">
                <label>
                  <span>Max Speed {Math.round(driveSettings.maxSpeed * 3.6)} km/h</span>
                  <input
                    type="range"
                    min="8"
                    max="54"
                    step="1"
                    value={driveSettings.maxSpeed}
                    onChange={(event) => handleDriveSettingChange('maxSpeed', Number(event.target.value))}
                  />
                </label>
                <label>
                  <span>Acceleration {driveSettings.acceleration.toFixed(1)} m/s²</span>
                  <input
                    type="range"
                    min="4"
                    max="28"
                    step="0.5"
                    value={driveSettings.acceleration}
                    onChange={(event) => handleDriveSettingChange('acceleration', Number(event.target.value))}
                  />
                </label>
                <label>
                  <span>Steer Sensitivity {driveSettings.steerRate.toFixed(1)}</span>
                  <input
                    type="range"
                    min="0.6"
                    max="9"
                    step="0.1"
                    value={driveSettings.steerRate}
                    onChange={(event) => handleDriveSettingChange('steerRate', Number(event.target.value))}
                  />
                </label>
              </div>
            </div>
          )}

          {isRoadMode && (
            <div className="viewer__toolbar-row">
              <span className="viewer__toolbar-label">Road</span>
              <div className="viewer__toolbar-buttons">
                <button
                  type="button"
                  className="button button--secondary"
                  aria-pressed={activeTool === 'road-edit'}
                  onClick={() => handleToolChange('road-edit')}
                >
                  Edit Geometry
                </button>
                <button
                  type="button"
                  className="button button--secondary"
                  aria-pressed={activeTool === 'road-add'}
                  onClick={() => handleToolChange('road-add')}
                >
                  Draw Road
                </button>
                <button
                  type="button"
                  className="button button--secondary"
                  aria-pressed={colorRoadVerticesByElevation}
                  onClick={handleToggleRoadElevationColor}
                >
                  Color by Z
                </button>
              </div>
            </div>
          )}

          {isDriveActive && (
            <div className="viewer__toolbar-banner">
              <span>Drive mode – arrow keys steer, space brakes, Enter to save, Esc to cancel</span>
            </div>
          )}
          {!isDriveActive && isPointerRecording && (
            <div className="viewer__toolbar-banner">
              <span>Recording path… playback reset to frame 0</span>
            </div>
          )}
          {isRoadMode && activeTool === 'road-add' && (
            <div className="viewer__toolbar-banner">
              <span>Road draw mode – click to place vertices, Enter to finish, Esc to cancel</span>
            </div>
          )}
        </div>
        {!activeScenario && (
          <p className="viewer__overlay">
            Load or create a scenario to start exploring the scene.
          </p>
        )}
        {activeScenario && activeScenario.frames.length === 0 && (
          <p className="viewer__overlay">
            This scenario has no frames yet. Add an agent or record a trajectory to begin editing.
          </p>
        )}
      </div>
    </section>
  );
}

export default ScenarioViewer;
