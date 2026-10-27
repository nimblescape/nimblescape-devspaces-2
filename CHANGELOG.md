# Change log

Each section lists the changes of one released version. The release workflow
takes the section of a version as the notes of its GitHub release.

## 0.2.0

**Course links:** a course link `vscode://nimblescape.nimblescape-devspaces-2/course?repository=owner/name-<username>` opens your own repository of a course, for example the repository that GitHub Classroom creates for you when you accept an assignment. Devspaces asks for the GitHub sign-in first if you are not signed in, puts the login of the signed-in account in place of `<username>`, and then opens the repository as a link `/open?repository=owner/name` does. A course link without `<username>` gets `-<username>` at the end of the name. When Devspaces is not installed, VS Code first offers to install it from the Visual Studio Marketplace. The section [Course links](https://github.com/nimblescape/nimblescape-devspaces-2/blob/main/docs/guide.md#course-links) of the user guide shows the link for a web page.

## 0.1.0

The first version.

**Devspaces:** the view lists the GitHub repositories that you can access and that contain a Dev Container configuration, grouped by owner. **Start** opens a repository in its own dev container, a devspace, and connects the VS Code window to it. Devspaces clones the repository into a Docker volume, builds the image and creates the container on the Docker of your computer, or on Docker on another computer that you reach over SSH. Git on your computer is not needed. The setting devspaces.defaultImage names an image that every repository can start from. A repository with several sources (several configurations, or a configuration and the default image) has one child row per source, and each child row is its own devspace.

**Background container:** on each Docker engine, the container devspaces-monitor keeps the images of your devspaces, the VS Code Server and your extensions up to date, prepares the next image of a devspace in advance, and stops a devspace a few minutes after its last window closes, unless you keep it running. The first Start or Rebuild on an engine, or Update All Images Now there, asks whether it keeps running there, also while VS Code is closed. Stop When Idle turns on the setting devspaces.stopMonitorWhenIdle, so the Monitor ends 5 minutes after the last devspace stopped, on each engine from the next start of a devspace or Update All Images Now there; until then, a Monitor that keeps running goes on. A Monitor that keeps running ends itself after 30 days in which no devspace was used on its engine.

**Remove Devspaces from This Docker Engine…:** the command removes the Monitor, the helper containers and images, and the shared volumes of Devspaces from the current Docker engine, after a confirmation. A second confirmation shows the recorded Git changes of your devspaces on the engine and asks whether they are deleted too.

**Safe updates:** when a newer image is available, Devspaces tells you before it updates the container (setting devspaces.updateContainer). The files in the workspace are kept.

**Open from a link:** a link `vscode://nimblescape.nimblescape-devspaces-2/open?repository=owner/name`, for example on a website, opens the repository in its devspace. Devspaces asks before a link creates a devspace.

**Switch and reopen:** **Switch Devspace…** and the status bar switch between your devspaces. When the window that you closed last was connected to a devspace, the next start of VS Code opens that devspace again.

**Remote Docker:** **Use a Remote Docker Host…** runs your devspaces on Docker on another computer that you reach over SSH. After you confirm, Devspaces creates a Docker context for it.

**Docker setup:** without Docker, the view shows the steps to install it: WSL 2 and Docker Desktop on Windows, Docker Desktop on macOS, and Docker Engine on Linux, each only after you confirm the commands. When the current Docker context cannot be read, the sidebar shows "Docker context cannot be read". When the `docker` command uses Podman, the sidebar shows "Podman is not supported".

**Security:** host access checks refuse configurations that reach into your computer, for example bind mounts, privileged mode or the Docker socket. Devspaces uses the GitHub sign-in of VS Code, stores no token, and collects no telemetry. It checks and pulls images first without a registry login. Before your first devspace, it does no Docker work. In Restricted Mode, only your user settings count. The top of the README and [Security](https://github.com/nimblescape/nimblescape-devspaces-2/blob/main/docs/security.md#what-devspaces-does-on-your-computer) say what Devspaces does on your computer.
