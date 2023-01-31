import {
  checkFilesExist,
  cleanupProject,
  expectTestsPass,
  newProject,
  runCLI,
  runCLIAsync,
  uniq,
  updateFile,
  updateJson,
} from '@nrwl/e2e/utils';
import { readJSON } from 'fs-extra';

describe('expo', () => {
  let proj: string;

  beforeEach(
    () => (proj = newProject({ name: uniq('proj'), packageManager: 'npm' }))
  );
  afterEach(() => cleanupProject());

  it('should test, lint and export, prebuild', async () => {
    const appName = uniq('my-app');
    const libName = uniq('lib');
    const componentName = uniq('component');

    runCLI(`generate @nrwl/expo:application ${appName} --no-interactive`);
    runCLI(`generate @nrwl/expo:library ${libName} --no-interactive`);
    runCLI(
      `generate @nrwl/expo:component ${componentName} --project=${libName} --export --no-interactive`
    );
    expectTestsPass(await runCLIAsync(`test ${appName}`));
    expectTestsPass(await runCLIAsync(`test ${libName}`));

    updateFile(`apps/${appName}/src/app/App.tsx`, (content) => {
      let updated = `// eslint-disable-next-line @typescript-eslint/no-unused-vars\nimport {${componentName}} from '${proj}/${libName}';\n${content}`;
      return updated;
    });

    expectTestsPass(await runCLIAsync(`test ${appName}`));

    const appLintResults = await runCLIAsync(`lint ${appName}`);
    expect(appLintResults.combinedOutput).toContain('All files pass linting.');

    const libLintResults = await runCLIAsync(`lint ${libName}`);
    expect(libLintResults.combinedOutput).toContain('All files pass linting.');

    const exportResults = await runCLIAsync(
      `export ${appName} --no-interactive`
    );
    expect(exportResults.combinedOutput).toContain(
      'Export was successful. Your exported files can be found'
    );

    const appJsonPath = `apps/${appName}/app.json`;
    const appJson = await readJSON(appJsonPath);
    if (appJson.expo.ios) {
      appJson.expo.ios = 'nx.test';
    }
    if (appJson.expo.android) {
      appJson.expo.android.package = 'nx.test';
    }
    updateJson(appJsonPath, appJson);
    process.env['EXPO_NO_GIT_STATUS'] = 'true';
    const prebuildResult = await runCLIAsync(
      `prebuild ${appName} --no-interactive`
    );
    expect(prebuildResult.combinedOutput).toContain('Config synced');
  }, 1000000);

  it('should build publishable library', async () => {
    const libName = uniq('lib');
    const componentName = uniq('component');

    runCLI(
      `generate @nrwl/expo:library ${libName} --buildable --publishable --importPath=${proj}/${libName}`
    );
    runCLI(
      `generate @nrwl/expo:component ${componentName} --project=${libName} --export`
    );
    expect(() => {
      runCLI(`build ${libName}`);
      checkFilesExist(`dist/libs/${libName}/index.js`);
      checkFilesExist(`dist/libs/${libName}/src/index.d.ts`);
    }).not.toThrow();
  });
});
