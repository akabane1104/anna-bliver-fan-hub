import React from 'react';
import { useLocation, useNavigate } from 'react-router';

const normalizePathname = (pathname) => {
  const path = String(pathname || '/').split('?')[0].split('#')[0].replace(/\/+$/, '');
  return path || '/';
};

const getDefaultBackTarget = (pathname) => {
  const path = normalizePathname(pathname);
  if (path === '/') return '/';
  if (/^\/admin\/prizes\/[^/]+\/edit$/.test(path)) return '/admin/prizes';

  const segments = path.split('/').filter(Boolean);
  if (segments.length <= 1) return '/';

  if (segments[0] === 'admin') {
    return segments.length <= 2 ? '/' : `/${segments.slice(0, -1).join('/')}`;
  }

  return `/${segments.slice(0, -1).join('/')}`;
};

const BackButton = ({ to, style }) => {
  const navigate = useNavigate();
  const location = useLocation();

  const handleClick = () => {
    navigate(to || getDefaultBackTarget(location.pathname));
  };

  return (
    <button
      onClick={handleClick}
      className="btn btn-secondary"
      style={{
        marginBottom: '1rem',
        display: 'inline-flex',
        alignItems: 'center',
        gap: '0.5rem',
        padding: '0.5rem 1rem',
        fontSize: '0.9rem',
        ...style
      }}
    >
      <span>{'\u2190'}</span> {'\u8fd4\u56de'}
    </button>
  );
};

export { getDefaultBackTarget };
export default BackButton;
