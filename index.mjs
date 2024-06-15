#!/usr/bin/env node

import { Octokit } from '@octokit/rest';
import chalk from 'chalk';
import cliProgress from 'cli-progress';
import arg from 'arg';
import inquirer from 'inquirer';
import updateNotifier from 'update-notifier';
import Configstore from 'configstore';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const pkgPath = join(__dirname, 'package.json');

const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));

const notifier = updateNotifier({ pkg });
notifier.notify();

const config = new Configstore(pkg.name);

async function getGithubToken() {
    let token = config.get('githubToken');
    if (!token) {
        const answers = await inquirer.prompt([
            {
                type: 'input',
                name: 'token',
                message: `${chalk.yellow('Please set a GitHub personal access token')}.\nCreate a new one now, giving it read permission to repos: https://github.com/settings/tokens\nPaste your token here: (${chalk.blue(`or hit 'enter' to continue anyway`)}):`,
            }
        ]);
        token = answers.token;
        if (token) {
            config.set('githubToken', token);
        }
    }
    return token;
}

async function createOctokit() {
    const token = await getGithubToken();
    return new Octokit({
        auth: token
    });
}

function parseArgumentsIntoOptions(rawArgs) {
  try {
    const args = arg(
      {
        '--details': Boolean,
        '-d': '--details'
      },
      {
        argv: rawArgs.slice(2),
      }
    );
    return {
      username: args._[0],
      showDetails: args['--details'] || false,
    };
  } catch (err) {
    console.log('Usage: github-email-crawler <username> [--details]');
    process.exit(1);
  }
}

async function fetchRepos(octokit, username) {
  try {
    const perPage = config.get('githubToken') ? 100 : 50;
    if (!config.get('githubToken')) {
      console.log(chalk.yellow('You are using the tool unauthenticated. Limiting to 50 repositories. Please provide a GitHub token for a higher rate limit.'));
    }
    const repos = await octokit.repos.listForUser({
      username,
      type: 'public',
      per_page: perPage
    });
    return repos.data;
  } catch (error) {
    console.error(chalk.red(`Error fetching repos for user ${username}: ${error.message}`));
    process.exit(1);
  }
}

async function fetchCommits(octokit, owner, repo, forkCreationDate = null) {
  try {
    const commits = await octokit.repos.listCommits({
      owner,
      repo,
      per_page: 100
    });

    if (forkCreationDate) {
      return commits.data.filter(commit => new Date(commit.commit.committer.date) > new Date(forkCreationDate));
    }

    return commits.data;
  } catch (error) {
    console.error(chalk.red(`Error fetching commits for repo ${repo}: ${error.message}`));
  }
}

(async function () {
  const options = parseArgumentsIntoOptions(process.argv);

  if (!options.username) {
    console.error(chalk.red('Please provide a GitHub username'));
    process.exit(1);
  }

  const octokit = await createOctokit();

  console.log(chalk.blue(`Fetching public repositories for user: ${chalk.bold(options.username)}`));
  const repos = await fetchRepos(octokit, options.username);

  let emails = new Map();

  const progressBar = new cliProgress.SingleBar({
    format: 'Progress |' + chalk.cyan('{bar}') + '| {percentage}% || {value}/{total} Repos || Duration: {duration_formatted}'
  }, cliProgress.Presets.shades_classic);

  progressBar.start(repos.length, 0);

  for (const repo of repos) {
    const forkCreationDate = repo.fork ? repo.created_at : null;
    const commits = await fetchCommits(octokit, repo.owner.login, repo.name, forkCreationDate);

    for (const commit of commits) {
      if (commit.commit.author.email) {
        const email = commit.commit.author.email;
        const name = commit.commit.author.name || 'N/A';
        if (!emails.has(email)) {
          emails.set(email, { names: new Set(), repos: new Map(), commitCount: 0 });
        }
        emails.get(email).names.add(name);
        emails.get(email).commitCount++;
        if (!emails.get(email).repos.has(repo.name)) {
          emails.get(email).repos.set(repo.name, []);
        }
        emails.get(email).repos.get(repo.name).push({
          commitHash: commit.sha,
          commitUrl: commit.html_url,
          authorName: name
        });
      }
    }

    progressBar.increment();
  }

  progressBar.stop();

  // Convert emails map to an array and sort by commit count
  const sortedEmails = Array.from(emails.entries()).sort((a, b) => b[1].commitCount - a[1].commitCount);

  console.log(chalk.yellow('\nCollected email addresses:'));
  sortedEmails.forEach(([email, details]) => {
    console.log(email);
    if (options.showDetails) {
      details.repos.forEach((commits, repoName) => {
        console.log(chalk.green(`  Repo: ${repoName}`));
        commits.forEach(commit => {
          console.log(chalk.magenta(`    Commit: ${commit.commitHash}`));
          console.log(chalk.blue(`    URL: ${commit.commitUrl}`));
          console.log(chalk.white(`    Author: ${commit.authorName}`));
        });
      });
    } else {
      console.log(chalk.white(`  Names: ${Array.from(details.names).join(', ')}`));
    }
  });
})();

