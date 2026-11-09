import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { AuthGate } from './components/auth/AuthGate';
import { ErrorBoundary } from './components/ui/ErrorBoundary';
import './index.css';
// Universally disable mouse wheel value increment/decrement on all number inputs
if (typeof window !== 'undefined') {
  const disableWheelNumberChange = (e: WheelEvent) => {
    const active = document.activeElement;
    if (active instanceof HTMLInputElement && active.type === 'number') {
      active.blur();
    }
    const target = e.target;
    if (target instanceof HTMLInputElement && target.type === 'number') {
      target.blur();
    }
  };

  window.addEventListener('wheel', disableWheelNumberChange, { capture: true, passive: true });
}


ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <AuthGate>
        <App />
      </AuthGate>
    </ErrorBoundary>
  </React.StrictMode>
);
