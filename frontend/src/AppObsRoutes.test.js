import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import fs from 'node:fs';
import path from 'node:path';
const mockSources = [];

jest.mock('./services/obsOverlayService', () => ({
  __esModule: true,
  default: {
    getState: jest.fn(async () => ({
      currentSong: { title: 'Current', requester: 'S***r' },
      nextSong: { title: 'Next', requester: 'N***r' },
      queue: [{ displayKey: 'one', title: 'Queue', requester: 'Q***r' }],
      todayRequestCount: 1,
      activity: { title: 'Activity', progress: 0.5, status: 'active' },
      events: []
    })),
    createEventSource: jest.fn(() => {
      const source = {
        addEventListener: jest.fn(),
        close: jest.fn()
      };
      mockSources.push(source);
      return source;
    })
  }
}));

jest.mock('./services', () => {
  const actual = jest.requireActual('./services');
  return {
    ...actual,
    authService: {
      ...actual.authService,
      isAuthenticated: jest.fn(() => false)
    },
    settingsService: {
      ...actual.settingsService,
      getSiteConfig: jest.fn(async () => ({}))
    }
  };
});

const App = require('./App').default;
const { hasObsRouteModeChanged, isObsOutputPath } = require('./utils/obsRoutePolicy');
const flush = () => new Promise((resolve) => window.setTimeout(resolve, 0));
const obsRoutes = [
  '/obs',
  '/obs/now-playing',
  '/obs/next-song',
  '/obs/song-queue',
  '/obs/today-count',
  '/obs/activity-progress',
  '/obs/gift-ticker',
  '/obs/guard-alert',
  '/obs/cotton-candy',
  '/obs/ai-bubble',
  '/obs/notice',
  '/obs/preview'
];

test('OBS output path policy is exact and crosses shells only at the route boundary', () => {
  expect(isObsOutputPath('/obs')).toBe(true);
  expect(isObsOutputPath('/obs/now-playing')).toBe(true);
  expect(isObsOutputPath('/obs/nested/output')).toBe(true);
  expect(isObsOutputPath('/observer')).toBe(false);
  expect(isObsOutputPath('/admin/obs-overlays')).toBe(false);
  expect(hasObsRouteModeChanged('/', '/obs/preview')).toBe(true);
  expect(hasObsRouteModeChanged('/obs/preview', '/obs/notice')).toBe(false);
  expect(hasObsRouteModeChanged('/obs/preview', '/admin/obs-overlays')).toBe(true);
});

test('every OBS route renders anonymously without the website shell', async () => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  global.IS_REACT_ACT_ENVIRONMENT = true;

  try {
    for (const pathname of obsRoutes) {
      window.history.replaceState(null, '', pathname);
      await act(async () => {
        root.render(<App />);
        window.dispatchEvent(new PopStateEvent('popstate'));
        await flush();
      });
      expect(container.querySelector('.app-shell')).toBeNull();
      expect(container.querySelector('footer')).toBeNull();
      expect(container.querySelector('.navbar')).toBeNull();
      expect(container.querySelector('x-r7-slot')).toBeNull();
      expect(container.textContent).not.toContain('Linus_Lieu');
      expect(container.textContent).not.toContain('小猪anna的秘密基地');
      expect(container.textContent).not.toContain('undefined');
      expect(container.textContent).not.toContain('null');
    }
  } finally {
    act(() => root.unmount());
    container.remove();
  }
});

test('every OBS route keeps the actual viewport and route canvas transparent', async () => {
  const styleElement = document.createElement('style');
  styleElement.textContent = fs.readFileSync(
    path.join(__dirname, 'pages', 'ObsOverlay.css'),
    'utf8'
  );
  document.head.appendChild(styleElement);

  const container = document.createElement('div');
  container.id = 'root';
  document.body.appendChild(container);
  const root = createRoot(container);
  global.IS_REACT_ACT_ENVIRONMENT = true;

  try {
    for (const pathname of obsRoutes) {
      window.history.replaceState(null, '', pathname);
      await act(async () => {
        root.render(<App />);
        window.dispatchEvent(new PopStateEvent('popstate'));
        await flush();
      });

      const routeCanvas = container.querySelector('.obs-stage, .obs-preview');
      expect(routeCanvas).not.toBeNull();
      for (const element of [
        document.documentElement,
        document.body,
        container,
        routeCanvas
      ]) {
        const style = window.getComputedStyle(element);
        expect(['transparent', 'rgba(0, 0, 0, 0)']).toContain(
          style.backgroundColor
        );
        expect(['', 'none']).toContain(style.backgroundImage);
      }

      for (const previewFrame of container.querySelectorAll('.obs-preview-frame')) {
        const style = window.getComputedStyle(previewFrame);
        expect(['transparent', 'rgba(0, 0, 0, 0)']).toContain(
          style.backgroundColor
        );
        expect(['', 'none']).toContain(style.backgroundImage);
      }
    }
  } finally {
    act(() => root.unmount());
    container.remove();
    styleElement.remove();
  }
});

test('normal website routes keep the protected attribution host', async () => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  global.IS_REACT_ACT_ENVIRONMENT = true;
  window.history.replaceState(null, '', '/');

  try {
    await act(async () => {
      root.render(<App />);
      await flush();
    });
    expect(container.querySelector('footer.site-footer')).not.toBeNull();
    expect(container.querySelector('x-r7-slot')).not.toBeNull();
  } finally {
    act(() => root.unmount());
    container.remove();
  }
});
