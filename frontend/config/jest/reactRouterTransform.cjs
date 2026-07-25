'use strict';

const craBabelTransform = require('react-scripts/config/jest/babelTransform');

const routerRouteModulesPattern =
  /[\\/]node_modules[\\/]react-router[\\/]dist[\\/](?:development|production)[\\/]lib[\\/]dom[\\/]ssr[\\/]routeModules\.js$/;

const importMetaHotPattern = /\bimport\.meta\.hot\b/g;

module.exports = {
  ...craBabelTransform,

  process(sourceText, sourcePath, transformOptions) {
    let transformedSource = sourceText;

    if (routerRouteModulesPattern.test(sourcePath)) {
      const occurrences =
        sourceText.match(importMetaHotPattern)?.length ?? 0;

      if (occurrences !== 1) {
        throw new Error(
          `Expected exactly one import.meta.hot in ${sourcePath}, found ${occurrences}`
        );
      }

      transformedSource = sourceText.replace(
        importMetaHotPattern,
        'undefined'
      );
    }

    return craBabelTransform.process(
      transformedSource,
      sourcePath,
      transformOptions
    );
  },
};
