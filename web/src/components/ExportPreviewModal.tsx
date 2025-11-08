import { useEffect, type MouseEvent } from 'react';
import type { ScenarioExportComparison } from '@/lib/scenarioDiff';

export interface ExportPreviewModalProps {
  scenarioName: string;
  comparison: ScenarioExportComparison;
  onExportJson: () => void;
  onExportBin: () => void;
  onCancel: () => void;
}

const MAX_LIST_ITEMS = 5;

interface SnapshotStats {
  agentCount: number;
  roadEdgeCount: number;
  predictionCount: number;
  frameCount: number;
  durationSeconds: number;
  boundsLabel: string;
}

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds)) {
    return '—';
  }
  if (seconds === 0) {
    return '0 s';
  }
  if (seconds < 1) {
    return `${(seconds * 1000).toFixed(0)} ms`;
  }
  if (seconds < 10) {
    return `${seconds.toFixed(2)} s`;
  }
  if (seconds < 60) {
    return `${seconds.toFixed(1)} s`;
  }
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${minutes}m ${remainder.toFixed(1)}s`;
}

function formatBoundsLabel(raw: string | undefined): string {
  return raw ?? '—';
}

function buildSnapshotStats(comparison: ScenarioExportComparison, variant: 'before' | 'after'): SnapshotStats | undefined {
  const payload = variant === 'before' ? comparison.before : comparison.after;
  if (!payload) {
    return undefined;
  }

  const boundsLabel = payload.bounds
    ? `${(payload.bounds.maxX - payload.bounds.minX).toFixed(1)} × ${(payload.bounds.maxY - payload.bounds.minY).toFixed(1)} m`
    : undefined;

  return {
    agentCount: payload.agents.length,
    roadEdgeCount: payload.roadEdges.length,
    predictionCount: payload.tracksToPredict.length,
    frameCount: payload.metadata.frameCount,
    durationSeconds: payload.metadata.durationSeconds,
    boundsLabel: formatBoundsLabel(boundsLabel)
  };
}

function renderLimitedList<T>(items: T[], renderItem: (item: T) => JSX.Element): JSX.Element[] {
  return items.slice(0, MAX_LIST_ITEMS).map(renderItem);
}

function ExportPreviewModal({ scenarioName, comparison, onCancel, onExportJson, onExportBin }: ExportPreviewModalProps) {
  const { diff } = comparison;
  const beforeStats = buildSnapshotStats(comparison, 'before');
  const afterStats = buildSnapshotStats(comparison, 'after')!;

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onCancel();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onCancel]);

  const handleOverlayClick = (event: MouseEvent<HTMLDivElement>) => {
    if (event.target === event.currentTarget) {
      onCancel();
    }
  };

  const changeSummary = diff.hasChanges
    ? `${diff.totalChangeCount} ${diff.totalChangeCount === 1 ? 'change detected' : 'changes detected'}`
    : 'No differences detected';

  return (
    <div
      className="export-preview"
      role="dialog"
      aria-modal="true"
      aria-label={`Export preview for ${scenarioName}`}
      onClick={handleOverlayClick}
    >
      <div className="export-preview__dialog">
        <header className="export-preview__header">
          <div>
            <h2>Preview Export</h2>
            <p>Review differences before downloading <code>{scenarioName}</code> as JSON or .bin.</p>
          </div>
          <div className="export-preview__summary">
            <span className="export-preview__summary-value">{changeSummary}</span>
            <button type="button" className="export-preview__close" onClick={onCancel} aria-label="Close preview">
              ×
            </button>
          </div>
        </header>

        <div className="export-preview__content">
          <section className="export-preview__columns">
            <div className="export-preview__column">
              <h3>Baseline</h3>
              {diff.hasBaseline && beforeStats ? (
                <dl className="export-preview__stats">
                  <div>
                    <dt>Agents</dt>
                    <dd>{beforeStats.agentCount}</dd>
                  </div>
                  <div>
                    <dt>Road Segments</dt>
                    <dd>{beforeStats.roadEdgeCount}</dd>
                  </div>
                  <div>
                    <dt>Prediction Tracks</dt>
                    <dd>{beforeStats.predictionCount}</dd>
                  </div>
                  <div>
                    <dt>Frames</dt>
                    <dd>{beforeStats.frameCount}</dd>
                  </div>
                  <div>
                    <dt>Duration</dt>
                    <dd>{formatDuration(beforeStats.durationSeconds)}</dd>
                  </div>
                  <div>
                    <dt>Bounds span</dt>
                    <dd>{beforeStats.boundsLabel}</dd>
                  </div>
                </dl>
              ) : (
                <p className="export-preview__placeholder">
                  No import baseline available. Everything will export as new content.
                </p>
              )}
            </div>

            <div className="export-preview__column export-preview__column--current">
              <h3>Current</h3>
              <dl className="export-preview__stats">
                <div>
                  <dt>Agents</dt>
                  <dd>{afterStats.agentCount}</dd>
                </div>
                <div>
                  <dt>Road Segments</dt>
                  <dd>{afterStats.roadEdgeCount}</dd>
                </div>
                <div>
                  <dt>Prediction Tracks</dt>
                  <dd>{afterStats.predictionCount}</dd>
                </div>
                <div>
                  <dt>Frames</dt>
                  <dd>{afterStats.frameCount}</dd>
                </div>
                <div>
                  <dt>Duration</dt>
                  <dd>{formatDuration(afterStats.durationSeconds)}</dd>
                </div>
                <div>
                  <dt>Bounds span</dt>
                  <dd>{afterStats.boundsLabel}</dd>
                </div>
              </dl>
            </div>
          </section>

          <section className="export-preview__diff">
            <h3>Change Log</h3>
            {!diff.hasBaseline && (
              <p className="export-preview__notice">
                This scenario was created here, so all content will be new in the export.
              </p>
            )}

            {!diff.hasChanges && (
              <p className="export-preview__placeholder">No differences from the baseline were detected.</p>
            )}

            {diff.metadataChanges.length > 0 && (
              <div className="export-preview__diff-group">
                <strong>Metadata</strong>
                <ul>
                  {diff.metadataChanges.map((change) => (
                    <li key={change.field}>
                      {change.label}: <span className="export-preview__value export-preview__value--from">{change.before ?? '—'}</span>
                      {' → '}
                      <span className="export-preview__value export-preview__value--to">{change.after ?? '—'}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {diff.agentChanges.added.length > 0 && (
              <div className="export-preview__diff-group">
                <strong>Agents added ({diff.agentChanges.added.length})</strong>
                <ul>
                  {renderLimitedList(diff.agentChanges.added, (agent) => (
                    <li key={`added-${agent.id}`}>
                      + <code>{agent.id}</code> ({agent.type}{agent.displayName ? ` · ${agent.displayName}` : ''})
                    </li>
                  ))}
                </ul>
                {diff.agentChanges.added.length > MAX_LIST_ITEMS && (
                  <p className="export-preview__more">
                    +{diff.agentChanges.added.length - MAX_LIST_ITEMS} more
                  </p>
                )}
              </div>
            )}

            {diff.agentChanges.removed.length > 0 && (
              <div className="export-preview__diff-group">
                <strong>Agents removed ({diff.agentChanges.removed.length})</strong>
                <ul>
                  {renderLimitedList(diff.agentChanges.removed, (agent) => (
                    <li key={`removed-${agent.id}`}>
                      − <code>{agent.id}</code> ({agent.type}{agent.displayName ? ` · ${agent.displayName}` : ''})
                    </li>
                  ))}
                </ul>
                {diff.agentChanges.removed.length > MAX_LIST_ITEMS && (
                  <p className="export-preview__more">
                    +{diff.agentChanges.removed.length - MAX_LIST_ITEMS} more
                  </p>
                )}
              </div>
            )}

            {diff.agentChanges.updated.length > 0 && (
              <div className="export-preview__diff-group">
                <strong>Agents updated ({diff.agentChanges.updated.length})</strong>
                <ul>
                  {renderLimitedList(diff.agentChanges.updated, (agent) => (
                    <li key={`updated-${agent.id}`}>
                      • <code>{agent.id}</code> ({agent.type}) – {agent.changes.join(', ')}
                    </li>
                  ))}
                </ul>
                {diff.agentChanges.updated.length > MAX_LIST_ITEMS && (
                  <p className="export-preview__more">
                    +{diff.agentChanges.updated.length - MAX_LIST_ITEMS} more
                  </p>
                )}
              </div>
            )}

            {diff.roadEdgeChanges.added.length > 0 && (
              <div className="export-preview__diff-group">
                <strong>Road segments added ({diff.roadEdgeChanges.added.length})</strong>
                <ul>
                  {renderLimitedList(diff.roadEdgeChanges.added, (edge) => (
                    <li key={`road-added-${edge.id}`}>
                      + <code>{edge.id}</code> {edge.type ? `(${edge.type})` : ''}
                    </li>
                  ))}
                </ul>
                {diff.roadEdgeChanges.added.length > MAX_LIST_ITEMS && (
                  <p className="export-preview__more">
                    +{diff.roadEdgeChanges.added.length - MAX_LIST_ITEMS} more
                  </p>
                )}
              </div>
            )}

            {diff.roadEdgeChanges.removed.length > 0 && (
              <div className="export-preview__diff-group">
                <strong>Road segments removed ({diff.roadEdgeChanges.removed.length})</strong>
                <ul>
                  {renderLimitedList(diff.roadEdgeChanges.removed, (edge) => (
                    <li key={`road-removed-${edge.id}`}>
                      − <code>{edge.id}</code> {edge.type ? `(${edge.type})` : ''}
                    </li>
                  ))}
                </ul>
                {diff.roadEdgeChanges.removed.length > MAX_LIST_ITEMS && (
                  <p className="export-preview__more">
                    +{diff.roadEdgeChanges.removed.length - MAX_LIST_ITEMS} more
                  </p>
                )}
              </div>
            )}

            {diff.roadEdgeChanges.updated.length > 0 && (
              <div className="export-preview__diff-group">
                <strong>Road segments updated ({diff.roadEdgeChanges.updated.length})</strong>
                <ul>
                  {renderLimitedList(diff.roadEdgeChanges.updated, (edge) => (
                    <li key={`road-updated-${edge.id}`}>
                      • <code>{edge.id}</code> – {edge.changes.join(', ')}
                    </li>
                  ))}
                </ul>
                {diff.roadEdgeChanges.updated.length > MAX_LIST_ITEMS && (
                  <p className="export-preview__more">
                    +{diff.roadEdgeChanges.updated.length - MAX_LIST_ITEMS} more
                  </p>
                )}
              </div>
            )}

            {(diff.tracksToPredictChanges.added.length > 0 || diff.tracksToPredictChanges.removed.length > 0) && (
              <div className="export-preview__diff-group">
                <strong>Prediction tracks</strong>
                <ul>
                  {diff.tracksToPredictChanges.added.length > 0 && (
                    <li>
                      Added: {diff.tracksToPredictChanges.added.join(', ')}
                    </li>
                  )}
                  {diff.tracksToPredictChanges.removed.length > 0 && (
                    <li>
                      Removed: {diff.tracksToPredictChanges.removed.join(', ')}
                    </li>
                  )}
                </ul>
              </div>
            )}

            {diff.bounds.changed && (
              <div className="export-preview__diff-group">
                <strong>Bounds</strong>
                <p>
                  {diff.bounds.before
                    ? `(${diff.bounds.before.minX.toFixed(1)}, ${diff.bounds.before.minY.toFixed(1)}) → (${diff.bounds.after?.minX.toFixed(1)}, ${diff.bounds.after?.minY.toFixed(1)})`
                    : 'New bounds calculated for export.'}
                </p>
              </div>
            )}

            {(diff.frames.countChanged || diff.frames.dataChanged) && (
              <div className="export-preview__diff-group">
                <strong>Frames</strong>
                <p>
                  {diff.frames.beforeCount} → {diff.frames.afterCount}
                  {diff.frames.dataChanged && !diff.frames.countChanged ? ' (frame contents updated)' : ''}
                </p>
              </div>
            )}
          </section>
        </div>

        <footer className="export-preview__footer">
          <button type="button" className="button button--secondary" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="button" onClick={onExportBin}>
            Download .bin
          </button>
          <button type="button" className="button button--primary" onClick={onExportJson}>
            Download JSON
          </button>
        </footer>
      </div>
    </div>
  );
}

export default ExportPreviewModal;
