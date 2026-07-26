export const isObsOutputPath = (pathname = '') => (
  pathname === '/obs' || pathname.startsWith('/obs/')
);

export const hasObsRouteModeChanged = (previousPathname, nextPathname) => (
  isObsOutputPath(previousPathname) !== isObsOutputPath(nextPathname)
);
