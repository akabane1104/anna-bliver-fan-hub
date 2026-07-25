import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import {
  BrowserRouter,
  Route,
  Routes,
  useNavigate
} from 'react-router';

function HomeRoute() {
  const navigate = useNavigate();

  return (
    <button type="button" onClick={() => navigate('/router-test-target')}>
      Navigate
    </button>
  );
}

test('React Router BrowserRouter renders and navigates in declarative mode', () => {
  const container = document.createElement('div');
  const root = createRoot(container);
  const previousActEnvironment = global.IS_REACT_ACT_ENVIRONMENT;
  global.IS_REACT_ACT_ENVIRONMENT = true;
  window.history.replaceState(null, '', '/');

  try {
    act(() => {
      root.render(
        <BrowserRouter>
          <Routes>
            <Route path="/" element={<HomeRoute />} />
            <Route path="/router-test-target" element={<span>Target</span>} />
          </Routes>
        </BrowserRouter>
      );
    });

    act(() => {
      container.querySelector('button').dispatchEvent(
        new MouseEvent('click', { bubbles: true })
      );
    });

    expect(container.textContent).toContain('Target');
  } finally {
    act(() => root.unmount());
    global.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
  }
});
