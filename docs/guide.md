# Devspaces user guide

The complete guide to Devspaces. The short overview is the [README](../README.md); how Devspaces works inside is in [architecture.md](architecture.md), and the security model in [security.md](security.md).

**Contents:** [Requirements](#requirements) · [Install](#install) · [First steps](#first-steps) · [The sidebar](#the-sidebar) · [Commands](#commands) · [Settings](#settings) · [Updates](#updates) · [Stop on close](#stop-on-close) · [Remote Docker host](#remote-docker-host) · [Shared Docker engines](#shared-docker-engines) · [Installing Docker](#installing-docker) · [Security](#security) · [Known limits](#known-limits) · [Troubleshooting](#troubleshooting) · [Uninstall](#uninstall) · [Build from source](#build-from-source)

## Requirements

- Visual Studio Code 1.125 or later, the build of Microsoft. The Dev Containers extension is licensed for this build only.
- Docker: Docker Desktop on macOS, Windows (with WSL 2), or Linux, or Docker Engine on Linux. Without Docker, Devspaces offers to install it (see [Installing Docker](#installing-docker)). Docker can also run on another computer that you reach over SSH, and then your computer needs no Docker (see [Remote Docker host](#remote-docker-host)). Podman is not supported. When the `docker` command on this computer uses Podman, for example with the package podman-docker, or when the local Docker is a Podman engine behind the Docker CLI, Devspaces says so and does nothing. With podman-docker, the sidebar shows "Podman is not supported" unless `DOCKER_HOST` is set.
- A GitHub account on github.com. Devspaces does not work with GitHub Enterprise Server or GHE.com: it uses the GitHub sign-in of VS Code for github.com and the GitHub API at `api.github.com`. When the settings `github-enterprise.uris` or `github-enterprise.uri` of VS Code name a GitHub Enterprise instance, the view shows a note under the button **Sign in with GitHub**.
- The Dev Containers extension (`ms-vscode-remote.remote-containers`). VS Code installs it together with Devspaces.

## Install

Install **Devspaces** from the Visual Studio Marketplace: search for "Devspaces" in the Extensions view of VS Code, or run:

```sh
code --install-extension nimblescape.nimblescape-devspaces-2
```

VS Code installs the Dev Containers extension with it. To install a `.vsix` file instead, run **Extensions: Install from VSIX…** or `code --install-extension nimblescape-devspaces-2-<version>.vsix`; to create the file yourself, see [Build from source](#build-from-source).

### Update from version 0.4.0 or older

Version 0.4.0 and older named the image of the worker `devspaces-helper:<hash>` (with the second tag `devspaces-monitor:<hash>`), its cache volume `devspaces-helper-cache`, and its labels `nimblescape.devspaces.helper…`. Later versions name them `devspaces-worker:<hash>`, `devspaces-worker-cache`, and `nimblescape.devspaces.worker…`, build the new image at the first use, and do not use or remove the old objects. On each Docker engine, after the first start of a devspace with the new version (which replaces the Monitor), remove the old objects, because the host access checks of the new version do not protect the old volume:

```sh
for tag in $(docker image ls devspaces-helper --format '{{.Tag}}'); do docker image rm "devspaces-helper:$tag" "devspaces-monitor:$tag"; done
docker volume rm devspaces-helper-cache
```

A `devspaces-monitor:<hash>` tag that does not exist gives an error for that tag only. All computers that use one Docker engine should have the same version, so that the worker of only one version runs there.

### Update from version 0.2.1 or older

Version 0.2.1 and older named the Docker objects of Devspaces `devspace-…` and their labels `nimblescape.devspace.…`. Later versions name them `devspaces-…` and `nimblescape.devspaces.…`, and they do not use the objects of the older versions: the sidebar does not show a devspace of an older version, and a start of its repository creates a new devspace that clones the repository again.

1. Before the update, push the changes in each devspace.
2. After the update, remove the objects of the older version on each Docker engine before you start a devspace, because the host access checks of the new version do not protect them. These are the containers, volumes, images, and networks whose names start with `devspace-` (without `s`): the Monitor container and volume `devspace-monitor`, the volumes `devspace-vscode` and `devspace-helper-cache`, the images `devspace-helper` and `devspace-monitor`, and the containers, volumes, images, and Compose networks of each devspace. Volumes that a configuration names itself (for example `api-node_modules`) have other names; `docker volume ls --filter label=nimblescape.devspace.id` lists them with the other volumes of the devspaces.
3. Rename your settings and keybindings as described in [Settings](#settings).

All computers that use one Docker engine need the same version: an older version does not see the devspaces of a newer one, and the other way round.

## First steps

1. Select the **Devspaces** icon in the activity bar. If Docker is not installed, the view shows the steps to set it up (see [Installing Docker](#installing-docker)), or to use Docker on another computer instead (see [Remote Docker host](#remote-docker-host)).
2. Select **Sign in with GitHub**. The list shows your repositories that have a Dev Container configuration, grouped by owner (with a [default image](#default-image), also the repositories without one). The first load can take a moment with many repositories; the view shows the repositories as they arrive, and later updates read only the repositories that changed.
3. Select **Start** on a repository, double-click it, or select it and press `Enter`. A repository with several sources (several configurations, or a configuration and a [default image](#default-image)) has one child row per source; **Start** is on the child rows then, and a double-click or `Enter` on the repository starts its first child row. The first start creates the devspace: it clones the repository, builds the image, and creates the container, which can take several minutes. Your first devspace also builds the helper image of Devspaces. Later starts take seconds.
4. The window connects to the container. You work in the repository folder under `/workspaces/<name>`.

The first start of a repository that belongs neither to one of your accounts nor to one of their organizations asks for a confirmation, because it runs code from that repository.

To go to another devspace, use **Devspaces: Switch Devspace…** (on macOS `Cmd+Alt+E`; on Windows and Linux, [set a key](#status-bar-and-switcher)) or select the Devspaces item in the status bar.

## Several GitHub accounts

VS Code can be signed in to several GitHub accounts at the same time, for example a personal account and the account of a course. Devspaces uses every GitHub account of VS Code that you allowed for Devspaces, and shows one list for all of them.

- **Add an account.** Select **Add GitHub Account…** in the title bar of the view (or run **Devspaces: Add GitHub Account…**). VS Code shows its accounts; **Sign in to another account** at the end signs in with a new one in the browser. When VS Code already has a GitHub account that Devspaces does not use, for example an account that only another extension uses, Devspaces asks once: "The GitHub account `<login>` is signed in to VS Code. Use it in Devspaces?" **Use in Devspaces** adds it; after **Not Now**, **Add GitHub Account…** still offers it.
- **The list.** The view lists the repositories of all accounts, each repository once. The tooltip of a row names the account that **Start** uses, with its permission on the repository, for example `Account: octocat (admin)`. With more than one account, the row of a devspace starts with the login of its account, for example `@octocat main   Stopped`. A hint of an organization that refuses the access names the account, for example "The organization `acme` refuses the access of `octocat`."
- **Which account starts a repository.** A devspace belongs to the account that created it, and always opens with that account. A new devspace uses the account with the highest permission on the repository (admin, maintain, write, triage, read). With equal permission, the account whose login owns the repository wins, then a member of the organization of the repository, then the login that comes first in alphabetical order.
- **Start with Account….** When two or more of your accounts can access a repository, its context menu has **Start with Account…**. It lists the accounts in the order above and creates a new devspace of the account that you select, with its own clone, container and images, or opens the devspace of that account when it has one. The devspace of the other account stays as it is, with its own row; **Delete** removes it when you no longer need it. The next **Start** opens the devspace that was used last.
- **One devspace, one account.** Git and the GitHub CLI in a devspace work as the account of the devspace. A push to a repository that only another of your accounts may change fails there; start the repository with that account instead.
- **Stop using an account.** In the Accounts menu of VS Code (the person icon in the activity bar), select the account, then **Manage Trusted Extensions**, and remove Devspaces there. **Sign Out** there removes the account for every extension. The list and the devspaces of the account disappear from the view, and a window of one of its devspaces closes its connection. The devspaces stay on the Docker engine and come back when the account is used again.
- **A devspace of an account that is not signed in.** Devspaces does not show it. When you start its repository, Devspaces asks: **Sign In as `<login>`** opens it after the sign-in of that account, and **New Devspace as `<login>`** creates a separate devspace of one of your accounts.

## Open from a link

A link opens a repository in Devspaces, for example from a website or a course page:

```text
vscode://nimblescape.nimblescape-devspaces-2/open?repository=owner/name
```

For VS Code Insiders, the link starts with `vscode-insiders://`. On a web page:

```html
<a href="vscode://nimblescape.nimblescape-devspaces-2/open?repository=owner/name">Open in Devspaces</a>
```

When you select the link:

1. Your browser usually asks whether it may open VS Code.
2. When Devspaces is not installed, VS Code offers to install it from the Visual Studio Marketplace, with the Dev Containers extension, and then opens the link. When Devspaces is installed, VS Code asks whether Devspaces may open the link. With **Do not ask me again for this extension**, VS Code opens later links to Devspaces without this question; **Extensions: Manage Authorized Extension URIs...** takes that choice back.
3. When you are not signed in, Devspaces asks for the GitHub sign-in.
4. Devspaces opens the devspace of the repository that you used last on the current Docker engine. Without one, Devspaces asks before it creates a devspace, and before any Docker work: the devspace clones the repository and runs code from it (Dockerfile, Features, and commands) on your Docker engine. For a repository that belongs neither to one of your accounts nor to one of their organizations, this question is the confirmation of the first start, as in the list. After **Open**, Devspaces starts the repository as a double-click on its row does, from its first source, with the account that **Start** uses (see [Several GitHub accounts](#several-github-accounts)). The repository does not need to be in your list: Devspaces then asks GitHub with each of your accounts, and only the accounts that GitHub shows it to count. For a repository of one of your accounts or of one of their organizations, the question also has the button **Always Open**: it opens the repository in the same way and turns off the setting `devspaces.confirmOpenFromLink`, so later links create such devspaces without this question. Turn the setting on again to get the question back. The confirmation for a repository of another owner has no such button, and it always comes.

The devspace opens in the window that VS Code gives the link, usually the window that was active last, when that window is empty; otherwise it opens in a new window, and that window keeps what it has. A link opens nothing, and a message says why, when it does not name a repository as `owner/name`, when GitHub does not show the repository to any of your accounts, or when the repository has no Dev Container configuration and `devspaces.defaultImage` is empty. When GitHub cannot be asked, for example without a connection to the internet, the link opens your devspace of the repository on the current Docker engine, if you have one there.

### Course links

A course link opens your own repository of a course, for example the repository that GitHub Classroom creates for you when you accept an assignment. GitHub Classroom names it after the assignment, with your GitHub login at the end: for the login `octocat`, the assignment `my-school/module-ts-2` gives the repository `my-school/module-ts-2-octocat`. One course link works for every student of the course:

```text
vscode://nimblescape.nimblescape-devspaces-2/course?repository=owner/name-<username>
```

On a web page:

```html
<a href="vscode://nimblescape.nimblescape-devspaces-2/course?repository=my-school/module-ts-2-<username>">Open in Devspaces</a>
```

A course link needs the GitHub sign-in, because only the sign-in tells Devspaces your login. When you are not signed in, Devspaces asks for the sign-in first; without it, the link opens nothing. Devspaces then puts the login of each of your accounts in place of `<username>` and opens the repository that exists, as a link `/open?repository=owner/name` does (see [Open from a link](#open-from-a-link)). It opens it with the account of the login in its name, also when another of your accounts has more rights on it, for example the account of a teacher who owns the organization of the course: the repository is the personal one of that login. When the repositories of two of your accounts exist, Devspaces asks which one to open. This also works when Devspaces is not installed yet: VS Code first offers to install it, as for a link `/open`.

- `<username>` can stand anywhere in the name, also more than once. A course link without `<username>` gets `-<username>` at the end of the name, so `/course?repository=my-school/module-ts-2` opens the same repository.
- The owner is the organization of the course and cannot contain `<username>`.
- When GitHub does not show the repository to your account, for example before you accepted the assignment, or when you signed in with another account than the one of the course, the link opens nothing, and a message names each repository and login that Devspaces tried. **Add GitHub Account…** adds the account of the course.

## The sidebar

The first row names the Docker engine that the view shows: **Local Docker**, or **Remote Docker host: `<host>`**. When the current Docker context of your computer reaches a host over SSH that is not in the list of Devspaces, it shows **Docker is set to `<host>` over SSH** (see [Remote Docker host](#remote-docker-host)). Select it to choose another engine. Below it, the repositories are grouped by owner.

The title bar has **Select Organizations…** (limits the list and the scan to the organizations and accounts that you select; with several GitHub accounts, each organization names the accounts that are members), **Show Only Devspaces** (lists only the repositories that have a devspace, in any state; **Show All Repositories** lists all again), **Search**, **Refresh**, **Expand All** (opens every owner, group and repository with several sources), and VS Code's **Collapse All**. Its **…** menu has **Add GitHub Account…**, **Edit Repository Groups…**, **Update All Images Now**, and **Remove Devspaces from This Docker Engine…**.

### What a row shows

A row shows the repository name, the branch that is checked out in the devspace, and the state of its devspace. Uncommitted changes and unpushed commits show as numbers, for example `Stopped · 3 unpushed`. With more than one GitHub account, the login of the account of the devspace comes first, for example `@octocat main   Stopped`. The tooltip shows more, for example the source of the devspace, its GitHub account, and the time of the last use.

A repository with one possible source is one row: its one Dev Container configuration, or the [default image](#default-image) when it has no configuration (the row then shows `(default image)` next to the branch). A repository with several possible sources is a node with one child row per source: a configuration in `.devcontainer/<name>/devcontainer.json` next to the one at the root, or a configuration and the default image. Each child row is its own devspace, so two devspaces of one repository can run at the same time, and the buttons, the state and the context menu are on the child rows. A double-click or `Enter` on the repository name starts its first child row (see [Default image](#default-image)). The label of a child row is the word of its source:

- `default` for the default image;
- `config` for the configuration at the root of the repository (`.devcontainer/devcontainer.json` or `.devcontainer.json`, which count as one configuration);
- the folder name for another configuration, for example `python` for `.devcontainer/python/devcontainer.json`.

A devspace keeps its source. When the branch that is checked out in the devspace does not have its configuration, the start uses the first configuration of that branch and says so once; the devspace stays on its row, and its configuration applies again on a branch that has it.

The same word is in the Docker names of the devspace, for example `devspaces-acme-api-default-brave-curie` and `devspaces-acme-api-config-calm-noether`, and in the texts that name it, for example `acme/api · default`.

| State | Meaning |
|---|---|
| `Connected` | This window is connected to the devspace. |
| `Connected · other window` | Another VS Code window is connected to it. **Start** brings that window to the front. |
| `Running` | The container runs, but no window is connected, for example during the waiting time after a close, or while an agent works in it. |
| `Stopped` | The container is stopped. **Start** starts it. |
| `Updating` | Devspaces creates, updates, rebuilds, or deletes the devspace. |
| `No container` | The container was removed outside of Devspaces. **Start** creates it again from the image of the devspace. |
| `Files missing` | The volume with the repository is missing. **Start** offers **Clone again** or **Delete devspace**. |
| `State unknown (…)` | Devspaces could not read the states on that Docker engine, for example while it prepares the engine (`Docker not ready`), when a remote host does not answer (`<host> cannot be reached`), or after you removed Devspaces from the engine (`Devspaces removed from Docker`). The local Docker is named `Docker`, a remote engine by its host. The actions stay available. |

A repository without a devspace shows no state; **Start** creates its devspace on the default branch.

More markers in a row:

- `· kept`: the devspace keeps running when no window uses it (see [Stop on close](#stop-on-close)).
- `· containers running`: the dev container is not running, but another container of the devspace is, for example a database of Docker Compose. **Stop** stops it.
- `not on GitHub`: GitHub no longer lists the repository, for example after you lost access. The devspace stays until you delete it.
- `host access unrestricted`: the host access checks are off for this repository (see [Security](#security)).

### Actions of a row

| Action | Effect |
|---|---|
| **Start** (or a double-click, or `Enter`) | Starts the devspace and connects the current window. Creates the devspace on the first start, from the source of the row. If another window is connected to it, that window comes to the front: a devspace is never open in two windows. |
| **Start in New Window** | The same, but a new window connects, and the current window keeps its devspace. With the setting `devspaces.openInNewWindow` on, the menu offers **Start in Current Window** instead. |
| **Start with Account…** | Only when two or more of your GitHub accounts can access the repository, and the row offers **Start**: starts the devspace of the account that you select, and creates it when that account has none (see [Several GitHub accounts](#several-github-accounts)). |
| **Stop** | Stops the container at once. Your files stay. If a window is connected, the connection closes first. The Monitor on the Docker engine is told first, so the devspace stops even when you quit VS Code right after the click. A notification shows the progress until `owner/name stopped.` |
| **Delete** | Removes the containers, the images, and the volume with the repository, after you confirm it. The confirmation shows uncommitted changes, unpushed commits, and stashes as far as Devspaces recorded them, and offers **Open devspace**. Additional volumes of the configuration, for example of a database, are removed only when you tick them. |
| **Keep Running When Closed** | The devspace keeps running when no window uses it, for example for a server or an agent. Only **Stop** or **Delete** stops it. **Stop When Closed** switches back. The choice is stored with the devspace. |
| **Close and Keep Running** | Only in a window that is connected to the devspace: closes the window, and the container keeps running this time. The next window that connects to it ends this. |
| **Rebuild** | Builds the image again and creates the container again. The volume with the repository stays. |
| **Show on GitHub** | Opens the repository in the browser. |
| **Turn Off Host Access Checks…** / **Turn On Host Access Checks** | Switches the host access checks of this repository (see [Security](#security)). |

A row has the buttons **Start**, **Stop** (when the devspace runs) and **⋯**. The other actions, also **Delete**, are in the context menu of the row and in its **⋯** button. A repository with child rows has no buttons and no context menu of its own: every action is on its child rows, and a double-click or `Enter` on the repository starts its first child row.

### Default image

By default, a devspace is built from the Dev Container configuration of its repository (`devcontainer.json`). With the setting `devspaces.defaultImage` you name one image, for example `ghcr.io/majikmate/devcontainer-base:latest`, that every repository can start from next to its configuration. This is useful when the repositories of a course or a team have no configuration, or when one shared image should be used for all of them.

With a default image, each repository with a configuration shows a `default` row next to the row of each of its configurations (`config`, or the folder name of the configuration). Each row is its own devspace with its own clone: **Start** on `default` creates the devspace of the default image, **Start** on `config` the devspace of the configuration, and both can run at the same time, also each in its own window. The setting `devspaces.startWithDefaultImage` (on by default) puts the `default` row first; off, it is the last row. A double-click or `Enter` on the repository starts its first row and opens its rows to show it: the default image while the setting is on, else the first configuration. A single click on the name of the repository only selects it; the arrow next to it and the arrow keys open and close its rows. A repository that has no Dev Container configuration on its default branch is listed too, as one row (the tooltip says so), and starts from the default image. Without a default image, these repositories are not listed, and no `default` row exists. **Search** and the switcher list the repositories the same way; when a repository has several sources, they ask which one to start. The devspaces of one repository share the named volumes that its configurations mount (for example a volume named after the folder of the repository): two of them that run at the same time write the same volume.

A devspace started from the default image is created from that image alone, as if the configuration of the repository were `{ "image": "<default image>" }`: the `devcontainer.json` of the repository, its Dockerfile, Features, lifecycle commands, mounts, ports and extensions are not read. The metadata of the image (its user, its settings and extensions) applies, as for any image. The repository is cloned into the workspace volume as usual.

A devspace keeps the source it was created from. When you change the default image in the settings, the next start of a devspace built from the old image asks **Rebuild now** or **Later**, as after a change of `devcontainer.json`; **Later** opens the devspace with its current image, and the next start asks again. When you clear the setting, the `default` devspaces that exist keep their row and keep starting from the image they were built from; a repository that has no `default` devspace loses its `default` row until the setting is set again.

### Status bar and switcher

The status bar shows the devspace of the window (`owner/name · branch`), **Open devspace…** in a window without one, `Updating owner/name…` while an operation runs, or **Reconnect owner/name** when the connection was lost. Select it to open the switcher, the progress details, or to reconnect. The devspace of a child row is named with the word of its source, for example `owner/name · default`, in the status bar, the switcher and the messages.

**Switch Devspace…** lists your recent devspaces with their state and, under **Open repository…**, every repository of the list. The selected devspace opens in the current window. **Switch Devspace in New Window…** opens it in a new window. With `devspaces.openInNewWindow` on, the two commands swap their roles.

On macOS, the key of **Switch Devspace…** is `Cmd+Alt+E`. On Windows and Linux, the command has no key, because on many Windows keyboards `Ctrl+Alt+E` is `AltGr+E` and types a character such as `€`. To set a key, open **Keyboard Shortcuts** (`Ctrl+K Ctrl+S`, on macOS `Cmd+K Cmd+S`), search for `Devspaces: Switch Devspace`, select the row, press `Enter`, press your keys, and press `Enter` again. In `keybindings.json`, the ID of the command is `devspaces.switchDevspace`.

## Commands

All commands are in the category **Devspaces** of the Command Palette. A command that acts on one devspace asks which one when you run it from the Command Palette, and a start of a repository with several sources asks which source.

| Command | What it does |
|---|---|
| Start, Start in New Window, Start in Current Window | Start a devspace (see [Actions of a row](#actions-of-a-row)). |
| Stop, Delete, Rebuild, Show on GitHub | The actions of a row. |
| Keep Running When Closed, Stop When Closed | Whether a devspace keeps running when no window uses it. |
| Close and Keep Running | Closes this window; its devspace keeps running this time. Only in a connected window. |
| Switch Devspace… (`Cmd+Alt+E` on macOS), Switch Devspace in New Window…, Switch Devspace in Current Window… | The switcher. |
| Refresh, Search | Update or search the repository list. |
| Expand All | Opens every owner, every group and every repository with several sources of the view. |
| Select Organizations… | Limits the list to some organizations and accounts. Select none to see all again. |
| Show Only Devspaces, Show All Repositories | Lists only the repositories that have a devspace, or all again (the setting `showOnlyDevspaces`). |
| Edit Repository Groups… | Opens the editor of the setting `devspaces.repositoryGroups`. |
| Sign in with GitHub | Signs in with the GitHub account of VS Code. |
| Add GitHub Account… | Adds another GitHub account of VS Code to Devspaces, or signs in with a new one (see [Several GitHub accounts](#several-github-accounts)). |
| Start with Account… | In the context menu of a repository that two or more of your accounts can access: starts it with the account that you select. |
| Show Log | Opens the log of Devspaces. |
| Use a Remote Docker Host…, Use the Local Docker | Choose the Docker engine of Devspaces (see [Remote Docker host](#remote-docker-host)). |
| Update All Images Now | Runs the background work of the Monitor on the current Docker engine at once (see [Updates](#updates)). |
| Remove Devspaces from This Docker Engine… | Removes the Monitor, the helper containers and images, and the shared volumes of Devspaces from the current Docker engine, and, if you agree, the devspaces of your accounts there (see [Uninstall](#uninstall)). |

The buttons of the Docker setup (**Install WSL 2**, **Install Docker**, **Start Docker**) and the host access switches appear only where they apply.

## Settings

All settings have the prefix `devspaces.`. The Settings editor shows them in the order of the table below. Settings marked *user only* count only in your user settings: a workspace or folder setting, which a repository could bring along, cannot change them. In a window whose folder VS Code does not trust (Restricted Mode), Devspaces runs as usual, and all its settings count only in your user settings.

Up to version 0.2.1 the prefix was `devspace.`. Settings with the old prefix are not read any more: rename them to `devspaces.…` in your `settings.json`. The command IDs changed the same way (`devspaces.start` instead of `devspace.start`), so a keybinding with an old ID must be changed too.

| Setting | Default | Description |
|---|---|---|
| `reopenLastOnStartup` | `true` | When VS Code starts with an empty window, open the devspace of the window that you closed last, if that window was connected to a devspace and you did not stop the devspace with **Stop**. When the window that you closed last was not connected to a devspace, nothing is opened, also when devspaces still run. When you quit VS Code while several windows are open, they close at about the same moment, and the window that closes last decides. |
| `openInNewWindow` | `false` | *User only.* On: **Start** and **Switch Devspace…** open a devspace in a new window, and the current window keeps its devspace (an empty window is used directly). The context menu always offers the other choice. |
| `defaultImage` | `""` | *User only.* An image, for example `ghcr.io/majikmate/devcontainer-base:latest`, that every repository can start from next to its Dev Container configuration: each repository with a configuration gets a `default` row, its own devspace, and a repository without a configuration is listed too and starts from the image (see [Default image](#default-image)). Empty: every devspace uses a configuration of the repository, and only repositories with a configuration are listed. A value that is not an image reference is ignored, with a warning. |
| `startWithDefaultImage` | `true` | *User only.* Only with `defaultImage`. On: the `default` row is the first child row of a repository, and a double-click on the repository starts the default image. Off: it is the last one, and a double-click on the repository starts its first configuration. |
| `stopOnClose` | `true` | *User only.* Stop a devspace 5 minutes after its last window closes; the 5 minutes are enough for a window reload. Off: every devspace keeps running until you stop it, and its row shows `· kept`. To keep only some devspaces running, use **Keep Running When Closed** on them. |
| `stopAfterMinutes` | `10` | *User only.* Minutes without any sign from a window before the Monitor stops the container anyway (5 to 1440). This covers a window that cannot say goodbye: the computer sleeps or goes offline, or VS Code crashes. Devspaces that keep running when closed are never stopped. |
| `updateImagesOnConnect` | `true` | At each start, check whether the base image or the Features of the devspace have a newer version, and update the devspace if so (your files stay). Off: the devspace keeps its image until you choose **Rebuild**. |
| `updateContainer` | `notify` | *User only.* What a start does when a newer image is available for the existing container (see [Updates](#updates)). `notify`: says that the container is updated now, with **Continue** or **Cancel**. `ask`: asks, with **Update Now** or **Later**. |
| `cacheUpdateSchedule` | `7 6 * * *` | *User only.* When the Monitor on each Docker engine does its background work (see [Updates](#updates)). A cron expression of five fields (minute, hour, day of month, month, day of week) in your time zone, with at least 5 minutes between two of its times, or the minutes between two runs (5 to 1440). Examples: `7 6 * * *` daily at 06:07, `7 6 * * 1-5` on weekdays at 06:07, `7 */6 * * *` every six hours, `60` every hour. An invalid value means the default, and a warning names it. Times shortly before and after midnight count as close together, also on days that do not follow each other, so `0,58 23,0 * * 1` is refused; then use a simpler schedule. |
| `stopMonitorWhenIdle` | `false` | *User only.* End the Monitor of a Docker engine, local or remote, when no devspace has run for 5 minutes; the next start starts it again. Off: the Monitor of an engine keeps running once you answered the question about it on that engine (see [The background run](#the-background-run)), so its background work and its retries also run while no devspace runs. Until you answer there, it ends when idle. The answer **Stop When Idle** turns this setting on, for all engines; the answer **Keep Running** keeps it off and applies to that engine only. A change applies on each engine at the next start of a devspace or **Update All Images Now** there. Until then, a Monitor that keeps running goes on; **Devspaces: Remove Devspaces from This Docker Engine…** removes it at once. On an engine that several computers use, a permanent Monitor that another computer created stays; the computer that created it replaces it when it turns this setting on, and a computer with the setting off and an answer for that engine makes it permanent again at its next start. |
| `respectShutdownActionNone` | `false` | *User only.* Keep a devspace running after its window closes when its `devcontainer.json` says `"shutdownAction": "none"`. Off: that line is ignored, and `stopOnClose` applies. |
| `owners` | `[]` | Organizations or accounts whose repositories the sidebar lists. Empty: all repositories that you can access. **Select Organizations…** changes it: in the workspace settings when they have a value for it, else in your user settings. |
| `includeArchived` | `false` | List archived repositories. |
| `includeForks` | `true` | List forked repositories. |
| `showOnlyDevspaces` | `false` | List only the repositories that have a devspace, whatever its state. **Show Only Devspaces** and **Show All Repositories** in the title bar switch it: in the workspace settings when they have a value for it, else in your user settings. |
| `refreshIntervalMinutes` | `60` | Minutes between the background updates of the repository list from GitHub. |
| `hostAccessChecksOff` | `[]` | *User only.* Repositories (`owner/name`) whose host access checks are off. Only for repositories that you fully trust (see [Security](#security)). **Turn Off Host Access Checks…** in the context menu of a repository changes it. A change applies when the container is created next, for example with **Rebuild**. |
| `repositoryGroups` | `[]` | *User only.* Regular expressions that filter and group the repositories of each owner by name (see [Repository groups](#repository-groups)). |
| `confirmOpenFromLink` | `true` | *User only.* Ask before a link creates a devspace of a repository of your account or of one of your organizations (see [Open from a link](#open-from-a-link)). **Always Open** in that question turns this off. A repository of another owner is always confirmed, also when this setting is off. |

### Repository groups

Each entry of `devspaces.repositoryGroups` is a regular expression (JavaScript syntax) for the repository name without the owner, or an object with `pattern`, an optional `name`, and optional `flags` (`i`, `u`, `s`). In an owner where at least one repository matches, the view shows only the matching repositories and those with a devspace. Each capturing group becomes a level of the tree, and the last one is the label of the row; the first matching entry wins, and an entry with a `name` gets its own node. For example, `^(\d{4}-[^-]+-[^-]+)-([^-]+-[^-]+)-(.+)$` shows `2026-web-1a-module-html-css` as `2026-web-1a` › `module-html` › `css`. The view runs these regular expressions in a separate thread with a time limit of one second for each entry, so a slow expression cannot stop VS Code. When an entry takes longer than one second for the names of your repositories, for example because of a nested repetition such as `(a+)+`, the view lists the repositories without groups, and a warning names the entry, until you change the setting.

**Devspaces: Edit Repository Groups…** opens an editor for this setting, because the Settings editor of VS Code can only open `settings.json` for it. It shows a preview of the tree for the repositories that the view has loaded, tests a repository name, and marks an expression that takes longer than one second as too slow; such an expression cannot be saved. **Save** replaces only this one value in your user `settings.json`. If the value changed in `settings.json` while the editor was open, the editor asks first: **Load settings.json**, **Save Mine**, or **Cancel**.

## Updates

Devspaces keeps your devspaces current in two places: in the background on each Docker engine, and at each start.

### The background run

A small container on each Docker engine, the **Monitor** (`devspaces-monitor`), does the background work at the times of `devspaces.cacheUpdateSchedule` (by default daily at 06:07 in your time zone). A time that was missed, for example while the engine was off, runs once when the monitor runs again. A run that reaches no server at all, for example right after the computer wakes up and before its Wi-Fi or VPN is back, does not count as a run: the monitor tries it again after 2, 5, 10, 20 and 30 minutes, then every hour, until a run reaches the network, and a shorter schedule still runs at its own times meanwhile. A run that reached at least one server counts, also when single images or downloads failed, so one registry that is down never makes the monitor run again and again. Each run:

1. **Pulls the newer versions of the images that the devspaces on that engine use**, for example `node:20` or `mcr.microsoft.com/devcontainers/base:ubuntu`, and removes the older versions of those images that nothing uses any more. It pulls without a sign-in, so private images are not updated in the background; an image pinned by a digest never changes.
2. **Downloads the newest VS Code server** into a store that all dev containers of the engine share, and links it into the running dev containers, so that a window that VS Code restores after its own update finds its server.
3. **Downloads the VS Code extensions** that the devspaces on that engine used in the last 14 days, also those of other users of the engine: of each extension, the newest release that works with the current VS Code server, or the exact version when the extension is listed as `publisher.name@x.y.z`. A start then installs them without a download.
4. **Cleans up** that store at most once a day.
5. **Prepares the next image of each devspace** whose base image or Features changed: it builds the new image in the background, so that the update at the next start takes seconds. It prepares one devspace at a time, the most recently used first, and stops a prepare after 30 minutes. It uses no token and no credentials, so devspaces with private images or Features, and repositories whose host access checks are off, are not prepared.

The monitor sends `User-Agent: nimblescape-devspaces/<version>` with each request to the update service of VS Code and to the Visual Studio Marketplace.

The first time that you start a devspace on a Docker engine with **Start** or **Rebuild**, or run **Update All Images Now** there, Devspaces asks: "Keep the Devspaces background container running on `<engine>`?"

- **Keep Running** (the default button): the monitor keeps running on that engine, also while VS Code is closed, and Docker starts it again when Docker or the computer restarts. Its background work runs at the scheduled time even when no devspace runs.
- **Stop When Idle**: the monitor ends 5 minutes after the last devspace stopped, and a missed run waits until the next start. This answer turns on the setting `devspaces.stopMonitorWhenIdle`, for all engines.

Devspaces asks once per engine (two windows that start at the same moment can both ask; the last answer counts), and only when you start something: the reopen at startup and a window that VS Code restores never ask. It does not ask while `devspaces.stopMonitorWhenIdle` is on. Until you answer, also when you close the question, the monitor of that engine ends when idle. You can change your answer at any time with the setting. A change applies on each engine at the next start of a devspace or **Update All Images Now** there. Until then, a monitor that keeps running goes on; **Remove Devspaces from This Docker Engine…** removes it at once. On an engine that several computers use, a monitor that keeps running and that another computer created stays; the computer that created it replaces it when it turns the setting on (see [Shared Docker engines](#shared-docker-engines)). After **Remove Devspaces from This Docker Engine…** (see [Uninstall](#uninstall)), Devspaces asks again on that engine.

A monitor that keeps running ends itself after 30 days in which no devspace was used on its engine: no window was connected to a devspace there, no devspace was started, stopped or deleted there, and **Update All Images Now** did not run there. Once it found the 30 days, it starts no scheduled background run until a devspace is used there again. When it ended, Docker does not start it again, and the next start of a devspace there creates it again.

**Devspaces: Update All Images Now** (Command Palette, or the **…** menu of the view) runs the same work at once on the current Docker engine, for example after a new image was pushed. The run starts within a minute, and the command does not wait for it: the message says "The Monitor on `<engine>` updates the images now."

### The update at a start

At each start, Devspaces checks whether the images and Features of the devspace have newer versions. It uses the registry answers of the last background run when they are recent, and asks the registries itself otherwise. Without internet access, it skips the check and starts the devspace with its current image.

When a newer image is available and the devspace has a container, running or stopped, Devspaces says so before it changes anything. The update creates the container again from the new image: your files in the workspace stay, but programs and files that you added outside the workspace, for example in the home folder, are gone. With the default `devspaces.updateContainer` = `notify`, the dialog says, for example:

> A newer image is available for owner/name. To use it, the running container is stopped and created again from the new image. Your files in the workspace are kept; programs and files that you added outside the workspace are not. Choose Continue to update now, or Cancel to leave the devspace closed.

- **Continue** updates the container. **Cancel** ends the start: nothing changes, and the window does not connect.
- With `ask`, the buttons are **Update Now** and **Later**. **Later** opens the current container without the update; the next start asks again.

A first start, a missing image, and **Rebuild** never ask.

After **Continue** or **Update Now**, Devspaces uses the image that the background run prepared when it fits. While the background run still prepares it, the progress shows "Preparing the newer image (3 min)…" and the start waits for it; cancel the progress to stop waiting. Otherwise Devspaces pulls and builds the new image. In every case the new image passes all checks again before the container is created.

If the build of a newer image fails, or the new image needs access to your computer that the checks refuse, the devspace starts with its current container, and a message says so.

## Stop on close

When you close the last window of a devspace, switch to another devspace, or quit VS Code, the Monitor on its Docker engine stops the container 5 minutes later. A window that connects again within that time keeps it running. If the window cannot say goodbye (the computer sleeps or goes offline, or VS Code crashes), the monitor stops the container after `devspaces.stopAfterMinutes` (default 10 minutes) without a sign from any window.

A devspace keeps running when no window uses it in these cases, and its row shows `· kept`:

- **Keep Running When Closed** is on for it. Only **Stop** or **Delete** stops it.
- You closed its window with **Close and Keep Running**. The next window that connects to it ends this.
- `devspaces.stopOnClose` is off.
- `devspaces.respectShutdownActionNone` is on, and its configuration says `"shutdownAction": "none"`.

Work that runs in a container after its window closed, for example a long build in a terminal, ends when the container stops.

## Remote Docker host

Your devspaces can run on Docker on another computer, for example a build server or a stronger machine, reached over SSH. VS Code, Devspaces, and your GitHub sign-in stay on your computer; the containers, volumes, and images are on the other computer. Devspaces keeps its own list of such hosts, and uses one of them, or the local Docker, in all its windows on this computer. It does not create or change a [Docker context](https://docs.docker.com/engine/manage-resources/contexts/) or any setting of Docker, so the `docker` command in your terminals keeps its target. The window of a devspace on the other computer reaches its engine through a Docker pipe of Devspaces on your computer, which the folder URI of the window names: the Dev Containers extension uses it for that window, and Devspaces carries its Docker connections over its own SSH connection. Devspaces sets no `DOCKER_HOST` of your environment and writes no setting of the Dev Containers extension. That window runs the Dev Containers extension with the Docker CLI of Devspaces (see [What to know](#what-to-know)).

### Set up

1. On the other computer, install Docker Engine and let your SSH user use it: add the user to the group `docker`, or use rootless Docker. Your computer needs no Docker: when it has no Docker CLI, Devspaces downloads its own after you choose the host in step 3 (see [What to know](#what-to-know)).
2. You need the SSH address of the host (`user@host` or `user@host:port`, or a host of your SSH config) and a way to log in: a password, or a key. Nothing needs to be set up on your computer: when the login asks a question, Devspaces asks it in VS Code (see [SSH questions](#ssh-questions)).
3. Run **Devspaces: Use a Remote Docker Host…**, or select the first row of the view. Without Docker on your computer, the Docker setup in the view offers **Use a Remote Docker Host…** too. The list shows the hosts that Devspaces used before (**Hosts of Devspaces**), the other hosts of your SSH config (`~/.ssh/config`, on Windows `%USERPROFILE%\.ssh\config`, with its `Include` files), and the SSH hosts of your Docker contexts. **Enter an SSH address…** takes `user@host` or `user@host:port` (an IPv6 address in brackets).
4. Devspaces tests the connection with one SSH login, which may ask for the host key and your password (see [SSH questions](#ssh-questions)), adds the host to its list, and uses it: "Devspaces now uses Docker on `<host>`." After a login with your password, Devspaces offers to log in with a key next time (see [A key for the next logins](#a-key-for-the-next-logins)).
5. **Devspaces: Use the Local Docker** goes back to the Docker of your computer. The host stays in the list.
6. **Remove a Host from the List…** at the end of the list of step 3 removes a host from the list. Its devspaces stay on that computer: add the host again to show them in the sidebar. An open window of such a devspace keeps working. When Devspaces uses that host, it uses the local Docker afterwards.

### SSH questions

When the login to the host asks a question, Devspaces asks it in VS Code, only in a flow that you started: the test of **Use a Remote Docker Host…**, and a command with its progress notification, for example **Start** or **Open**.

- **The host key**, the first time that your computer connects to the host: a dialog shows its fingerprint. Choose **Accept and Connect** only when it is the fingerprint of that host (ask the person who runs the host). `ssh` then keeps the key in your `known_hosts`, as in a terminal. When the host shows another key later, `ssh` refuses the login.
- **Your password**, the passphrase of your key, or a code: an input box at the top of the window, which hides what you type. When the answer was not accepted, the box asks again. Cancel ends the login. **Cancel** of the progress notification closes the box too.
- Devspaces keeps no answer. The work of Devspaces in the background (the states in the view, the builds of its helper image) asks nothing: without a key, it waits for your next command and shows the state as unknown until then. Each window logs in once for each host.
- This needs the OpenSSH client of your computer (Windows 10 and 11, macOS, and Linux bring it). It asks through the program in `SSH_ASKPASS`, which Devspaces sets only for these logins.

### A key for the next logins

After a login with your password, Devspaces asks once: "Log in to `<host>` without a password next time?"

- **Use a Key**: Devspaces creates its own SSH key `~/.ssh/devspaces_ed25519` on your computer (on Windows in `%USERPROFILE%\.ssh`), when it is not there yet, and adds its public key to `~/.ssh/authorized_keys` of your account on the host, on the same login. Then it tests a login with the key. From then on, every login of Devspaces to that host uses this key and needs no password, also the work in the background. Devspaces never writes over another file in `~/.ssh` and never changes your SSH config.
- **Not for This Host**: Devspaces keeps asking for the password on that host and does not offer the key again, until you remove the host from the list and add it again.
- When you close the dialog, Devspaces asks again after the next login with your password.
- The key has no passphrase, so every program of your user on this computer can use it (see [Security](security.md#remote-and-shared-engines)). One key serves all hosts. To remove it from a host, delete the line that ends with `devspaces@<name of your computer>` from `~/.ssh/authorized_keys` there.
- When the key cannot be set up, a warning says why, for example when the SSH server of the host allows no keys. When the test login with the key failed, Devspaces removes the line of the key from `authorized_keys` again. Devspaces then asks again after the next login with your password, unless you choose **Not for This Host** in the warning.

### The WSL distribution of Devspaces (Windows)

On Windows, Devspaces can use Docker Engine in a WSL distribution of its own, named `devspaces`, as a host of its list: without Docker Desktop and without SSH.

- **Set it up**: click **Set Up Docker for Devspaces** in the Docker setup of the view, or run **Devspaces: Set Up Docker for Devspaces in WSL…**. It needs WSL 2.4.4 or later; without WSL, the message offers **Install WSL 2** (Windows asks for administrator permission, and you restart the computer afterwards). One question shows what Devspaces downloads and the folder. Then Devspaces:
  1. downloads the Debian file for WSL from the list of WSL distributions of Microsoft, the list that `wsl --install` uses, and checks it against the SHA-256 in that list;
  2. creates the distribution `devspaces` of WSL 2 for your Windows user with `wsl --install --from-file`, with its virtual disk in `%LOCALAPPDATA%\nimblescape\devspaces\wsl\disk`; this needs no administrator permission;
  3. installs Docker Engine there as root from the package repository of Docker (`download.docker.com`), and turns on systemd, which starts Docker;
  4. restarts the distribution, waits for Docker, and then uses it as the Docker host of Devspaces. On a computer without a Docker CLI, it first downloads the Docker CLI of Devspaces.

  The question shows the size of the Debian file; Docker Engine and the packages that it needs are about 120 MB more. One setup or removal runs at a time, also across your VS Code windows; when another window set up or removed the distribution while your question was open, the command changes nothing and says so. A progress notification shows each step; **Cancel** stops the step that runs (during the creation of the distribution, after that step), and during the installation of Docker Engine it also stops the distribution, so that no command goes on there. When a step fails, the message names it, and **Show details** opens the log, with the last lines of the log of the distribution (`/var/log/devspaces-setup.log`). Run the command again to go on: a distribution that Devspaces set up is set up again without a new download (it asks first, because the restart stops the devspaces that run there).
- **What it changes**: your other WSL distributions and Docker Desktop stay as they are. In the distribution, `/etc/wsl.conf` turns on systemd, makes root the user of `wsl -d devspaces`, does not mount the drives of Windows at the start, and turns off the start of Windows programs. So Docker and your devspaces do not see your Windows files by default. These settings are no wall: root in the distribution can mount the drives of Windows again (see [Security](security.md#remote-and-shared-engines)). The distribution grows with your devspaces, their images and their volumes.
- **A distribution of your own**: a distribution with the name `devspaces` that you made yourself is never changed or removed. Devspaces knows its own distribution by the folder of its virtual disk, which the registry of your Windows user names. When the registry cannot be read, Devspaces neither sets the distribution up again nor removes it, and says so. The setup only offers to use a distribution of your own as it is (**Use It**), when Docker Engine runs there so that `docker info` works as root.
- **Use it**: when the distribution `devspaces` exists on your computer, **Devspaces: Use a Remote Docker Host…** lists it as `wsl:devspaces` in the group **WSL**. Devspaces tests it with `docker info` in the distribution and then uses it as any other host of its list: the same view, the same windows, and the same Docker CLI of Devspaces.
- **No login**: Devspaces starts `wsl.exe` as your Windows user and runs its commands as root of the distribution. There is no password, no key, and no question.
- **When it runs**: WSL starts the distribution for a Start, an Open, or another command of Devspaces there, and for the window of a devspace there. While a window of VS Code is open and a devspace or the Monitor runs there, Devspaces keeps the distribution running. After the last of them stopped, and when Devspaces did not use the distribution for about 10 minutes, WSL stops it, with Docker. The work of Devspaces in the background, for example the refresh of the view, does not start it: the view then shows the devspaces there as stopped, with **Start**. When the list of your devspaces was lost, **Refresh** restores it. Only when you answered **Keep Running** for its Monitor (see [The background run](#the-background-run)) does the work in the background start it, so that the Monitor runs again. After VS Code closes, WSL stops the distribution 15 seconds later, also a devspace there that keeps running when closed, and the Monitor.
- **Remove it**: **Devspaces: Remove the WSL Distribution of Devspaces…** asks first, then deletes the distribution with `wsl --unregister devspaces`, with everything in it: all devspaces there with the changes that you did not push, their images and their volumes. Push your changes first. It also removes the folder of the distribution and the host `wsl:devspaces` from the list; when Devspaces used it, it uses the local Docker again. The rows of the devspaces that were there are not shown while the host is gone; when you set the distribution up again, they show **Files missing**, and **Delete** removes them. It removes only a distribution that Devspaces set up.
- When the distribution is not installed, the message says so. A devspace in the distribution opens only on this computer: on another computer, its window does not open, and the message says that WSL is missing.
- **Remove by hand**: the Docker commands of [Remove by hand](#remove-by-hand) work with `wsl -d devspaces -u root -- docker` in place of `docker`.

### What to know

- The view and the switcher show only the devspaces of the current Docker engine, and the commands of the Command Palette act only on them. Each devspace belongs to the engine where it was created, and a repository gets its own devspace on each engine. Two names of the same computer (an SSH alias and `user@address`) count as two hosts. A window of a devspace that opens again, for example from **Open Recent**, always runs on the engine of its devspace, without a question. So do **Close and Keep Running** and **Reconnect** in the status bar of that window, also while another engine is current.
- Devspaces does not follow your Docker context. When the current Docker context, or `DOCKER_HOST`, reaches a computer over SSH while Devspaces uses the local Docker, Devspaces does nothing with Docker, and the first row of the view shows **Docker is set to `<host>` over SSH**. Devspaces offers once to use that host: **Use `<host>`** adds it to the list and uses it, as **Devspaces: Use a Remote Docker Host…** does. Else set Docker on your computer to its local engine, for example with `docker context use default`.
- A Docker context that points to another computer without SSH (for example `tcp://10.0.0.5:2375`) is not supported: no operation runs there, and the view says so.
- When Devspaces cannot read the current Docker context (the command `docker context inspect` fails) and `DOCKER_HOST` is not set, it does nothing with Docker, because it does not know which computer the Docker commands would reach. The view shows "Docker context cannot be read". Run `docker context inspect` in a terminal to see the problem, or choose **Devspaces: Use a Remote Docker Host…**.
- When the host cannot be reached, the message names the reason: the computer does not answer, the login failed, the host key is unknown, or Docker does not run there. Devspaces never starts or installs Docker on a remote host.
- To stop using a host, run **Devspaces: Remove Devspaces from This Docker Engine…** while it is the current engine, then **Remove a Host from the List…**.
- Published ports are bound to `127.0.0.1` of the other computer. Reach them through the port forwarding of VS Code (the Ports view, `forwardPorts`). `host.docker.internal` exists only with Docker Desktop.
- Rootless Docker on the other computer works. Its limits: no published ports below 1024, Docker-in-Docker needs set-up there, and resource limits need cgroup v2.
- The window of a devspace on another computer connects only while Devspaces runs in that VS Code: its folder URI names the Docker pipe of Devspaces on your computer. Such a URI does not work on another computer, or after you copied it; open the devspace there from the Devspaces view. When the window cannot serve its pipe, it closes its connection and says so.
- **The Docker CLI of Devspaces.** The window of a devspace on another computer runs the Dev Containers extension with a Docker CLI that Devspaces downloads from `download.docker.com` and checks against the size and SHA-256 in its code, so every computer connects with the same tested version, also when the Docker CLI of your computer is older or newer. The first such window downloads it once for each version (between 20 and 90 MB, depending on the system) while it starts, and a notification shows the progress. When the download fails or you cancel it, the window uses the Docker CLI of your computer and says so. Once it is there, Devspaces runs its own Docker calls on the other computer with it too, in every window. On a computer without a Docker CLI, **Use a Remote Docker Host…** downloads it after you choose the host; when that download fails or you cancel it, Devspaces does not change its host. Devspaces then works only with the other computer: **Use the Local Docker** shows the Docker setup again. The Docker tools in your terminals keep their Docker CLI. The log of the window names the CLI that it uses.
- **Use SSH connection sharing.** Devspaces keeps one SSH connection per window and engine for its worker, for the Docker connections of the window of a devspace, and for its own Docker calls while that connection is open. Its checks before that connection opens (the first time in a window, and again after 10 minutes without use) run on the same SSH login, so the open of a window logs in to the host once. Some calls still open a new SSH connection each through the Docker CLI on your computer: a build of the helper image of Devspaces, and the Docker tools in your terminals. SSH servers limit new connections (`MaxStartups`, and in OpenSSH 9.8 and later `PerSourcePenalties`), and a dropped connection fails with a message that the SSH server closed it before the login. Connection sharing avoids this and is much faster:

  ```
  Host build-box
    ControlMaster auto
    ControlPath ~/.ssh/cm-%C
    ControlPersist 10m
  ```

  Connection sharing needs Unix sockets and does not work with the OpenSSH client of Windows. There, raise `MaxStartups` in `/etc/ssh/sshd_config` of the other computer (for example `MaxStartups 30:30:100`) if connections drop.

## Shared Docker engines

Several people, each with their own computer, can use the same remote Docker engine. Each devspace belongs to the GitHub account that created it, and the Monitor on the engine decides by the newest sign of any computer: closing a window on one computer never stops a devspace that a window on another computer still uses.

The engine has one Monitor for all computers, and each computer asks the question about it for itself (see [The background run](#the-background-run)). An older version of Devspaces on another computer that uses the engine does not ask: it still starts a Monitor that keeps running, until that computer is updated. **Remove Devspaces from This Docker Engine…** says when other computers use Devspaces on the engine. It deletes only the devspaces of your GitHub accounts in Devspaces; the devspaces of other accounts and of other computers stay. It removes the Monitor and the helper containers of all computers, so an operation of another computer that runs at that time can fail. The next work of that computer on the engine creates them again.

**A shared engine is for a group that trusts each other.** Everyone who can use Docker on that engine (root and the members of the group `docker` there) can reach every container and every volume on it, including the GitHub token in the memory of another person's running devspace. Devspaces separates accounts against mistakes, not against the other users of the engine. For people who must not see each other's work, give each person an engine of their own, for example a virtual machine.

## Installing Docker

When Docker is not installed, the view shows the steps to set it up instead of the repositories, each with its button:

1. On Windows: **Install WSL 2** (`wsl --install`; restart the computer afterwards). Once WSL 2 is ready, the view shows "✓ WSL 2 is installed."
2. On Windows: **Set Up Docker for Devspaces** creates the WSL distribution of Devspaces with Docker Engine, without Docker Desktop and without administrator permission (see [The WSL distribution of Devspaces](#the-wsl-distribution-of-devspaces-windows)). Or install Docker Desktop with **Install Docker** below.
3. **Install Docker**:
   - macOS: with Homebrew, `brew install --cask docker-desktop`. If the terminal shows "Operation not permitted" from `xattr`, allow VS Code in System Settings › Privacy & Security › App Management and install again. Without Homebrew, `Docker.dmg` is downloaded from Docker and opens; drag Docker to Applications.
   - Windows: with winget, `winget install --exact --id Docker.DockerDesktop`; without winget, `Docker Desktop Installer.exe` is downloaded from Docker and starts. The installer of Docker Desktop installs it for your user by default, in `%LOCALAPPDATA%\Programs\DockerDesktop`; an installation for all users goes to `C:\Program Files\Docker\Docker`. Devspaces finds Docker in both folders, also when VS Code, or the browser that opens a link of Devspaces, started before the installation and does not know the new PATH yet.
   - Linux (Ubuntu, Debian, Fedora, RHEL, CentOS): Docker Engine from the package repository of Docker, and your user joins the group `docker` (sign in again afterwards). On other distributions, the installation guide of Docker opens.
4. Docker starts by itself when a devspace needs it. Right after the installation, a notification also offers **Start Docker**. On Linux, **Start Docker** runs `sudo systemctl enable --now docker` in a terminal.

Instead of an installation, the last step of the view, **Use a Remote Docker Host…**, uses Docker on another computer that you reach over SSH; your computer then needs no Docker (see [Remote Docker host](#remote-docker-host)).

Nothing runs without your confirmation: a dialog first lists the exact commands, or the download address and the file. Commands run visibly in a terminal of VS Code, where you enter your password if one is needed. Downloads come only from Docker over HTTPS, and the installers are signed by Docker. The setup of the WSL distribution of Devspaces is the exception: its dialog names the downloads and the folder, and its steps run without a terminal, with a progress notification and the log. If Docker is installed already, nothing is installed. The installation works only in a local window. Docker Desktop is free for personal use, education, non-commercial open source projects, and small businesses; larger companies need a paid subscription.

## Security

**A repository that you open is code that you run.** Its Dockerfile, its Features, its lifecycle commands, and the extensions in its container run with the rights of the container: they can use the network, attack the kernel that all containers share, use the channels that VS Code keeps open to your computer (for example the SSH agent and the clipboard), and use the GitHub token of the devspace. Open only repositories that you trust.

What Devspaces does to limit the harm:

- Each devspace runs in containers of its own, with the repository in a Docker volume. Devspaces mounts no file or folder of your computer into the container.
- **Host access checks**, on for every repository, refuse configurations that ask for access to your computer: bind mounts (also of the Docker socket), privileged mode, extra capabilities, devices and GPUs, the namespaces of the computer, ports on all network addresses, and the volumes of other programs. Published ports are bound to `127.0.0.1`. For a repository that you fully trust, **Turn Off Host Access Checks…** lifts these refusals after a warning; the row then shows `host access unrestricted`.
- Some things are refused whatever the switch says, for example the volumes and containers of other devspaces and the folder of the token.
- The GitHub token is never in an environment variable, on a command line, or in a log. It is kept only in the memory of the running dev container, at `/run/devspace`, and is gone when the container stops.
- Git and the GitHub CLI in the container use only the configuration of the devspace and the token of the account that owns it. Devspaces switches off the copy of your Git configuration, the forwarding of your Git and Docker credentials, and the sign-in of the GitHub CLI by the Dev Containers extension for its containers.

The checks are a guard rail against mistakes and copied templates, not a sandbox. The full security model, the complete lists, the known limits, and the steps to harden your computer are in [security.md](security.md).

**Privacy.** Devspaces uses the GitHub sign-in of VS Code and stores no token in its settings or files. Its stored lists hold metadata only, for example repository names, branch names, image names, and the GitHub account of each devspace. It collects no telemetry.

## Known limits

- The first start of a repository needs internet access, to download the repository and the images.
- The repository is in a Docker volume, not in a folder of your computer. Other programs on your computer cannot open its files directly, and configurations that mount files of the repository from your computer (`${localWorkspaceFolder}`) do not work.
- Only the volume with the repository, and additional named volumes of the configuration (`mounts`), survive an update or a rebuild. Files in other folders of the container, for example the home folder, are lost. When Devspaces itself needs to create a container again, the progress says so. When a container is damaged so that it cannot start (for example its `/etc/passwd` lacks the user), **Start** asks whether to create it again and names what is lost.
- Values of `${localEnv:…}` variables of your computer are not passed to the devspace.
- Each GitHub account has its own devspace of a repository, with its own clone. A configuration with a fixed volume name works for one account only; use `${devcontainerId}` in the name to give each devspace its own volume.
- In one devspace, Git works as one GitHub account, the account of the devspace. A push to a repository that only another of your accounts may change fails there.
- With several GitHub accounts, an organization repository that two accounts can see is read for each account at the first load of its list. Later updates read only the repositories that changed.
- Docker Compose configurations start the dev container together with the other services, for example a database. The same checks apply to every service. A service that mounts files of the repository (for example `./init.sql`) gets them from the volume of the devspace (Docker Engine 26 or newer). Remote `include` and `extends` of compose files do not work.
- With **Select Organizations…**, GitHub is asked only about the selected owners. Your devspaces of other owners stay in the list, but Devspaces does not check whether their repositories are still on GitHub.
- Git in the container older than version 2.32 reads the configuration of the devspace only through `~/.gitconfig`. When the image brings a `~/.gitconfig` with content, Git older than 2.31 gets no credential for github.com. Git older than 2.9 may use the credentials of your computer; Devspaces warns about it.
- On Linux with Docker Engine, Devspaces cannot start the Docker service itself, because that needs administrator rights. **Start Docker** runs the command in a terminal; in a remote window, the message names the command instead.

## Troubleshooting

- **The log.** **Devspaces: Show Log** opens the complete log of Devspaces, including the output of the clone, the build, and the lifecycle commands. Every progress notification of Devspaces has **Show details** for the same log. **Show details** also hides the notification: the operation goes on, the status bar shows its progress, and the notification stays in the notification center (the bell in the status bar) with its **Cancel** button.
- **The Monitor.** Its log shows each stop, each background run, and each prepare: `docker logs devspaces-monitor` on the engine, or from your computer `docker -H ssh://<host> logs devspaces-monitor`. Docker keeps at most 2 × 1 MB of it.
- **A devspace stops too early or keeps running.** Check its row for `· kept`, and the settings `stopOnClose`, `stopAfterMinutes`, and `respectShutdownActionNone`. If the window warns that its heartbeats failed, the Monitor may stop the devspace after `stopAfterMinutes`.
- **GitHub limits the requests.** When GitHub refuses the requests of your account for a while (its rate limit), the view keeps the repositories that it shows, and a message says at what time Devspaces loads the list again. It tries once at that time; after that, use **Refresh**.
- **`State unknown`.** Devspaces could not read the engine. On a remote host that you log in to without a key, the work in the background asks no password, so the state stays unknown until your next command logs in (see [SSH questions](#ssh-questions)); **Use a Key** after that login ends this (see [A key for the next logins](#a-key-for-the-next-logins)). Otherwise check that `ssh <host>` works and that Docker runs there. After the images of an engine were removed, Devspaces prepares the engine again in the background; the status bar shows "Devspaces: preparing `<host>`…".
- **Report a problem.** Open an issue on GitHub. [SUPPORT.md](../SUPPORT.md) says what to include.

## Uninstall

Devspaces keeps a few things on each Docker engine that you used: the Monitor (`devspaces-monitor`), its helper containers and images, and three volumes that all devspaces of the engine share. Remove them before you uninstall the extension. On each Docker engine:

1. Push the changes that you want to keep from each devspace there.
2. Close the windows of your devspaces there. The command does not run while a window on this computer is connected to a devspace on the engine or is opening one, or while an operation runs, also **Update All Images Now** in the same window. When that changes while it asks, it removes nothing after your answer.
3. Make the engine current with **Devspaces: Use the Local Docker** or **Devspaces: Use a Remote Docker Host…**. The first row of the view names it.
4. Run **Devspaces: Remove Devspaces from This Docker Engine…** (Command Palette, or the **…** menu of the view). It removes: the container `devspaces-monitor`, the helper containers, the helper images `devspaces-worker:<hash>` with their second tag `devspaces-monitor:<hash>`, and the volumes `devspaces-monitor`, `devspaces-worker-cache` and `devspaces-vscode`. In the question "Remove Devspaces from `<engine>`?", choose **Remove**.
5. When you have devspaces there, a second question asks "Also delete your devspace on `<engine>`?" (with several devspaces, for example "Also delete your 2 devspaces on `<engine>`?") and shows their recorded changes. **Delete Devspaces Too** deletes each one as **Delete** does, with its containers, its images and its volumes, also the clone of the repository, before the rest is removed. A volume that another devspace also uses stays, and so does a devspace that a window connects to in the meantime. **Keep Devspaces** keeps them, and the volume `devspaces-vscode` then stays while they use it. If you close the question, nothing is removed.

On Windows, when you set up the WSL distribution of Devspaces, run **Devspaces: Remove the WSL Distribution of Devspaces…** after these steps. It deletes the distribution with its Docker engine and its folder (see [The WSL distribution of Devspaces](#the-wsl-distribution-of-devspaces-windows)). Without the extension, `wsl --unregister devspaces` in a terminal deletes it; then remove the folder `%LOCALAPPDATA%\nimblescape\devspaces\wsl`.

Then uninstall Devspaces in the Extensions view of VS Code, or run `code --uninstall-extension nimblescape.nimblescape-devspaces-2`.

What to know:

- The command never starts Docker; only the WSL distribution of Devspaces starts, because WSL starts it for every use. When the engine does not answer, it removes nothing and says so.
- While it removes Devspaces, a Start, a Rebuild, a Stop, a Delete or **Update All Images Now** on that engine in another window is refused with the message "Devspaces is being removed from `<engine>` in another window. Try again after that." An **Update All Images Now** that waits for Docker to start when the removal begins sends no request either. **Refresh** still updates the view, but it does not restore lost records of Devspaces from the volumes there, in any window, and says so. When that window was closed or crashed during the removal, the next Start runs.
- It deletes only the devspaces of your GitHub accounts in Devspaces, and with several accounts the second question names them. The devspaces of other accounts and of other computers stay, and the first question says so. Without a sign-in, your devspaces stay too.
- After the removal, this computer does no Docker work on the engine by itself, also not when VS Code starts, until you start or rebuild a devspace there or run **Update All Images Now**. That sets up the engine again and asks again about the Monitor. Until then, the devspaces that you kept there show `State unknown (Devspaces removed from Docker)`, or on a remote host `State unknown (Devspaces removed from <host>)`, and the reopen at startup does not open them. A window of one of them, for example from **Open Recent** or attached by hand with Dev Containers, stays connected while its GitHub account is signed in to Devspaces, and works without Devspaces, so you can still save your changes: nothing is updated in the background, and the container does not stop when you close the window. A message says so. A Start of that devspace in another window shows this window, and a Start in this window sets Devspaces up again and connects this window. A container that runs is never replaced under the window: one of an older version stays as it is, and the window closes its connection, so that a Start from the empty window makes a new one.
- **Stop** and **Delete** of a devspace that you kept there still work, and so does **Refresh** when the records of Devspaces on your computer were lost (it restores them from the volumes there): they build the helper image and create the volumes `devspaces-monitor` and `devspaces-vscode` there again, but they do not start the Monitor, nothing runs there by itself afterwards, and running the command again removes them again.
- A build of the helper image that another VS Code window began in the background before the removal, for example right after an update of Devspaces, goes on and can make the image `devspaces-worker:<hash>` there again. When `docker image ls` still lists it after the removal, run the command again.
- An **Update All Images Now** in another VS Code window that is already sending its request when the removal begins goes on, and can create the container `devspaces-monitor`, the helper image and the volumes there again. When `docker ps -a` still lists `devspaces-monitor` after the removal, run the command again.
- When something cannot be removed, for example a volume that a container still uses, the message says so. The log of Devspaces (**Devspaces: Show Log**) names each item and the command that removes it.
- Your settings and the files of Devspaces on your computer stay (see below).

### Remove by hand

These Docker commands remove the same without the extension, in a shell such as bash, zsh or PowerShell. For a remote engine, write `docker -H ssh://<host>` for each `docker`, or set `DOCKER_HOST=ssh://<host>` in the shell first (in PowerShell `$env:DOCKER_HOST = 'ssh://<host>'`). A command with an empty list stops with "requires at least 1 argument": there is nothing of that kind. A volume that does not exist gives an error for that volume only.

1. First the Monitor and the helper containers, so that nothing of Devspaces works on the engine while you remove the rest, and no helper container uses a volume of a devspace:

   ```sh
   docker rm -f $(docker ps -aq --filter label=nimblescape.devspaces.monitor)
   docker rm -f $(docker ps -aq --filter label=nimblescape.devspaces.worker-run)
   ```

2. Only if you want to delete the devspaces too: their containers, volumes, images and Docker Compose networks. These commands delete every devspace on the engine, also those of other accounts and other computers, with the clones of the repositories. Push your changes first.

   ```sh
   docker rm -f $(docker ps -aq --filter label=nimblescape.devspaces.id)
   docker volume rm $(docker volume ls -q --filter label=nimblescape.devspaces.id)
   docker image prune -a -f --filter label=nimblescape.devspaces.id
   docker network prune -f --filter label=nimblescape.devspaces.id
   ```

   Images that the devspaces were built from, for example `node:20`, stay; `docker image ls` lists them.

3. The rest that Devspaces keeps on the engine: the helper images and the shared volumes. The volume `devspaces-vscode` cannot be removed while a container of a devspace uses it.

   ```sh
   docker image prune -a -f --filter label=nimblescape.devspaces.worker
   docker volume rm devspaces-monitor devspaces-worker-cache devspaces-vscode
   ```

The objects of version 0.4.0 and older have other names: see [Update from version 0.4.0 or older](#update-from-version-040-or-older).

### Docker contexts and your computer

- **Docker contexts.** Devspaces creates no Docker context, so there is none to remove.
- **Files.** Devspaces keeps its records, also the list of remote hosts (`remote-docker.json`), in a folder of VS Code: `~/.config/Code/User/globalStorage/nimblescape.nimblescape-devspaces-2` on Linux, `~/Library/Application Support/Code/User/globalStorage/nimblescape.nimblescape-devspaces-2` on macOS, and `%APPDATA%\Code\User\globalStorage\nimblescape.nimblescape-devspaces-2` on Windows. For VS Code Insiders, the folder `Code - Insiders` takes the place of `Code`. You can delete this folder after the uninstall.
- **Settings.** The settings `devspaces.…` stay in your `settings.json` until you remove them.

## Build from source

The commands to build, test, and package Devspaces, and the release, are in [CONTRIBUTING.md](../CONTRIBUTING.md).

How Devspaces works inside is described in [architecture.md](architecture.md).

© 2026 Hannes Stauss (scalarion@nimblescape.com) · [MIT License](../LICENSE).
