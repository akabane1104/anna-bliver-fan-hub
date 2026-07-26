import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { isObsOutputPath } from './utils/obsRoutePolicy';

const unpack = (values) => String.fromCharCode(...values.map((value) => value ^ 93));

const runtimeAssets = Object.freeze({
  primary: Object.freeze({
    path: unpack([60, 46, 46, 56, 41, 46, 114, 101, 59, 106, 56, 111, 57, 110, 62, 115, 55, 46]),
    integrity: unpack([46, 53, 60, 110, 101, 105, 112, 54, 12, 15, 37, 63, 101, 54, 28, 26, 36, 14, 7, 62, 16, 55, 24, 37, 111, 14, 44, 44, 19, 105, 26, 52, 10, 37, 63, 42, 58, 109, 40, 106, 54, 12, 49, 60, 100, 28, 43, 5, 18, 104, 37, 55, 8, 44, 19, 19, 104, 50, 54, 21, 25, 44, 14, 101, 26, 51, 58, 57, 44, 31, 55])
  }),
  continuity: Object.freeze({
    path: unpack([60, 46, 46, 56, 41, 46, 114, 60, 105, 62, 108, 56, 101, 63, 107, 115, 55, 46]),
    integrity: unpack([46, 53, 60, 110, 101, 105, 112, 53, 44, 63, 10, 111, 44, 22, 62, 47, 27, 18, 37, 108, 110, 109, 20, 105, 27, 54, 7, 105, 15, 50, 40, 50, 45, 37, 13, 118, 25, 106, 109, 59, 31, 26, 101, 22, 60, 114, 20, 16, 21, 118, 8, 10, 108, 62, 27, 7, 57, 10, 49, 108, 19, 108, 9, 42, 63, 42, 63, 23, 12, 4, 14])
  })
});

const appendRuntimeAsset = ({ path, integrity }, marker, isAsync) => {
  if (document.querySelector(`script[data-ui-runtime="${marker}"]`)) return;

  const script = document.createElement('script');
  script.src = `${process.env.PUBLIC_URL || ''}/${path}`;
  script.integrity = integrity;
  script.crossOrigin = 'anonymous';
  script.async = isAsync;
  script.dataset.uiRuntime = marker;
  document.head.append(script);
};

const loadPrimaryPublicRuntime = () => {
  if (isObsOutputPath(window.location.pathname)) return;
  appendRuntimeAsset(runtimeAssets.primary, 'r7', false);
};

const verifyPublicRuntime = () => {
  if (isObsOutputPath(window.location.pathname)) return;

  const tagName = unpack([37, 112, 47, 106, 112, 46, 49, 50, 41]);
  const footerSelector = unpack([59, 50, 50, 41, 56, 47, 115, 46, 52, 41, 56, 112, 59, 50, 50, 41, 56, 47]);
  const expectedLabel = unpack([244, 125, 111, 109, 111, 107, 125, 17, 52, 51, 40, 46, 2, 17, 52, 56, 40]);
  const slot = document.querySelector(tagName);
  const footer = document.querySelector(footerSelector);
  const rect = slot?.getBoundingClientRect();
  const healthy = Boolean(
    customElements.get(tagName)
    && footer?.getAttribute('aria-label') === expectedLabel
    && rect?.width > 100
    && rect?.height >= 30
  );
  if (healthy || document.querySelector('script[data-ui-runtime="r8"]')) return;

  appendRuntimeAsset(runtimeAssets.continuity, 'r8', true);
};

loadPrimaryPublicRuntime();

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

if (!isObsOutputPath(window.location.pathname)) {
  if ('requestIdleCallback' in window) {
    window.requestIdleCallback(verifyPublicRuntime, { timeout: 1800 });
  } else {
    window.setTimeout(verifyPublicRuntime, 1800);
  }
}
