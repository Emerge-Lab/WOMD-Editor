import { useCallback, useEffect, useMemo, useState, type ChangeEvent, type KeyboardEvent } from 'react';
import ExportPreviewModal from '@/components/ExportPreviewModal';
import { downloadScenarioAsBinary, downloadScenarioAsJson } from '@/lib/scenarioExporter';
import { compareScenarioForExport, type ScenarioExportComparison } from '@/lib/scenarioDiff';
import { useScenarioStore, type AgentLabelMode } from '@/state/scenarioStore';
import type { AgentType, ScenarioAgent } from '@/types/scenario';

const ROAD_TYPE_OPTIONS = [
  { value: 'ROAD_EDGE', label: 'Road Edge' },
  { value: 'ROAD_LINE', label: 'Road Line' },
  { value: 'CROSSWALK', label: 'Crosswalk' },
  { value: 'OTHER', label: 'Other' }
] as const;

const AGENT_TYPE_OPTIONS: Array<{ value: AgentType; label: string }> = [
  { value: 'VEHICLE', label: 'Vehicle' },
  { value: 'PEDESTRIAN', label: 'Pedestrian' },
  { value: 'CYCLIST', label: 'Cyclist' },
  { value: 'OTHER', label: 'Other' }
];

const DEFAULT_AGENT_DIMENSIONS: Record<AgentType, { length: number; width: number; height?: number }> = {
  VEHICLE: { length: 4.5, width: 2.0, height: 1.6 },
  PEDESTRIAN: { length: 0.8, width: 0.8, height: 1.8 },
  CYCLIST: { length: 1.8, width: 0.6, height: 1.6 },
  OTHER: { length: 2.0, width: 1.0, height: 1.5 }
};

function normalizeScenarioName(name: string | undefined): string {
  if (!name) {
    return '';
  }

  let trimmed = name.trim();
  if (trimmed.toLowerCase().endsWith('.json')) {
    trimmed = trimmed.slice(0, -5).trim();
  }

  return trimmed;
}

type AgentDetailsDraft = {
  type: AgentType;
  length: string;
  width: string;
  height: string;
};

