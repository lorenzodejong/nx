import { dirname, join, relative, resolve } from 'path';
import { minimatch } from 'minimatch';
import { existsSync, promises as fsp } from 'node:fs';
import * as chalk from 'chalk';
import { load as yamlLoad } from '@zkochan/js-yaml';
import { cloneFromUpstream, GitRepository } from '../../utils/git-utils';
import { stat, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'tmp';
import { prompt } from 'enquirer';
import { output } from '../../utils/output';
import * as createSpinner from 'ora';
import { detectPlugins, installPlugins } from '../init/init-v2';
import { readNxJson } from '../../config/nx-json';
import { workspaceRoot } from '../../utils/workspace-root';
import {
  detectPackageManager,
  getPackageManagerCommand,
  isWorkspacesEnabled,
  PackageManager,
  PackageManagerCommands,
} from '../../utils/package-manager';
import { resetWorkspaceContext } from '../../utils/workspace-context';
import { runInstall } from '../init/implementation/utils';
import { getBaseRef } from '../../utils/command-line-utils';
import { prepareSourceRepo } from './utils/prepare-source-repo';
import { mergeRemoteSource } from './utils/merge-remote-source';
import {
  getPackagesInPackageManagerWorkspace,
  needsInstall,
} from './utils/needs-install';
import { readPackageJson } from '../../project-graph/file-utils';

const importRemoteName = '__tmp_nx_import__';

export interface ImportOptions {
  /**
   * The remote URL of the repository to import
   */
  sourceRemoteUrl: string;
  /**
   * The branch or reference to import
   */
  ref: string;
  /**
   * The directory in the source repo to import
   */
  source: string;
  /**
   * The directory in the destination repo to import into
   */
  destination: string;
  /**
   * The depth to clone the source repository (limit this for faster clone times)
   */
  depth: number;

  verbose: boolean;
  interactive: boolean;
}

export async function importHandler(options: ImportOptions) {
  let { sourceRemoteUrl, ref, source, destination } = options;

  output.log({
    title:
      'Nx will walk you through the process of importing code from another repository into this workspace:',
    bodyLines: [
      `1. Nx will clone the other repository into a temporary directory`,
      `2. Code to be imported will be moved to the same directory it will be imported into on a temporary branch`,
      `3. The code will be merged into the current branch in this workspace`,
      `4. Nx will recommend plugins to integrate tools used in the imported code with Nx`,
      `5. The code will be successfully imported into this workspace`,
      '',
      `Git history will be preserved during this process`,
    ],
  });

  const tempImportDirectory = join(tmpdir, 'nx-import');

  if (!sourceRemoteUrl) {
    sourceRemoteUrl = (
      await prompt<{ sourceRemoteUrl: string }>([
        {
          type: 'input',
          name: 'sourceRemoteUrl',
          message:
            'What is the URL of the repository you want to import? (This can be a local git repository or a git remote URL)',
          required: true,
        },
      ])
    ).sourceRemoteUrl;
  }

  try {
    const maybeLocalDirectory = await stat(sourceRemoteUrl);
    if (maybeLocalDirectory.isDirectory()) {
      sourceRemoteUrl = resolve(sourceRemoteUrl);
    }
  } catch (e) {
    // It's a remote url
  }

  const sourceRepoPath = join(tempImportDirectory, 'repo');
  const spinner = createSpinner(
    `Cloning ${sourceRemoteUrl} into a temporary directory: ${sourceRepoPath} (Use --depth to limit commit history and speed up clone times)`
  ).start();
  try {
    await rm(tempImportDirectory, { recursive: true });
  } catch {}
  await mkdir(tempImportDirectory, { recursive: true });

  let sourceGitClient: GitRepository;
  try {
    sourceGitClient = await cloneFromUpstream(sourceRemoteUrl, sourceRepoPath, {
      originName: importRemoteName,
      depth: options.depth,
    });
  } catch (e) {
    spinner.fail(`Failed to clone ${sourceRemoteUrl} into ${sourceRepoPath}`);
    let errorMessage = `Failed to clone ${sourceRemoteUrl} into ${sourceRepoPath}. Please double check the remote and try again.\n${e.message}`;

    throw new Error(errorMessage);
  }
  spinner.succeed(`Cloned into ${sourceRepoPath}`);

  // Detecting the package manager before preparing the source repo for import.
  const sourcePackageManager = detectPackageManager(sourceGitClient.root);

  if (!ref) {
    const branchChoices = await sourceGitClient.listBranches();
    ref = (
      await prompt<{ ref: string }>([
        {
          type: 'autocomplete',
          name: 'ref',
          message: `Which branch do you want to import?`,
          choices: branchChoices,
          /**
           * Limit the number of choices so that it fits on screen
           */
          limit: process.stdout.rows - 3,
          required: true,
        } as any,
      ])
    ).ref;
  }

  if (!source) {
    source = (
      await prompt<{ source: string }>([
        {
          type: 'input',
          name: 'source',
          message: `Which directory do you want to import into this workspace? (leave blank to import the entire repository)`,
        },
      ])
    ).source;
  }

  if (!destination) {
    destination = (
      await prompt<{ destination: string }>([
        {
          type: 'input',
          name: 'destination',
          message: 'Where in this workspace should the code be imported into?',
          required: true,
          initial: source ? source : undefined,
        },
      ])
    ).destination;
  }

  const absSource = join(sourceRepoPath, source);
  const absDestination = join(process.cwd(), destination);

  const destinationGitClient = new GitRepository(process.cwd());
  await assertDestinationEmpty(destinationGitClient, absDestination);

  const tempImportBranch = getTempImportBranch(ref);
  await sourceGitClient.addFetchRemote(importRemoteName, ref);
  await sourceGitClient.fetch(importRemoteName, ref);
  spinner.succeed(`Fetched ${ref} from ${sourceRemoteUrl}`);
  spinner.start(
    `Checking out a temporary branch, ${tempImportBranch} based on ${ref}`
  );
  await sourceGitClient.checkout(tempImportBranch, {
    new: true,
    base: `${importRemoteName}/${ref}`,
  });

  spinner.succeed(`Created a ${tempImportBranch} branch based on ${ref}`);

  try {
    await stat(absSource);
  } catch (e) {
    throw new Error(
      `The source directory ${source} does not exist in ${sourceRemoteUrl}. Please double check to make sure it exists.`
    );
  }

  const packageManager = detectPackageManager(workspaceRoot);

  const originalPackageWorkspaces = await getPackagesInPackageManagerWorkspace(
    packageManager
  );

  const relativeDestination = relative(
    destinationGitClient.root,
    absDestination
  );
  await prepareSourceRepo(
    sourceGitClient,
    ref,
    source,
    relativeDestination,
    tempImportBranch,
    sourceRemoteUrl
  );

  await createTemporaryRemote(
    destinationGitClient,
    join(sourceRepoPath, '.git'),
    importRemoteName
  );

  await mergeRemoteSource(
    destinationGitClient,
    sourceRemoteUrl,
    tempImportBranch,
    destination,
    importRemoteName,
    ref
  );

  spinner.start('Cleaning up temporary files and remotes');
  await rm(tempImportDirectory, { recursive: true });
  await destinationGitClient.deleteGitRemote(importRemoteName);
  spinner.succeed('Cleaned up temporary files and remotes');

  const pmc = getPackageManagerCommand();
  const nxJson = readNxJson(workspaceRoot);

  resetWorkspaceContext();

  const { plugins, updatePackageScripts } = await detectPlugins(
    nxJson,
    options.interactive
  );

  if (packageManager !== sourcePackageManager) {
    output.warn({
      title: `Mismatched package managers`,
      bodyLines: [
        `The source repository is using a different package manager (${sourcePackageManager}) than this workspace (${packageManager}).`,
        `This could lead to install issues due to discrepancies in "package.json" features.`,
      ],
    });
  }

  // If install fails, we should continue since the errors could be resolved later.
  let installFailed = false;
  if (plugins.length > 0) {
    try {
      output.log({ title: 'Installing Plugins' });
      installPlugins(workspaceRoot, plugins, pmc, updatePackageScripts);

      await destinationGitClient.amendCommit();
    } catch (e) {
      installFailed = true;
      output.error({
        title: `Install failed: ${e.message || 'Unknown error'}`,
        bodyLines: [e.stack],
      });
    }
  } else if (await needsInstall(packageManager, originalPackageWorkspaces)) {
    try {
      output.log({
        title: 'Installing dependencies for imported code',
      });

      runInstall(workspaceRoot, getPackageManagerCommand(packageManager));

      await destinationGitClient.amendCommit();
    } catch (e) {
      installFailed = true;
      output.error({
        title: `Install failed: ${e.message || 'Unknown error'}`,
        bodyLines: [e.stack],
      });
    }
  }

  console.log(await destinationGitClient.showStat());

  if (installFailed) {
    const pmc = getPackageManagerCommand(packageManager);
    output.warn({
      title: `The import was successful, but the install failed`,
      bodyLines: [
        `You may need to run "${pmc.install}" manually to resolve the issue. The error is logged above.`,
      ],
    });
  }

  await warnOnMissingWorkspacesEntry(packageManager, pmc, relativeDestination);

  // When only a subdirectory is imported, there might be devDependencies in the root package.json file
  // that needs to be ported over as well.
  if (ref) {
    output.log({
      title: `Check root dependencies`,
      bodyLines: [
        `"dependencies" and "devDependencies" are not imported from the source repository (${sourceRemoteUrl}).`,
        `You may need to add some of those dependencies to this workspace in order to run tasks successfully.`,
      ],
    });
  }

  output.log({
    title: `Merging these changes into ${getBaseRef(nxJson)}`,
    bodyLines: [
      `MERGE these changes when merging these changes.`,
      `Do NOT squash and do NOT rebase these changes when merging these changes.`,
      `If you would like to UNDO these changes, run "git reset HEAD~1 --hard"`,
    ],
  });
}

async function assertDestinationEmpty(
  gitClient: GitRepository,
  absDestination: string
) {
  const files = await gitClient.getGitFiles(absDestination);
  if (files.length > 0) {
    throw new Error(
      `Destination directory ${absDestination} is not empty. Please make sure it is empty before importing into it.`
    );
  }
}

function getTempImportBranch(sourceBranch: string) {
  return `__nx_tmp_import__/${sourceBranch}`;
}

async function createTemporaryRemote(
  destinationGitClient: GitRepository,
  sourceRemoteUrl: string,
  remoteName: string
) {
  try {
    await destinationGitClient.deleteGitRemote(remoteName);
  } catch {}
  await destinationGitClient.addGitRemote(remoteName, sourceRemoteUrl);
  await destinationGitClient.fetch(remoteName);
}

// If the user imports a project that isn't in NPM/Yarn/PNPM workspaces, then its dependencies
// will not be installed. We should warn users and provide instructions on how to fix this.
async function warnOnMissingWorkspacesEntry(
  pm: PackageManager,
  pmc: PackageManagerCommands,
  pkgPath: string
) {
  if (!isWorkspacesEnabled(pm, workspaceRoot)) {
    output.warn({
      title: `Missing workspaces in package.json`,
      bodyLines:
        pm === 'npm'
          ? [
              `We recommend enabling NPM workspaces to install dependencies for the imported project.`,
              `Add \`"workspaces": ["${pkgPath}"]\` to package.json and run "${pmc.install}".`,
              `See: https://docs.npmjs.com/cli/using-npm/workspaces`,
            ]
          : pm === 'yarn'
          ? [
              `We recommend enabling Yarn workspaces to install dependencies for the imported project.`,
              `Add \`"workspaces": ["${pkgPath}"]\` to package.json and run "${pmc.install}".`,
              `See: https://yarnpkg.com/features/workspaces`,
            ]
          : pm === 'bun'
          ? [
              `We recommend enabling Bun workspaces to install dependencies for the imported project.`,
              `Add \`"workspaces": ["${pkgPath}"]\` to package.json and run "${pmc.install}".`,
              `See: https://bun.sh/docs/install/workspaces`,
            ]
          : [
              `We recommend enabling PNPM workspaces to install dependencies for the imported project.`,
              `Add the following entry to to pnpm-workspace.yaml and run "${pmc.install}":`,
              chalk.bold(`packages:\n  - '${pkgPath}'`),
              `See: https://pnpm.io/workspaces`,
            ],
    });
  } else {
    // Check if the new package is included in existing workspaces entries. If not, warn the user.
    let workspaces: string[] | null = null;

    if (pm === 'npm' || pm === 'yarn' || pm === 'bun') {
      const packageJson = readPackageJson();
      workspaces = packageJson.workspaces;
    } else if (pm === 'pnpm') {
      const yamlPath = join(workspaceRoot, 'pnpm-workspace.yaml');
      if (existsSync(yamlPath)) {
        const yamlContent = await fsp.readFile(yamlPath, 'utf-8');
        const yaml = yamlLoad(yamlContent);
        workspaces = yaml.packages;
      }
    }

    if (workspaces) {
      const isPkgIncluded = workspaces.some((w) => minimatch(pkgPath, w));
      if (!isPkgIncluded) {
        const pkgsDir = dirname(pkgPath);
        output.warn({
          title: `Project missing in workspaces`,
          bodyLines:
            pm === 'npm' || pm === 'yarn' || pm === 'bun'
              ? [
                  `The imported project (${pkgPath}) is missing the "workspaces" field in package.json.`,
                  `Add "${pkgsDir}/*" to workspaces run "${pmc.install}".`,
                ]
              : [
                  `The imported project (${pkgPath}) is missing the "packages" field in pnpm-workspaces.yaml.`,
                  `Add "${pkgsDir}/*" to packages run "${pmc.install}".`,
                ],
        });
      }
    }
  }
}