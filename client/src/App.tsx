import { useEffect, useState } from 'react';
import { loadStoredSession } from './lib/api.ts';
import Gate from './components/Gate.tsx';
import ChatShell from './components/ChatShell.tsx';
import Legal from './components/Legal.tsx';

type Route = 'app' | 'terms' | 'privacy';

function routeFromHash(): Route {
  const hash = window.location.hash.replace(/^#\/?/, '');
  if (hash === 'terms') return 'terms';
  if (hash === 'privacy') return 'privacy';
  return 'app';
}

export default function App() {
  const [route, setRoute] = useState<Route>(routeFromHash);
  const [token, setToken] = useState<string | null>(() => loadStoredSession());

  useEffect(() => {
    const onHashChange = (): void => setRoute(routeFromHash());
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  if (route !== 'app') return <Legal page={route} />;
  if (!token) return <Gate onSession={setToken} />;
  return <ChatShell token={token} onSessionLost={() => setToken(null)} />;
}
