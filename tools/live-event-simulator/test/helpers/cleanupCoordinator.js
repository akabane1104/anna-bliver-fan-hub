function createCleanupCoordinator(actions) {
  if (!Array.isArray(actions) || actions.some((action) => typeof action !== 'function')) {
    throw new TypeError('cleanup actions must be functions');
  }

  let cleanupPromise = null;
  return function cleanup() {
    if (!cleanupPromise) {
      cleanupPromise = (async () => {
        const errors = [];
        for (const action of actions) {
          try {
            await action();
          } catch (error) {
            errors.push(error);
          }
        }
        return errors;
      })();
    }
    return cleanupPromise;
  };
}

module.exports = {
  createCleanupCoordinator
};
