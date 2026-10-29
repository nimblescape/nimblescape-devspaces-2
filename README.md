# nimblescape Devspaces 2

Open your GitHub repositories in dev containers with one click, on your own Docker.

Devspaces lists the GitHub repositories that you can access and that contain a Dev Container configuration. **Start** opens a repository in its own dev container, a **devspace**, and connects the VS Code window to it. The containers run on the Docker of your computer, or on Docker on another computer that you reach over SSH.

## What Devspaces does on your computer

- **GitHub sign-in.** Devspaces uses the GitHub sign-in of VS Code with the scopes `repo` (read and change the repositories that you can access, also the private ones) and `read:org` (read your organization memberships). Only for a private image on `ghcr.io`, it also asks for `read:packages`. Devspaces uses every GitHub account of VS Code that you allowed for Devspaces. VS Code keeps the sign-ins, and Devspaces saves no token on your computer. At each open from a VS Code window, Devspaces writes the token of the account that owns the devspace into the memory of the devspace, so that Git and the GitHub CLI work there; code in that container can use it.
- **When it works.** Devspaces starts with every VS Code window, also right after the installation.
  - Before your first devspace, Devspaces only reads its Docker host and, for the local Docker, the current Docker context when VS Code starts. When that read fails and `DOCKER_HOST` is not set, it also runs `docker --version` on this computer, to recognize Podman. It does not contact the Docker engine, read registry logins, build its helper image, or start a helper container.
  - After your first devspace, each window can also check the Docker engine when it starts, and build the helper image: after an update of Devspaces that changes the helper image, and once a week, to check its base image for a newer version. While the view of Devspaces is visible, it reads the state of your devspaces from Docker. For an engine on another computer, these checks run `ssh`.
  - When VS Code starts with an empty window and the window that you closed last was connected to a devspace, Devspaces opens that devspace again, unless you stopped it. When VS Code restores the window of a devspace, Devspaces opens that devspace first. This can start Docker Desktop and the container.
  - Each window where you are signed in reads the repository list of each of your GitHub accounts in Devspaces from GitHub when it opens, and then every hour by default. When VS Code has a GitHub account that Devspaces does not use yet, Devspaces asks once whether to use it.
  - A link `vscode://nimblescape.nimblescape-devspaces-2/open?repository=owner/name`, for example on a website, opens your devspace of that repository after VS Code asks whether Devspaces may open the link, unless you chose "Do not ask me again for this extension" there. Before a link creates a devspace, Devspaces asks too; for a repository of one of your accounts or of one of their organizations, "Always Open" in that question turns this question off. Opening a devspace from a link can start Docker Desktop and the container.
  - A course link `vscode://nimblescape.nimblescape-devspaces-2/course?repository=owner/name-<username>` does the same for your own repository of a course. Devspaces first asks for the GitHub sign-in if you are not signed in, puts the login of each of your accounts in place of `<username>`, and opens the repository that exists with the account of that login.
