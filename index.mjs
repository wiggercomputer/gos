#!/usr/bin/env node

import { Octokit } from "@octokit/rest";
import chalk from "chalk";
import cliProgress from "cli-progress";
import arg from "arg";
import inquirer from "inquirer";
import updateNotifier from "update-notifier";
import Configstore from "configstore";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const pkgPath = join(__dirname, "package.json");
const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));

const notifier = updateNotifier({ pkg });
notifier.notify();

const config = new Configstore(pkg.name);

async function getGithubToken() {
  let token = config.get("githubToken");
  if (!token) {
    const answers = await inquirer.prompt([
      {
        type: "input",
        name: "token",
        message: `${chalk.yellow("Please set a GitHub personal access token")
          }.\nCreate a new one now, giving it read permission to repos: https://github.com/settings/tokens\nPaste your token here: (${chalk.blue(`or hit 'enter' to continue anyway`)
          }):`,
      },
    ]);
    token = answers.token;
    if (token) {
      config.set("githubToken", token);
    }
  }
  return token;
}

async function createOctokit() {
  const token = await getGithubToken();
  return new Octokit({ auth: token });
}

function parseArgumentsIntoOptions(rawArgs) {
  try {
    const args = arg(
      {
        "--details": Boolean,
        "-d": "--details",
        "--secrets": Boolean,
        "-s": "--secrets",
      },
      { argv: rawArgs.slice(2) },
    );
    return {
      username: args._[0],
      showDetails: args["--details"] || false,
      checkSecrets: args["--secrets"] || false,
    };
  } catch (err) {
    console.log("Usage: gos <username> [--details] [--secrets]");
    process.exit(1);
  }
}

async function fetchRepos(octokit, username) {
  const perPage = config.get("githubToken") ? 100 : 50;
  if (!config.get("githubToken")) {
    console.log(
      chalk.yellow(
        "You are using the tool unauthenticated. Limiting to 50 repositories. Please provide a GitHub token for a higher rate limit.",
      ),
    );
  }
  try {
    const repos = await octokit.repos.listForUser({
      username,
      type: "public",
      per_page: perPage,
    });
    return repos.data;
  } catch (error) {
    console.error(
      chalk.red(`Error fetching repos for user ${username}: ${error.message}`),
    );
    process.exit(1);
  }
}

async function fetchCommits(octokit, owner, repo, forkCreationDate = null) {
  try {
    const commits = await octokit.repos.listCommits({
      owner,
      repo,
      per_page: 100,
    });

    return forkCreationDate
      ? commits.data.filter((commit) =>
        new Date(commit.commit.committer.date) > new Date(forkCreationDate)
      )
      : commits.data;
  } catch (error) {
    console.error(
      chalk.red(`Error fetching commits for repo ${repo}:\n${error.message}`),
    );
    return [];
  }
}

