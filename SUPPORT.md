# Support

Devspaces is free and open source. Ask questions and report problems in the [issues on GitHub](https://github.com/nimblescape/devspaces-vscode-2/issues). Search the open and closed issues first. The [user guide](https://github.com/nimblescape/devspaces-vscode-2/blob/main/docs/guide.md#troubleshooting) has a section "Troubleshooting".

## What to include in a report

- The version of Devspaces (the Extensions view shows it) and of VS Code (command **Help: About**).
- Your operating system and its version, for example Windows 11, macOS 15 or Ubuntu 24.04.
- Docker: Docker Desktop or Docker Engine, the output of `docker version`, and whether Docker runs on your computer or on another computer over SSH.
- What you did, what you expected, and what happened, with the exact text of each message.
- The log: run **Devspaces: Show Log**. It opens the Output view with the channel "Devspaces". Copy the lines of the problem. For a problem of the background container, also add the output of `docker logs devspaces-monitor`.

## Before you post

An issue is public. The log can contain the names of your repositories and organizations, your GitHub user name, host names and folder names. Remove what you do not want to show. Devspaces removes GitHub tokens from its log, but check the text before you post it. Never post a token, a password, or the content of `~/.docker/config.json`.