function ScenarioEditorPanel() {
  const {
    activeScenario,
    activeScenarioId,
    activeScenarioBaseline,
    updateScenario,
    updateAgentStartPose,
    updateAgentAttributes,
    visibleTrajectoryIds,
    showAllTrajectories,
    hideAllTrajectories,
    showAgentLabels,
    agentLabelMode,
    toggleAgentLabels,
    setAgentLabelMode,
    toggleAgentExpert,
    setAgentTrackPrediction,
    removeAllAgents,
    spawnVehicleAgent,
    setRoadEdgeType,
    updateRoadEdgePoints,
    updateRoadEdgePoint,
    insertRoadEdgePoint,
    splitRoadEdge,
    removeRoadEdgePoint,
    removeRoadEdge,
    basicUndo,
    basicUndoStepsRemaining,
    editing
  } = useScenarioStore();
  const {
    state: editingState,
    selectEntity,
    clearSelection,
    setSelectedRoadHandle,
    pushHistoryEntry,
    setRotationMode,
    setRoadDraftElevation
  } = editing;
  const [localName, setLocalName] = useState('');
  const [startPoseDraft, setStartPoseDraft] = useState({ x: '', y: '', heading: '' });
  const [agentDetailsDraft, setAgentDetailsDraft] = useState<AgentDetailsDraft>({
    type: 'VEHICLE',
    length: '',
    width: '',
    height: ''
  });
  const [roadVertexDraft, setRoadVertexDraft] = useState<{ x: string; y: string; z: string }>({ x: '', y: '', z: '' });
  const [roadUniformZDraft, setRoadUniformZDraft] = useState('');
  const [roadDraftElevationInput, setRoadDraftElevationInput] = useState('0.00');
  const [exportPreview, setExportPreview] = useState<ScenarioExportComparison | null>(null);

  useEffect(() => {
    setLocalName(normalizeScenarioName(activeScenario?.metadata.name) || '');
  }, [activeScenario?.metadata.name]);

  useEffect(() => {
    setRoadDraftElevationInput(editingState.roadDraftElevation.toFixed(2));
  }, [editingState.roadDraftElevation]);

  const handleNameChange = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    setLocalName(event.target.value);
  }, []);

  const handleAgentLabelModeChange = useCallback((event: ChangeEvent<HTMLSelectElement>) => {
    setAgentLabelMode(event.target.value as AgentLabelMode);
  }, [setAgentLabelMode]);

  const normalizedName = useMemo(() => normalizeScenarioName(localName), [localName]);

  const handleNameCommit = useCallback(() => {
    if (!activeScenario || !activeScenarioId) {
      return;
    }

    const nextName = normalizedName;
    if (!nextName) {
      return;
    }

    const previousName = activeScenario.metadata.name;
    if (previousName === nextName) {
      return;
    }

    updateScenario(activeScenarioId, (current) => ({
      ...current,
      metadata: {
        ...current.metadata,
        name: nextName
      }
    }));

    const now = Date.now();
    pushHistoryEntry({
      id: `rename-${now.toString(36)}`,
      label: `Renamed scenario to ${nextName}`,
      timestamp: now
    });
  }, [activeScenario, activeScenarioId, normalizedName, updateScenario, pushHistoryEntry]);

  const handleRequestExport = useCallback(() => {
    if (!activeScenario) {
      return;
    }

    const comparison = compareScenarioForExport(activeScenarioBaseline, activeScenario);
    setExportPreview(comparison);
  }, [activeScenario, activeScenarioBaseline]);

  const handleExportJson = useCallback(() => {
    if (!activeScenario) {
      return;
    }

    const draftName = normalizedName || normalizeScenarioName(activeScenario.metadata.name) || 'Scenario';
    downloadScenarioAsJson(activeScenario, { fileName: draftName });
    setExportPreview(null);
  }, [activeScenario, normalizedName]);

  const handleExportBin = useCallback(() => {
    if (!activeScenario) {
      return;
    }

    const draftName = normalizedName || normalizeScenarioName(activeScenario.metadata.name) || 'Scenario';
    downloadScenarioAsBinary(activeScenario, { fileName: draftName });
    setExportPreview(null);
  }, [activeScenario, normalizedName]);

  const handleCancelExport = useCallback(() => {
    setExportPreview(null);
  }, []);

  const selectedEntity = editingState.selectedEntity;
  const rotationMode = editingState.rotationMode;
  const selectedAgentId = selectedEntity?.kind === 'agent' ? selectedEntity.id : undefined;
  const agents = useMemo(() => activeScenario?.agents ?? [], [activeScenario?.agents]);
  const tracksToPredictSet = useMemo(() => new Set(activeScenario?.tracksToPredict ?? []), [activeScenario?.tracksToPredict]);
  const selectedAgent = useMemo(
    () => agents.find((agent) => agent.id === selectedAgentId),
    [agents, selectedAgentId]
  );
  const selectedAgentIndex = useMemo(() => (selectedAgent ? agents.findIndex((agent) => agent.id === selectedAgent.id) : -1), [agents, selectedAgent]);
  const selectedAgentIsPrediction = selectedAgentIndex >= 0 && tracksToPredictSet.has(selectedAgentIndex);
  const predictionTargets = useMemo(() => {
    if (!activeScenario) {
      return [] as Array<{ index: number; agent: ScenarioAgent }>;
    }

    return activeScenario.tracksToPredict
      .map((trackIndex) => {
        const agent = activeScenario.agents[trackIndex];
        if (!agent) {
          return undefined;
        }
        return { index: trackIndex, agent };
      })
      .filter((entry): entry is { index: number; agent: ScenarioAgent } => typeof entry !== 'undefined');
  }, [activeScenario]);
  const selectedRoadEdgeId = editingState.selectedEntity?.kind === 'roadEdge' ? editingState.selectedEntity.id : undefined;
  const roadEdges = useMemo(() => activeScenario?.roadEdges ?? [], [activeScenario?.roadEdges]);
  const selectedRoadEdge = useMemo(
    () => roadEdges.find((edge) => edge.id === selectedRoadEdgeId),
    [roadEdges, selectedRoadEdgeId]
  );
  const selectedRoadVertexIndex = useMemo(() => {
    if (!selectedRoadEdge) {
      return undefined;
    }
    return editingState.selectedRoadHandle?.roadId === selectedRoadEdge.id
      ? editingState.selectedRoadHandle.pointIndex
      : undefined;
  }, [editingState.selectedRoadHandle, selectedRoadEdge]);
  const selectedRoadVertex = useMemo(() => {
    if (!selectedRoadEdge || typeof selectedRoadVertexIndex !== 'number') {
      return undefined;
    }
    return selectedRoadEdge.points[selectedRoadVertexIndex];
  }, [selectedRoadEdge, selectedRoadVertexIndex]);

  useEffect(() => {
    if (!selectedRoadVertex) {
      setRoadVertexDraft({ x: '', y: '', z: '' });
      return;
    }

    setRoadVertexDraft({
      x: selectedRoadVertex.x.toFixed(2),
      y: selectedRoadVertex.y.toFixed(2),
      z: typeof selectedRoadVertex.z === 'number' && Number.isFinite(selectedRoadVertex.z)
        ? selectedRoadVertex.z.toFixed(2)
        : ''
    });
  }, [selectedRoadVertex]);

  useEffect(() => {
    if (!selectedRoadEdge) {
      setRoadUniformZDraft('');
      return;
    }

    const sample = selectedRoadEdge.points.find((point) => typeof point.z === 'number' && Number.isFinite(point.z));
    if (sample && typeof sample.z === 'number') {
      setRoadUniformZDraft(sample.z.toFixed(2));
    } else {
      setRoadUniformZDraft('');
    }
  }, [selectedRoadEdge]);

  useEffect(() => {
    if (!selectedAgent) {
      setStartPoseDraft({ x: '', y: '', heading: '' });
      setAgentDetailsDraft({
        type: 'VEHICLE',
        length: '',
        width: '',
        height: ''
      });
      return;
    }

    const anchorPoint = selectedAgent.trajectory.find((point) => point.valid !== false) ?? selectedAgent.trajectory[0];
    if (!anchorPoint) {
      setStartPoseDraft({ x: '', y: '', heading: '' });
      const fallbackDims = DEFAULT_AGENT_DIMENSIONS[selectedAgent.type];
      setAgentDetailsDraft({
        type: selectedAgent.type,
        length: fallbackDims.length.toFixed(2),
        width: fallbackDims.width.toFixed(2),
        height: fallbackDims.height !== undefined ? fallbackDims.height.toFixed(2) : ''
      });
      return;
    }

    const headingDeg = typeof anchorPoint.heading === 'number'
      ? (anchorPoint.heading * 180) / Math.PI
      : 0;

    setStartPoseDraft({
      x: anchorPoint.x.toFixed(2),
      y: anchorPoint.y.toFixed(2),
      heading: headingDeg.toFixed(1)
    });

    const baseDimensions = selectedAgent.dimensions ?? DEFAULT_AGENT_DIMENSIONS[selectedAgent.type];
    setAgentDetailsDraft({
      type: selectedAgent.type,
      length: baseDimensions.length.toFixed(2),
      width: baseDimensions.width.toFixed(2),
      height: baseDimensions.height !== undefined ? baseDimensions.height.toFixed(2) : ''
    });
  }, [selectedAgent]);
  const allVisible = useMemo(() => {
    if (!activeScenario) {
      return false;
    }
    if (activeScenario.agents.length === 0) {
      return false;
    }
    return activeScenario.agents.every((agent) => visibleTrajectoryIds.has(agent.id));
  }, [activeScenario, visibleTrajectoryIds]);

  const handleClearSelection = useCallback(() => {
    clearSelection();
  }, [clearSelection]);

  const handleStartPoseChange = useCallback((field: 'x' | 'y' | 'heading', value: string) => {
    setStartPoseDraft((prev) => ({ ...prev, [field]: value }));
  }, []);

  const handleAgentTypeDraftChange = useCallback((event: ChangeEvent<HTMLSelectElement>) => {
    const nextType = event.target.value as AgentType;
    setAgentDetailsDraft((prev) => {
      if (prev.type === nextType) {
        return prev;
      }
      const defaults = DEFAULT_AGENT_DIMENSIONS[nextType];
      return {
        type: nextType,
        length: defaults.length.toFixed(2),
        width: defaults.width.toFixed(2),
        height: defaults.height !== undefined ? defaults.height.toFixed(2) : ''
      };
    });
  }, []);

  const handleAgentDimensionChange = useCallback((field: 'length' | 'width' | 'height', value: string) => {
    setAgentDetailsDraft((prev) => ({ ...prev, [field]: value }));
  }, []);

  const handleDeleteAllAgents = useCallback(() => {
    if (!activeScenario || !activeScenarioId || activeScenario.agents.length === 0) {
      return;
    }

    const confirmed = window.confirm('Delete all agents from this scenario? This cannot be undone.');
    if (!confirmed) {
      return;
    }

    const removed = removeAllAgents(activeScenarioId);
    if (removed) {
      clearSelection();
      const now = Date.now();
      pushHistoryEntry({
        id: `delete-all-${now.toString(36)}`,
        label: 'Removed all agents',
        timestamp: now
      });
    }
  }, [activeScenario, activeScenarioId, removeAllAgents, clearSelection, pushHistoryEntry]);

  const handleSpawnVehicle = useCallback(() => {
    if (!activeScenarioId) {
      return;
    }

    const spawned = spawnVehicleAgent(activeScenarioId);
    if (!spawned) {
      return;
    }

    selectEntity({ kind: 'agent', id: spawned.id });
    const now = Date.now();
    pushHistoryEntry({
      id: `spawn-${spawned.id}-${now.toString(36)}`,
      label: `Spawned ${spawned.displayName ?? spawned.id}`,
      timestamp: now
    });
  }, [activeScenarioId, spawnVehicleAgent, selectEntity, pushHistoryEntry]);

  const commitStartPose = useCallback(() => {
    if (!activeScenario || !activeScenarioId || !selectedAgent) {
      return;
    }

    const anchorPoint = selectedAgent.trajectory.find((point) => point.valid !== false) ?? selectedAgent.trajectory[0];
    if (!anchorPoint) {
      return;
    }

    const parsedX = Number.parseFloat(startPoseDraft.x);
    const parsedY = Number.parseFloat(startPoseDraft.y);
    const parsedHeading = Number.parseFloat(startPoseDraft.heading);

    const nextX = Number.isFinite(parsedX) ? parsedX : anchorPoint.x;
    const nextY = Number.isFinite(parsedY) ? parsedY : anchorPoint.y;
    const anchorHeadingDeg = typeof anchorPoint.heading === 'number' ? (anchorPoint.heading * 180) / Math.PI : 0;
    const nextHeadingDeg = Number.isFinite(parsedHeading) ? parsedHeading : anchorHeadingDeg;
    const nextHeadingRad = (nextHeadingDeg * Math.PI) / 180;

    const epsilon = 1e-4;
    const unchanged =
      Math.abs(nextX - anchorPoint.x) < epsilon &&
      Math.abs(nextY - anchorPoint.y) < epsilon &&
      Math.abs(nextHeadingRad - (anchorPoint.heading ?? 0)) < epsilon;

    if (unchanged) {
      return;
    }

    updateAgentStartPose(
      activeScenarioId,
      selectedAgent.id,
      {
        x: nextX,
        y: nextY,
        headingRadians: nextHeadingRad
      },
      { rotationMode }
    );

    const now = Date.now();
    pushHistoryEntry({
      id: `pose-${selectedAgent.id}-${now.toString(36)}`,
      label: `Adjusted ${selectedAgent.displayName ?? selectedAgent.id} start pose`,
      timestamp: now
    });
  }, [
    activeScenario,
    activeScenarioId,
    selectedAgent,
    startPoseDraft.x,
    startPoseDraft.y,
    startPoseDraft.heading,
    updateAgentStartPose,
    pushHistoryEntry
  ]);

  const commitAgentDetails = useCallback(() => {
    if (!activeScenarioId || !selectedAgent) {
      return;
    }

    const nextType = agentDetailsDraft.type;
    const defaultsForNextType = DEFAULT_AGENT_DIMENSIONS[nextType];
    const parsedLength = Number.parseFloat(agentDetailsDraft.length);
    const parsedWidth = Number.parseFloat(agentDetailsDraft.width);
    const parsedHeight = Number.parseFloat(agentDetailsDraft.height);
    const safeLength = Number.isFinite(parsedLength) && parsedLength > 0 ? parsedLength : defaultsForNextType.length;
    const safeWidth = Number.isFinite(parsedWidth) && parsedWidth > 0 ? parsedWidth : defaultsForNextType.width;
    const heightInput = agentDetailsDraft.height.trim();
    let safeHeight: number | null;
    if (heightInput.length === 0) {
      safeHeight = defaultsForNextType.height ?? null;
    } else if (Number.isFinite(parsedHeight) && parsedHeight > 0) {
      safeHeight = parsedHeight;
    } else if (defaultsForNextType.height !== undefined) {
      safeHeight = defaultsForNextType.height;
    } else {
      safeHeight = null;
    }

    const epsilon = 1e-4;
    const prevDims = selectedAgent.dimensions;
    const prevHeight = typeof prevDims?.height === 'number' ? prevDims.height : null;
    const nextHeight = safeHeight ?? null;
    const dimsChanged = !prevDims
      ? true
      : Math.abs(prevDims.length - safeLength) > epsilon
        || Math.abs(prevDims.width - safeWidth) > epsilon
        || (
          (prevHeight === null && nextHeight !== null)
          || (prevHeight !== null && nextHeight === null)
          || (prevHeight !== null && nextHeight !== null && Math.abs(prevHeight - nextHeight) > epsilon)
        );
    const typeChanged = selectedAgent.type !== nextType;

    if (!typeChanged && !dimsChanged) {
      return;
    }

    const updated = updateAgentAttributes(activeScenarioId, selectedAgent.id, {
      type: nextType,
      dimensions: {
        length: safeLength,
        width: safeWidth,
        height: safeHeight
      }
    });

    if (updated) {
      const name = selectedAgent.displayName ?? selectedAgent.id;
      const parts: string[] = [];
      if (typeChanged) {
        parts.push(`type → ${nextType}`);
      }
      if (dimsChanged) {
        parts.push('dimensions');
      }
      const detail = parts.length > 0 ? parts.join(' & ') : 'attributes';
      const now = Date.now();
      pushHistoryEntry({
        id: `agent-attrs-${selectedAgent.id}-${now.toString(36)}`,
        label: `Updated ${name} ${detail}`,
        timestamp: now
      });
    }
  }, [activeScenarioId, agentDetailsDraft, selectedAgent, updateAgentAttributes, pushHistoryEntry]);

  const handleAgentDimensionKeyDown = useCallback((event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      commitAgentDetails();
    }
  }, [commitAgentDetails]);

  const handleToggleExpert = useCallback(() => {
    if (!activeScenarioId || !selectedAgent) {
      return;
    }

    const nextIsExpert = !selectedAgent.isExpert;
    const updated = toggleAgentExpert(activeScenarioId, selectedAgent.id);
    if (updated) {
      const now = Date.now();
      pushHistoryEntry({
        id: `expert-${selectedAgent.id}-${now.toString(36)}`,
        label: nextIsExpert
          ? `Marked ${selectedAgent.displayName ?? selectedAgent.id} as expert`
          : `Unmarked ${selectedAgent.displayName ?? selectedAgent.id} as expert`,
        timestamp: now
      });
    }
  }, [activeScenarioId, selectedAgent, toggleAgentExpert, pushHistoryEntry]);

  const handleTrackPredictionToggle = useCallback(() => {
    if (!activeScenarioId || !selectedAgent) {
      return;
    }

    const toggled = setAgentTrackPrediction(activeScenarioId, selectedAgent.id, !selectedAgentIsPrediction);
    if (toggled) {
      const now = Date.now();
      pushHistoryEntry({
        id: `prediction-${selectedAgent.id}-${now.toString(36)}`,
        label: !selectedAgentIsPrediction
          ? `Added ${selectedAgent.displayName ?? selectedAgent.id} to tracks_to_predict`
          : `Removed ${selectedAgent.displayName ?? selectedAgent.id} from tracks_to_predict`,
        timestamp: now
      });
    }
  }, [activeScenarioId, selectedAgent, selectedAgentIsPrediction, setAgentTrackPrediction, pushHistoryEntry]);

  const handleSelectPredictionTarget = useCallback((agentId: string) => {
    selectEntity({ kind: 'agent', id: agentId });
  }, [selectEntity]);

  const handleStartPoseKeyDown = useCallback((event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      commitStartPose();
    }
  }, [commitStartPose]);

  const handleRoadTypeChange = useCallback((event: ChangeEvent<HTMLSelectElement>) => {
    if (!activeScenarioId || !selectedRoadEdge) {
      return;
    }

    const nextType = event.target.value as (typeof ROAD_TYPE_OPTIONS)[number]['value'];
    if (nextType === selectedRoadEdge.type) {
      return;
    }

    const updated = setRoadEdgeType(activeScenarioId, selectedRoadEdge.id, nextType);
    if (updated) {
      const now = Date.now();
      pushHistoryEntry({
        id: `road-type-${selectedRoadEdge.id}-${now.toString(36)}`,
        label: `Set ${selectedRoadEdge.id} type to ${nextType}`,
        timestamp: now
      });
    }
  }, [activeScenarioId, selectedRoadEdge, setRoadEdgeType, pushHistoryEntry]);

  const handleRoadVertexDraftChange = useCallback((field: 'x' | 'y' | 'z', value: string) => {
    setRoadVertexDraft((prev) => ({
      ...prev,
      [field]: value
    }));
  }, []);

  const handleRoadDraftElevationInputChange = useCallback((value: string) => {
    setRoadDraftElevationInput(value);
  }, []);

  const commitRoadDraftElevation = useCallback(() => {
    const parsed = Number.parseFloat(roadDraftElevationInput);
    if (!Number.isFinite(parsed)) {
      return;
    }
    setRoadDraftElevation(parsed);
  }, [roadDraftElevationInput, setRoadDraftElevation]);

  const handleRoadDraftElevationKeyDown = useCallback((event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      commitRoadDraftElevation();
    }
  }, [commitRoadDraftElevation]);

  const handleRoadUniformZDraftChange = useCallback((value: string) => {
    setRoadUniformZDraft(value);
  }, []);

  const commitRoadVertexDraft = useCallback(() => {
    if (!activeScenarioId || !selectedRoadEdge || typeof selectedRoadVertexIndex !== 'number') {
      return;
    }

    const parsedX = Number.parseFloat(roadVertexDraft.x);
    const parsedY = Number.parseFloat(roadVertexDraft.y);
    if (!Number.isFinite(parsedX) || !Number.isFinite(parsedY)) {
      return;
    }

    const parsedZ = Number.parseFloat(roadVertexDraft.z);
    const payload = Number.isFinite(parsedZ)
      ? { x: parsedX, y: parsedY, z: parsedZ }
      : { x: parsedX, y: parsedY };

    const updated = updateRoadEdgePoint(activeScenarioId, selectedRoadEdge.id, selectedRoadVertexIndex, payload);

    if (updated) {
      const now = Date.now();
      pushHistoryEntry({
        id: `road-vertex-${selectedRoadEdge.id}-${selectedRoadVertexIndex}-${now.toString(36)}`,
        label: `Adjusted vertex ${selectedRoadVertexIndex} on ${selectedRoadEdge.type ?? 'road edge'}`,
        timestamp: now
      });
    }
  }, [
    activeScenarioId,
    selectedRoadEdge,
    selectedRoadVertexIndex,
    roadVertexDraft.x,
    roadVertexDraft.y,
    roadVertexDraft.z,
    updateRoadEdgePoint,
    pushHistoryEntry
  ]);

  const handleRoadVertexInputKeyDown = useCallback((event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      commitRoadVertexDraft();
    }
  }, [commitRoadVertexDraft]);

  const handleApplyUniformRoadZ = useCallback(() => {
    if (!activeScenarioId || !selectedRoadEdge || selectedRoadEdge.points.length === 0) {
      return;
    }

    const parsed = Number.parseFloat(roadUniformZDraft);
    if (!Number.isFinite(parsed)) {
      return;
    }

    const nextPoints = selectedRoadEdge.points.map((point) => ({
      x: point.x,
      y: point.y,
      z: parsed
    }));

    const updated = updateRoadEdgePoints(activeScenarioId, selectedRoadEdge.id, nextPoints);
    if (updated) {
      const now = Date.now();
      pushHistoryEntry({
        id: `road-uniform-z-${selectedRoadEdge.id}-${now.toString(36)}`,
        label: `Set all ${selectedRoadEdge.id} vertices to z=${parsed.toFixed(2)}`,
        timestamp: now
      });
    }
  }, [
    activeScenarioId,
    selectedRoadEdge,
    roadUniformZDraft,
    updateRoadEdgePoints,
    pushHistoryEntry
  ]);

  const handleInsertRoadVertex = useCallback((position: 'before' | 'after') => {
    if (!activeScenarioId || !selectedRoadEdge || typeof selectedRoadVertexIndex !== 'number') {
      return;
    }

    const points = selectedRoadEdge.points;
    if (points.length === 0) {
      return;
    }

    const currentPoint = points[selectedRoadVertexIndex];
    const previousPoint = selectedRoadVertexIndex > 0 ? points[selectedRoadVertexIndex - 1] : undefined;
    const nextPoint = selectedRoadVertexIndex < points.length - 1 ? points[selectedRoadVertexIndex + 1] : undefined;

    const afterIndex = position === 'after' ? selectedRoadVertexIndex : selectedRoadVertexIndex - 1;

    const resolveInterpolatedZ = (a?: { z?: number }, b?: { z?: number }) => {
      const aZ = typeof a?.z === 'number' && Number.isFinite(a.z) ? a.z : undefined;
      const bZ = typeof b?.z === 'number' && Number.isFinite(b.z) ? b.z : undefined;
      if (typeof aZ === 'number' && typeof bZ === 'number') {
        return (aZ + bZ) / 2;
      }
      if (typeof aZ === 'number') {
        return aZ;
      }
      if (typeof bZ === 'number') {
        return bZ;
      }
      return undefined;
    };

    let insertPoint: { x: number; y: number; z?: number } = {
      x: currentPoint.x,
      y: currentPoint.y,
      ...(typeof currentPoint.z === 'number' ? { z: currentPoint.z } : {})
    };
    if (position === 'after' && nextPoint) {
      const zValue = resolveInterpolatedZ(currentPoint, nextPoint);
      insertPoint = {
        x: (currentPoint.x + nextPoint.x) / 2,
        y: (currentPoint.y + nextPoint.y) / 2,
        ...(typeof zValue === 'number' ? { z: zValue } : {})
      };
    } else if (position === 'before' && previousPoint) {
      const zValue = resolveInterpolatedZ(previousPoint, currentPoint);
      insertPoint = {
        x: (currentPoint.x + previousPoint.x) / 2,
        y: (currentPoint.y + previousPoint.y) / 2,
        ...(typeof zValue === 'number' ? { z: zValue } : {})
      };
    }

    const insertedIndex = insertRoadEdgePoint(activeScenarioId, selectedRoadEdge.id, insertPoint, {
      afterIndex
    });

    if (typeof insertedIndex === 'number') {
      setSelectedRoadHandle({
        roadId: selectedRoadEdge.id,
        pointIndex: insertedIndex
      });
      const now = Date.now();
      pushHistoryEntry({
        id: `road-vertex-insert-${selectedRoadEdge.id}-${insertedIndex}-${now.toString(36)}`,
        label: `Inserted vertex on ${selectedRoadEdge.type ?? 'road edge'}`,
        timestamp: now
      });
    }
  }, [
    activeScenarioId,
    selectedRoadEdge,
    selectedRoadVertexIndex,
    insertRoadEdgePoint,
    setSelectedRoadHandle,
    pushHistoryEntry
  ]);

  const handleRemoveRoadVertex = useCallback(() => {
    if (!activeScenarioId || !selectedRoadEdge || typeof selectedRoadVertexIndex !== 'number') {
      return;
    }

    if (selectedRoadEdge.points.length <= 2) {
      return;
    }

    const removed = removeRoadEdgePoint(activeScenarioId, selectedRoadEdge.id, selectedRoadVertexIndex);
    if (removed) {
      const fallbackIndex = Math.max(
        0,
        Math.min(selectedRoadVertexIndex, selectedRoadEdge.points.length - 2)
      );
      setSelectedRoadHandle({
        roadId: selectedRoadEdge.id,
        pointIndex: fallbackIndex
      });
      const now = Date.now();
      pushHistoryEntry({
        id: `road-vertex-delete-${selectedRoadEdge.id}-${selectedRoadVertexIndex}-${now.toString(36)}`,
        label: `Deleted vertex from ${selectedRoadEdge.type ?? 'road edge'}`,
        timestamp: now
      });
    }
  }, [
    activeScenarioId,
    selectedRoadEdge,
    selectedRoadVertexIndex,
    removeRoadEdgePoint,
    setSelectedRoadHandle,
    pushHistoryEntry
  ]);

  const handleSplitRoadEdge = useCallback(() => {
    if (!activeScenarioId || !selectedRoadEdge || typeof selectedRoadVertexIndex !== 'number') {
      return;
    }

    const result = splitRoadEdge(activeScenarioId, selectedRoadEdge.id, selectedRoadVertexIndex);
    if (!result) {
      return;
    }

    selectEntity({ kind: 'roadEdge', id: result.created.id });
    setSelectedRoadHandle({
      roadId: result.created.id,
      pointIndex: 0
    });
    const now = Date.now();
    pushHistoryEntry({
      id: `road-split-${selectedRoadEdge.id}-${selectedRoadVertexIndex}-${now.toString(36)}`,
      label: `Split road segment ${selectedRoadEdge.id} at vertex ${selectedRoadVertexIndex}`,
      timestamp: now
    });
  }, [
    activeScenarioId,
    selectedRoadEdge,
    selectedRoadVertexIndex,
    splitRoadEdge,
    selectEntity,
    setSelectedRoadHandle,
    pushHistoryEntry
  ]);

  const canEditRoadVertex = Boolean(selectedRoadEdge && typeof selectedRoadVertexIndex === 'number');
  const canDeleteRoadVertex = Boolean(canEditRoadVertex && (selectedRoadEdge?.points.length ?? 0) > 2);
  const canSplitRoadEdge = useMemo(() => {
    if (!selectedRoadEdge || typeof selectedRoadVertexIndex !== 'number') {
      return false;
    }
    const firstSegmentLength = selectedRoadVertexIndex;
    const secondSegmentLength = selectedRoadEdge.points.length - selectedRoadVertexIndex;
    return firstSegmentLength >= 2 && secondSegmentLength >= 2;
  }, [selectedRoadEdge, selectedRoadVertexIndex]);
  const roadVertexCount = selectedRoadEdge?.points.length ?? 0;
  const canApplyUniformZ = roadVertexCount > 0 && Boolean(selectedRoadEdge);

  const handleDeleteRoadEdge = useCallback(() => {
    if (!activeScenarioId || !selectedRoadEdge) {
      return;
    }

    const removed = removeRoadEdge(activeScenarioId, selectedRoadEdge.id);
    if (removed) {
      clearSelection();
      const now = Date.now();
      pushHistoryEntry({
        id: `road-delete-${selectedRoadEdge.id}-${now.toString(36)}`,
        label: `Deleted road segment ${selectedRoadEdge.id}`,
        timestamp: now
      });
    }
  }, [activeScenarioId, selectedRoadEdge, removeRoadEdge, clearSelection, pushHistoryEntry]);

  useEffect(() => {
    if (!exportPreview) {
      return;
    }

    if (!activeScenario || exportPreview.after.metadata.id !== activeScenario.metadata.id) {
      setExportPreview(null);
    }
  }, [activeScenario, exportPreview, setExportPreview]);

  if (!activeScenario) {
    return (
      <section className="editor-panel editor-panel--empty">
        <p>Select or create a scenario to edit metadata, agents, lanes, and trajectories.</p>
      </section>
    );
  }

  const exportScenarioName = normalizedName || normalizeScenarioName(activeScenario.metadata.name) || 'Scenario';

  return (
    <>
      {exportPreview && (
        <ExportPreviewModal
          scenarioName={exportScenarioName}
          comparison={exportPreview}
          onCancel={handleCancelExport}
          onExportJson={handleExportJson}
          onExportBin={handleExportBin}
        />
      )}

      <section className="editor-panel">
        <div className="editor-panel__header">
          <h3>Scenario Details</h3>
          <div className="editor-panel__header-actions">
            <button
              type="button"
              className="button button--secondary button--compact"
              onClick={() => basicUndo()}
              disabled={basicUndoStepsRemaining === 0}
              title="Naive 3-step undo. Reloads stored JSON; no redo or redo stack."
              aria-label={`Undo (${basicUndoStepsRemaining} steps left)`}
            >
              Undo
              <span className="button__pill" aria-hidden="true">
                {basicUndoStepsRemaining}
              </span>
            </button>
            <button
              type="button"
              className="button"
              onClick={handleRequestExport}
            >
              Export
            </button>
          </div>
        </div>

        <div className="editor-panel__controls">
          <label>
            Scenario Name
            <div className="field-row field-row--filename">
              <input
                type="text"
                placeholder="Scenario name"
                value={normalizedName}
                onChange={handleNameChange}
                onBlur={handleNameCommit}
              />
              <span className="field-row__suffix">.json</span>
            </div>
          </label>
          <label className="toggle-row">
            <span>Show Agent Labels</span>
            <input
              type="checkbox"
              checked={showAgentLabels}
              onChange={() => toggleAgentLabels()}
            />
          </label>
          <label>
            Agent Label Mode
            <select value={agentLabelMode} onChange={handleAgentLabelModeChange} disabled={!showAgentLabels}>
              <option value="id">Agent ID</option>
              <option value="index">Array Index</option>
            </select>
          </label>
        </div>

        <div className="editor-panel__section">
          <div className="editor-panel__section-header">
            <h4>Tracks to Predict</h4>
          </div>
          {predictionTargets.length === 0 ? (
            <p className="editor-panel__placeholder">No agents flagged for prediction targets.</p>
          ) : (
            <ul className="trajectory-list">
              {predictionTargets.map(({ index, agent }) => {
                const isSelected = selectedAgentId === agent.id;
                const classes = ['trajectory-list__item', 'trajectory-list__item--prediction'];
                if (isSelected) {
                  classes.push('trajectory-list__item--selected');
                }
                return (
                  <li key={agent.id} className={classes.join(' ')}>
                    <div className="trajectory-list__item-row">
                      <div>
                        <strong>#{index}</strong>
                        {' · '}
                        <code>{agent.id}</code>
                        {agent.displayName ? ` · ${agent.displayName}` : ''}
                      </div>
                      <button
                        type="button"
                        className="button button--secondary"
                        onClick={() => handleSelectPredictionTarget(agent.id)}
                      >
                        Select
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div className="editor-panel__section">
          <div className="editor-panel__section-header">
            <h4>Agent Trajectories</h4>
            <div className="editor-panel__section-actions">
              <button type="button" className="button button--primary" onClick={handleSpawnVehicle}>
                Spawn Vehicle
              </button>
              <button type="button" className="button button--secondary" onClick={allVisible ? hideAllTrajectories : showAllTrajectories}>
                {allVisible ? 'Hide All' : 'Show All'}
              </button>
              <button type="button" className="button button--danger" onClick={handleDeleteAllAgents}>
                Delete All
              </button>
            </div>
          </div>
          <p className="editor-panel__placeholder">Select agents directly in the viewer to edit their paths.</p>
        </div>

        <div className="editor-panel__section">
          <div className="editor-panel__section-header">
            <h4>Selection</h4>
            {selectedEntity && (
              <button type="button" className="button button--secondary" onClick={handleClearSelection}>
                Clear Selection
              </button>
            )}
          </div>
          {selectedAgent ? (
            <>
              <ul className="selection-summary">
                <li>
                  <span>ID</span>
                  <code>{selectedAgent.id}</code>
                </li>
                <li>
                  <span>Type</span>
                  <span>{selectedAgent.type}</span>
                </li>
                <li>
                  <span>Array Index</span>
                  <span>{selectedAgentIndex >= 0 ? selectedAgentIndex : '—'}</span>
                </li>
                <li>
                  <span>Trajectory Points</span>
                  <span>{selectedAgent.trajectory.length}</span>
                </li>
                <li>
                  <span>Expert</span>
                  <span>{selectedAgent.isExpert ? 'Yes' : 'No'}</span>
                </li>
                <li>
                  <span>Predict Target</span>
                  <span>{selectedAgentIsPrediction ? 'Yes' : 'No'}</span>
                </li>
              </ul>
              <label className="toggle-row">
                <span>Mark as Expert</span>
                <input
                  type="checkbox"
                  checked={Boolean(selectedAgent.isExpert)}
                  onChange={handleToggleExpert}
                />
              </label>
              <label className="toggle-row">
                <span>Include in tracks_to_predict</span>
                <input
                  type="checkbox"
                  checked={selectedAgentIsPrediction}
                  onChange={handleTrackPredictionToggle}
                />
              </label>
              <div className="selection-edit-grid">
                <label>
                  Agent Type
                  <select value={agentDetailsDraft.type} onChange={handleAgentTypeDraftChange}>
                    {AGENT_TYPE_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Length (m)
                  <input
                    type="number"
                    min="0.1"
                    step="0.05"
                    value={agentDetailsDraft.length}
                    onChange={(event) => handleAgentDimensionChange('length', event.target.value)}
                    onKeyDown={handleAgentDimensionKeyDown}
                    placeholder="0.00"
                  />
                </label>
                <label>
                  Width (m)
                  <input
                    type="number"
                    min="0.1"
                    step="0.05"
                    value={agentDetailsDraft.width}
                    onChange={(event) => handleAgentDimensionChange('width', event.target.value)}
                    onKeyDown={handleAgentDimensionKeyDown}
                    placeholder="0.00"
                  />
                </label>
                <label>
                  Height (m)
                  <input
                    type="number"
                    min="0.1"
                    step="0.05"
                    value={agentDetailsDraft.height}
                    onChange={(event) => handleAgentDimensionChange('height', event.target.value)}
                    onKeyDown={handleAgentDimensionKeyDown}
                    placeholder="0.00"
                  />
                </label>
              </div>
              <button type="button" className="button button--secondary" onClick={commitAgentDetails}>
                Apply Agent Details
              </button>
              <div className="selection-edit-grid">
                <label>
                  Start X (m)
                  <input
                    type="number"
                    step="0.05"
                    value={startPoseDraft.x}
                    onChange={(event) => handleStartPoseChange('x', event.target.value)}
                    onBlur={commitStartPose}
                    onKeyDown={handleStartPoseKeyDown}
                    placeholder="0.00"
                  />
                </label>
                <label>
                  Start Y (m)
                  <input
                    type="number"
                    step="0.05"
                    value={startPoseDraft.y}
                    onChange={(event) => handleStartPoseChange('y', event.target.value)}
                    onBlur={commitStartPose}
                    onKeyDown={handleStartPoseKeyDown}
                    placeholder="0.00"
                  />
                </label>
                <label>
                  Start Heading (deg)
                  <input
                    type="number"
                    step="1"
                    value={startPoseDraft.heading}
                    onChange={(event) => handleStartPoseChange('heading', event.target.value)}
                    onBlur={commitStartPose}
                    onKeyDown={handleStartPoseKeyDown}
                    placeholder="0"
                  />
                </label>
              </div>
              <div className="selection-rotation-mode">
                <span className="selection-rotation-mode__label">Rotation Mode</span>
                <div className="selection-rotation-mode__buttons">
                  <button
                    type="button"
                    className={rotationMode === 'path' ? 'button button--primary' : 'button button--secondary'}
                    onClick={() => setRotationMode('path')}
                  >
                    Rotate Path
                  </button>
                  <button
                    type="button"
                    className={rotationMode === 'pose' ? 'button button--primary' : 'button button--secondary'}
                    onClick={() => setRotationMode('pose')}
                  >
                    Pose Only
                  </button>
                </div>
              </div>
              <button type="button" className="button button--secondary" onClick={commitStartPose}>
                Apply Start Pose
              </button>
            </>
          ) : selectedRoadEdge ? (
            <>
              <ul className="selection-summary">
                <li>
                  <span>ID</span>
                  <code>{selectedRoadEdge.id}</code>
                </li>
                <li>
                  <span>Type</span>
                  <span>{selectedRoadEdge.type ?? 'Unspecified'}</span>
                </li>
                <li>
                  <span>Vertices</span>
                  <span>{selectedRoadEdge.points.length}</span>
                </li>
              </ul>
                <div className="selection-road-panel">
                  <label>
                    <span>Road Type</span>
                    <select value={selectedRoadEdge.type ?? 'OTHER'} onChange={handleRoadTypeChange}>
                      {ROAD_TYPE_OPTIONS.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <div className="selection-road-elevation">
                    <label>
                      <span>Default Draw Z (m)</span>
                      <input
                        type="number"
                        step="0.05"
                        value={roadDraftElevationInput}
                        onChange={(event) => handleRoadDraftElevationInputChange(event.target.value)}
                        onBlur={commitRoadDraftElevation}
                        onKeyDown={handleRoadDraftElevationKeyDown}
                      />
                    </label>
                    <p className="selection-note selection-note--muted">
                      Applied to new vertices when using Draw Road.
                    </p>
                  </div>
                  <div className="selection-road-elevation selection-road-elevation--uniform">
                    <label>
                      <span>All Vertices Z (m)</span>
                      <input
                        type="number"
                        step="0.05"
                        value={roadUniformZDraft}
                        onChange={(event) => handleRoadUniformZDraftChange(event.target.value)}
                        placeholder="0.00"
                        disabled={!canApplyUniformZ}
                      />
                    </label>
                    <button
                      type="button"
                      className="button button--secondary"
                      onClick={handleApplyUniformRoadZ}
                      disabled={!canApplyUniformZ}
                    >
                      Apply to Road
                    </button>
                  </div>
                  <div className="selection-road-vertices">
                    <div className="selection-road-vertices__header">
                      <span>Vertices</span>
                      <span>{roadVertexCount}</span>
                    </div>
                    {roadVertexCount === 0 && (
                      <p className="selection-road-vertices__empty">Road segment has no vertices.</p>
                    )}
                    <div className="selection-road-vertex-editor">
                      <div className="selection-road-vertex-editor__inputs">
                        <label>
                          <span>X (m)</span>
                          <input
                            type="number"
                            step="0.05"
                            value={roadVertexDraft.x}
                            onChange={(event) => handleRoadVertexDraftChange('x', event.target.value)}
                            onBlur={commitRoadVertexDraft}
                            onKeyDown={handleRoadVertexInputKeyDown}
                            placeholder="0.00"
                            disabled={!canEditRoadVertex}
                          />
                        </label>
                        <label>
                          <span>Y (m)</span>
                          <input
                            type="number"
                            step="0.05"
                            value={roadVertexDraft.y}
                            onChange={(event) => handleRoadVertexDraftChange('y', event.target.value)}
                            onBlur={commitRoadVertexDraft}
                            onKeyDown={handleRoadVertexInputKeyDown}
                            placeholder="0.00"
                            disabled={!canEditRoadVertex}
                          />
                        </label>
                        <label>
                          <span>Z (m)</span>
                          <input
                            type="number"
                            step="0.05"
                            value={roadVertexDraft.z}
                            onChange={(event) => handleRoadVertexDraftChange('z', event.target.value)}
                            onBlur={commitRoadVertexDraft}
                            onKeyDown={handleRoadVertexInputKeyDown}
                            placeholder="0.00"
                            disabled={!canEditRoadVertex}
                          />
                        </label>
                    </div>
                    <div className="selection-road-vertex-editor__actions">
                      <button
                        type="button"
                        className="button button--secondary"
                        onClick={commitRoadVertexDraft}
                        disabled={!canEditRoadVertex}
                      >
                        Apply Coordinates
                      </button>
                      <div className="selection-road-vertex-editor__row">
                        <button
                          type="button"
                          className="button button--secondary"
                          onClick={() => handleInsertRoadVertex('before')}
                          disabled={!canEditRoadVertex}
                        >
                          Insert Before
                        </button>
                        <button
                          type="button"
                          className="button button--secondary"
                          onClick={() => handleInsertRoadVertex('after')}
                          disabled={!canEditRoadVertex}
                        >
                          Insert After
                        </button>
                      </div>
                      <button
                        type="button"
                        className="button button--secondary"
                        onClick={handleSplitRoadEdge}
                        disabled={!canSplitRoadEdge}
                        title="Shortcut: Shift+S"
                        data-hotkey="Shift+S"
                      >
                        Split at Vertex
                      </button>
                      <button
                        type="button"
                        className="button button--danger"
                        onClick={handleRemoveRoadVertex}
                        disabled={!canDeleteRoadVertex}
                        title="Shortcut: Shift+Delete / Shift+Backspace"
                        data-hotkey="Shift+Delete"
                      >
                        Delete Vertex
                      </button>
                    </div>
                  </div>
                  <p className="selection-note selection-note--muted">
                    Tip: Shift/Ctrl-click a segment to insert or Alt/Cmd-click a vertex to delete directly on the canvas.
                  </p>
                </div>
                <p className="selection-note">Segment type hints downstream renderers and exporters.</p>
                <button
                  type="button"
                  className="button button--danger"
                  onClick={handleDeleteRoadEdge}
                  title="Shortcut: Delete or Backspace"
                  data-hotkey="Delete"
                >
                  Delete Road Segment
                </button>
              </div>
            </>
          ) : (
            <p className="editor-panel__placeholder">Select an agent or road segment to edit.</p>
          )}
        </div>
      </section>
    </>
  );
}

export default ScenarioEditorPanel;