const secretPatterns = [
  /AKIA[0-9A-Z]{16}/, // AWS Access Key ID
  /[A-Za-z0-9+/]{40}/, // AWS Secret Access Key (simplified)
  /[0-9a-fA-F]{32}/, // Generic API Key (simplified)
  /"password":\s*".*?"/i, // Passwords in JSON
  /"secret":\s*".*?"/i, // Secrets in JSON
  /-----BEGIN PRIVATE KEY-----/, // Private Key
  /-----BEGIN CERTIFICATE-----/, // Certificate
  /[a-zA-Z0-9_.+/~$-]([a-zA-Z0-9_.+/=~$-]|\\\\(?![ntr\"])){14,1022}[a-zA-Z0-9_.+/=~$-]/, // High Entropy Strings
];

function checkForSecrets(text) {
  const secrets = [];
  text.split("\n").forEach((line) => {
    for (const pattern of secretPatterns) {
      if (pattern.test(line)) {
        secrets.push(line);
        break;
      }
    }
  });
  // Remove duplicates
  return [...new Set(secrets)];
}

function displayResults(sortedEmails, showDetails, checkSecrets) {
  if (!checkSecrets) {
    console.log(chalk.yellow("\nCollected email addresses:"));
    sortedEmails.forEach(([email, details]) => {
      console.log(email);
      if (showDetails) {
        details.repos.forEach((commits, repoName) => {
          console.log(chalk.green(`  Repo: ${repoName}`));
          commits.forEach((commit) => {
            console.log(chalk.magenta(`    Commit: ${commit.commitHash}`));
            console.log(chalk.blue(`    URL: ${commit.commitUrl}`));
            console.log(chalk.white(`    Author: ${commit.authorName}`));
            if (commit.secrets && commit.secrets.length > 0) {
              console.log(
                chalk.red(`    Potential Secrets:`) +
                `${commit.secrets.join("\n    ")}`,
              );
            }
          });
        });
      } else {
        console.log(
          chalk.white(`  Names: ${Array.from(details.names).join(", ")}`),
        );
      }
    });
  } else {
    // Display all secrets found
    const allSecrets = [];
    sortedEmails.forEach(([_, details]) => {
      details.repos.forEach((commits) => {
        commits.forEach((commit) => {
          if (commit.secrets && commit.secrets.length > 0) {
            allSecrets.push(...commit.secrets);
          }
        });
      });
    });

    if (allSecrets.length > 0) {
      console.log(chalk.red("\nFound Potential Secrets:"));
      allSecrets.forEach((secret) => {
        console.log(secret);
      });
    } else {
      console.log(chalk.green("\nNo exposed secrets found."));
    }
  }
}

(async function() {
  const options = parseArgumentsIntoOptions(process.argv);

  if (!options.username) {
    console.error(chalk.red("Please provide a GitHub username"));
    process.exit(1);
  }

  const octokit = await createOctokit();

  console.log(
    chalk.blue(
      `Fetching public repositories for user: ${chalk.bold(options.username)}`,
    ),
  );
  const repos = await fetchRepos(octokit, options.username);

  let emails = new Map();

  const progressBar = new cliProgress.SingleBar({
    format: "Progress |" + chalk.cyan("{bar}") +
      "| {percentage}% || {value}/{total} Repos || Duration: {duration_formatted}",
  }, cliProgress.Presets.shades_classic);

  progressBar.start(repos.length, 0);

  for (const repo of repos) {
    const forkCreationDate = repo.fork ? repo.created_at : null;
    const commits = await fetchCommits(
      octokit,
      repo.owner.login,
      repo.name,
      forkCreationDate,
    );

    for (const commit of commits) {
      if (commit.commit.author.email) {
        const email = commit.commit.author.email;
        const name = commit.commit.author.name || "N/A";
        const commitMessage = commit.commit.message;

        const commitDetails = await octokit.repos.getCommit({
          owner: repo.owner.login,
          repo: repo.name,
          ref: commit.sha,
        });

        const commitContent = commitDetails.data.files.map((file) =>
          file.patch || ""
        ).join("\n");
        const secrets = options.checkSecrets
          ? [
            ...checkForSecrets(commitMessage),
            ...checkForSecrets(commitContent),
          ]
          : [];

        if (!emails.has(email)) {
          emails.set(email, {
            names: new Set(),
            repos: new Map(),
            commitCount: 0,
          });
        }

        const emailDetails = emails.get(email);
        emailDetails.names.add(name);
        emailDetails.commitCount++;

        if (!emailDetails.repos.has(repo.name)) {
          emailDetails.repos.set(repo.name, []);
        }

        emailDetails.repos.get(repo.name).push({
          commitHash: commit.sha,
          commitUrl: commit.html_url,
          authorName: name,
          secrets,
        });
      }
    }

    progressBar.increment();
  }

  progressBar.stop();

  const sortedEmails = Array.from(emails.entries()).sort((a, b) =>
    b[1].commitCount - a[1].commitCount
  );

  displayResults(sortedEmails, options.showDetails, options.checkSecrets);
})();
