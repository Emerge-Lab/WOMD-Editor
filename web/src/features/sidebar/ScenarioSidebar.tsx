import { useCallback, useMemo, useState, type ChangeEventHandler } from 'react';
import { useScenarioStore } from '@/state/scenarioStore';

function ScenarioSidebar() {
  const {
    scenarios,
    activeScenarioId,
    selectScenario,
    removeScenario,
    loadScenarioFromJson
  } = useScenarioStore();
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const sortedScenarios = useMemo(() => [...scenarios].sort((a, b) => a.name.localeCompare(b.name)), [scenarios]);

  const handleFileUpload = useCallback<ChangeEventHandler<HTMLInputElement>>((event) => {
    const files = event.target.files;
    if (!files) {
      return;
    }

    setMessage(null);
    setError(null);

    Array.from(files).forEach((file) => {
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const payload = JSON.parse(reader.result as string);
          const resource = loadScenarioFromJson({ json: payload, name: file.name, source: 'uploaded' });
          setMessage(`Loaded ${resource.name}`);
        } catch (err) {
          console.error(err);
          setError(`Failed to parse ${file.name}`);
        }
      };

      reader.readAsText(file);
    });

    event.target.value = '';
  }, [loadScenarioFromJson]);

  return (
    <aside className="sidebar">
      <div className="sidebar__header">
        <h1 className="sidebar__title">Scenarios</h1>
        <p className="sidebar__subtitle">Manage example, blank, or imported scenario files.</p>
      </div>

      <div className="sidebar__actions">
        <label className="upload">
          <input type="file" accept="application/json" multiple onChange={handleFileUpload} />
          <span>Import JSON…</span>
        </label>
      </div>

      {message && <p className="sidebar__message sidebar__message--success">{message}</p>}
      {error && <p className="sidebar__message sidebar__message--error">{error}</p>}

      <ul className="scenario-list">
        {sortedScenarios.map((scenario) => {
          const isActive = scenario.id === activeScenarioId;
          return (
            <li key={scenario.id} className={isActive ? 'scenario-item scenario-item--active' : 'scenario-item'}>
              <button type="button" onClick={() => selectScenario(scenario.id)}>
                <strong>{scenario.name}</strong>
                <span className="scenario-item__meta">{scenario.source}</span>
              </button>
              <button type="button" className="scenario-item__delete" onClick={() => removeScenario(scenario.id)}>
                ×
              </button>
            </li>
          );
        })}

        {sortedScenarios.length === 0 && <li className="scenario-list__empty">No scenarios loaded yet.</li>}
      </ul>
    </aside>
  );
}

export default ScenarioSidebar;