- **Docker and the Dev Containers CLI.** Devspaces runs the Docker CLI on your computer. On the Docker engine, the Docker of your computer or Docker on another computer that you reach over SSH, its helper containers clone your repositories into Docker volumes, and build, create, start, stop and remove the containers of your devspaces with the Docker Engine API and the Dev Containers CLI. For another computer, Devspaces runs `ssh` to reach it and keeps it in its own list of hosts. It never creates or changes a Docker context, so the Docker tools in your terminals keep their target. The window of a devspace on another computer reaches that Docker through a Docker pipe of Devspaces on your computer (a socket that only your user can open, or a named pipe on Windows), which carries its Docker connections over the SSH login of Devspaces; the Docker calls of Devspaces itself use such a pipe too while that login is open. Before that login starts the helper container, Devspaces runs its checks on it: `docker` commands that only read, in a shell on the other computer. That window runs the Dev Containers extension with a Docker CLI that Devspaces downloads once from `download.docker.com` and checks against the SHA-256 in its code; the Docker tools in your terminals keep their CLI.
- **Registry logins.** Devspaces checks and pulls an image or Feature of a devspace first without a login. It uses the login that Docker stored for its registry on your computer only when the registry refuses this or does not find the image, or when Docker Hub limits pulls without a login: it reads `~/.docker/config.json` and runs its `docker-credential-*` helpers. For `ghcr.io` without such a login, it uses the GitHub sign-in of the account of the devspace with `read:packages`. Devspaces gives the login of that one registry to its helper container only for one check or pull, for at most 8 registries in one open, writes each request to its log, and never stores the login. To build its helper image, Devspaces runs `docker build --pull`: the Docker CLI of your computer then sends the Docker Hub login that Docker stored, if there is one, for the public base image `node`, as for any build.
- **Docker installation.** When Docker is missing, Devspaces can install it: WSL 2 and Docker Desktop on Windows, Docker Desktop on macOS, and Docker Engine on Linux, where your user joins the group `docker`, which gives root rights on the computer. Devspaces first shows the exact commands, or the download address of the installer, and runs them only after you confirm, in a terminal of VS Code that you see.
- **Background container.** On each Docker engine, the container `devspaces-monitor` keeps the images of your devspaces, the VS Code Server and your extensions up to date, builds the next image of a devspace in advance, removes older versions of those images that no container uses, and stops a devspace a few minutes after its last window closes, unless you keep it running. To build the next image, Docker runs the Dockerfile and the Features of the repository, also while no VS Code window is open. To add a newer VS Code Server to a running devspace, the Monitor runs a command in it, as `docker exec` does. The first time that you start a devspace on an engine, Devspaces asks whether this container keeps running there, also while VS Code is closed, or stops 5 minutes after the last devspace stops. Until you answer, it stops when no devspace runs. A container that keeps running ends itself after 30 days in which no devspace was used on that engine. **Devspaces: Remove Devspaces from This Docker Engine…** removes it (see Uninstall below).
- **Network.** Devspaces and its helper containers connect to GitHub, to a remote Docker host over SSH, to the image registries of your Dev Container configurations and of the setting `devspaces.defaultImage`, to the update service of VS Code, to the Visual Studio Marketplace, to Docker Hub, Debian, Docker and npm for the helper image, to Docker for the Docker CLI of the window of a devspace on another computer, and to Docker and the package sources of your system for the installation of Docker. Each HTTPS request of the code of Devspaces, in VS Code and in its helper containers, sends the header `User-Agent: nimblescape-devspaces/<version>`. Other programs, such as Docker, Git and the Dev Containers CLI, send their own User-Agent. Only the Monitor asks the Visual Studio Marketplace: in its background run, for the extensions that the devspaces on its Docker engine used in the last 14 days, also the devspaces of other users of that engine. For each extension, it takes the newest release that works with the current VS Code Server, or the exact version when the extension is listed as `publisher.name@x.y.z`. It downloads only the files that its store does not have. Devspaces collects no telemetry. The code in a devspace can connect to any address.

