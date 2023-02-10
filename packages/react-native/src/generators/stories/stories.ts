import {
  convertNxGenerator,
  ensurePackage,
  getProjects,
  Tree,
  visitNotIgnoredFiles,
} from '@nrwl/devkit';
import { join } from 'path';
import componentStoryGenerator from '../component-story/component-story';
import { StorybookStoriesSchema } from './schema';
import {
  containsComponentDeclaration,
  projectRootPath,
} from '@nrwl/react/src/generators/stories/stories';
import minimatch = require('minimatch');
import { nxVersion } from '../../utils/versions';

export async function createAllStories(
  tree: Tree,
  projectName: string,
  ignorePaths?: string[]
) {
  ensurePackage(tree, '@nrwl/storybook', nxVersion);
  const { isTheFileAStory } = await import(
    '@nrwl/storybook/src/utils/utilities'
  );

  const projects = getProjects(tree);
  const projectConfiguration = projects.get(projectName);

  const { sourceRoot } = projectConfiguration;
  const projectPath = await projectRootPath(tree, projectConfiguration);

  let componentPaths: string[] = [];
  visitNotIgnoredFiles(tree, projectPath, (path) => {
    if (ignorePaths?.some((pattern) => minimatch(path, pattern))) return;

    if (
      (path.endsWith('.tsx') && !path.endsWith('.spec.tsx')) ||
      (path.endsWith('.js') && !path.endsWith('.spec.js')) ||
      (path.endsWith('.jsx') && !path.endsWith('.spec.jsx'))
    ) {
      // Check if file is NOT a story (either ts/tsx or js/jsx)
      if (!isTheFileAStory(tree, path)) {
        // Since the file is not a story
        // Let's see if the .stories.* file exists
        const ext = path.slice(path.lastIndexOf('.'));
        const storyPath = `${path.split(ext)[0]}.stories${ext}`;

        if (!tree.exists(storyPath)) {
          componentPaths.push(path);
        }
      }
    }
  });

  await Promise.all(
    componentPaths.map(async (componentPath) => {
      const relativeCmpDir = componentPath.replace(join(sourceRoot, '/'), '');

      if (!containsComponentDeclaration(tree, componentPath)) {
        return;
      }

      await componentStoryGenerator(tree, {
        componentPath: relativeCmpDir,
        project: projectName,
      });
    })
  );
}

export async function storiesGenerator(
  host: Tree,
  schema: StorybookStoriesSchema
) {
  await createAllStories(host, schema.project, schema.ignorePaths);
}

export default storiesGenerator;
export const storiesSchematic = convertNxGenerator(storiesGenerator);
