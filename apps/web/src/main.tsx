import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { CssBaseline } from '@mui/material';
import App from './App';
import { captureTwaLaunch } from './platform/android-app/twa';
import { registerImportProgressPanelView } from './platform-extensions/telemetry/ImportProgressPanelView';

// Before the first render, so the launch parameters (`?source=twa&appVersion=…`)
// are remembered for the session and stripped from the address before any
// route reads them (issue #515).
captureTwaLaunch();

// MemoriaHub's Telemetry Dashboard card "Bulk import progress" (RETRO-T3, #628).
registerImportProgressPanelView();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <CssBaseline />
      <App />
    </BrowserRouter>
  </React.StrictMode>,
);
