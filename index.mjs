#!/usr/bin/env node

import { Octokit } from '@octokit/rest';
import chalk from 'chalk';
import cliProgress from 'cli-progress';
import arg from 'arg';

const octokit = new Octokit();

function parseArgumentsIntoOptions(rawArgs) {
  try{
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
  }
  catch(err){
    console.log(`Usage: gso <username> [--details]`)
    process.exit(1);
  }
}

async function fetchRepos(username) {
    try {
        const repos = await octokit.repos.listForUser({
            username,
            type: 'public',
            per_page: 100
        });
        return repos.data;
    } catch (error) {
        console.error(chalk.red(`Error fetching repos for user ${username}: ${error.message}`));
        process.exit(1);
    }
}

async function fetchCommits(owner, repo, forkCreationDate = null) {
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

    console.log(chalk.blue(`Fetching public repositories for user: ${chalk.bold(options.username)}`));
    const repos = await fetchRepos(options.username);

    let emails = new Map();

    const progressBar = new cliProgress.SingleBar({
        format: 'Progress |' + chalk.cyan('{bar}') + '| {percentage}% || {value}/{total} Repos || Duration: {duration_formatted}'
    }, cliProgress.Presets.shades_classic);

    progressBar.start(repos.length, 0);

    for (const repo of repos) {
        const forkCreationDate = repo.fork ? repo.created_at : null;
        const commits = await fetchCommits(repo.owner.login, repo.name, forkCreationDate);

        for (const commit of commits) {
            if (commit.commit.author.email) {
                const email = commit.commit.author.email;
                const name = commit.commit.author.name || 'N/A';
                if (!emails.has(email)) {
                    emails.set(email, { names: new Set(), repos: new Map() });
                }
                emails.get(email).names.add(name);
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

    console.log(chalk.yellow('\nCollected email addresses:'));
    emails.forEach((details, email) => {
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

