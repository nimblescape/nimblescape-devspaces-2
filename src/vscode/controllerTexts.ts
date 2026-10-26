// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// User-visible texts of the controller that messages.ts lacks (plain language); to be moved there.
// No `vscode` import.

export const ControllerTexts = {
  // Progress titles (one notification per operation).
  stopping: (repository: string) => `Stopping ${repository}…`,
  // When the Stop has ended.
  stopped: (repository: string) => `${repository} stopped.`,
  // A Start in the window of the devspace whose container could not be read.
  containerStateUnreadable: (repository: string) => `The state of the container of ${repository} could not be read. Details are in the log.`,
  deleting: (repository: string) => `Deleting the devspace of ${repository}…`,
  rebuilding: (repository: string) => `Rebuilding ${repository}…`,
  checkingChanges: (repository: string) => `Checking ${repository} for changes…`,
  waitingForOtherWindow: (repository: string) => `Waiting until another window has finished changing ${repository}…`,
  // Messages.
  alreadyConnected: (repository: string) => `This window is connected to ${repository}.`,
  // Keep Running When Closed and Stop When Closed.
  keptRunning: (repository: string) =>
    `${repository} keeps running when no window uses it. Stop it yourself when you no longer need it.`,
  stopsWhenClosed: (repository: string) => `${repository} stops when no window uses it.`,
  keepAllRunning: 'The setting "Stop On Close" is off, so all devspaces keep running when no window uses them.',
  // Close and Keep Running.
  closeAndKeepRunningNotConnected: 'This window is not connected to a devspace.',
  // "Update All Images Now" (`engine`: describeDockerHost).
  requestingImageUpdate: (engine: string) => `Asking the Monitor on ${engine} to update the images…`,
  imagesUpdatingNow: (engine: string) => `The Monitor on ${engine} updates the images now.`,
  /** No request: a removal of Devspaces from the engine began and ended after the question about the Monitor. */
  removedInTheMeantime: (engine: string) =>
    `Devspaces was removed from ${engine} in the meantime. No request was sent. Run "Update All Images Now" again to set up Devspaces there again.`,
  /**
   * The question about the Monitor of an engine (monitorQuestion.ts), once per engine before the first Monitor there
   * that would keep running (`engine`: describeDockerHost). "Keep Running" is the first and default button.
   */
  monitorQuestion: (engine: string) => `Keep the Devspaces background container running on ${engine}?`,
  monitorQuestionDetail:
    'The container devspaces-monitor updates the images of your devspaces, the VS Code Server and your extensions, by default once a day. ' +
    'When the base image or the Features of a devspace changed, it also builds the next image of that devspace, so that the update at the next start is fast. ' +
    'If you keep it running, it also runs while VS Code is closed, and Docker starts it again after a restart. ' +
    'It ends itself after 30 days in which no devspace was used on this Docker engine. ' +
    'If it stops when idle, it ends 5 minutes after the last devspace stops, and this work runs only while a devspace runs. ' +
    'Keep Running applies to this Docker engine only. If you choose Stop When Idle, this applies to all Docker engines, each from the next start of a devspace or "Update All Images Now" there. ' +
    'You can change your answer with the setting "Devspaces: Stop Monitor When Idle". ' +
    'The command "Devspaces: Remove Devspaces from This Docker Engine…" removes the container.',
  keepMonitorRunning: 'Keep Running',
  stopMonitorWhenIdle: 'Stop When Idle',
  /** The answer to the question about the Monitor could not be stored (the log names the cause). */
  monitorAnswerNotSaved: 'Your answer about the background container could not be saved. Details are in the log.',
  // "Remove Devspaces from This Docker Engine…" (`engine`: describeDockerHost).
  removeLooking: (engine: string) => `Looking for Devspaces on ${engine}…`,
  removeEngineNotAnswering: (engine: string) => `Devspaces cannot reach ${engine}. Nothing was removed. Start Docker there, then try again.`,
  removeListFailed: (engine: string) => `Devspaces could not list what it has on ${engine}. Nothing was removed. Details are in the log.`,
  removeCloseWindowsFirst: (engine: string, repositories: string) =>
    `Close the windows of your devspaces on ${engine} first: ${repositories}. Nothing was removed.`,
  /** A window is opening a devspace there (its pending connection file), and no window is connected to it yet. */
  removeWhileOpening: (engine: string, repositories: string) => `A devspace is being opened on ${engine}: ${repositories}. Try again after that. Nothing was removed.`,
  /**
   * `operation`: the operation that runs, for example Rebuild, on a devspace of `repository`; without `repository`, a
   * request of "Update All Images Now" in this window.
   */
  removeWhileOperation: (operation: string, repository?: string) =>
    `${repository !== undefined ? `${operation} of ${repository}` : operation} is still running. Try again after it ends. Nothing was removed.`,
  /** An operation of this window while Devspaces is being removed from an engine. */
  removalRunning: (engine: string) => `Devspaces is being removed from ${engine}. Try again after that.`,
  /**
   * A Start, a Rebuild, "Update All Images Now" or a second removal while another window removes Devspaces from the
   * engine.
   */
  removalRunningElsewhere: (engine: string) => `Devspaces is being removed from ${engine} in another window. Try again after that.`,
  removeNothingFound: (engine: string) => `Devspaces has nothing on ${engine} to remove.`,
  removeQuestion: (engine: string) => `Remove Devspaces from ${engine}?`,
  removeDetail:
    'This removes the container devspaces-monitor, the helper containers and helper images of Devspaces, and the volumes devspaces-monitor, devspaces-worker-cache and devspaces-vscode. ' +
    'Your settings and the files on this computer stay. The next Start on this engine creates them again.',
  /** The engine has devspaces that this computer does not know (EngineInventory.unknownDevspaces). */
  removeUnknownDevspaces:
    'This engine also has devspaces that this computer does not know, for example from other computers. They stay, but operations that run for them now can fail.',
  /** The engine has a Monitor that another computer keeps running, and no devspace that this computer does not know. */
  removeOtherComputer: 'Another computer also uses Devspaces on this engine. Its operations that run now can fail.',
  removeOtherAccounts: (repositories: string) => `The devspaces of other GitHub accounts stay: ${repositories}.`,
  removeSignedOut: 'Your devspaces on this engine stay. To delete them too, sign in with GitHub first.',
  remove: 'Remove',
  removeDevspacesQuestion: (count: number, engine: string) =>
    `Also delete your ${count === 1 ? 'devspace' : `${count} devspaces`} on ${engine}?`,
  /** `changes`: the recorded changes of the devspaces (recordedChanges), or "none". */
  removeDevspacesDetail: (changes: string) =>
    'Each one is deleted with its container and all its volumes, also the clone of the repository. Changes that you did not push are lost. ' +
    `Recorded changes: ${changes}. If you keep the devspaces, the volume devspaces-vscode stays while they use it.`,
  /** In the recorded changes: a devspace without a recorded Git state. */
  changesNotRecorded: 'not recorded',
  noChanges: 'none',
  deleteDevspacesToo: 'Delete Devspaces Too',
  keepDevspaces: 'Keep Devspaces',
  removing: (engine: string) => `Removing Devspaces from ${engine}…`,
  /** The progress detail: `item` is, for example, "the container devspaces-monitor". */
  removingItem: (item: string) => `Removing ${item}.`,
  removedFromEngine: (engine: string) => `Devspaces was removed from ${engine}.`,
  /** After removedFromEngine, when devspaces stay on the engine. */
  vscodeVolumeKept: 'The volume devspaces-vscode stays because devspaces still use it.',
  removalLeftItems: (count: number, engine: string) =>
    `${count} ${count === 1 ? 'item' : 'items'} of Devspaces could not be removed from ${engine}. The log names each one and the command to remove it.`,
  removalEnded: (engine: string) =>
    `The removal from ${engine} stopped before the end. The log names the commands that remove the rest.`,
  /** After the last message of the removal, when it stopped waiting for a background build (HELPER_BUILDS_STOP_WAIT_MS). */
  helperBuildNotWaitedFor:
    'The removal did not wait for the end of a background build of the helper image in this window; if that build makes the image again, run the command again.',
  /** After the last message of the removal, when the removal mark could not be written (docker-engines.json). */
  removalNotRecorded: (engine: string) =>
    `This computer could not record the removal, so its background work may set Devspaces up on ${engine} again.`,
  /** A window of a devspace that the user kept on an engine with the removal mark (Controller.workWithoutDevspaces). */
  windowOnRemovedEngine: (engine: string) =>
    `Devspaces was removed from ${engine}, so this window works without it: no background updates and no stop on close. A Start of this devspace sets Devspaces up again there.`,
  // On every engine; for the local Docker (host '') the Monitor there is named.
  closeAndKeepRunningUnreachable: (host: string, minutes: number) =>
    `${host === '' ? 'The Monitor of the local Docker' : `The Docker host ${host}`} cannot be reached. The container would stop after ${minutes} ${minutes === 1 ? 'minute' : 'minutes'} without contact. The window stays open.`,
  /**
   * Keep Running When Closed or Stop When Closed was stored, but the Monitor of the engine could not be told at
   * once (the windows that use the devspace tell it at their next heartbeat).
   */
  keepRunningNotSent: (repository: string) =>
    `The Monitor on the Docker engine of ${repository} could not be told about this choice yet (see the Devspaces output). While no window uses ${repository}, it follows its earlier choice.`,
  // Stop, Rebuild, and Delete of a devspace that another window uses: that window closes its connection first.
  otherWindowClosesConnection: (repository: string) =>
    `${repository} is open in another window. That window closes its connection first.`,
  /**
   * The window status files could not be read, so it is not known whether another window uses the devspace; the
   * operation is refused.
   */
  otherWindowsUnknown:
    'It could not be checked whether another window uses this devspace: the window status files could not be read. Nothing was changed; see the Devspaces output.',
  /**
   * The pending connection files could not be read, so it is not known whether a window opens a devspace: the removal
   * from an engine does not start, or does not delete that devspace.
   */
  connectingWindowsUnknown:
    'It could not be checked whether a window is opening a devspace: the pending connection files could not be read. Nothing was changed; see the Devspaces output.',
  /** A pending operation (a Stop, Rebuild or Delete handed over by a window) could not be read. */
  pendingOperationsUnreadable: (cause: string) =>
    `A pending operation could not be read and was not run (${cause}). Run it again if it is still needed; see the Devspaces output.`,
  otherWindowContinues: (repository: string) =>
    `The other window of ${repository} closes its connection. The operation continues in that window.`,
  otherWindowNoAnswer: (repository: string) =>
    `The other window of ${repository} did not close its connection. Nothing was changed.`,
  alreadyDeleting: (repository: string) => `The devspace of ${repository} is being deleted in another window.`,
  // Accounts. A named devspace of another account: Messages.otherAccount.
  signedOutConnection: (repository: string) =>
    `Nobody is signed in to GitHub. This window closes its connection to the devspace of ${repository}. Sign in with GitHub to use it again.`,
  /**
   * The window of a devspace container on an engine with the removal mark, after the registry lost its content: the
   * labels of the container do not say which account owns it (Controller.leaveUnknownOwner).
   */
  unknownOwnerConnection: (containerName: string) =>
    `Devspaces cannot tell which GitHub account owns the container ${containerName}. This window closes its connection to it.`,
  /** The window kept its connection after it left a devspace that it must not use (for example Cancel on unsaved files). */
  stillConnected: (repository: string) =>
    `This window is still connected to the devspace of ${repository}, which it must not use. Save your files: the window closes its connection again.`,
  /** A container of an older version lacks the current setup. */
  outdatedContainerClosed: (repository: string) =>
    `The container of ${repository} was made by an older version of Devspaces and cannot be used. This window closes its connection. Start ${repository} again to make a new container.`,
  /**
   * A container that was made while the host access checks of the repository were off, and they are on now.
   */
  unrestrictedContainerClosed: (repository: string) =>
    `The container of ${repository} was made while the host access checks were off. They are on now, so it cannot be used. This window closes its connection. Start ${repository} again to make a new container with the checks.`,
  noDevspaces: 'There is no devspace yet. Start a repository to create one.',
  noRepositories: 'No repository is available. Sign in with GitHub, or refresh the list.',
  // A link to Devspaces (links.ts), for example on a website.
  invalidLink: 'Devspaces cannot open this link. A link to Devspaces ends with /open?repository=owner/name, with the name of a GitHub repository.',
  linkRepositoryNotFound: (repository: string) =>
    `GitHub does not show the repository ${repository} to your GitHub account. Check the link, or sign in with an account that can access the repository.`,
  linkRepositoryUnknown: (repository: string) => `GitHub could not be asked for the repository ${repository}. Open the link again later.`,
  /** The modal question before a link creates a devspace of the account or of one of its organizations (button Open). */
  linkStartConfirm: (repository: string) =>
    `Open ${repository} from a link? Devspaces creates a devspace for it: it clones the repository and runs code from it (Dockerfile, Features, and commands) on your Docker engine.`,
  // Buttons.
  stop: 'Stop',
  /** The one button of the modal message stillConnected: the window closes its connection after it. */
  closeConnection: 'Close Connection',
  // Quick Picks.
  selectDevspaceToStop: 'Select a devspace to stop',
  selectDevspaceToKeepRunning: 'Select a devspace to keep running when closed',
  selectDevspaceToStopWhenClosed: 'Select a devspace to stop when closed',
  selectDevspaceToDelete: 'Select a devspace to delete',
  selectDevspaceToRebuild: 'Select a devspace to rebuild',
  selectRepositoryForGitHub: 'Select a repository to show on GitHub',
  /** The Quick Pick of the source of a repository with several sources (sourceChoices), after a pick of the repository. */
  selectSourceTitle: 'Select Source',
  sourcePlaceholder: (repository: string) => `Select what ${repository} starts from`,
  /** The marker of a source whose devspace exists (sourceChoices). */
  devspaceExists: 'devspace exists',
} as const;
