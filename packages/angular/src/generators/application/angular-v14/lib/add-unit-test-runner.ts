import type { Tree } from '@nrwl/devkit';
import type { NormalizedSchema } from './normalized-schema';

import { jestProjectGenerator } from '@nrwl/jest';

import { UnitTestRunner } from '../../../../utils/test-runners';
import karmaProjectGenerator from '../../../karma-project/karma-project';

export async function addUnitTestRunner(host: Tree, options: NormalizedSchema) {
  if (options.unitTestRunner === UnitTestRunner.Jest) {
    await jestProjectGenerator(host, {
      project: options.name,
      setupFile: 'angular',
      supportTsx: false,
      skipSerializers: false,
      skipPackageJson: options.skipPackageJson,
      rootProject: options.rootProject,
    });
  } else if (options.unitTestRunner === UnitTestRunner.Karma) {
    const {
      karmaProjectGenerator,
    } = require('../../../karma-project/karma-project');
    await karmaProjectGenerator(host, {
      project: options.name,
      skipFormat: true,
    });
  }
}
