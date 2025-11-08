import AppLayout from '@/components/AppLayout';
import { ScenarioStoreProvider } from '@/state/scenarioStore';

function App() {
  return (
    <ScenarioStoreProvider>
      <AppLayout />
    </ScenarioStoreProvider>
  );
}

export default App;
