# Git, Oh Shit! (gos)

A CLI tool to crawl GitHub repositories and pull all names and email addresses from commit histories.

## Installation

You can install this package globally using npm:

```sh
npm i -g gos
```

## Usage

```sh
gos <github_username> [--details]
```

### Options

- `--details`, `-d`: Show detailed information for each email address, including the repositories and commit details.

## Example

Fetch all emails and committer names for the user `wiggercomputer`:

```sh
gos wiggercomputer
```

Fetch all emails and detailed commit information for the user `wiggercomputer`:

```sh
gos wiggercomputer --details
gos wiggercomputer -d
```

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