[Security](https://github.com/nimblescape/nimblescape-devspaces-2/blob/main/docs/security.md#what-devspaces-does-on-your-computer) describes each step and what Devspaces protects.

## Features

- **One click to code.** Devspaces clones the repository into a Docker volume, builds the image, creates the container, and connects the window. Git on your computer is not needed.
- **Fast starts.** A small container on each Docker engine, the Monitor, keeps images, the VS Code server, and your extensions up to date in the background, and prepares newer images before you need them.
- **Safe updates.** When a newer image is available, Devspaces tells you before it updates the container. Your files in the workspace are kept.
- **Stops by itself.** A devspace stops a few minutes after its last window closes, unless you keep it running.
- **Open from a link.** A link on a website opens a repository in its devspace. When Devspaces is not installed, VS Code installs it first ([Open from a link](https://github.com/nimblescape/nimblescape-devspaces-2/blob/main/docs/guide.md#open-from-a-link)). A course link opens the own repository of each student of a course, with the GitHub login of the student in its name ([Course links](https://github.com/nimblescape/nimblescape-devspaces-2/blob/main/docs/guide.md#course-links)).
- **Several GitHub accounts.** One list for all GitHub accounts of VS Code that you use in Devspaces. A new devspace uses the account with the highest permission on the repository, an existing devspace always its own account, and **Start with Account…** lets you choose ([Several GitHub accounts](https://github.com/nimblescape/nimblescape-devspaces-2/blob/main/docs/guide.md#several-github-accounts)).
- **Back where you left off.** When the window that you closed last was connected to a devspace, the next start of VS Code opens that devspace again.
- **Remote Docker.** Run your devspaces on a stronger machine or a shared classroom server over SSH.
- **Guard rails.** Host access checks refuse configurations that reach into your computer (bind mounts, privileged mode, the Docker socket, …). The GitHub token stays in the memory of the container only.
- **Docker setup.** Without Docker, the view walks you through installing it.

## Requirements

- VS Code 1.125 or later (the Microsoft build).
- Docker: Docker Desktop (macOS, Windows with WSL 2, Linux) or Docker Engine (Linux), locally or on a computer that you reach over SSH. Podman is not supported. This includes the package podman-docker.
- A GitHub account on github.com. Devspaces does not work with GitHub Enterprise Server or GHE.com.
- The Dev Containers extension. VS Code installs it with Devspaces.

## Getting started

1. Select the **Devspaces** icon in the activity bar.
2. Select **Sign in with GitHub**. Your repositories with a Dev Container configuration appear, grouped by owner (with a default image, also those without one).
3. Select **Start** on a repository, double-click it, or select it and press `Enter`. A repository with several sources (several configurations, or a configuration and a default image) has a child row per source, each its own devspace; a double-click on the repository starts its first child row. The first start takes a few minutes; later starts take seconds.

Switch between devspaces with **Devspaces: Switch Devspace…** or the status bar. On macOS, the key of the command is `Cmd+Alt+E`. On Windows and Linux, the command has no key, because on many Windows keyboards `Ctrl+Alt+E` types a character such as `€`. To set a key, open **Keyboard Shortcuts** (`Ctrl+K Ctrl+S`), search for `Devspaces: Switch Devspace`, select the row, press `Enter`, press your keys, and press `Enter` again.

## Main settings

| Setting | Default | |
|---|---|---|
| `devspaces.defaultImage` | `""` | An image that every repository can start from next to its configuration: a repository with a configuration gets a `default` row next to its configuration rows, its own devspace; a repository without a configuration starts from the image. `devspaces.startWithDefaultImage` puts the `default` row first (on) or last (off); a double-click on the repository starts its first row. |
| `devspaces.stopOnClose` | `true` | Stop a devspace 5 minutes after its last window closes. |
| `devspaces.updateContainer` | `notify` | At a start with a newer image: `notify` (Continue/Cancel) or `ask` (Update Now/Later). |
| `devspaces.cacheUpdateSchedule` | `7 6 * * *` | When the background updates run: a cron expression in your time zone, or minutes. |
| `devspaces.owners` | `[]` | Organizations and accounts to list. Empty: all. |
| `devspaces.repositoryGroups` | `[]` | Regular expressions that filter and group repositories by name. |

All commands, settings, and details are in the [user guide](https://github.com/nimblescape/nimblescape-devspaces-2/blob/main/docs/guide.md).

## Security and privacy

**A repository that you open is code that you run.** Open only repositories that you trust. The host access checks are a guard rail against mistakes, not a sandbox; see [Security](https://github.com/nimblescape/nimblescape-devspaces-2/blob/main/docs/security.md).

Devspaces uses the GitHub sign-in of VS Code, stores no token, and collects no telemetry.

## Uninstall

Before you uninstall Devspaces, run **Devspaces: Remove Devspaces from This Docker Engine…** (Command Palette, or the **…** menu of the view) on each Docker engine that you used. **Devspaces: Use a Remote Docker Host…** and **Devspaces: Use the Local Docker** switch the engine. The command removes the container `devspaces-monitor`, the helper containers and images of Devspaces, and the volumes `devspaces-monitor`, `devspaces-worker-cache` and `devspaces-vscode`. It asks first, and it asks again before it deletes your devspaces on that engine. Then uninstall the extension in VS Code. The [user guide](https://github.com/nimblescape/nimblescape-devspaces-2/blob/main/docs/guide.md#uninstall) has the Docker commands that remove the same by hand, and the Docker contexts that Devspaces created.

---

[Change log](https://github.com/nimblescape/nimblescape-devspaces-2/blob/main/CHANGELOG.md) · [Contributing](https://github.com/nimblescape/nimblescape-devspaces-2/blob/main/CONTRIBUTING.md) · [User guide](https://github.com/nimblescape/nimblescape-devspaces-2/blob/main/docs/guide.md) · [Support](https://github.com/nimblescape/nimblescape-devspaces-2/blob/main/SUPPORT.md) · [Issues](https://github.com/nimblescape/nimblescape-devspaces-2/issues) · [Source](https://github.com/nimblescape/nimblescape-devspaces-2)

© 2026 Hannes Stauss (scalarion@nimblescape.com) · [MIT License](https://github.com/nimblescape/nimblescape-devspaces-2/blob/main/LICENSE).

The icons of Devspaces are based on the [Codicons](https://github.com/microsoft/vscode-codicons) of Microsoft, under the [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) license. See [ThirdPartyNotices.txt](https://github.com/nimblescape/nimblescape-devspaces-2/blob/main/ThirdPartyNotices.txt).
