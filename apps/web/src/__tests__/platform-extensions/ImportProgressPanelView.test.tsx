import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { getDashboardPanelView } from '@marinoscar/platform-web/telemetry/ui/dashboard-panels';
import type { DashboardPanelViewProps } from '@marinoscar/platform-web/telemetry/ui/dashboard-panels';

import {
  formatMinutes,
  IMPORT_PROGRESS_PANEL_ID,
  ImportProgressPanelView,
  registerImportProgressPanelView,
  type ImportProgressPayload,
} from '../../platform-extensions/telemetry/ImportProgressPanelView';

function props(payload: ImportProgressPayload, layout: 'phone' | 'desktop' = 'desktop') {
  return { payload, layout } as unknown as DashboardPanelViewProps<ImportProgressPayload>;
}

const PAYLOAD: ImportProgressPayload = {
  available: true,
  uploads: 2000,
  windowHours: 24,
  stages: [
    { stage: 'faces', pending: 600, done: 1400, perMinute: 10, etaMinutes: 60 },
    { stage: 'tags', pending: 0, done: 2000, perMinute: 12, etaMinutes: 0 },
    { stage: 'geocode', pending: 50, done: 1950, perMinute: 0, etaMinutes: null },
  ],
  oldestPending: [{ jobType: 'auto_tagging', ageSeconds: 7200 }],
};

describe('ImportProgressPanelView', () => {
  it('draws one bar per stage with its ETA', () => {
    render(<ImportProgressPanelView {...props(PAYLOAD)} />);
    expect(screen.getByTestId('import-progress-view')).toHaveTextContent('2,000');
    expect(screen.getByRole('img', { name: 'Faces: 1,400 done, 600 pending' })).toBeInTheDocument();
    expect(screen.getByTestId('import-stage-faces')).toHaveTextContent('About 60 min left');
    expect(screen.getByTestId('import-stage-tags')).toHaveTextContent('Up to date');
    expect(screen.getByTestId('import-stage-geocode')).toHaveTextContent('Not moving');
    expect(screen.getByTestId('import-progress-oldest')).toHaveTextContent('auto tagging, 2 h');
  });

  it('renders at phone width too', () => {
    render(<ImportProgressPanelView {...props(PAYLOAD, 'phone')} />);
    expect(screen.getAllByRole('img')).toHaveLength(3);
  });

  it('says "no data yet" when the store has none', () => {
    render(<ImportProgressPanelView {...props({ ...PAYLOAD, available: false })} />);
    expect(screen.getByTestId('import-progress-empty')).toBeInTheDocument();
  });

  it('registers under the API panel id', () => {
    registerImportProgressPanelView();
    expect(getDashboardPanelView(IMPORT_PROGRESS_PANEL_ID)?.builtin).toBe(false);
  });

  it('formats durations compactly', () => {
    expect(formatMinutes(0.5)).toBe('under a minute');
    expect(formatMinutes(45)).toBe('45 min');
    expect(formatMinutes(210)).toBe('3.5 h');
    expect(formatMinutes(3 * 24 * 60)).toBe('3 d');
  });
});
