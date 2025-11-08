export type AgentType = 'VEHICLE' | 'PEDESTRIAN' | 'CYCLIST' | 'OTHER';

export interface TrajectoryPoint {
  frameIndex?: number;
  timestampMicros: number;
  x: number;
  y: number;
  z?: number;
  heading?: number;
  speed?: number;
  velocityX?: number;
  velocityY?: number;
  valid?: boolean;
}

export interface ScenarioAgent {
  id: string;
  type: AgentType;
  displayName?: string;
  dimensions?: {
    length: number;
    width: number;
    height?: number;
  };
  trajectory: TrajectoryPoint[];
  colour?: string;
  isExpert?: boolean;
}

export interface RoadEdge {
  id: string;
  points: Array<Pick<TrajectoryPoint, 'x' | 'y' | 'z'>>;
  type?: 'ROAD_LINE' | 'ROAD_EDGE' | 'CROSSWALK' | 'OTHER';
}

export interface ScenarioMetadata {
  id: string;
  name: string;
  description?: string;
  frameCount: number;
  durationSeconds: number;
  frameIntervalMicros?: number;
}

export interface ScenarioFrameAgentState {
  id: string;
  type: AgentType;
  x: number;
  y: number;
  z?: number;
  heading?: number;
  width?: number;
  length?: number;
  height?: number;
  speed?: number;
  velocityX?: number;
  velocityY?: number;
  valid?: boolean;
}

export interface ScenarioFrame {
  index: number;
  timestampMicros: number;
  agents: ScenarioFrameAgentState[];
}

export interface ScenarioBounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

export interface WaymoScenario {
  metadata: ScenarioMetadata;
  agents: ScenarioAgent[];
  roadEdges: RoadEdge[];
  frames: ScenarioFrame[];
  tracksToPredict: number[];
  bounds?: ScenarioBounds;
  raw?: unknown;
}

export interface ScenarioFrameSummary {
  index: number;
  timestampMicros: number;
}
