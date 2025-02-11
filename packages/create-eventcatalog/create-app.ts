/* eslint-disable no-restricted-syntax */
import retry from 'async-retry';
import chalk from 'chalk';
import cpy from 'cpy';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  downloadAndExtractExample,
  downloadAndExtractRepo,
  getRepoInfo,
  hasExample,
  hasRepo,
  RepoInfo,
} from './helpers/examples';
import { makeDir } from './helpers/make-dir';
import { tryGitInit } from './helpers/git';
import { install } from './helpers/install';
import { isFolderEmpty } from './helpers/is-folder-empty';
import { isWriteable } from './helpers/is-writeable';
import { shouldUseYarn } from './helpers/should-use-yarn';

export class DownloadError extends Error {}

export async function createApp({
  appPath,
  example,
  examplePath,
  useNpm,
}: // typescript,
{
  appPath: string;
  useNpm: boolean;
  example?: string;
  examplePath?: string;
  // typescript?: boolean
}): Promise<void> {
  let repoInfo: RepoInfo | undefined;
  // const template = typescript ? 'typescript' : 'default'
  const template = 'default';

  if (example) {
    let repoUrl: URL | undefined;

    try {
      repoUrl = new URL(example);
    } catch (error: any) {
      if (error.code !== 'ERR_INVALID_URL') {
        console.error(error);
        process.exit(1);
      }
    }

    if (repoUrl) {
      if (repoUrl.origin !== 'https://github.com') {
        console.error(
          `Invalid URL: ${chalk.red(
            `"${example}"`
          )}. Only GitHub repositories are supported. Please use a GitHub URL and try again.`
        );
        process.exit(1);
      }

      repoInfo = await getRepoInfo(repoUrl, examplePath);

      if (!repoInfo) {
        console.error(`Found invalid GitHub URL: ${chalk.red(`"${example}"`)}. Please fix the URL and try again.`);
        process.exit(1);
      }

      const found = await hasRepo(repoInfo);

      if (!found) {
        console.error(
          `Could not locate the repository for ${chalk.red(
            `"${example}"`
          )}. Please check that the repository exists and try again.`
        );
        process.exit(1);
      }
    } else if (example !== '__internal-testing-retry') {
      const found = await hasExample(example);

      if (!found) {
        console.error(
          `Could not locate an example named ${chalk.red(`"${example}"`)}. It could be due to the following:\n`,
          `1. Your spelling of example ${chalk.red(`"${example}"`)} might be incorrect.\n`,
          '2. You might not be connected to the internet.'
        );
        process.exit(1);
      }
    }
  }

  const root = path.resolve(appPath);

  if (!(await isWriteable(path.dirname(root)))) {
    console.error('The application path is not writable, please check folder permissions and try again.');
    console.error('It is likely you do not have write permissions for this folder.');
    process.exit(1);
  }

  const appName = path.basename(root);

  await makeDir(root);
  if (!isFolderEmpty(root, appName)) {
    process.exit(1);
  }

  const useYarn = useNpm ? false : shouldUseYarn();
  const originalDirectory = process.cwd();

  console.log(`Creating a new eventcatalog in ${chalk.green(root)}.`);
  console.log();

  await makeDir(root);
  process.chdir(root);

  if (example) {
    /**
     * If an example repository is provided, clone it.
     */
    try {
      if (repoInfo) {
        const repoInfo2 = repoInfo;
        console.log(`Downloading files from repo ${chalk.cyan(example)}. This might take a moment.`);
        console.log();
        await retry(() => downloadAndExtractRepo(root, repoInfo2), {
          retries: 3,
        });
      } else {
        console.log(`Downloading files for example ${chalk.cyan(example)}. This might take a moment.`);
        console.log();
        await retry(() => downloadAndExtractExample(root, example), {
          retries: 3,
        });
      }
    } catch (reason: any) {
      throw new DownloadError(reason);
    }
    // Copy our default `.gitignore` if the application did not provide one
    const ignorePath = path.join(root, '.gitignore');
    if (!fs.existsSync(ignorePath)) {
      fs.copyFileSync(path.join(__dirname, 'templates', template, 'gitignore'), ignorePath);
    }

    console.log('Installing packages. This might take a couple of minutes.');
    console.log();

    await install(root, null, { useYarn, isOnline: true });
    console.log();
  } else {
    /**
     * Otherwise, if an example repository is not provided for cloning, proceed
     * by installing from a template.
     */
    /**
     * Create a package.json for the new project.
     */
    const packageJson = {
      name: appName,
      version: '0.0.1',
      private: true,
      scripts: {
        start: 'eventcatalog start',
        dev: 'eventcatalog dev',
        build: 'eventcatalog build',
        generate: 'eventcatalog generate',
        test: 'echo "Error: no test specified" && exit 1',
      },
      devDependencies: {
        tailwindcss: '^2.2.19',
        typescript: '^4.4.4',
        postcss: '^8.3.11',
        'cross-env': '^7.0.3',
        autoprefixer: '^10.4.0',
      },
    };

    /**
     * Write it to disk.
     */
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(packageJson, null, 2) + os.EOL);
    /**
     * These flags will be passed to `install()`.
     */
    const installFlags = { useYarn, isOnline: true };
    /**
     * Default dependencies.
     */

    const dependencies = ['@eventcatalog/core'];

    /**
     * Default devDependencies.
     */
    const devDependencies = ['@types/react', '@eventcatalog/types', '@types/node'];
    /**
     * TypeScript projects will have type definitions and other devDependencies.
     */
    // if (typescript) {
    //   devDependencies.push('typescript')
    // }
    /**
     * Install package.json dependencies if they exist.
     */
    if (dependencies.length) {
      console.log();
      console.log('Installing dependencies:');
      for (const dependency of dependencies) {
        console.log(`- ${chalk.cyan(dependency)}`);
      }
      console.log();

      await install(root, dependencies, installFlags);
    }
    /**
     * Install package.json devDependencies if they exist.
     */
    if (devDependencies.length) {
      console.log();
      console.log('Installing devDependencies:');
      for (const devDependency of devDependencies) {
        console.log(`- ${chalk.cyan(devDependency)}`);
      }
      console.log();

      const devInstallFlags = { devDependencies: true, ...installFlags };
      await install(root, devDependencies, devInstallFlags);
    }
    /**
     * Copy the template files to the target directory.
     */
    await cpy('**', root, {
      parents: true,
      cwd: path.join(__dirname, 'templates', template),
      rename: (name) => {
        switch (name) {
          case 'env':
          case 'gitignore':
          case 'dockerignore':
          case 'eslintrc': {
            return '.'.concat(name);
          }
          // README.md is ignored by webpack-asset-relocator-loader used by ncc:
          // https://github.com/vercel/webpack-asset-relocator-loader/blob/e9308683d47ff507253e37c9bcbb99474603192b/src/asset-relocator.js#L227
          case 'README-template.md': {
            return 'README.md';
          }
          default: {
            return name;
          }
        }
      },
    });
  }

  if (tryGitInit(root)) {
    console.log('Initialized a git repository.');
    console.log();
  }

  let cdpath: string;
  if (path.join(originalDirectory, appName) === appPath) {
    cdpath = appName;
  } else {
    cdpath = appPath;
  }

  console.log(`${chalk.green('Success!')} Created ${appName} at ${appPath}`);
  console.log('Inside that directory, you can run several commands:');
  console.log();
  console.log(chalk.cyan('  npm run dev'));
  console.log('    Starts the app in development mode.');
  console.log();
  console.log(chalk.cyan('  npm start'));
  console.log('    Runs the app in production mode.');
  console.log();
  console.log('We suggest that you begin by typing:');
  console.log();
  console.log(chalk.cyan('  cd'), cdpath);
  console.log(`  ${chalk.cyan('npm run dev')}`);
  console.log();
}
