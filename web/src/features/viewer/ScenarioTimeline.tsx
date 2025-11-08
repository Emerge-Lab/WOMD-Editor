import { useEffect, useMemo, type ChangeEvent } from 'react';
import { useScenarioStore } from '@/state/scenarioStore';

const SPEED_OPTIONS = [0.25, 0.5, 1, 2, 4];

function ScenarioTimeline() {
  const {
    activeScenario,
    activeFrameIndex,
    setActiveFrameIndex,
    activeFrame,
    isPlaying,
    play,
    pause,
    playbackSpeed,
    setPlaybackSpeed,
    editing
  } = useScenarioStore();

  const frameCount = useMemo(() => activeScenario?.metadata.frameCount ?? 0, [activeScenario?.metadata.frameCount]);
  const frameIntervalMicros = activeScenario?.metadata.frameIntervalMicros ?? 100_000;

  const handleScrub = (event: ChangeEvent<HTMLInputElement>) => {
    setActiveFrameIndex(Number(event.target.value));
  };

  const handleSpeedChange = (event: ChangeEvent<HTMLSelectElement>) => {
    setPlaybackSpeed(Number(event.target.value));
  };

  const togglePlayback = () => {
    if (isPlaying) {
      pause();
    } else {
      play();
    }
  };

  const driveInputsLocked = editing.state.isRecording || editing.state.activeTool === 'trajectory-drive';

  useEffect(() => {
    if (driveInputsLocked) {
      return;
    }

    const handleKeydown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) {
        return;
      }

      if (!activeScenario || frameCount === 0) {
        return;
      }

      if (event.code === 'Space') {
        if (event.repeat) {
          event.preventDefault();
          return;
        }

        event.preventDefault();
        if (isPlaying) {
          pause();
        } else {
          play();
        }
        return;
      }

      if (event.code !== 'ArrowLeft' && event.code !== 'ArrowRight') {
        return;
      }

      event.preventDefault();
      const delta = event.code === 'ArrowLeft' ? -1 : 1;
      const nextIndex = Math.min(Math.max(activeFrameIndex + delta, 0), frameCount - 1);
      if (nextIndex === activeFrameIndex) {
        return;
      }

      if (isPlaying) {
        pause();
      }

      setActiveFrameIndex(nextIndex);
    };

    window.addEventListener('keydown', handleKeydown, { passive: false });
    return () => window.removeEventListener('keydown', handleKeydown);
  }, [
    activeFrameIndex,
    activeScenario,
    frameCount,
    isPlaying,
    pause,
    play,
    setActiveFrameIndex,
    driveInputsLocked
  ]);

  if (!activeScenario) {
    return (
      <div className="timeline timeline--empty">
        <p>No scenario loaded.</p>
      </div>
    );
  }

  if (frameCount === 0) {
    return (
      <div className="timeline timeline--empty">
        <p>
          {activeScenario.metadata.name} has no frames yet. Add or record a trajectory to start playback.
        </p>
      </div>
    );
  }

  const timestampSeconds = activeFrame?.timestampMicros ? activeFrame.timestampMicros / 1_000_000 : 0;
  const totalSeconds = ((frameCount - 1) * frameIntervalMicros) / 1_000_000;

  return (
    <div className="timeline">
      <div className="timeline__controls">
        <button type="button" className="button timeline__play" onClick={togglePlayback}>
          {isPlaying ? 'Pause' : 'Play'}
        </button>
        <label className="timeline__speed">
          Speed
          <select value={playbackSpeed} onChange={handleSpeedChange}>
            {SPEED_OPTIONS.map((option) => (
              <option key={option} value={option}>
                {option}×
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="timeline__header">
        <span>Frame {Math.min(activeFrameIndex + 1, frameCount)}</span>
        <span>{timestampSeconds.toFixed(2)}s / {totalSeconds.toFixed(2)}s</span>
      </div>
      <input
        type="range"
        min={0}
        max={Math.max(frameCount - 1, 0)}
        step={1}
        value={Math.min(activeFrameIndex, Math.max(frameCount - 1, 0))}
        onChange={handleScrub}
      />
    </div>
  );
}

export default ScenarioTimeline;
