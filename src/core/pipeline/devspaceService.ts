// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Devspace service: the open pipeline and the operations on devspaces. It works without VS Code and never
// connects a window; the VS Code layer connects the window with the result of `open`. Each step checks the current
// state first and does nothing when its result exists, so the pipeline can run again at any time.
import * as path from 'path';
import { deleteCheck, type DeleteDecision, type RemovableVolumes } from './deleteCheck';
import { otherWindowMayUseDevspace, otherWindowUsesDevspace, sleepGraceOfWindow, statusNamesDevspace, WINDOW_STATUS_SLACK_MS } from '../busy';
import type { ContainerInfo, ImageInfo, NetworkInfo, VolumeInfo } from '../docker/dockerObjects';
import { isValidToken, redact } from '../helperChannel/protocol';
import { runScript, scriptCommand } from '../worker/containerScripts';
import { mountsVscodeStore, vscodeServerLinkOutcome, vscodeServerPresent } from '../worker/vscodeServerLink';
import { vscodeExtensionSeedOutcome } from '../worker/vscodeExtensionSeed';
import { configurationExtensions, type ExtensionRef } from '../vscodeExtensions';
import type { VscodePlatform, VscodeServerLink } from '../helperChannel/protocol';
import { isDevContainer } from '../worker/dockerEngine';
import { VIEWER_TIMEOUT_MS } from '../worker/hostSide';
import {
  dockerHostField,
  dockerHostOf,
  devspacesOfHost,
  isOnDockerHost,
} from '../docker/dockerHost';
import {
  DevspaceLockError,
  holdsDevspaceLock,
  runWithDevspaceLock,
  type HeldDevspaceLock,
} from '../docker/devspaceLock';
import {
  BatchHelperUnavailableError,
  UserFacingError,
  errorMessage,
  isBatchHelperUnavailable,
  isSessionMonitorFailed,
  isUserFacingError,
} from '../errors';
import {
  MAX_SERVICE_FOLDERS,
  boundServiceFolders,
  parseExistingPaths,
  isNumericId,
  serviceFolderPaths,
  servicePathArguments,
  type DevMountPaths,
  type ServiceFolders,
} from '../git/gitSummary';
import { MAX_CONFIG_TEXT_LENGTH, MAX_IMAGE_ID_REFERENCES } from '../helper/analysisLimits';
import { composeVolumeNames, type ComposeModel } from '../helper/composeModel';
import {
  COMPOSE_DEV_DOCKERFILE,
  COMPOSE_MODEL_PATH,
  builtServiceImages,
  composeBuildModel,
  composeConfigHash,
  composeInputsHash,
  composeModelLimit,
  composeNetworkReferences,
  composeServiceImageReferences,
  composeServiceVolumeNames,
  composeUpModel,
  composeUserArgs,
  composeDevServiceBaseImages,
  composeOtherServiceImages,
  composeServiceImage,
  resolveComposeFiles,
  type ComposeBuildModelRewrite,
  type ComposeModelOutput,
  type ComposeRewriteParams,
} from '../helper/compose';
import { devspaceDevcontainerId, helperCliVariables } from '../helper/cliVariables';
import { checkConfiguration, type ConfigurationProblems } from '../helper/configChecks';
import {
  ANALYSIS_FAILED_ITEM,
  analysisFailureItem,
  type AnalysisFailure,
  type AnalysisJob,
  type AnalysisResult,
  type AnalysisResults,
} from '../helper/configurationAnalysis';
import {
  containerGitSupport,
  gitIdentity,
  isGitHubLogin,
  type GitIdentity,
} from '../helper/containerGit';
import { tokenLogin, tokenRunMessage } from '../helper/containerToken';
import { currentBatchScope, runWithBatchScope } from '../helper/batchScope';
import {
  DevcontainerCommandError,
  buildComposeOverrideConfig,
  buildOverrideConfig,
  composeConfigOverride,
} from '../helper/devcontainerCli';
import { findLocalEnvNames, helperEnvNames } from '../helper/localEnv';
import type { HelperImageUse } from '../helper/helperImage';
import type { HelperFiles } from '../helper/stepInputs';
import {
  compareWithBuildRecord,
  type CheckedOutcome,
  type CheckOutcome,
  type ConfigReferences,
} from '../imageCheck/imageCheck';
import { parseImageReference, registryDisplayName } from '../imageCheck/reference';
import { parseJsonc } from '../jsonc';
import { Messages, listSome } from '../messages';
import {
  CONFIG_FOLDER,
  CONTAINER_CONFIG_UNKNOWN_LABEL,
  LABEL_COMPOSE_SERVICE,
  LABEL_CONFIG_PATH,
  LABEL_DEVSPACE_ID,
  LABEL_DEFAULT_IMAGE,
  LABEL_OWNER_ID,
  LABEL_PREPARED,
  LABEL_REPOSITORY,
  LABEL_SERVICE_DATA,
  LABEL_VOLUME,
  SERVICE_DATA,
  VOLUME_KIND_ADDITIONAL,
  VOLUME_KIND_COMPOSE,
  VSCODE_STORE_VOLUME,
  composeProjectName,
  configurationFolder,
  configurationName,
  devspaceImageName,
  devspaceImageRepository,
  isConfigPathLabelValue,
  newDevspaceId,
  preparedImageName,
  preparedServiceImageName,
  repositoryFolder,
  resourceName,
  splitRepository,
} from '../names';
import { sameSource, sourceLabel, sourceOf, sourceOperationKey, sourceSegment } from '../devspaceSource';
import { MAX_REFERENCE_LENGTH } from '../imageCheck/dockerfile';
import { namePair } from '../namePairs';
import { imageBuildRecord, imageRecordLabels, preparedImageLabels, preparedImageMismatch, type PrepareKey } from './imageRecord';
import { ownerOf } from '../ownership';
import { keepFlagsOf, keptWhenClosed } from '../session/sessionRules';
import { BRANCH_EXEC_TIMEOUT_MS, readBranch, readGitSummary } from './refreshStates';
import {
  MAX_ITEM_LENGTH,
  addRefusedItems,
  capped,
  cappedReport,
  composeIgnoredProperties,
  composeMissingBuildPaths,
  describeRefusal,
  foreignVolumeName,
  hostAccessChecks,
  devspaceImageIds,
  devspaceImageNames,
  imageNamedBy,
  imageLabelItems,
  imageReferencesToInspect,
  inspectedImageItems,
  otherAccountImageItems,
  hasUnknownDevspace,
  volumeOwners,
  isOwnVolume,
  isRefused,
  isSameOwnerAdditionalVolume,
  mountedVolumeNames,
  removedRunArgs,
  resolveNetworkReference,
  runArgsNetworks,
  truncated,
  volumeLabelOwner,
  withoutComposeIgnored,
  type CheckStage,
  type DevspaceImageIds,
  type InspectedImage,
  type HostAccessChecks,
  type HostAccessInput,
  type HostAccessReport,
  type NamedImageReference,
  type NetworkState,
} from '../policy';
import { abortError, isAbortError, isoTime, silentProgress, type ProgressReporter, type ConfigurationChangeKind } from '../ports';
import { isStorageId } from '../storage/paths';
import { answerTimeText, freshRegistryDigests } from '../remoteMonitor/registryAnswers';
import { analysisJobHash, configCheckKey } from './configCheck';
import { parseConfigCheckEntry, type ConfigCheckEntry } from '../storage/configCheckEntry';
import type {
  BuildRecord,
  BusyMark,
  BusyOperation,
  DevcontainerConfig,
  DevcontainerResult,
  Devspace,
  DevspaceSource,
  GitHubAccount,
  GitSummary,
  PendingConnection,
  RefusedUpdate,
  WindowStatus,
} from '../types';
import {
  DEFAULT_CONFIG_PATH,
  MAX_REFUSED_ITEMS_LENGTH,
  composeRecordOf,
  isRepositoryName,
  refusedUpdateOf,
} from './recordRules';
import { sameContainer, sameContainerId } from './containerIds';
import {
  baseImageKey,
  composeConfigurationChange,
  composeMountVolumes,
  hasComposeRecord,
  recordedComposeService,
  serviceFoldersOf,
  devMountFolders,
  verifiedIdentityTargets,
  workspaceIdentityMounts,
  liveServiceFolders,
  repositoryServiceDataFolders,
  configHash,
  defaultImageConfiguration,
  containerIsCurrent,
  digestReference,
  errorDetail,
  configRemoteUser,
  imageRemoteUser,
  imagesToPull,
  isComposeContainer,
  isComposeRecreateLeftoverName,
  COMPOSE_CONTAINER_NUMBER_LABEL,
  COMPOSE_SERVICE_LABEL,
  COMPOSE_IMAGE_LABEL,
  COMPOSE_CONFIG_HASH_LABEL,
  COMPOSE_ONEOFF_LABEL,
  isContainerFault,
  containerMetadataUser,
  sharedNamespaceServices,
  builtOtherServices,
  unnamedVolumeFolders,
  isGitHubTokenRejected,
  isNetworkFailure,
  isRefusedUpdate,
  isRootUser,
  isUnrestrictedContainer,
  lifecycleHookFailure,
  lifecycleHookName,
  needsBuild,
  nextBuildNumber,
  nonEmptyString,
  PREPARE_LIMIT_MS,
  PREPARE_STOP_WAIT_SECONDS,
  PREPARE_WAIT_STEP_SECONDS,
  prepareKeyHash,
  recordDigests,
  shouldCheckImages,
  stringList,
  type ImageCheckState,
} from './pipelineRules';
import { sameBusyMark } from './openRecords';
import type { DevspaceHelper, DevspaceServiceDeps, PrepareResult, PrepareRun } from './devspacePorts';
import { rememberedFor } from './lifecycleMemory';
import {
  OperationBase,
  PipelineTexts,
  StepReporter,
  waitUnlessAborted,
  cancelledError,
  devspaceMissing,
  devspaceBusy,
  BUSY_POLL_MS,
  DEVSPACE_LOCK_WAIT_SECONDS,
  type GitHubSession,
  type OpenOptions,
  type OpenResult,
  type OperationOptions,
  type RepositoryTarget,
} from './operationBase';
import { isRecord } from '../valueChecks';

/** The pause before the second write of Devspace.lifecycleIncomplete. */
const LIFECYCLE_MARK_RETRY_MS = 500;

/**
 * The states of `docker inspect` (State.Status) of a container that does not run; every other state (`running`,
 * `restarting`, `paused`, `removing`, `dead`, an unknown one) counts as running.
 */
const NOT_RUNNING_STATES: ReadonlySet<string> = new Set(['exited', 'created']);

// A pending connection file counts for 2 minutes. A helper image build, `up` with long lifecycle commands, or an open
// prompt can take longer; a refresh well within the waiting time keeps the container in use.
const DEFAULT_PENDING_REFRESH_MS = 15_000;
const IMAGE_INSPECT_TIMEOUT_MS = 60_000;
const GIT_EXEC_TIMEOUT_MS = 30_000;
const OWNERSHIP_TIMEOUT_MS = 10 * 60_000;
const DOCKER_START_TIMEOUT_MS = 60_000;
// A helper container that a cancel removes can hold the volume for a moment.
const VOLUME_REMOVE_ATTEMPTS = 3;
const VOLUME_REMOVE_DELAY_MS = 1_000;
// About 15,000 pairs (namePair): an ID whose pair is in use on the engine is rare; a few attempts are enough.
const DEVSPACE_ID_ATTEMPTS = 20;

/** The values of the labels that the extension gives the images of `env` (imageLabelItems). */
function ownImageLabels(env: Devspace): { id: string; repository: string; ownerId: string } {
  return { id: env.id, repository: env.repository, ownerId: env.owner.id };
}

/** devcontainer.json and its Dockerfile, read from the volume. */
type ConfigFiles = NonNullable<Awaited<ReturnType<DevspaceHelper['readConfigFiles']>>>;

/** Configuration of one pipeline run, read from the volume (step 5). */
interface LoadedConfiguration {
  configPath: string;
  /**
   * The configuration of the devspace does not exist on this branch; `configPath` is the first one in the volume.
   * The selection of the user (the registry entry) stays, except on a first open.
   */
  fallback: boolean;
  configHash: string;
  /**
   * The run reads the default image of the setting in place of the configuration of the repository
   * (PipelineContext.defaultImage): `config` is the synthesized configuration (defaultImageConfiguration), and
   * `configHash` the hash of its text. BuildRecord.defaultImage of the build.
   */
  defaultImage?: string;
  config: DevcontainerConfig;
  dockerfileText?: string;
  references: ConfigReferences;
  /**
   * The named volumes that the configuration and its merged configuration mount, other than the workspace volume, read
   * with the parser of the host access policy (mountedVolumeNames): the additional volumes of the registry entry.
   */
  mountedVolumes: string[];
  /** A Docker Compose configuration. */
  compose?: LoadedCompose;
  /**
   * The extensions of the configuration (configurationExtensions: of the merged configuration when the open has it,
   * else of devcontainer.json), for the shared extension cache.
   */
  extensions: ExtensionRef[];
}

/**
 * A Docker Compose configuration of one pipeline run: the merged model that the check read and that `build` and `up`
 * run in our rewrite (composeBuildModel, composeUpModel), so nothing can change between the check and `up`.
 */
interface LoadedCompose {
  /** composeProjectName of the devspace. */
  project: string;
  /** `service` of devcontainer.json: the dev service. */
  service: string;
  /** `runServices` of devcontainer.json, when it names them. */
  runServices?: string[];
  /** The result of the model run: the checked merged model. */
  output: ComposeModelOutput;
  /** The API version of the Docker Engine at the check (volume.subpath of bind mounts of repository files). */
  engineApiVersion?: string;
  /** devcontainer.json as written, for our copy of it in `read-configuration` and `build` (composeConfigOverride). */
  raw: Record<string, unknown>;
  /** The `mounts` values of the configuration and of the merged configuration (composeMountVolumes). */
  mounts: unknown[];
  /** The switch of the host access checks with which the model was checked (PipelineContext.hostAccessChecks). */
  hostAccessChecks: HostAccessChecks;
  /** composeInputsHash of the files as written. */
  inputsHash: string;
}

/**
 * The fetch of the shared VS Code server of an open (startVscodeServer): `ready` resolves with the platform whose
 * server the store has, or `undefined` (never rejects); `settled` once it resolved.
 */
interface VscodeServerFetch {
  ready: Promise<VscodePlatform | undefined>;
  settled: boolean;
}

/** State of one pipeline run. */
interface PipelineContext {
  env: Devspace;
  /** Configuration to read. Kept apart from `env`, which is replaced by the registry entry after each change. */
  configPath: string;
  /**
   * The default image that this run reads and builds in place of the configuration of the repository: the devspace
   * is the default-image devspace of its repository (DevspaceSource `defaultImage`; the image of the setting now, as
   * the open names it, else the one the devspace was last opened with). Missing: the devspace of the configuration
   * `configPath`. A prepare takes the one of its approved record.
   */
  defaultImage?: string;
  firstOpen: boolean;
  forced: boolean;
  steps: StepReporter;
  signal?: AbortSignal;
  /**
   * Show Messages.configurationNotFound when the configuration is missing on this branch, unless the devspace was
   * built from the fallback already (the configuration of its build record: the devspace keeps its source, so every
   * open on such a branch falls back; the message comes once).
   */
  announceConfigFallback: boolean;
  /** The repository was cloned in this run: fix the ownership, and read the full Git summary. */
  cloned: boolean;
  /** The ownership fix before the first `up` of this run was tried. */
  ownershipPrepared: boolean;
  /**
   * The clone completed one that a window which ended had begun (resumeInterruptedClone): the volume may hold files
   * that the services wrote, so the ownership fix before `up` leaves out their paths too.
   */
  resumedClone?: boolean;
  /**
   * The paths of the repository that the other services of the Docker Compose model of this run mount (composeUpModel's
   * `serviceFolders`), set by runComposeUp.
   */
  modelServiceFolders?: string[];
  /**
   * What the ownership fix after a resumed clone leaves to the services, computed by runComposeUp before `up` (the
   * paths of the model, of the existing containers, and the recorded ones).
   */
  serviceFolders?: ServiceFolders;
  /** This run holds a busy mark. */
  busy: boolean;
  /**
   * The busy mark that requireNoOtherWindow set (takeStepMark) and that this run holds (`busy`), so that
   * offerRecreation can clear exactly this mark before its question. Unset by markBusy and releaseBusy.
   */
  stepMark?: BusyMark;
  /**
   * The workspace helper image could not be prepared (for example offline after an extension update: no previous helper
   * image). At Step 5 a running container that is current still opens; a helperFailed after Step 5 ends the open.
   * Nothing is started (no docker start fallback).
   */
  helperUnavailable: boolean;
  /**
   * The helper image of this run (the current tag with the ID of its image), resolved once by the first prepareHelper
   * of the run and passed to every helper run of it: the configuration that the Dev Container CLI of this image read
   * and checked is built and started with the same CLI, whatever another open of the window resolves meanwhile. Further
   * prepareHelper calls of the run do not resolve it again.
   */
  helperImage?: HelperImageUse;
  /**
   * The configuration was read, but its check could not run (AnalysisFailure `internal`, for example Docker did not
   * answer for its images): the reason of a Docker Compose start that fails says so.
   */
  configurationUnchecked?: boolean;
  /** The Monitor of the engine was ensured in this run (once per run; any engine). */
  sessionMonitorEnsured?: boolean;
  /**
   * The Monitor was ensured again after `up` started the container of this run (ensureSessionMonitorAfterStart;
   * once per run).
   */
  sessionMonitorEnsuredAfterStart?: boolean;
  /** The GitHub session of the owner account, for the token file of the container. */
  session: GitHubSession;
  /** The token and the Git configuration were written into the volume in this run. */
  gitPrepared: boolean;
  /**
   * Lifecycle token: the container into which runUserCommands wrote the token in this run, before the lifecycle
   * commands; finish does not write it again there.
   */
  tokenWrittenTo?: string;
  /**
   * The container whose ~/.gitconfig runUserCommands prepared in this run (HOME_GIT_CONFIG_SCRIPT), before the
   * lifecycle commands, for Git older than 2.31; finish does not run the script again there (it still checks the Git
   * version of a new container).
   */
  homeGitConfigWrittenTo?: string;
  /**
   * The Git identity of the account (identityOf), asked for as soon as the session is known, so the question to GitHub
   * runs while Docker starts and the image check runs. Never rejects.
   */
  identity: Promise<GitIdentity>;
  /**
   * The fetch of the shared VS Code server of the open (startVscodeServer), started at the start of the open like
   * `identity`, and awaited before the link in `finish`; `settled` once it resolved. Missing without
   * DevspaceServiceDeps.vscodeServer. Never rejects.
   */
  vscodeServer?: VscodeServerFetch;
  /**
   * The switch of the host access checks for the repository, read from the settings at the start of this open
   * (hostAccessChecks). `off` lifts the refusals of access to the computer.
   */
  hostAccessChecks: HostAccessChecks;
  /** The configuration of this run is a Docker Compose configuration (loadComposeConfiguration read it). */
  compose?: boolean;
  /**
   * The configuration is of the other kind (Docker Compose or a single container) than the devspace, and no build
   * applies it: the devspace is kept as it is (configurationOfKind); a Docker Compose devspace then does not
   * start (no docker start fallback).
   */
  kindKept?: boolean;
  /**
   * The container of the devspace at the start of this run was created by Docker Compose (the project of the
   * devspace), so the devspace may still have containers of other services.
   */
  composeContainer?: boolean;
  /**
   * What the switch between Docker Compose and a single container removed in this run before `up`, for the message when
   * `up` fails: the containers of the other services, or the single container.
   */
  kindSwitchRemoved?: string[];
  /**
   * `devcontainer up` ran in this run (it may have removed or replaced the dev container with
   * --remove-existing-container), so a later helperFailed of a switch gets the detail of the switch. Set once `up`
   * returned: a helperFailed of `up` itself means that its helper container never started.
   */
  upStarted?: boolean;
  /**
   * runComposeUp removed the single container of the devspace in this run (a switch to Docker Compose), and the IDs
   * of the containers of Docker Compose of the project that existed before its `up`. After a failed `up`,
   * removeFailedComposeContainers removes only the others (those that the failed `up` created).
   */
  composeSwitch?: { existing: ReadonlySet<string> };
  /**
   * runComposeUp began to move the previous dev container of another service out of the way in this run
   * (movePreviousDevContainer), so a failed `up` is a failed switch of the dev service.
   */
  devServiceMoved?: boolean;
  /**
   * What movePreviousDevContainer did with the previous dev container of another service: its ID, its name now (after
   * the rename), and whether it was removed (its rename failed). `service`, the service that it belongs to (its label
   * com.docker.compose.service), for the guard of a failed switch of the dev service, which must not depend on the
   * build record.
   */
  previousDevContainer?: { id: string; name: string; removed: boolean; service: string };
  /**
   * The service of the previous dev container that movePreviousDevContainer began to move (set with devServiceMoved,
   * before previousDevContainer).
   */
  devServiceMovedFrom?: string;
  /**
   * `up` of this run returned, and run-user-commands then failed with helperFailed, so the lifecycle commands of its
   * container did not run (withdrawAfterHelperFailed): what happened to that container, for the detail of the error.
   * Reset before each `up`.
   */
  upWithdrawn?: UpWithdrawn;
  /**
   * The value of Devspace.lifecycleIncomplete that this run decided with (read at the start of the pipeline, and
   * again where Step 9 or opensAsItIs decides whether the container opens as it is). finish clears the mark only when
   * it still has this value, or when it names lifecycleRanFor: a mark that another window set meanwhile (for a
   * container that this run opened as it is) stays.
   */
  lifecycleMarkRead?: string;
  /**
   * The container that the window remembers for the devspace (LifecycleMemory), read under the lock at the start of
   * the open; kept here as this run changes it.
   */
  unrecordedLifecycle?: string;
  /**
   * The container whose `up` and run-user-commands this run completed (its lifecycle commands ran, also when one of
   * them failed on its own: keptAfterLifecycleFailure).
   */
  lifecycleRanFor?: string;
  /**
   * Recreate offer: the user chose to create the damaged dev container of this Docker Compose devspace again
   * (offerRecreation). runComposeUp removes only that container (never a volume, never another service) after the
   * checks, right before `up`.
   */
  recreateDevContainer?: ContainerInfo;
  /**
   * This run starts the devspace with the configuration and the images of its build record (UpdatePlan.current, no
   * build), so the model of Docker Compose is the one its containers were created with. Unset: not known (for example
   * "Rebuild later", or the fallback after a failed update).
   */
  modelOfContainers?: boolean;
  /**
   * This run is a headless prepare (DevspaceService.prepare), which prepares only the configuration that the build
   * record `record` approved: loadConfiguration ends it (PrepareSkipped) for one that is not on the checked-out branch,
   * and one whose hash is another, before it analyses or merges anything. For Docker Compose, after the model run (the
   * hash needs the model), as the open compares it (composeConfigurationChange: an unchanged set of files that another
   * version of the Compose plugin prints as another model is the approved configuration).
   */
  prepare?: { record: BuildRecord };
}

/**
 * Why a headless prepare ends without a build (`reason`, for its one line of the log); not an error of the
 * configuration.
 */
class PrepareSkipped extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = 'PrepareSkipped';
  }
}

/**
 * What withdrawAfterHelperFailed did with the container of an `up` whose lifecycle commands could not run
 * (run-user-commands failed with helperFailed). `id`: its container ID (a later cleanup of a failed switch may remove
 * it). `created`: this `up` created it (it was not among the containers of the devspace right before `up`);
 * `undefined` when that is not known (the listing before `up` failed). `removed`: it was removed; `stopped`: it existed
 * and did not run before `up` (or it is not known whether `up` created it), and was stopped (again);
 * `stoppedAfterRemovalFailed`: its removal failed, so it was stopped; `kept`: neither worked (the registry entry then
 * names it in Devspace.lifecycleIncomplete, `marked`); `unchanged`: it ran already before `up` (it ran before this
 * open); `inUse`: another window is connected to the devspace, so nothing was touched; `useUnknown`: the window
 * status files or the pending connection files could not be read, so it is not known whether another window uses it,
 * and nothing was touched either (when in doubt, the containers stay). With `inUse` and `useUnknown`, a container that
 * did not run before `up` is marked too (`marked`).
 */
export interface UpWithdrawn {
  outcome: 'removed' | 'stopped' | 'stoppedAfterRemovalFailed' | 'kept' | 'unchanged' | 'inUse' | 'useUnknown';
  id: string;
  created: boolean | undefined;
  name: string;
  /**
   * With `kept` (and with `inUse` or `useUnknown`), the mark Devspace.lifecycleIncomplete was recorded. With
   * `unchanged` (and a container that ran before `up`), the mark of an earlier open names it still, so the next open
   * runs its lifecycle commands.
   */
  marked?: boolean;
  /**
   * With `inUse`, how another window uses the devspace: `connected` (its window status file), `opening` (its pending
   * connection file: it opens the devspace, and may still wait or build), or `busy` (its busy mark: the withdrawal
   * could not take its own). Unset: `connected`.
   */
  use?: 'connected' | 'opening' | 'busy';
  /** The container ran before `up` (this `up` neither created nor started it). */
  ranBefore?: boolean;
  /**
   * It runs without its lifecycle commands, and the mark Devspace.lifecycleIncomplete could not be written (with
   * `kept`, `inUse`, `useUnknown`): nothing may promise that the next open runs them.
   */
  markFailed?: boolean;
}

/** The end of the sentence of withdrawnOutcome when the mark could not be written. */
const MARK_FAILED = ', and it could not be recorded that its lifecycle commands did not run: stop or rebuild the devspace before working in it.';

/**
 * Whether another window uses the devspace, with a sentence for the log. `known: false`: it is not known (a file or
 * the registry could not be read or written), and the containers stay. `use`: how the other window uses it
 * (UpWithdrawn.use).
 */
interface WindowUse {
  known: boolean;
  text: string;
  use?: 'connected' | 'opening' | 'busy';
}

/**
 * The sentence of the detail that says what happened to the container (UpWithdrawn). `inSwitch` (a failed switch of the
 * kind or of the dev service keeps the previous configuration, so the next open does not start this container): no
 * sentence about the next open.
 */
export function withdrawnOutcome(withdrawn: UpWithdrawn, inSwitch = false): string {
  switch (withdrawn.outcome) {
    case 'removed':
      return inSwitch ? 'It was removed.' : 'It was removed; the next open creates it again.';
    case 'stopped':
      return inSwitch ? 'It was stopped.' : 'It was stopped; the next open starts it again and runs its lifecycle commands.';
    case 'stoppedAfterRemovalFailed':
      return inSwitch ? 'It could not be removed and was stopped.' : 'It could not be removed and was stopped; the next open starts it and runs its lifecycle commands.';
    case 'kept': {
      const what = withdrawn.created === true ? 'It could be neither removed nor stopped' : 'It could not be stopped';
      // The mark could not be written.
      if (withdrawn.markFailed === true) return `${what}${MARK_FAILED}`;
      // The mark makes the next open run `up` and the lifecycle commands for it.
      return !inSwitch && withdrawn.marked === true ? `${what}; the next open runs its lifecycle commands.` : `${what}.`;
    }
    case 'unchanged':
      // The next open runs its lifecycle commands only when the mark still names it.
      return !inSwitch && withdrawn.marked === true ? 'It runs; its lifecycle commands run at the next open.' : 'It runs as before this open.';
    case 'inUse': {
      // A pending connection file means that another window opens the devspace (it may still wait or build), not
      // that it is connected; `busy`: a busy mark of another window.
      const what =
        withdrawn.use === 'opening'
          ? 'It was left running: another window is opening the devspace'
          : withdrawn.use === 'busy'
            ? 'It was left running: another window is working on the devspace'
            : 'It was left running: another window is connected to it';
      // The mark could not be written.
      return withdrawn.markFailed === true ? `${what}${MARK_FAILED}` : `${what}.`;
    }
    case 'useUnknown': {
      // When it is not known whether another window uses it, it stays.
      const what = 'It was left running: it could not be checked whether another window is connected to it';
      // The mark could not be written.
      if (withdrawn.markFailed === true) return `${what}${MARK_FAILED}`;
      return !inSwitch && withdrawn.marked === true ? `${what}; the next open runs its lifecycle commands.` : `${what}.`;
    }
  }
}

/** What `up` did with the container, "created or started" when that is not known. */
function createdOrStarted(withdrawn: UpWithdrawn): string {
  return withdrawn.created === undefined ? 'created or started' : withdrawn.created ? 'created' : 'started';
}

/**
 * The clause about the (dev) container `subject` (for example "Its dev container") whose lifecycle commands could not
 * run after `up`: a container that ran before `up` was neither created nor started by it, so it "runs already";
 * otherwise what `up` did with it (createdOrStarted).
 */
export function afterUpClause(subject: string, withdrawn: UpWithdrawn): string {
  return lifecycleClause(subject, withdrawn.ranBefore === true, createdOrStarted(withdrawn));
}

/** afterUpClause, with `what` for a container that did not run before `up` ("created", "started", ...). */
function lifecycleClause(subject: string, ranBefore: boolean, what: string): string {
  return ranBefore ? `${subject} runs already, but its lifecycle commands could not run.` : `${subject} was ${what}, but its lifecycle commands could not run.`;
}

/** The cause at the end of a detail: the detail of a UserFacingError (for example of helperFailed), else errorDetail. */
function causeOf(error: unknown): string {
  return isUserFacingError(error) && error.detail ? error.detail : errorDetail(error);
}

/** What steps 8 and 9 did with the container. */
interface ContainerOutcome {
  /** Result of `devcontainer up`, if it ran. */
  result?: DevcontainerResult;
  /** A new container was created (first creation, replacement, or creation from the devspace image). */
  created: boolean;
  /** The container that existed before, when no `up` created a new one. */
  container?: ContainerInfo;
}

interface UpdatePlan {
  check: ImageCheckState;
  build: boolean;
  forced: boolean;
  updateAvailable: boolean;
  /**
   * The configuration and the digests are those of the build record (no change of the configuration, no newer image,
   * also none that was refused), so the model of this run is the one the containers were created with.
   */
  current: boolean;
}

/**
 * A step without a busy mark (Step 9) would have to stop, remove, or rename a container, and another window uses the
 * devspace (or that could not be checked): nothing was changed (requireNoOtherWindow).
 */
class OtherWindowUsesError extends UserFacingError {
  constructor(detail: string) {
    super('startFailed', PipelineTexts.startFailed, detail);
  }
}

/** The workspace helper could not be prepared, or the helper image of the open is gone (UserFacingError helperFailed). */
function isHelperFailed(error: unknown): boolean {
  return isUserFacingError(error) && error.code === 'helperFailed';
}

function isFilesMissing(error: unknown): boolean {
  return isUserFacingError(error) && error.code === 'filesMissing';
}

/** Errors of reading the configuration: helper and CLI failures become "could not be prepared". */
function configurationError(error: unknown): unknown {
  if (isUserFacingError(error) || isAbortError(error)) return error;
  return new UserFacingError('buildFailed', Messages.buildFailed, errorDetail(error));
}

/** The labels of every volume of a devspace: its ID, its repository, and its owner (the account that created it). */
function volumeLabels(devspace: Devspace): Record<string, string> {
  return { [LABEL_DEVSPACE_ID]: devspace.id, [LABEL_REPOSITORY]: devspace.repository, [LABEL_OWNER_ID]: devspace.owner.id };
}

/**
 * The labels of the workspace volume of a devspace: volumeLabels, and its source (nimblescape.devspaces.default-image
 * of a default-image devspace, else nimblescape.devspaces.config-path). The owner and the source come back with the
 * entry when the registry is lost (devspaceOfVolume).
 */
function workspaceVolumeLabels(devspace: Devspace): Record<string, string> {
  const labels = volumeLabels(devspace);
  if (devspace.defaultImage !== undefined) labels[LABEL_DEFAULT_IMAGE] = devspace.defaultImage;
  else labels[LABEL_CONFIG_PATH] = devspace.configPath;
  return labels;
}

/**
 * The detail of a failed `up` after a build that switched the kind of the devspace: the devspace is not started
 * with its previous kind, and what the switch removed before (`removed`) is named; the volumes are kept. Towards Docker
 * Compose, `created` names the containers that the failed `up` created and that were removed again
 * (removeFailedComposeContainers); `kept` the containers of Docker Compose that existed before and stay. `afterUp`: the
 * sentence of withdrawnOutcome when `up` returned and the lifecycle commands of its (dev) container could not run
 * (helperFailed). `removeExisting`: the `up` of the switch ran with --remove-existing-container (there was a dev
 * container); only then does the detail say that the CLI removed (or may have removed) it. `afterUpWhat`: what that
 * `up` did with the (dev) container (createdOrStarted: "created or started" when the listing before `up` failed), in
 * both directions. `ranBefore`: the (dev) container ran before that `up`, so it "runs already" (afterUpClause).
 */
export function kindSwitchFailure(
  toCompose: boolean,
  removed: readonly string[],
  cause: string,
  created: readonly string[] = [],
  kept: readonly string[] = [],
  afterUp?: string,
  removeExisting = true,
  afterUpWhat = 'created',
  ranBefore = false,
): string {
  // `ranBefore`: the (dev) container ran before that `up` (it "runs already").
  const clause = (subject: string): string => lifecycleClause(subject, ranBefore, afterUpWhat);
  const what =
    afterUp !== undefined
      ? toCompose
        ? `The configuration now uses Docker Compose. ${clause('Its dev container')} ${afterUp}`
        : `The configuration no longer uses Docker Compose. ${clause('Its container')} ${afterUp}`
      : toCompose
        ? 'The configuration now uses Docker Compose, and its containers could not all be created and started.'
        : 'The configuration no longer uses Docker Compose, and its container could not be created.';
  const gone = removed.length > 0 ? `The change removed ${removed.join(', ')}.` : 'The change removed no container of the other kind.';
  const again = created.length > 0 ? ` The containers that Docker Compose had created were removed again: ${created.join(', ')}.` : '';
  // The containers of Docker Compose that existed before this start stay.
  const stayed = kept.length > 0 ? ` The containers of Docker Compose that existed before this start were kept: ${kept.join(', ')}.` : '';
  // `up --remove-existing-container` of a single container removes the dev container that it finds by the ID label.
  // After `up` returned, the CLI did remove it (--remove-existing-container); only when that `up` ran with
  // --remove-existing-container.
  const cli =
    toCompose || !removeExisting
      ? ''
      : afterUp !== undefined
        ? ' The Dev Container CLI removed the previous dev container.'
        : ' The Dev Container CLI may have removed the previous dev container before it failed.';
  // After `up` returned, `afterUp` names what happened to the new container, so "nothing else" would not be true.
  const rest = afterUp !== undefined ? 'The files in the volumes are kept.' : 'Nothing else was removed, and the files in the volumes are kept.';
  return `${what} The devspace is not started with its previous containers, which belong to the previous configuration; rebuild it to try again. ${gone}${again}${stayed}${cli} ${rest} ${cause}`;
}

/**
 * Labels of an additional volume that the pipeline creates before `up`: those of the workspace volume, and
 * nimblescape.devspaces.volume=additional. Only these labels make a volume the devspace's own (isOwnVolume).
 */
export function additionalVolumeLabels(devspace: Devspace): Record<string, string> {
  return { ...volumeLabels(devspace), [LABEL_VOLUME]: VOLUME_KIND_ADDITIONAL };
}

/**
 * The files of a helper run for the build model of a Docker Compose configuration: the model, and the Dockerfile of the
 * dev service.
 */
function composeBuildFiles(build: ComposeBuildModelRewrite): HelperFiles {
  return {
    [COMPOSE_MODEL_PATH]: JSON.stringify(build.model, null, 2),
    ...(build.devDockerfile !== undefined ? { [COMPOSE_DEV_DOCKERFILE]: build.devDockerfile } : {}),
  };
}

function isHostAccess(error: unknown): boolean {
  return isUserFacingError(error) && error.code === 'hostAccess';
}

/**
 * The message of a refusal of the host access policy: the settings that need access to the computer
 * (Messages.hostAccess), the settings that the policy does not know (Messages.unsupportedOptions), or both.
 */
function refusalMessage(report: HostAccessReport): string {
  // The analysis failed; no settings to name.
  if (report.hostAccess.length === 0 && report.unsupported.length === 1 && report.unsupported[0] === ANALYSIS_FAILED_ITEM) {
    return Messages.configurationTooComplex(ANALYSIS_FAILED_ITEM);
  }
  const access = report.hostAccess.join(', ');
  const unsupported = report.unsupported.join(', ');
  if (access === '') return Messages.unsupportedOptions(unsupported);
  if (unsupported === '') return Messages.hostAccess(access);
  return Messages.hostAccessAndUnsupported(access, unsupported);
}

/** UserFacingError('hostAccess') with what the configuration or the image needs, and what the policy does not know. */
class HostAccessError extends UserFacingError {
  /** All refused settings, for the message of a refused update (Messages.updateRefused). */
  readonly items: readonly string[];

  constructor(
    readonly report: HostAccessReport,
    message: string = refusalMessage(report),
  ) {
    super('hostAccess', message, `Refused by the host access policy: ${describeRefusal(report)}`);
    this.items = [...report.hostAccess, ...report.unsupported];
  }
}

/**
 * The reasons of dockerCheckItem when the images of the devspaces on the Docker host, or the volumes that name the
 * owners of some of them, could not be read.
 */
const DEVSPACE_IMAGES_UNREAD = 'the images of the devspaces on the Docker host could not be read';
const DEVSPACE_OWNERS_UNREAD = 'the owners of the images of the devspaces on the Docker host could not be read';

/**
 * The analysis of the host access policy failed (AnalysisFailure): refused like a refusal of the policy (fail closed),
 * but an update is not remembered as refused (it is tried again), and an analysis that could not run (`internal`) has a
 * message of its own, does not block an existing devspace whose container is only started, and blames no
 * configuration.
 */
class AnalysisFailedError extends HostAccessError {
  constructor(readonly failure: AnalysisFailure) {
    const item = analysisFailureItem(failure);
    super(
      { hostAccess: [], unsupported: [item] },
      failure.kind !== 'internal'
        ? Messages.configurationTooComplex(item)
        : failure.docker === true
          ? Messages.configurationCheckDocker(item)
          : Messages.configurationCheckInternal(item),
    );
  }

  /** The text for the user: ANALYSIS_FAILED_ITEM, analysisInternalItem, or dockerCheckItem. */
  get item(): string {
    return analysisFailureItem(this.failure);
  }
}

/** An analysis that could not run (AnalysisFailure `internal`). */
function isInternalAnalysisFailure(error: unknown): error is AnalysisFailedError {
  return error instanceof AnalysisFailedError && error.failure.kind === 'internal';
}

/** A configuration beyond the limits of analysisLimits.ts, refused as too large or too complex. */
function tooLargeError(reason: string): AnalysisFailedError {
  // A size limit, which the same configuration always exceeds.
  return new AnalysisFailedError({ kind: 'size', reason });
}

/** The most characters of the paths of one EXISTING_PATHS_SCRIPT call (existingServiceFolders). */
const EXISTING_PATHS_CHARACTERS = 16 * 1024;

/** After a failed question for the profile, the fallback identity is used this long before GitHub is asked again. */
const IDENTITY_RETRY_MS = 10 * 60_000;

/**
 * The session of a headless prepare: the owner of the devspace, and no token (a read of it throws, so no step of the
 * prepare can use one).
 */
function prepareSession(owner: GitHubAccount): GitHubSession {
  return {
    get token(): string {
      throw new Error('A prepare has no GitHub token.');
    },
    account: owner,
  };
}

/** The Git identity of a headless prepare, which never asks GitHub (no step of the prepare uses it). */
function prepareIdentity(): Promise<GitIdentity> {
  const identity = Promise.reject<GitIdentity>(new Error('A prepare has no Git identity.'));
  identity.catch(() => undefined);
  return identity;
}

/** A duration for the log of a prepare, for example `4 min 12 s`. */
function durationText(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  return seconds < 60 ? `${seconds} s` : `${Math.floor(seconds / 60)} min ${seconds % 60} s`;
}

/** A default image of the label of a volume, as `record restore` takes it: a valid image reference, bounded. */
function isRestoredDefaultImage(value: string): boolean {
  return value.length <= MAX_REFERENCE_LENGTH && !/[\u0000-\u001f\u007f]/.test(value) && parseImageReference(value) !== undefined;
}

/**
 * Registry lost (reconcileFromVolumes): the entry that the workspace volume `volume` (with the label
 * nimblescape.devspaces.id, and no nimblescape.devspaces.volume) stands for, with the owner of its label
 * nimblescape.devspaces.owner-id and the source of its labels nimblescape.devspaces.default-image or
 * nimblescape.devspaces.config-path (a volume of version 0.5.0 or older has neither: the default configuration), at
 * `now` on `dockerHost`; or why it is skipped (`skipped`, the line of the log). Also the devspaces that a headless
 * prepare knows (the worker's engineDevspaceStore), which has no registry.
 */
export function devspaceOfVolume(volume: VolumeInfo, now: string, dockerHost: string): Devspace | { skipped: string } {
  const id = volume.labels[LABEL_DEVSPACE_ID];
  const repository = volume.labels[LABEL_REPOSITORY];
  const ownerId = volume.labels[LABEL_OWNER_ID];
  const defaultImage = volume.labels[LABEL_DEFAULT_IMAGE];
  const labelledConfigPath = volume.labels[LABEL_CONFIG_PATH];
  // A repository as `record restore` takes it (no control characters, at most 256).
  if (!isStorageId(id) || !isRepositoryName(repository) || repository.length > 256 || /[\u0000-\u001f\u007f]/.test(repository) || !isStorageId(ownerId)) {
    return { skipped: `The volume ${volume.name} has invalid labels and is skipped.` };
  }
  // The source of the labels, as `record restore` takes it: a valid image reference, or a configuration path.
  if (defaultImage !== undefined && (!isRestoredDefaultImage(defaultImage) || labelledConfigPath !== undefined)) {
    return { skipped: `The volume ${volume.name} has an invalid default image label and is skipped.` };
  }
  if (labelledConfigPath !== undefined && !isConfigPathLabelValue(labelledConfigPath)) {
    return { skipped: `The volume ${volume.name} has an invalid configuration path label and is skipped.` };
  }
  const configPath = labelledConfigPath ?? DEFAULT_CONFIG_PATH;
  const source: DevspaceSource = defaultImage !== undefined ? { kind: 'defaultImage', image: defaultImage } : { kind: 'configuration', configPath };
  // Only a volume with the name that the extension gives the devspace of these labels: a configuration cannot create
  // such a volume (the host access policy refuses these names and the labels of volumes), so labels on any other volume
  // do not make it a devspace. A volume of version 0.5.0 or older has no source in its name.
  const expected = [resourceName(repository, id, sourceSegment(source)), resourceName(repository, id)].map((name) => name.toLowerCase());
  if (!expected.includes(volume.name.toLowerCase())) {
    return { skipped: `The volume ${volume.name} has the labels of a devspace but not its name. It is skipped.` };
  }
  // The owner label of the volume gives the entry its owner again; its login follows at the next open.
  return {
    id,
    repository,
    configPath,
    ...(defaultImage !== undefined ? { defaultImage } : {}),
    volumeName: volume.name,
    containerName: volume.name,
    createdAt: now,
    lastUsedAt: now,
    owner: { id: ownerId, login: '' },
    ...dockerHostField(dockerHost),
  };
}

/**
 * The open pipeline and the devspace operations. Operations on the same devspace (the repository and the source,
 * sourceOperationKey) run one after the other in this window; busy marks in the registry keep other windows and the
 * Monitor away while a devspace changes.
 */
export class DevspaceService extends OperationBase {
  /**
   * Git identity per account ID (identityOf): the question to GitHub, shared by the opens of this window. After a failed
   * question, `retryAfter` is the time from which GitHub is asked again.
   */
  private readonly identities = new Map<string, { identity: Promise<GitIdentity>; retryAfter?: number }>();
  /** The fetch of the shared VS Code server of each open (startVscodeServer), by the options of the open. */
  private readonly vscodeServerFetches = new WeakMap<OpenOptions, VscodeServerFetch>();
  private readonly pendingRefreshMs: number;
  private readonly output = (text: string): void => this.deps.logger.output(text);

  // The rules of an operation of a window are OperationBase's (shared with DevspaceOperations).
  constructor(protected override readonly deps: DevspaceServiceDeps) {
    super(deps, deps.startDocker, () => ({ busyMarks: deps.busyMarks, openRecords: deps.openRecords }));
    this.pendingRefreshMs = Math.max(1, deps.pendingRefreshMs ?? DEFAULT_PENDING_REFRESH_MS);
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Open pipeline

  /**
   * Open pipeline for a repository: the devspace of the source of the open (OpenOptions.source; without one, the
   * first configuration of the repository) of the signed-in account. The first open of a source creates its devspace;
   * a devspace of another account is neither used nor named. The worker's pipeline runs it (the operation `open`);
   * the extension sends it with openInWorker.
   */
  async open(target: RepositoryTarget, options: OpenOptions): Promise<OpenResult> {
    splitRepository(target.repository);
    const source: DevspaceSource = options.source ?? { kind: 'configuration', configPath: target.configPaths[0] ?? DEFAULT_CONFIG_PATH };
    return this.exclusive(sourceOperationKey(target.repository, source), options.signal, async () => {
      try {
        // The account decides which devspace is used, and the token of the same session goes into it.
        const session = await this.requireSession();
        const existing = await this.deps.registry.findForAccount(target.repository, session.account.id, await this.currentDockerHost(), source);
        if (existing) {
          return await this.openExisting(existing, options, target.defaultBranch ?? undefined, session);
        }
        return await this.openFirst(target, options, session, source);
      } catch (error) {
        throw this.toUserError(error, options.signal);
      }
    });
  }

  /**
   * Open pipeline for an existing devspace (reconnect, reopen, restored window, switch, rebuild). The worker's
   * pipeline runs it; the extension sends it with openDevspaceInWorker.
   */
  async openDevspace(devspaceId: string, options: OpenOptions): Promise<OpenResult> {
    const devspace = await this.deps.registry.get(devspaceId);
    if (!devspace) throw devspaceMissing();
    await this.requireCurrentHost(devspace);
    return this.exclusive(sourceOperationKey(devspace.repository, sourceOf(devspace)), options.signal, async () => {
      try {
        const current = await this.deps.registry.get(devspaceId);
        if (!current) throw devspaceMissing(devspace.repository);
        return await this.openExisting(current, options, undefined);
      } catch (error) {
        throw this.toUserError(error, options.signal);
      }
    });
  }

  /**
   * First open of the repository for the account of `session`: security confirmation, registry entry, workspace volume,
   * clone, then the pipeline.
   */
  private async openFirst(target: RepositoryTarget, options: OpenOptions, session: GitHubSession, source: DevspaceSource): Promise<OpenResult> {
    const { signal } = options;
    const steps = new StepReporter(options.progress, this.logger);
    this.throwIfCancelled(signal);
    if (!target.trusted && !(await this.deps.ui.confirmUntrustedRepository(target.repository))) {
      this.logger.info(`The first open of ${target.repository} was not confirmed.`);
      throw cancelledError();
    }
    // Asked now, so the question to GitHub runs while Docker starts and the repository is cloned.
    const identity = this.identityOf(session);
    // Started now too, so a download of the VS Code server runs while the repository is cloned and the image is built.
    const vscodeServer = this.startVscodeServer(options);
    await this.startDocker(steps, signal);
    // Registry lost: a labeled volume of this repository and account that the registry lacks holds the work of the
    // user. It becomes the devspace again; a second devspace would hide it. Docker runs now, so the volumes are
    // read also when the registry was lost while Docker was stopped, or when registry.json is invalid.
    const dockerHost = await this.currentDockerHost();
    if ((await this.reconcileFromVolumes()) > 0) {
      const restored = await this.deps.registry.findForAccount(target.repository, session.account.id, dockerHost, source);
      if (restored) {
        this.logger.info(`A devspace of ${target.repository} was restored from its volume ${restored.volumeName}. It is used.`);
        return this.openExisting(restored, options, target.defaultBranch ?? undefined, session);
      }
    }

    const segment = sourceSegment(source);
    const id = await this.unusedDevspaceId(target.repository, segment);
    const name = resourceName(target.repository, id, segment);
    const now = isoTime(this.deps.clock);
    const devspace: Devspace = {
      id,
      repository: target.repository,
      // The default-image devspace keeps the first configuration of the repository as the path of its synthesized
      // configuration.
      configPath: source.kind === 'configuration' ? source.configPath : (target.configPaths[0] ?? DEFAULT_CONFIG_PATH),
      // The kind of the devspace, fixed at its creation (sourceOf).
      ...(source.kind === 'defaultImage' ? { defaultImage: source.image } : {}),
      volumeName: name,
      containerName: name,
      createdAt: now,
      lastUsedAt: now,
      busy: this.busyMark('create'),
      // The devspace belongs to the account that creates it.
      owner: ownerOf(session.account),
      // And to the Docker host of the operation.
      ...dockerHostField(dockerHost),
    };
    try {
      await this.openRecords.createDevspace(devspace);
    } catch (error) {
      // One devspace per repository, source and account: another window of the account may have created it right now.
      const other = await this.deps.registry.findForAccount(target.repository, session.account.id, dockerHost, source);
      if (!other) throw error;
      this.logger.info(`A devspace of ${target.repository} was created in the meantime. It is used.`);
      return this.openExisting(other, options, target.defaultBranch ?? undefined, session);
    }
    this.logger.info(`First open of ${target.repository}: devspace ${id}, volume ${name}.`);
    if (source.kind === 'defaultImage') this.logger.info(`${target.repository} opens with the default image ${source.image} in place of its configuration.`);

    const ctx: PipelineContext = {
      env: devspace,
      configPath: devspace.configPath,
      ...(source.kind === 'defaultImage' ? { defaultImage: source.image } : {}),
      firstOpen: true,
      forced: false,
      steps,
      signal,
      announceConfigFallback: target.configPaths.length > 0,
      cloned: true,
      ownershipPrepared: false,
      busy: true,
      helperUnavailable: false,
      session,
      gitPrepared: false,
      identity,
      ...(vscodeServer !== undefined ? { vscodeServer } : {}),
      hostAccessChecks: this.hostAccessChecksFor(devspace.repository),
    };
    // The first open runs under the lock of the devspace on the Docker host, from before the volume is created
    // through the pipeline and the removal after a failure. A refused lock has created nothing on Docker: only the new
    // registry entry is removed again (no busy mark, no partial state). When the lock is lost during the removal, its
    // Docker calls fail and the volume stays; the entry then stays too, with its create mark, so the next open
    // completes the clone or Delete removes it (removeFailedFirstOpen keeps the entry whenever the volume cannot be
    // removed); nothing is removed without the lock.
    let locked = false;
    try {
      // With the batch scope of the volume `name` (one batch helper for the steps of the open; it opens at the first
      // volume step, after createVolume, and closes before the lock is released).
      return await this.withDevspaceLock(devspace, signal, async () => {
        locked = true;
        try {
          steps.step('downloadingRepository');
          await this.deps.docker.createVolume(name, workspaceVolumeLabels(devspace));
          // `docker volume create` takes an existing volume as it is; one that another devspace created meanwhile
          // under the same name is never cloned into.
          await this.requireOwnVolume(devspace);
          await this.prepareHelper(ctx);
          await this.clone(ctx, session.token, target.defaultBranch ?? undefined);
          return await this.runPipeline(ctx);
        } catch (error) {
          // The volume could not be removed (for example the lock was lost): the entry keeps its create mark, so the
          // next open completes the clone (resumeInterruptedClone) or Delete removes it.
          if (!(await this.removeFailedFirstOpen(ctx.env, ctx.compose === true))) {
            ctx.busy = false;
            // Kept as ended, so it blocks nothing while this window lives.
            await this.quietly('keep the create mark as ended', () => this.openRecords.createMark(ctx.env.id, 'ended'));
          }
          throw error;
        }
      }, { batchVolume: name });
    } catch (error) {
      if (!locked) await this.removeRefusedFirstOpen(devspace);
      throw error;
    } finally {
      await this.releaseBusy(ctx);
    }
  }

  /**
   * The lock of a first open was refused (or its wait cancelled) before anything was created on Docker. Only the
   * registry entry of `env` (with its busy mark) is removed; no Docker call runs, as none may run without the lock.
   */
  private async removeRefusedFirstOpen(env: Devspace): Promise<void> {
    await this.quietly('remove the registry entry', () => this.openRecords.dropCreated(env.id));
  }

  /**
   * Steps 2 and 4 for an existing devspace, then the pipeline. `known`: the session with which `open` found the
   * devspace of the repository.
   */
  private async openExisting(
    devspace: Devspace,
    options: OpenOptions,
    defaultBranch: string | undefined,
    known?: GitHubSession,
  ): Promise<OpenResult> {
    const { signal } = options;
    const steps = new StepReporter(options.progress, this.logger);
    // Only the owner account opens a devspace; each open writes its token into the devspace.
    const session = known ?? (await this.requireSession());
    const owned = await this.requireOwner(devspace, session);
    // Asked now, so the question to GitHub runs while Docker starts and the image check runs.
    const identity = this.identityOf(session);
    // Started now too (the same fetch when openFirst started it already for these options).
    const vscodeServer = this.startVscodeServer(options);
    // The Monitor must not stop a running container while the pipeline runs. The file is written again while
    // the pipeline runs, because it counts only for 2 minutes and not every step holds a busy mark.
    await this.deps.sessionFiles.writePending(owned.id, this.deps.owner.windowId);
    const stopRefresh = this.keepPendingFresh(owned.id);
    let ctx: PipelineContext | undefined;
    let succeeded = false;
    try {
      await this.startDocker(steps, signal);
      const env = await this.waitForOtherOperation(owned, signal);
      // Start, Rebuild and Clone again run under the lock of the devspace on the Docker host,
      // from here through `finish` (in runPipeline): the check of the volume, Clone again (recoverMissingFiles, with
      // its Delete, which holds the lock already: re-entrant), the resumed clone, and the pipeline. Without the helper
      // image or the worker the open is refused before anything is changed; a lock held elsewhere is refused after 10
      // s. The lock stays held while a question to the user is open. The `finally` below runs after the release and
      // changes no Docker state. With the batch scope of the volume (batchScope.ts): every helper step of the open runs
      // in one batch helper of the operation, opened at the first volume step (after Clone again created a missing
      // volume) and closed before the release.
      const result = await this.withDevspaceLock(env, signal, async () => {
        let forced = options.forceRebuild === true;
        let configPath = env.configPath;
        if (options.configPath !== undefined) {
          forced = true;
          if (options.configPath !== env.configPath) {
            this.logger.info(`Configuration of ${env.repository}: ${env.configPath} → ${options.configPath}.`);
            configPath = options.configPath;
          }
        }
        // The default image of a default-image devspace: the one of the setting as the open names it, else the one
        // of the last open (the setting was cleared). The devspace keeps its kind: a source of the other kind in the
        // options is not followed.
        const defaultImage = env.defaultImage !== undefined ? (options.source?.kind === 'defaultImage' ? options.source.image : env.defaultImage) : undefined;
        if (defaultImage !== undefined) this.logger.info(`${env.repository} opens with the default image ${defaultImage} in place of its configuration.`);
        const opened: PipelineContext = {
          env,
          configPath,
          ...(defaultImage !== undefined ? { defaultImage } : {}),
          firstOpen: false,
          forced,
          steps,
          signal,
          announceConfigFallback: options.configPath !== undefined || env.buildRecord !== undefined,
          cloned: false,
          ownershipPrepared: false,
          busy: false,
          helperUnavailable: false,
          session,
          gitPrepared: false,
          identity,
          ...(vscodeServer !== undefined ? { vscodeServer } : {}),
          hostAccessChecks: this.hostAccessChecksFor(env.repository),
          // What the window remembers, read under the lock (no other open of the devspace runs now).
          unrecordedLifecycle: await this.lifecycleMemory.get(env.id),
        };
        ctx = opened;
        // A volume of its name that is another devspace's is never opened.
        const ownership = await this.workspaceVolumeOwnership(env);
        if (ownership === 'foreign' || ownership === 'unreadable') await this.requireOwnVolume(env);
        if (ownership === 'missing') {
          await this.recoverMissingFiles(opened, defaultBranch, options.progress);
        } else if (env.busy?.operation === 'create') {
          await this.resumeInterruptedClone(opened, defaultBranch);
        }
        return this.runPipeline(opened);
      }, { batchVolume: env.volumeName });
      succeeded = true;
      return result;
    } finally {
      await stopRefresh();
      if (ctx) await this.releaseBusy(ctx);
      if (!succeeded) {
        await this.quietly('remove the pending connection file', () => this.deps.sessionFiles.removePending(owned.id));
      }
    }
  }

  /**
   * Refuses a devspace of another account: UserFacingError('otherAccount'). Only an explicit devspace
   * (openDevspace: a reconnect, a reopen, a restored window) can be one; `open` of a repository uses the devspace
   * of the account. Returns the registry entry; the login of the owner is updated when the account has another one now
   * (a rename on GitHub, or an owner restored from a volume label).
   */
  private async requireOwner(devspace: Devspace, session: GitHubSession): Promise<Devspace> {
    const { account } = session;
    const current = this.availableEntry(devspace, account);
    if (current.owner.login === account.login) return current;
    const updated = await this.openRecords.ownerLogin(current.id, account);
    return updated ?? current;
  }

  /** The workspace volume is missing. Never creates an empty volume without asking. */
  private async recoverMissingFiles(ctx: PipelineContext, defaultBranch: string | undefined, progress: ProgressReporter): Promise<void> {
    const env = ctx.env;
    this.logger.warn(`The workspace volume ${env.volumeName} of ${env.repository} is missing.`);
    const choice = await this.deps.ui.filesMissing(env.repository);
    this.throwIfCancelled(ctx.signal);
    if (choice === 'deleteDevspace') {
      await this.deleteLocked(env, { progress, signal: ctx.signal, additionalVolumesToRemove: [] });
      throw cancelledError();
    }
    if (choice !== 'cloneAgain') throw cancelledError();

    await this.markBusy(ctx, 'create');
    ctx.steps.step('downloadingRepository');
    try {
      // Inside the try, as at the first open: a create that Docker did but reported as failed (a dropped connection)
      // leaves a volume that the catch below handles like any other.
      await this.deps.docker.createVolume(env.volumeName, workspaceVolumeLabels(env));
      // As the first open, never a volume of the name that another devspace created meanwhile (`docker volume
      // create` takes it as it is), and that volume is never removed.
      await this.requireOwnVolume(env);
      await this.prepareHelper(ctx);
      await this.clone(ctx, ctx.session.token, defaultBranch);
    } catch (error) {
      // The new volume is empty: remove it, so the files count as missing again (only while it is still its own). When
      // whose it is cannot be read, or its removal fails, the `create` mark stays (as ended), so the next open reads it
      // again and completes the clone (resumeInterruptedClone).
      const ownership = await this.workspaceVolumeOwnership(env);
      let removed = ownership !== 'own' && ownership !== 'unreadable';
      if (ownership === 'own') {
        removed = await this.removeVolumeWithRetry(env.volumeName).then(
          () => true,
          (removal: unknown) => {
            this.logger.warn(`Could not remove the volume ${env.volumeName}: ${errorMessage(removal)}`);
            return false;
          },
        );
      }
      if (!removed) {
        ctx.busy = false;
        await this.quietly('keep the create mark as ended', () => this.openRecords.createMark(env.id, 'ended'));
      }
      throw error;
    }
    ctx.cloned = true;
    this.entryUpdated(ctx, await this.openRecords.configuration(ctx.env.id, { cloned: true }));
  }

  /**
   * A first open or "Clone again" whose window ended during the preparation left its `create` mark (the owner process
   * is gone). The clone is completed first; it does nothing when the
   * repository is complete (the clone script is idempotent). Without this, a clone that was cut off would look like a
   * repository without configuration.
   */
  private async resumeInterruptedClone(ctx: PipelineContext, defaultBranch: string | undefined): Promise<void> {
    this.logger.info(`The preparation of ${ctx.env.repository} was interrupted. The clone is completed first.`);
    const interrupted = ctx.env.busy;
    await this.markBusy(ctx, 'create');
    ctx.steps.step('downloadingRepository');
    try {
      await this.prepareHelper(ctx);
      await this.clone(ctx, ctx.session.token, defaultBranch);
    } catch (error) {
      // The mark of the ended window comes back, so the next open completes the clone again. A mark of this window
      // would count as live: the devspace would show as busy without Start and Delete, and other windows could not
      // use it, as long as this window lives; so it comes back as ended.
      ctx.busy = false;
      // The create mark of a failed first open of this window (kept because its volume could not be removed) comes back
      // too, so a resume that fails again does not lose the clone (createMark).
      await this.quietly('restore the busy mark', () => this.openRecords.createMark(ctx.env.id, 'previous', interrupted));
      throw error;
    }
    ctx.cloned = true;
    ctx.resumedClone = true;
  }

  /** Steps 5 to 11 of the pipeline. */
  private async runPipeline(ctx: PipelineContext): Promise<OpenResult> {
    const { docker } = this.deps;
    this.throwIfCancelled(ctx.signal);
    // The mark as this run read it (Step 9 and opensAsItIs read it again).
    ctx.lifecycleMarkRead = ctx.env.lifecycleIncomplete;
    const container = await docker.findContainer(ctx.env.id, ctx.env.containerName);
    ctx.composeContainer = container !== undefined && isComposeContainer(container.labels, composeProjectName(ctx.env.repository, ctx.env.id));
    // An entry without a build record (restored from its volume after a lost registry, or a devspace that another
    // computer created) takes the record of its newest image (adoptImageRecord). The kind of the entry is fixed before
    // the open (the label of its volume, or the record of its newest image at reconcileFromVolumes).
    const record = ctx.env.buildRecord ?? (await this.adoptImageRecord(ctx));
    const imagePresent = record !== undefined && (await this.pinnedImagePresent(record));
    this.logger.info(
      `State of ${ctx.env.repository}: container ${container ? container.state : 'missing'}, devspace image ` +
        (record ? `${record.devspaceImage} ${imagePresent ? 'present' : 'missing'}` : 'not built yet') +
        '.',
    );

    // Step 5. With a broken configuration, the existing devspace still starts, so the user can fix it inside (a
    // Docker Compose devspace does not: without its model there is no `up`, and no docker start fallback; except a
    // dev container that runs already when no container of the devspace must be created again, which opens as it
    // is). A configuration that the host access policy refuses starts nothing (the volume stays).
    let loaded: LoadedConfiguration | undefined;
    try {
      loaded = await this.loadConfiguration(ctx, imagePresent, container);
    } catch (error) {
      const usable = container !== undefined || imagePresent;
      const cancelled = this.isCancellation(error, ctx.signal);
      const helperFailed = isUserFacingError(error) && error.code === 'helperFailed';
      // Also when a helper run of this open failed (its helper image was removed), not only prepareHelper: the rest of
      // the open uses no helper.
      if (helperFailed) ctx.helperUnavailable = true;
      // No docker start fallback: without the workspace helper only a running container opens; otherwise the open fails
      // with helperFailed at once, without a warning that the devspace is started. Only a running container that is
      // current opens as it is (Step 9); a running one that is outdated would be created again, which needs the helper,
      // too. Whether it opens as it is (a Docker listing) is asked only when the answer is needed, and a failure of the
      // listing counts as `false`, so the error of the configuration is never lost. A helper that cannot be opened is
      // an inconsistent state: the refusal of the batch scope (the session cannot be opened, a lost lock, a step
      // without a batch kind) is rethrown before that rule: Start and Rebuild are refused, and a
      // running, current container is not opened as it is.
      if (isBatchHelperUnavailable(error)) throw error;
      // Without the Monitor nothing is opened, not even a running container as it is.
      if (isSessionMonitorFailed(error)) throw error;
      if (helperFailed && (cancelled || !(await this.opensAsItIsOrFalse(ctx, container, record, false)))) throw error;
      // An analysis that could not run blames no configuration: the existing devspace starts as it is (nothing is
      // built or created from the configuration), as with a configuration that cannot be read.
      if (!usable || cancelled || isFilesMissing(error) || (isHostAccess(error) && !isInternalAnalysisFailure(error))) {
        throw configurationError(error);
      }
      // The log line says what happens next. A Docker Compose devspace that is not opened as it is starts nothing
      // (startContainer: startFailed); a single container starts through `up`.
      if (isInternalAnalysisFailure(error)) ctx.configurationUnchecked = true;
      if (helperFailed) {
        // The configuration was not the problem.
        this.logger.error(`The workspace helper is not available for ${ctx.env.repository}. The running devspace is opened as it is.`, error);
      } else {
        const next = (await this.opensAsItIsOrFalse(ctx, container, record, false))
          ? 'The running devspace is opened as it is.'
          : this.isComposeDevspace(ctx.env, record, container)
            ? 'Its containers are not started.'
            : 'The existing devspace is started without it.';
        this.logger.error(`The configuration of ${ctx.env.repository} could not be used. ${next}`, error);
      }
      // A Rebuild or a selected configuration says what was not applied; the selected configuration was never saved, so
      // the previous one stays selected. (A helperFailed in Step 8 ends the open instead.)
      const selected = ctx.configPath !== ctx.env.configPath;
      this.deps.ui.warn(
        helperFailed && (ctx.forced || selected)
          ? Messages.helperFailedOpenedAsItIs(selected ? 'configuration' : 'rebuild', selected ? configurationName(ctx.env.configPath) : undefined)
          : isUserFacingError(error)
            ? error.message
            : Messages.buildFailed,
      );
    }

    let outcome: ContainerOutcome | undefined;
    // An entry without a build record (restored from its volumes, with the configuration path of the label
    // nimblescape.devspaces.config-path of its containers, or else the default one) whose containers are of the other
    // kind than the configuration: the devspace switches only when the user says so (a rebuild), never by the build
    // of a first open. Also when the dev container of Docker Compose is gone but containers of its other services
    // exist, with a question of its own that names the switch and what it removes.
    const containersCompose = loaded && record === undefined && !ctx.forced ? await this.containersUseCompose(ctx.env, container) : undefined;
    if (loaded && containersCompose !== undefined && containersCompose !== (loaded.compose !== undefined)) {
      this.logger.info(
        `The containers of ${ctx.env.repository} are of another kind than the configuration ${loaded.configPath} (${loaded.compose ? 'Docker Compose' : 'a single container'}), and the devspace has no build record.`,
      );
      // Without the dev container, Later starts nothing, and the question says so.
      const question =
        container === undefined ? Messages.configurationKindChangedDevContainerMissing(loaded.configPath) : Messages.configurationKindChanged(containersCompose, loaded.configPath);
      const answer = await this.deps.ui.configurationKindChanged(ctx.env.repository, question);
      this.throwIfCancelled(ctx.signal);
      if (answer === 'rebuildNow') ctx.forced = true;
      else {
        this.logger.info('Rebuild later: the existing containers are kept.');
        await this.saveConfiguration(ctx, loaded, record);
        if (container === undefined) {
          // Without its dev container, the Docker Compose devspace cannot start without the switch: nothing is removed.
          throw new UserFacingError('startFailed', PipelineTexts.startFailed, Messages.composeDevContainerMissing(loaded.configPath));
        }
        outcome = await this.startContainer(ctx, container, record, imagePresent, this.configurationOfKind(ctx, loaded, container, record));
        return this.finish(ctx, outcome, loaded);
      }
    }
    if (loaded) {
      const previousConfigPath = ctx.env.configPath;
      await this.saveConfiguration(ctx, loaded, record);
      // A container of an older setup is created again; it does not count as a working container.
      const currentContainer = container !== undefined && containerIsCurrent(container.labels, true, ctx.hostAccessChecks);
      const plan = await this.planUpdate(ctx, loaded, record, imagePresent, currentContainer, container === undefined ? undefined : { running: container.state === 'running' });
      ctx.modelOfContainers = plan.current && !plan.build;
      try {
        if (plan.build) outcome = await this.buildAndReplace(ctx, loaded, plan, record, imagePresent, container);
      } catch (error) {
        // A configuration path that could not start (the fallback of a configuration that is missing on this branch)
        // does not stay selected, so the next open starts the devspace with the path that it had (its containers are
        // of that one).
        if (ctx.env.configPath !== previousConfigPath) {
          this.logger.info(`The configuration ${ctx.env.configPath} of ${ctx.env.repository} could not be started; ${previousConfigPath} stays selected.`);
          await this.quietly('restore the configuration path', async () =>
            this.entryUpdated(ctx, await this.openRecords.configuration(ctx.env.id, { select: previousConfigPath })),
          );
        }
        throw error;
      }
    }
    outcome ??= await this.startContainer(ctx, container, record, imagePresent, this.configurationOfKind(ctx, loaded, container, record));
    return this.finish(ctx, outcome, loaded);
  }

  /**
   * The devspace switches between Docker Compose and a single container only with a build (as the configuration
   * changes otherwise apply only with a rebuild). Without a build ("Rebuild later", a failed or refused update), the
   * configuration of the other kind is not used to start the devspace: `undefined`, so a Docker Compose devspace
   * does not start (no docker start fallback: without its Docker Compose configuration there is no `up`; a dev
   * container that runs already opens as it is when no container of the devspace must be created again), and a
   * single container starts as a container whose configuration is not known. The kind of the devspace: its build
   * record, or else its dev container (existingCompose).
   */
  private configurationOfKind(
    ctx: PipelineContext,
    loaded: LoadedConfiguration | undefined,
    container: ContainerInfo | undefined,
    record: BuildRecord | undefined,
  ): LoadedConfiguration | undefined {
    if (loaded === undefined || this.keepsKind(ctx, loaded, container, record)) return loaded;
    const existingCompose = this.existingCompose(ctx, record);
    this.logger.info(
      existingCompose
        ? `The configuration ${loaded.configPath} of ${ctx.env.repository} no longer uses Docker Compose. It applies with the next rebuild; until then, the containers of Docker Compose start only when the dev container runs already and no container of the devspace must be created again (the dev container then opens as it is).`
        : `The configuration ${loaded.configPath} of ${ctx.env.repository} now uses Docker Compose. It applies with the next rebuild; until then, the existing container is started as it is.`,
    );
    ctx.kindKept = true;
    return undefined;
  }

  /** Whether configurationOfKind keeps `loaded` (Step 9 then counts the configuration as known), without its log line. */
  private keepsKind(ctx: PipelineContext, loaded: LoadedConfiguration, container: ContainerInfo | undefined, record: BuildRecord | undefined): boolean {
    if (container === undefined && record === undefined) return true;
    return this.existingCompose(ctx, record) === (loaded.compose !== undefined);
  }

  /**
   * Whether the devspace is of the kind Docker Compose for configurationOfKind: its build record says so when there
   * is one, else its dev container. The record first (as at a failed switch in buildAndReplace), so that the single
   * container that a failed switch from Docker Compose left over (its removal failed) does not make the new
   * configuration current without a build: "Rebuild later" then ends with startFailed, as after a switch whose removal
   * worked.
   */
  private existingCompose(ctx: PipelineContext, record: BuildRecord | undefined): boolean {
    // The key decides the kind (hasComposeRecord), not the validity of its fields.
    return record !== undefined ? hasComposeRecord(record) : ctx.composeContainer === true;
  }

  /**
   * Step 5: reads the configuration from the volume. `container`: the container of the devspace, if it exists (the
   * CLI merges its metadata into the merged configuration).
   */
  private async loadConfiguration(
    ctx: PipelineContext,
    imagePresent: boolean,
    container: ContainerInfo | undefined,
  ): Promise<LoadedConfiguration> {
    const { helper } = this.deps;
    const env = ctx.env;
    // Reading the configuration is the first part of the image check. Without a likely check, no step is reported here:
    // the next step comes from the check, the build, or the start, so the steps keep their order.
    const updateImagesOnConnect = this.deps.settings().updateImagesOnConnect;
    const hasRecord = env.buildRecord !== undefined;
    if (shouldCheckImages({ hasRecord, imagePresent, forced: ctx.forced, skipUpdate: false, updateImagesOnConnect })) {
      ctx.steps.step('checkingImage');
    }
    await this.prepareHelper(ctx);

    // The default image: the synthesized configuration in place of the files of the repository (whatever the branch
    // has), read and built under the configuration path of the devspace, which the CLI gets as `--config` while it
    // reads our configuration (`--override-config`, like our copy of a Docker Compose configuration).
    const synthesized = ctx.defaultImage !== undefined ? defaultImageConfiguration(ctx.defaultImage) : undefined;
    const resolved =
      synthesized !== undefined
        ? { configPath: ctx.configPath, files: { configText: synthesized.text } as ConfigFiles, fallback: false }
        : await this.resolveConfigFiles(env, ctx.configPath, ctx.signal, ctx.helperImage);
    if (!resolved) throw new UserFacingError('noConfiguration', Messages.noConfiguration(env.repository));
    const { configPath, files, fallback } = resolved;
    const override = synthesized !== undefined ? { override: synthesized.config } : {};
    // A prepare builds only the configuration of its build record.
    if (ctx.prepare !== undefined && fallback) throw new PrepareSkipped(`its configuration ${ctx.configPath} is not on the checked-out branch`);
    if (fallback) {
      this.logger.info(`The configuration ${ctx.configPath} does not exist on this branch. ${configPath} is used.`);
      // Said once per fallback to another configuration; the root configuration under its other file name is the
      // same configuration, so there is nothing to say.
      const sameConfiguration = sameSource({ kind: 'configuration', configPath }, { kind: 'configuration', configPath: ctx.configPath });
      if (ctx.announceConfigFallback && !sameConfiguration && env.buildRecord?.configPath !== configPath) {
        this.deps.ui.info(Messages.configurationNotFound(ctx.configPath, sourceLabel({ kind: 'configuration', configPath })));
      }
    }

    const problems = checkConfiguration(files.configText);
    if (problems.compose) return this.loadComposeConfiguration(ctx, { configPath, fallback, files, problems });

    // The check result that the extension remembers for the devspace, when nothing that the two CLI runs below
    // depend on changed (configCheck.ts); then they are not run.
    const remembered = await this.rememberedCheck(ctx, { configPath, fallback, files, container });
    if (remembered.entry !== undefined) this.logger.info(`The configuration of ${env.repository} is unchanged; its check result is reused.`);
    // devcontainer.json first without the merged configuration (for which the CLI inspects, and pulls when it is
    // missing, the image or the base image of the Dockerfile, and merges its metadata), as for Docker Compose: the
    // checks of the configuration and of the image references (imageIdItems) come before the read of the merged
    // configuration.
    let config: DevcontainerConfig;
    if (remembered.entry !== undefined) {
      config = structuredClone(remembered.entry.config) as DevcontainerConfig;
    } else {
      await this.requireVolume(env);
      ({ config } = await helper.readConfiguration({
        volumeName: env.volumeName,
        repository: env.repository,
        configPath,
        devspaceId: env.id,
        merged: false,
        ...override,
        onOutput: this.output,
        image: ctx.helperImage,
        signal: ctx.signal,
      }));
    }
    // Host access checks: before any build or container start. With the folders against which the CLI resolves the
    // build context and the Dockerfile. The content of the Dockerfile at the path that the resolved configuration names
    // is not checked: its FROM images are the references of the update check, and its text is part of the configuration
    // hash. The Dockerfile itself is: one that is a link out of the repository or could not be read is refused whatever
    // the switch says, and one too large for the hash is not supported.
    const repository = repositoryFolder(env.repository);
    const dockerfile = await this.resolvedDockerfile(env, configPath, config, files, ctx.signal, ctx.helperImage);
    // Only the configuration that the build record approved is prepared (its hash), before any analysis.
    if (ctx.prepare !== undefined && configHash(files.configText, dockerfile.text) !== ctx.prepare.record.configHash) {
      throw new PrepareSkipped('its configuration changed since its last build (only the approved configuration is prepared)');
    }
    const input: Omit<HostAccessInput, 'ownVolume'> = {
      config,
      configFolder: path.posix.resolve(repository, configurationFolder(configPath)),
      repositoryFolder: repository,
      ...(dockerfile.text !== undefined ? { dockerfileLength: dockerfile.text.length } : {}),
      ...(dockerfile.unreadable !== undefined ? { dockerfileUnreadable: dockerfile.unreadable } : {}),
    };
    // In the worker (ConfigurationAnalyzer), with the image references of the configuration and the references of the
    // update check. A job that is the same as one of the remembered check result (its whole input, with what
    // hostAccessInput read from Docker and the registry now) takes its result from there; each analysis of this open
    // that passed is remembered under the hash of its job.
    const analyses: ConfigCheckEntry['analyses'] = [];
    let analysesRun = 0;
    const singleAnalysis = async (checked: HostAccessInput): Promise<AnalysisResults['single']> => {
      const job = {
        kind: 'single' as const,
        input: checked,
        checksOn: ctx.hostAccessChecks === 'on',
        config,
        ...(dockerfile.text !== undefined ? { dockerfileText: dockerfile.text } : {}),
      };
      const hash = remembered.key !== undefined ? analysisJobHash(job) : undefined;
      const known = hash === undefined ? undefined : remembered.entry?.analyses.find((analysis) => analysis.job === hash);
      if (known !== undefined) {
        analyses.push(known);
        return structuredClone(known.result);
      }
      if (remembered.entry !== undefined) {
        this.logger.info(`The host access check of the configuration of ${env.repository} runs again: what it reads from Docker or from the records of this computer changed.`);
      }
      const result = await this.analyze(ctx, job);
      analysesRun += 1;
      if (hash !== undefined && result.failure === undefined && !isRefused(result.report)) {
        analyses.push({ job: hash, result: structuredClone({ report: { hostAccess: [], unsupported: [] }, imageReferences: result.imageReferences, references: result.references }) });
      }
      return result;
    };
    // A reference that Docker takes for the ID of a local image, only when the configuration is not refused already.
    // `known`: the references that were asked already.
    const refuseUnlessAllowed = async (report: HostAccessReport, references: readonly NamedImageReference[]) => {
      if (!isRefused(report)) {
        const items = await this.imageIdItems(env, references, ctx.signal);
        addRefusedItems(report, 'hostAccess', items.hostAccess);
        addRefusedItems(report, 'unsupported', items.unsupported);
      }
      if (isRefused(report)) {
        this.logger.warn(`The configuration ${configPath} of ${env.repository} is refused by the host access policy: ${describeRefusal(report)}`);
        throw new HostAccessError(report);
      }
    };
    let checked = await this.hostAccessInput(env, input);
    let analysis = await singleAnalysis(checked);
    await refuseUnlessAllowed(analysis.report, analysis.imageReferences);
    const imageReferences = analysis.imageReferences;
    // The merged configuration (only now), or the one of the remembered check result.
    let read: Record<string, unknown> | undefined;
    if (remembered.entry !== undefined) {
      read = structuredClone(remembered.entry.merged);
    } else {
      await this.requireVolume(env);
      read = (
        await helper.readConfiguration({
          volumeName: env.volumeName,
          repository: env.repository,
          configPath,
          devspaceId: env.id,
          ...override,
          onOutput: this.output,
          image: ctx.helperImage,
          signal: ctx.signal,
        })
      ).merged;
    }
    let merged = read;
    // The CLI merges the metadata of an existing container. A container created while the host access checks were off
    // holds what they allowed then (for example `privileged` of a configuration that has changed since); with the checks
    // on, it is not current and is created again (containerIsCurrent), and the image metadata of the new container is
    // checked before `up` (checkImageHostAccess). So its merged configuration does not block the open.
    if (merged !== undefined && ctx.hostAccessChecks === 'on' && container !== undefined && isUnrestrictedContainer(container.labels)) {
      this.logger.info(
        `The container ${container.name} was created while the host access checks were off. Its merged configuration is not checked; the image metadata is checked before the container is created again.`,
      );
      merged = undefined;
    }
    // A container that Docker Compose created (the configuration was a Docker Compose configuration): the CLI finds the
    // container by the ID label, which every container of the project has, so it may merge the metadata of another
    // service. It is created again (startContainer), and the image metadata is checked before `up`.
    if (merged !== undefined && ctx.composeContainer === true) {
      this.logger.info(
        `The container of ${env.repository} was created for a Docker Compose configuration. Its merged configuration is not checked; the image metadata is checked before the container is created again.`,
      );
      merged = undefined;
    }
    if (merged !== undefined) {
      // The whole check again with the merged configuration; only the image references that were not asked yet go to
      // Docker.
      checked = await this.hostAccessInput(env, { ...input, merged });
      analysis = await singleAnalysis(checked);
      const asked = new Set(imageReferences.map((entry) => `${entry.what} ${entry.reference}`));
      await refuseUnlessAllowed(
        analysis.report,
        analysis.imageReferences.filter((entry) => !asked.has(`${entry.what} ${entry.reference}`)),
      );
    }
    // A Dockerfile that does not exist in the repository is an error of the configuration, not a refusal (also of the
    // merged configuration): the existing devspace still starts (runPipeline), and nothing is built from a file that
    // is not checked.
    if (dockerfile.missing !== undefined) {
      this.logger.warn(`The Dockerfile ${dockerfile.missing} of the configuration ${configPath} of ${env.repository} does not exist.`);
      throw new UserFacingError('buildFailed', Messages.buildFileMissing(`the Dockerfile ${dockerfile.missing}`));
    }
    if (merged === undefined) {
      this.logger.info('The merged configuration is not known: the image metadata is checked before the container starts.');
    }
    // The check passed (a refusal threw above): the extension remembers it, with the CLI results, unless it has it
    // already. Only with a merged configuration that the CLI gave (not one that its time limit cut off).
    if (remembered.key !== undefined && read !== undefined && (remembered.entry === undefined || analysesRun > 0)) {
      await this.rememberCheck(ctx, { key: remembered.key, config, merged: read, analyses });
    }
    this.warnAboutConfiguration(configPath, files, problems);
    return {
      configPath,
      fallback,
      // The Dockerfile at the resolved path.
      configHash: configHash(files.configText, dockerfile.text),
      ...(ctx.defaultImage !== undefined ? { defaultImage: ctx.defaultImage } : {}),
      config,
      dockerfileText: dockerfile.text,
      references: analysis.references,
      mountedVolumes: mountedVolumeNames(checked),
      // The extensions of the merged configuration that the checks used (else of devcontainer.json).
      extensions: configurationExtensions(config, merged),
    };
  }

  /**
   * The key of the CLI results of this open (configCheckKey) and the check result that the extension remembers for the
   * devspace when its key is that one. No key (nothing is reused or remembered) without the store, without the ID of
   * the helper image, or without exactly one container of the devspace's ID label that is the container of the
   * devspace (by its full ID): the CLI finds the container by that label and merges its metadata; without one it
   * reads the base image and the Features from the registries, whose tags change without a change of the key. A failed
   * read of the entry is none. Throws only a cancellation.
   */
  private async rememberedCheck(
    ctx: PipelineContext,
    p: { configPath: string; fallback: boolean; files: ConfigFiles; container: ContainerInfo | undefined },
  ): Promise<{ key?: string; entry?: ConfigCheckEntry }> {
    const store = this.deps.configChecks;
    const helperImageId = ctx.helperImage?.id;
    const containerId = p.container?.id.toLowerCase();
    if (store === undefined || helperImageId === undefined || containerId === undefined || !/^[0-9a-f]{64}$/.test(containerId)) return {};
    const env = ctx.env;
    try {
      const labelled = await this.deps.docker.devspaceContainers(env.id);
      if (labelled.length !== 1 || labelled[0].id.toLowerCase() !== containerId) return {};
      const key = configCheckKey({
        helperImageId,
        devspaceId: env.id,
        repository: env.repository,
        volumeName: env.volumeName,
        configPath: p.configPath,
        fallback: p.fallback,
        hostAccessChecks: ctx.hostAccessChecks,
        configText: p.files.configText,
        ...(p.files.dockerfilePath !== undefined ? { dockerfilePath: p.files.dockerfilePath } : {}),
        ...(p.files.dockerfileText !== undefined ? { dockerfileText: p.files.dockerfileText } : {}),
        ...(p.files.dockerfileMissing === true ? { dockerfileMissing: true } : {}),
        containerId,
      });
      const entry = await store.get(env.id);
      this.throwIfCancelled(ctx.signal);
      return entry !== undefined && entry.key === key ? { key, entry } : { key };
    } catch (error) {
      if (this.isCancellation(error, ctx.signal)) throw error;
      this.logger.info(`The remembered check result of the configuration of ${env.repository} could not be read: ${errorMessage(error)}`);
      return {};
    }
  }

  /** The extension remembers the check result that passed (ConfigCheckEntry); a failure is only logged. */
  private async rememberCheck(
    ctx: PipelineContext,
    p: { key: string; config: DevcontainerConfig; merged: Record<string, unknown>; analyses: ConfigCheckEntry['analyses'] },
  ): Promise<void> {
    const store = this.deps.configChecks;
    const entry = parseConfigCheckEntry({ key: p.key, config: p.config, merged: p.merged, analyses: p.analyses });
    if (store === undefined || entry === undefined) {
      this.logger.info(`The check result of the configuration of ${ctx.env.repository} is not remembered: it is too large or not plain JSON.`);
      return;
    }
    await this.quietly('remember the check result of the configuration', () => store.remember(ctx.env.id, entry));
  }

  /**
   * The Dockerfile of a single container at the path that the configuration names after the Dev Container CLI resolved
   * its variables (the text of the configuration may name it with a variable, for example
   * `${localEnv:NAME:Dockerfile}`, which READ_FILES_SCRIPT does not read): the text that readConfigFiles read when it
   * is that file, or else the file at the resolved path. `unreadable`: the configuration names a Dockerfile that could
   * not be read (outside of the repository, a link out of it, or a path with a variable that is not resolved): the
   * check refuses it whatever the switch says, because the CLI and BuildKit in the workspace helper would read the file
   * that it points to (for example the token or a file of the shared cache volume) as the Dockerfile. Its content is
   * not checked otherwise. `missing`: the Dockerfile does not exist in the repository (an error of the configuration,
   * not a refusal).
   */
  private async resolvedDockerfile(
    env: Devspace,
    configPath: string,
    config: DevcontainerConfig,
    files: ConfigFiles,
    signal: AbortSignal | undefined,
    image?: HelperImageUse,
  ): Promise<{ text?: string; unreadable?: string; missing?: string }> {
    const build: Record<string, unknown> = isRecord(config.build) ? config.build : {};
    const raw: Record<string, unknown> = config as Record<string, unknown>;
    const named = typeof build.dockerfile === 'string' ? build.dockerfile : typeof raw.dockerFile === 'string' ? raw.dockerFile : undefined;
    if (named === undefined || named.trim() === '') return files.dockerfileText !== undefined ? { text: files.dockerfileText } : {};
    const repository = repositoryFolder(env.repository);
    const relative = path.posix.relative(repository, path.posix.resolve(repository, configurationFolder(configPath), named));
    if (files.dockerfilePath === relative) {
      if (files.dockerfileText !== undefined) return { text: files.dockerfileText };
      if (files.dockerfileMissing === true) return { missing: named };
    }
    await this.requireVolume(env);
    const read = await this.deps.helper.readConfigFiles({
      volumeName: env.volumeName,
      repository: env.repository,
      configPath,
      dockerfile: named,
      image,
      signal,
    });
    if (read?.dockerfileText !== undefined) return { text: read.dockerfileText };
    return read?.dockerfileMissing === true ? { missing: named } : { unreadable: named };
  }

  /** The warnings of a configuration that the pipeline uses: `${localWorkspaceFolder}`, and variables of the computer. */
  private warnAboutConfiguration(configPath: string, files: ConfigFiles, problems: ConfigurationProblems): void {
    // Each message names at most MAX_LISTED_NAMES (listSome), the log at most 200.
    if (problems.computerDependent.length > 0) {
      this.logger.warn(`The configuration ${configPath} depends on the computer: ${listSome(problems.computerDependent, 200)}`);
      this.deps.ui.warn(Messages.computerDependent(listSome(problems.computerDependent)));
    }
    // The values of the computer are not passed to the workspace helper: the CLI resolves the variables there, so a
    // variable that the helper sets (for example HOME) gets its value, any other one is empty or has its default.
    const localEnvNames = findLocalEnvNames(files.configText);
    if (localEnvNames.length > 0) {
      const fromHelper = helperEnvNames(localEnvNames);
      this.logger.info(`Variables of the computer that the configuration uses and that are not passed: ${listSome(localEnvNames, 200)}`);
      this.deps.ui.warn(Messages.localEnvNotPassed(listSome(localEnvNames), fromHelper.length > 0 ? fromHelper.join(', ') : undefined));
    }
  }

  /**
   * Step 5 for a Docker Compose configuration: devcontainer.json as the CLI resolves it (`service`,
   * `dockerComposeFile`, `runServices`), then the merged model of its compose files, read in the workspace helper as
   * the owner of the repository, so without the Docker socket and the configuration folder of the volume, unless root
   * owns the repository (WorkspaceHelper.composeModel). Host access checks, before any build: every service of the
   * model and the settings of devcontainer.json that Compose does not support (checkContainer `composeModel`), then
   * devcontainer.json and its merged configuration with the rules of a single container (checkContainer
   * `configuration`, without the properties that the CLI ignores for Compose, withoutComposeIgnored). The merged
   * configuration is read with our copy of devcontainer.json, whose only compose file is our build model. The switch of
   * the host access checks applies as for a single container: with the checks off, only the items of the class
   * `computer` are lifted.
   */
  private async loadComposeConfiguration(
    ctx: PipelineContext,
    p: { configPath: string; fallback: boolean; files: ConfigFiles; problems: ConfigurationProblems },
  ): Promise<LoadedConfiguration> {
    const { helper } = this.deps;
    const env = ctx.env;
    const { configPath, files } = p;
    const project = composeProjectName(env.repository, env.id);
    await this.requireVolume(env);
    // With the project name in the environment of the CLI, as for the merged read below: the CLI resolves
    // `${localEnv:COMPOSE_PROJECT_NAME}` of devcontainer.json (for example in `mounts`) with it, and the mounts, their
    // volumes, and the checks use this configuration.
    const { config } = await helper.readConfiguration({
      volumeName: env.volumeName,
      repository: env.repository,
      configPath,
      devspaceId: env.id,
      merged: false,
      env: { COMPOSE_PROJECT_NAME: project },
      onOutput: this.output,
      image: ctx.helperImage,
      signal: ctx.signal,
    });
    const service = nonEmptyString(config.service);
    const composeFiles = resolveComposeFiles(configPath, splitRepository(env.repository).name, config.dockerComposeFile);
    if (service === undefined || 'problem' in composeFiles) {
      const unsupported = [
        ...(service === undefined ? ['service (the dev service of the Docker Compose configuration is missing)'] : []),
        ...('problem' in composeFiles ? [composeFiles.problem] : []),
      ];
      this.logger.warn(`The Docker Compose configuration ${configPath} of ${env.repository} is refused: ${unsupported.join('; ')}`);
      throw new HostAccessError({ hostAccess: [], unsupported });
    }
    ctx.compose = true;
    await this.requireVolume(env);
    const output = await helper.composeModel({
      volumeName: env.volumeName,
      repository: env.repository,
      files: composeFiles.files,
      project,
      image: ctx.helperImage,
      signal: ctx.signal,
    });
    if ('error' in output) {
      this.logger.warn(`Docker Compose could not read the configuration ${configPath} of ${env.repository}: ${output.error}`);
      throw new UserFacingError('buildFailed', Messages.composeConfigurationFailed, output.error);
    }
    // Before anything in this thread works on the model; also the Dockerfiles, before the hashes read them.
    const tooLarge = composeModelLimit(output.model, output.dockerfiles);
    if (tooLarge !== undefined) {
      this.logger.warn(`The Docker Compose configuration ${configPath} of ${env.repository} is too large to check: ${tooLarge}.`);
      throw tooLargeError(tooLarge);
    }
    // A prepare builds only the configuration that its build record approved, before any analysis.
    if (ctx.prepare !== undefined) {
      const current = {
        configHash: composeConfigHash(files.configText, output.model, output.dockerfiles),
        inputsHash: composeInputsHash(files.configText, output.inputsHash, output.dockerfiles),
        version: output.version,
      };
      if (composeConfigurationChange(ctx.prepare.record, current) === 'changed') {
        throw new PrepareSkipped('its configuration changed since its last build (only the approved configuration is prepared)');
      }
    }
    const engineApiVersion = await this.deps.docker.engineApiVersion(ctx.signal);
    this.logger.info(
      `Docker Compose configuration ${configPath} of ${env.repository}: project ${project}, dev service ${service}, services ${Object.keys(output.model.services).join(', ')}; Docker Compose ${output.version}, Docker Engine API ${engineApiVersion ?? 'unknown'}.`,
    );
    const runServices = config.runServices === undefined ? undefined : (stringList(config.runServices) ?? []);
    const compose: LoadedCompose = {
      project,
      service,
      ...(runServices !== undefined ? { runServices } : {}),
      output,
      ...(engineApiVersion !== undefined ? { engineApiVersion } : {}),
      raw: parseJsonc<Record<string, unknown>>(files.configText),
      mounts: [config.mounts],
      hostAccessChecks: ctx.hostAccessChecks,
      inputsHash: composeInputsHash(files.configText, output.inputsHash, output.dockerfiles),
    };
    const { report: composeReport, references } = await this.composeReport(ctx, compose, config);
    if (isRefused(composeReport)) {
      this.logger.warn(`The Docker Compose configuration ${configPath} of ${env.repository} is refused by the host access policy: ${describeRefusal(composeReport)}`);
      throw new HostAccessError(composeReport);
    }
    // devcontainer.json itself before the paths that do not exist, so that a configuration that the policy refuses (for
    // example privileged mode) never counts as a plain error of the configuration, after which the existing devspace
    // would start. The merged configuration follows below (it needs the read with our build model). `mounts` also as
    // the Dev Container CLI writes them into its compose file (composeMounts).
    const ownReport = await this.check(ctx, 'configuration', await this.hostAccessInput(env, { config: withoutComposeIgnored(config), composeMounts: true }), ctx.hostAccessChecks);
    if (isRefused(ownReport)) {
      this.logger.warn(`The configuration ${configPath} of ${env.repository} is refused by the host access policy: ${describeRefusal(ownReport)}`);
      throw new HostAccessError(ownReport);
    }
    // A build context or Dockerfile that does not exist in the repository is an error of the configuration, not a
    // refusal: the existing devspace still starts (runPipeline), and nothing is built.
    const missing = composeMissingBuildPaths({ model: output.model, missing: output.missing, repositoryFolder: repositoryFolder(env.repository) });
    if (missing.length > 0) {
      this.logger.warn(`The Docker Compose configuration ${configPath} of ${env.repository} names paths that do not exist: ${listSome(missing, 200, '; ')}`);
      throw new UserFacingError('buildFailed', Messages.buildFileMissing(listSome(missing, undefined, '; ')));
    }
    const ignored = composeIgnoredProperties(config);
    if (ignored.length > 0) {
      this.logger.info(`The Dev Container CLI ignores ${ignored.join(', ')} of ${configPath} for Docker Compose. They are not used and not checked.`);
    }
    await this.requireVolume(env);
    const read = await helper.readConfiguration({
      volumeName: env.volumeName,
      repository: env.repository,
      configPath,
      devspaceId: env.id,
      override: composeConfigOverride(compose.raw, COMPOSE_MODEL_PATH),
      files: composeBuildFiles(composeBuildModel(output.model, this.composeParams(env, compose, []))),
      env: { COMPOSE_PROJECT_NAME: project },
      onOutput: this.output,
      image: ctx.helperImage,
      signal: ctx.signal,
    });
    const merged = read.merged;
    const checked = await this.hostAccessInput(env, {
      config: withoutComposeIgnored(config),
      ...(merged !== undefined ? { merged: withoutComposeIgnored(merged) } : {}),
      composeMounts: true,
    });
    const report = await this.check(ctx, 'configuration', checked, ctx.hostAccessChecks);
    if (isRefused(report)) {
      this.logger.warn(`The configuration ${configPath} of ${env.repository} is refused by the host access policy: ${describeRefusal(report)}`);
      throw new HostAccessError(report);
    }
    if (merged === undefined) {
      this.logger.info('The merged configuration is not known: the image metadata is checked before the container starts.');
    }
    compose.mounts = [config.mounts, merged?.mounts];
    this.warnAboutConfiguration(configPath, files, p.problems);
    const volumes = composeVolumeNames(output.model, project).map((volume) => volume.name);
    return {
      configPath,
      fallback: p.fallback,
      configHash: composeConfigHash(files.configText, output.model, output.dockerfiles),
      config,
      references,
      mountedVolumes: [...new Set([...volumes, ...this.composeMountVolumes(env, compose, compose.mounts).names])],
      compose,
      // The extensions of the merged configuration (else of devcontainer.json).
      extensions: configurationExtensions(config, merged),
    };
  }

  /**
   * The container policy for the merged model of a Docker Compose configuration and the settings of devcontainer.json
   * that Compose does not support (checkContainer `composeModel`), with the labels of its named volumes now and the
   * volumes of the devspaces of other accounts (hostAccessInput), and the image references that Docker resolves by
   * the ID of an image (imageIdItems, cappedReport). With the switch of the check (LoadedCompose.hostAccessChecks).
   */
  private async composeReport(
    ctx: PipelineContext,
    compose: LoadedCompose,
    config: DevcontainerConfig,
  ): Promise<{ report: HostAccessReport; references: ConfigReferences }> {
    const env = ctx.env;
    const names = composeVolumeNames(compose.output.model, compose.project).map((volume) => volume.name);
    const volumes = await this.hostAccessInput(env, {}, names, composeNetworkReferences(compose.output.model, compose.project));
    // In the worker (ConfigurationAnalyzer), with the image references of the model.
    const analysis = await this.analyze(ctx, {
      kind: 'compose',
      checksOn: compose.hostAccessChecks === 'on',
      features: config.features,
      input: {
      ownVolume: volumes.ownVolume,
      foreignVolumes: volumes.foreignVolumes,
      volumeLabels: volumes.volumeLabels,
      devspace: volumes.devspace,
      ...(volumes.networks !== undefined ? { networks: volumes.networks } : {}),
      dockerfiles: compose.output.dockerfiles,
      model: compose.output.model,
      devService: compose.service,
      runServices: config.runServices,
      project: compose.project,
      repositoryFolder: repositoryFolder(env.repository),
      engineApiVersion: compose.engineApiVersion,
      realPaths: compose.output.realPaths,
      ...(compose.output.mountAncestors !== undefined ? { mountAncestors: compose.output.mountAncestors } : {}),
      ...(compose.output.missing !== undefined ? { missing: compose.output.missing } : {}),
      },
    });
    // A reference that Docker takes for the ID of a local image, only when the configuration is not refused already.
    const items = isRefused(analysis.report) ? { hostAccess: [], unsupported: [] } : await this.imageIdItems(env, analysis.imageReferences, ctx.signal);
    return { report: cappedReport(analysis.report, items.unsupported, items.hostAccess), references: analysis.references };
  }

  /**
   * A job of the host access analysis (AnalysisJob) with the analyzer of the deps, which runs it in a worker thread
   * with limits of time and memory; a failed job resolves a refusal (ANALYSIS_FAILED_ITEM).
   */
  private async analyze<J extends AnalysisJob>(ctx: PipelineContext, job: J): Promise<AnalysisResult<J>> {
    this.throwIfCancelled(ctx.signal);
    const result = await waitUnlessAborted(this.deps.analyzer.analyze(job), ctx.signal);
    this.throwIfCancelled(ctx.signal);
    // A failed analysis is an error of its own (still a refusal: never allowed).
    const failure = (result as { failure?: AnalysisFailure }).failure;
    if (failure !== undefined) {
      this.logger.warn(`The host access analysis of the configuration of ${ctx.env.repository} failed (${failure.kind}: ${failure.reason}).`);
      throw new AnalysisFailedError(failure);
    }
    return result;
  }

  /** checkContainer of the container policy at `stage`, with the switch `checks`, in the analyzer (analyze). */
  private async check(ctx: PipelineContext, stage: Exclude<CheckStage, 'composeModel'>, input: HostAccessInput, checks: HostAccessChecks): Promise<HostAccessReport> {
    return (await this.analyze(ctx, { kind: 'hostAccess', stage, input, checksOn: checks === 'on' })).report;
  }

  /**
   * The items (imageIdItem, not supported) of the references that name a local image by its ID or a prefix of it, not
   * by its name: Docker resolves such a reference (for example `a1b2c3d4`) to any local image, also one of another
   * devspace. A reference whose image does not exist locally is left (the pull or the build fails, or it is pulled
   * by its name). A reference that Docker cannot inspect for another reason is refused too (imageUncheckedItem). A
   * reference that is not valid in Docker's grammar is refused before any inspect (imageInvalidReferenceItem). Only a
   * definitive answer of Docker about a reference (`invalid`) is an item of the configuration (remembered when it
   * refuses an update); when Docker could not answer (`transient`: a timeout, a daemon that cannot be reached, an
   * unknown error), the check failed: AnalysisFailedError of kind `internal` (still no new or changed configuration is
   * used, an existing devspace starts, and a refused update is not remembered). A failure of Docker never hides a
   * definitive refusal: grammar-invalid references are returned before any inspect, and the items of `invalid` answers
   * (and image IDs) are returned also when other references are transient (which are logged, never turned into items);
   * AnalysisFailedError only when there is no definitive item. `hostAccess` (protected): the references whose image is
   * an image of the devspaces of another account on the Docker host of `env` and of none of its own account
   * (otherAccountImageItems, by the image ID; hostDevspaceImageIds), not by the name `devspaces-…`.
   */
  private async imageIdItems(
    env: Devspace,
    references: readonly NamedImageReference[],
    signal?: AbortSignal,
  ): Promise<{ unsupported: string[]; hostAccess: string[] }> {
    const { named, invalid } = imageReferencesToInspect(references);
    // The configuration is refused for them anyway (like the isRefused short-circuit of the callers): no inspect, so
    // that no failure of Docker for another reference hides the refusal. At most MAX_LISTED_ITEMS items, each at most
    // MAX_ITEM_LENGTH characters (capped).
    if (invalid.length > 0) {
      this.logger.warn(`Image references that are not valid: ${capped(invalid).join(', ')}.`);
      return { unsupported: capped(invalid), hostAccess: [] };
    }
    const distinct = [...new Set(named.map((entry) => entry.reference))];
    if (distinct.length === 0) return { unsupported: [], hostAccess: [] };
    // One call of the port for all of them (inspectImageNames; the worker's engine answers each reference with a
    // request of its own).
    if (distinct.length > MAX_IMAGE_ID_REFERENCES) throw tooLargeError(`${distinct.length} image references (at most ${MAX_IMAGE_ID_REFERENCES})`);
    this.throwIfCancelled(signal);
    // A reference that Docker cannot inspect (for another reason than a missing image) is refused as not checked, never
    // left: one invalid reference does not leave the others of its batch unchecked (inspectImageNames inspects them one
    // by one). inspectImageNames throws only when cancelled; the catch is for a Docker port that throws anyway.
    const { images, unchecked } = await this.deps.docker.inspectImageNames(distinct, signal).catch((error: unknown) => {
      if (this.isCancellation(error, signal)) {
        this.throwIfCancelled(signal);
        throw error;
      }
      this.logger.warn(`The local images of the image references could not be read: ${errorMessage(error)}`);
      return { images: [], unchecked: distinct.map((reference) => ({ reference, reason: 'transient' as const })) };
    });
    this.throwIfCancelled(signal);
    const { items, transient, notChecked } = inspectedImageItems(named, images, unchecked);
    if (notChecked.length > 0) this.logger.warn(`Docker could not inspect the image references ${capped(notChecked).join(', ')}.`);
    // The images of the devspaces of other accounts, by their IDs; only when a reference found a local image
    // (another one is pulled by its name, or the build fails), or names no local image under the name of a devspace
    // image. `undefined`: Docker could not say. Missing only by a definitive answer of Docker; a reference that it
    // could not inspect is not decided by its name.
    const unanswered = new Set(unchecked.map((entry) => entry.reference));
    const missing = new Set(
      named.filter((entry) => !unanswered.has(entry.reference) && imageNamedBy(entry.reference, images) === undefined).map((entry) => entry.reference),
    );
    const missingNamed = [...missing].filter((reference) => devspaceImageNames(reference).length > 0);
    const read =
      images.length > 0 || missingNamed.length > 0
        ? await this.hostDevspaceImageIds(env, images, missingNamed, signal)
        : { ids: { own: new Set<string>(), others: new Set<string>() } };
    const ids = read.ids;
    const foreign = ids === undefined ? [] : otherAccountImageItems(named, images, ids, missing);
    if (foreign.length > 0) this.logger.warn(`Image references of ${env.repository} name images of devspaces of another GitHub account: ${capped(foreign).join(', ')}.`);
    if (transient.length > 0 || ids === undefined) {
      const shown =
        transient.length > 0
          ? transient.slice(0, 5).map((reference) => truncated(reference, MAX_ITEM_LENGTH)).join(', ') + (transient.length > 5 ? ` and ${transient.length - 5} more` : '')
          : (read.unread ?? DEVSPACE_IMAGES_UNREAD);
      // A definitive refusal is not hidden by a failure of Docker for another reference: the configuration is refused
      // for it anyway (and an update refused for it is remembered); the failure is logged. A refusal as an image of
      // another account is definitive only with the images of the devspaces read (`ids`).
      if (items.length > 0 || foreign.length > 0) {
        this.logger.warn(`Docker could not check the image references ${shown}; the configuration is refused for the others.`);
        return { unsupported: capped(items), hostAccess: capped(foreign) };
      }
      // A text of its own (dockerCheckItem), not the one of an analysis that could not run.
      throw new AnalysisFailedError({ kind: 'internal', docker: true, reason: shown });
    }
    return { unsupported: capped(items), hostAccess: capped(foreign) };
  }

  /**
   * The IDs of the images of the devspaces on the Docker host of `env` (DevspaceImageIds, devspaceImageIds):
   * the images that Docker lists under a name of a devspace (`<name>:<build>` and `<name>-<service>`,
   * devspaceImageNames), whichever computer built them (so also an older build that is still there, a new one before
   * its build record, and one that a Delete could not remove), split by the owner account of the devspace of the
   * name: the registry entries on the host (and `env` itself), else the labels of the volumes of that devspace on
   * the host (one `docker volume ls`, only when an image that a reference found, `found`, or a reference without a
   * local image, `missingNamed`, has names of which the registry knows none: a devspace that another computer
   * created on a shared host, or an image left behind). An image of no known owner, or of volumes with different owner
   * labels, counts as another account's. One `docker image ls` on each check whose references found a local image or
   * name a devspace image that Docker found missing. `unread`: Docker could not answer (the reason of
   * dockerCheckItem; the caller fails the check, as for a reference: AnalysisFailedError); a cancellation is thrown.
   */
  private async hostDevspaceImageIds(
    env: Devspace,
    found: readonly InspectedImage[],
    missingNamed: readonly string[],
    signal?: AbortSignal,
  ): Promise<{ ids?: DevspaceImageIds; unread?: string }> {
    const unread = (what: string, reason: string, error: unknown): { unread: string } => {
      if (this.isCancellation(error, signal)) {
        this.throwIfCancelled(signal);
        throw error;
      }
      this.logger.warn(`The ${what} on the Docker host could not be read: ${errorMessage(error)}`);
      return { unread: reason };
    };
    this.throwIfCancelled(signal);
    let images: ImageInfo[];
    try {
      images = await this.deps.docker.listDevspaceImages(signal);
    } catch (error) {
      return unread('images of the devspaces', DEVSPACE_IMAGES_UNREAD, error);
    }
    this.throwIfCancelled(signal);
    // The label nimblescape.devspaces.id of each image (one `docker image inspect`).
    let labels: Map<string, Record<string, string>>;
    try {
      labels = images.length === 0 ? new Map() : await this.deps.docker.imageLabelsOf(images.map((image) => image.id), signal);
    } catch (error) {
      return unread('images of the devspaces', DEVSPACE_IMAGES_UNREAD, error);
    }
    this.throwIfCancelled(signal);
    const labelled = images.map((image) => {
      const devspaceId = labels.get(image.id.toLowerCase())?.[LABEL_DEVSPACE_ID];
      return devspaceId === undefined ? image : { ...image, devspaceId };
    });
    const byName = new Map<string, string>();
    const byId = new Map<string, string>();
    for (const entry of [...devspacesOfHost(await this.deps.registry.list(), dockerHostOf(env)), env]) {
      byName.set(resourceName(entry.repository, entry.id).toLowerCase(), entry.owner.id);
      byId.set(entry.id, entry.owner.id);
    }
    const foundIds = new Set(found.map((image) => image.id.toLowerCase()));
    if (hasUnknownDevspace(labelled, missingNamed, { byName, byId }, foundIds)) {
      let volumes: VolumeInfo[];
      try {
        volumes = await this.deps.docker.listDevspaceVolumes(signal);
      } catch (error) {
        return unread('volumes of the devspaces', DEVSPACE_OWNERS_UNREAD, error);
      }
      this.throwIfCancelled(signal);
      const fromVolumes = volumeOwners(volumes);
      for (const [name, owner] of fromVolumes.byName) if (!byName.has(name)) byName.set(name, owner);
      for (const [id, owner] of fromVolumes.byId) if (!byId.has(id)) byId.set(id, owner);
    }
    return { ids: devspaceImageIds(labelled, { byName, byId }, env.owner.id) };
  }

  /**
   * The named volumes of the `mounts` values `mounts` of a Docker Compose configuration (composeMountVolumes),
   * substituted as the Dev Container CLI substitutes them at `up`: the variables of the workspace helper
   * (helperCliVariables, as the host access policy resolves them) and the real `${devcontainerId}` of the devspace
   * (devspaceDevcontainerId), so that our model declares, and the pipeline creates with the labels of the
   * devspace, the volumes that the CLI writes. A source that is still no key of a Compose volume is logged and left
   * to the CLI.
   */
  private composeMountVolumes(env: Devspace, compose: LoadedCompose, mounts: readonly unknown[]): { names: string[]; sources: string[] } {
    // With COMPOSE_PROJECT_NAME, which the pipeline passes to the CLI runs of Docker Compose.
    const variables = { ...helperCliVariables(env.repository, { COMPOSE_PROJECT_NAME: compose.project }), devcontainerId: devspaceDevcontainerId(env.id) };
    const { names, sources, skipped } = composeMountVolumes(compose.project, mounts, variables);
    if (skipped.length > 0) {
      this.logger.info(
        `Volumes of mounts of ${env.repository} whose names are not known before the start (${listSome(skipped.map((source) => JSON.stringify(truncated(source, MAX_ITEM_LENGTH))), 20, ', ')}) are left to the Dev Container CLI: they are not declared in the Docker Compose model and not created with the labels of the devspace.`,
      );
    }
    return { names, sources };
  }

  /** What composeBuildModel and composeUpModel need to know about the devspace. */
  private composeParams(env: Devspace, compose: LoadedCompose, mountVolumeSources: readonly string[]): ComposeRewriteParams {
    return {
      project: compose.project,
      devService: compose.service,
      devspaceId: env.id,
      containerName: env.containerName,
      volumeName: env.volumeName,
      repositoryFolder: repositoryFolder(env.repository),
      // The checked Dockerfile of the dev service, which the build writes.
      dockerfiles: compose.output.dockerfiles,
      ...(compose.engineApiVersion !== undefined ? { engineApiVersion: compose.engineApiVersion } : {}),
      realPaths: compose.output.realPaths,
      ...(compose.output.mountAncestors !== undefined ? { mountAncestors: compose.output.mountAncestors } : {}),
      ...(compose.output.mountCreateTargets !== undefined ? { mountCreateTargets: compose.output.mountCreateTargets } : {}),
      mountVolumeSources,
      hostAccessChecks: compose.hostAccessChecks,
    };
  }

  /**
   * The files of the configuration `configPath`; when it does not exist on the current branch, the files of the first
   * configuration in the volume (`fallback`). `undefined` when the volume has no configuration.
   */
  private async resolveConfigFiles(
    env: Devspace,
    configPath: string,
    signal: AbortSignal | undefined,
    image?: HelperImageUse,
  ): Promise<{ configPath: string; files: ConfigFiles; fallback: boolean } | undefined> {
    const { helper } = this.deps;
    await this.requireVolume(env);
    const files = await helper.readConfigFiles({ volumeName: env.volumeName, repository: env.repository, configPath, image, signal });
    if (files) return { configPath, files: this.limitedConfigFiles(env, configPath, files), fallback: false };
    await this.requireVolume(env);
    const available = await helper.listConfigurations({ volumeName: env.volumeName, repository: env.repository, image, signal });
    if (available.length === 0) return undefined;
    const fallback = available[0];
    await this.requireVolume(env);
    const fallbackFiles = await helper.readConfigFiles({ volumeName: env.volumeName, repository: env.repository, configPath: fallback, image, signal });
    return fallbackFiles ? { configPath: fallback, files: this.limitedConfigFiles(env, fallback, fallbackFiles), fallback: true } : undefined;
  }

  /**
   * A devcontainer.json longer than MAX_CONFIG_TEXT_LENGTH (READ_FILES_SCRIPT reads at most one character more) is
   * refused as too large, before this thread parses or searches it.
   */
  private limitedConfigFiles(env: Devspace, configPath: string, files: ConfigFiles): ConfigFiles {
    if (files.configText.length <= MAX_CONFIG_TEXT_LENGTH) return files;
    const reason = `the configuration ${configPath} is longer than ${MAX_CONFIG_TEXT_LENGTH} characters`;
    this.logger.warn(`The configuration ${configPath} of ${env.repository} is too large to check: ${reason}.`);
    throw tooLargeError(reason);
  }

  /**
   * Stores what the registry needs from the configuration: path, shutdownAction, additional volumes. The path is the
   * source of the devspace (DevspaceSource): a fallback on a branch without its configuration does not replace it, so
   * the devspace keeps its source (its row, its names) and the configuration applies again on a branch that has it.
   * The build record keeps what was built. One exception: without a build record (first open, entry restored from a
   * volume), the other file name of the same configuration at the root (`.devcontainer.json` for
   * `.devcontainer/devcontainer.json`, sameSource) is stored, so that the next open reads it directly.
   */
  private async saveConfiguration(ctx: PipelineContext, loaded: LoadedConfiguration, record: BuildRecord | undefined): Promise<void> {
    // Only the volumes whose labels make them the devspace's own or an additional volume of the same owner
    // (recordedVolumes); the others are never recorded.
    const additionalVolumes = await this.recordedVolumes(loaded.mountedVolumes, ctx.env);
    const sameConfiguration = sameSource({ kind: 'configuration', configPath: loaded.configPath }, { kind: 'configuration', configPath: ctx.configPath });
    const configPath = loaded.fallback && (record !== undefined || !sameConfiguration) ? ctx.configPath : loaded.configPath;
    // The services' volumes are read from the model here, before the write; it only adds them.
    const serviceVolumes = loaded.compose ? composeServiceVolumeNames(loaded.compose.output.model, loaded.compose.project, loaded.compose.service) : undefined;
    const updated = await this.openRecords.configuration(ctx.env.id, {
      select: configPath,
      // The default image of this open of a default-image devspace (the kind of the devspace never changes).
      ...(loaded.defaultImage !== undefined ? { defaultImage: loaded.defaultImage } : {}),
      shutdownActionNone: loaded.config.shutdownAction === 'none',
      // Volumes recorded before stay: the pipeline adds those that it creates before `up` (createAdditionalVolumes), and
      // a volume that the devspace used may still hold its data.
      addVolumes: additionalVolumes,
      // The volumes of the other services of Docker Compose, for the question of Delete (kept once recorded: a volume
      // that a service used holds its data).
      ...(serviceVolumes !== undefined ? { addServiceVolumes: serviceVolumes } : {}),
      // A refused update of another configuration is not tried again anyway.
      keepRefusedFor: { configPath: loaded.configPath, configHash: loaded.configHash },
    });
    this.entryUpdated(ctx, updated);
  }

  /**
   * Whether the configuration hash differs from the build record. Docker Compose: with composeConfigurationChange; when
   * only the version of the Compose plugin (and with it the printed model) changed, the record takes the new model hash
   * and version without a question.
   */
  private async configHashChanged(ctx: PipelineContext, record: BuildRecord, loaded: LoadedConfiguration): Promise<boolean> {
    if (!loaded.compose) return record.configHash !== loaded.configHash;
    const current = { configHash: loaded.configHash, inputsHash: loaded.compose.inputsHash, version: loaded.compose.output.version };
    const change = composeConfigurationChange(record, current);
    if (change !== 'rebaseline') return change === 'changed';
    this.logger.info(
      `The Docker Compose plugin of the workspace helper is now ${current.version} and prints the unchanged files of ${ctx.env.repository} as another model. That is no change of the configuration.`,
    );
    this.entryUpdated(
      ctx,
      await this.openRecords.build(ctx.env.id, { kind: 'rebaseline', devspaceImage: record.devspaceImage, configHash: current.configHash, version: current.version }),
    );
    return false;
  }

  /**
   * Steps 6 and 7: configuration change, image check, and the decision to build. `existing`: the container of the
   * devspace exists, and whether it runs (its update is announced or asked, updateContainer).
   */
  private async planUpdate(
    ctx: PipelineContext,
    loaded: LoadedConfiguration,
    record: BuildRecord | undefined,
    imagePresent: boolean,
    containerExists: boolean,
    existing: { running: boolean } | undefined,
  ): Promise<UpdatePlan> {
    let forced = ctx.forced;
    let skipUpdate = false;
    const changed = record !== undefined && (record.configPath !== loaded.configPath || (await this.configHashChanged(ctx, record, loaded)));
    if (changed && !forced) {
      // A changed default image (the setting) of a default-image devspace: the question names it.
      const what: ConfigurationChangeKind | undefined =
        record.defaultImage !== undefined && loaded.defaultImage !== undefined && record.defaultImage !== loaded.defaultImage ? 'defaultImage' : undefined;
      this.logger.info(
        what === 'defaultImage'
          ? `The default image of ${ctx.env.repository} changed since the last build: ${record.defaultImage} → ${loaded.defaultImage}.`
          : `The configuration of ${ctx.env.repository} changed since the last build.`,
      );
      const answer = await this.deps.ui.configurationChanged(ctx.env.repository, what);
      this.throwIfCancelled(ctx.signal);
      if (answer === 'rebuildNow') forced = true;
      else skipUpdate = true;
      this.logger.info(answer === 'rebuildNow' ? 'Rebuild now.' : 'Rebuild later: no update this time.');
    }

    const input = { hasRecord: record !== undefined, imagePresent, forced, skipUpdate };
    let check: ImageCheckState = { kind: 'skipped' };
    if (shouldCheckImages({ ...input, updateImagesOnConnect: this.deps.settings().updateImagesOnConnect })) {
      // A rebuild asks the registry itself for every reference (no answer of the Monitor).
      check = await this.checkImages(ctx, loaded, record, imagePresent || containerExists, forced);
    }
    // An update whose new image the host access policy refused is not built again for the same digests and
    // configuration; the existing devspace starts. A changed digest or configuration, or a rebuild, tries again.
    // Before a refused update counts as up to date below. The user saw the warning at the refusal
    // (rememberRefusedUpdate); the later opens of the same refused update only log it, so the warning does not come at
    // every open.
    const newerImages = check.kind === 'checked' && !check.upToDate;
    const refused = refusedUpdateOf(ctx.env);
    const refusedAgain =
      !forced &&
      record !== undefined &&
      imagePresent &&
      check.kind === 'checked' &&
      !check.upToDate &&
      isRefusedUpdate(refused, this.updateKey(ctx, loaded, record, check.outcome));
    if (refusedAgain && refused && check.kind === 'checked') {
      this.logger.info(
        refused.reason === 'size'
          ? `The update of ${ctx.env.repository} is too large or too complex to check (${refused.items}). The existing devspace is used.`
          : `The update of ${ctx.env.repository} was refused by the host access policy (${refused.items}). The existing devspace is used.`,
      );
      check = { ...check, upToDate: true, changedImages: [], changedFeatures: [] };
    }
    let build = needsBuild({ ...input, check, containerExists });
    let updateAvailable = check.kind === 'checked' && !check.upToDate && !skipUpdate;
    // The update of an existing container, running or stopped (only an update: not a rebuild, not a first build, not a
    // missing image), is announced (`notify`: Continue or Cancel) or asked (`ask`: Update Now or Later), before
    // anything is changed.
    let postponed = false;
    if (build && updateAvailable && !forced && record !== undefined && imagePresent && existing !== undefined) {
      const answer = await this.deps.ui.updateContainer(ctx.env.repository, existing.running);
      this.throwIfCancelled(ctx.signal);
      if (answer === 'cancel') {
        this.logger.info(`Decision for ${ctx.env.repository}: no build (the update of its container was cancelled; nothing was changed, and the window is not connected).`);
        this.deps.ui.info(Messages.containerUpdateCancelled(ctx.env.repository));
        throw cancelledError();
      }
      if (answer === 'later') {
        build = false;
        updateAvailable = false;
        postponed = true;
      }
    }
    const reason = forced
      ? 'rebuild requested'
      : check.kind === 'unreachable' && !build
        ? 'no connection to the registry, the existing container is started'
        : !record
        ? 'no devspace image yet'
        : !imagePresent
          ? 'the devspace image is missing'
          : updateAvailable
            ? 'a newer image is available'
            : postponed
              ? 'update postponed'
              : refusedAgain
              ? refused?.reason === 'size'
                ? 'the newer image is too large or too complex to check'
                : 'the newer image needs access to the computer'
              : 'up to date';
    // A new devspace image is a prepared one when it fits (preparedImage logs that), else a build.
    this.logger.info(`Decision for ${ctx.env.repository}: ${build ? 'a new devspace image' : 'no build'} (${reason}).`);
    return { check, build, forced, updateAvailable, current: !changed && !newerImages && !forced };
  }

  /**
   * Whether the devspace image of `record` exists with the ID that the record pins (BuildRecord.imageId). An image
   * under that name with another ID (or a record without a pinned ID) was not built or taken over by this computer: it
   * is not used, and the open builds again (the build removes the other tags of the devspace image).
   */
  private async pinnedImagePresent(record: BuildRecord): Promise<boolean> {
    const id = await this.deps.docker.imageId(record.devspaceImage);
    if (id === undefined) return false;
    if (record.imageId !== undefined && id.toLowerCase() === record.imageId.toLowerCase()) return true;
    this.logger.warn(`The devspace image ${record.devspaceImage} has the ID ${id}, not the ID of its build record (${record.imageId ?? 'none'}). It is not used.`);
    return false;
  }

  /**
   * The image to create `container` again from without its build record: its name when that still names the image the
   * container was created from (ContainerInfo.imageId), else that image by its ID (an image swapped under the name is
   * never used); undefined when the image is gone or cannot be read.
   */
  private async containerImage(container: ContainerInfo): Promise<string | undefined> {
    if (container.image === '') return undefined;
    const named = await this.deps.docker.imageId(container.image).catch(() => undefined);
    if (container.imageId === undefined) return named !== undefined ? container.image : undefined;
    if (named !== undefined && named.toLowerCase() === container.imageId.toLowerCase()) return container.image;
    const own = await this.deps.docker.imageId(container.imageId).catch(() => undefined);
    if (own === undefined) return undefined;
    this.logger.warn(`The name ${container.image} no longer names the image of the container ${container.name} (${container.imageId}); that image is used by its ID.`);
    return container.imageId;
  }

  /**
   * The build record of the newest devspace image of `ctx.env` (the highest build number of
   * devspaceImageRepository), from its labels (imageBuildRecord: its devspace ID, repository, and owner must be
   * those of the devspace, and the record must name that image), with the ID of that image pinned. The record is
   * written to the entry. `undefined` when there is no such image or its labels do not fit (the open builds, as without
   * a record). Only the image of the devspace's own ID: never an image without the volume of its ID.
   */
  private async adoptImageRecord(ctx: PipelineContext): Promise<BuildRecord | undefined> {
    const env = ctx.env;
    const found = await this.newestImageRecord(env);
    if ('reason' in found) {
      if (found.warning !== undefined) this.logger.warn(found.warning);
      return undefined;
    }
    const { record, tag } = found;
    this.entryUpdated(ctx, await this.openRecords.build(ctx.env.id, { kind: 'record', record, dropRefused: false }));
    this.logger.info(`The build record of ${env.repository} was taken from its devspace image ${tag} (${record.imageId}).`);
    return record;
  }

  /**
   * The build record of the newest devspace image of `env` (the highest build number of devspaceImageRepository),
   * from its labels (imageBuildRecord), with the ID of that image pinned; else why there is none (`reason`), and the
   * warning of the open when that is worth one (`warning`). A Docker failure only means that there is no record. Apart
   * from adoptImageRecord, for the prepare (the approved record).
   */
  private async newestImageRecord(env: Devspace): Promise<{ record: BuildRecord; tag: string } | { reason: string; warning?: string }> {
    const repository = devspaceImageRepository(env.repository, env.id);
    let tags: string[];
    try {
      tags = await this.deps.docker.listImageTags(repository);
    } catch (error) {
      const warning = `The tags of ${repository} could not be listed: ${errorMessage(error)}`;
      return { reason: warning, warning };
    }
    const newest = tags.map((tag) => ({ tag, number: Number(tag.slice(repository.length + 1)) })).filter((entry) => Number.isSafeInteger(entry.number) && entry.number > 0).sort((a, b) => b.number - a.number)[0];
    if (newest === undefined) return { reason: 'it has no devspace image' };
    // As for the tags, a Docker failure only means that no record is taken over.
    let id: string | undefined;
    let labels: Record<string, string> | undefined;
    try {
      id = await this.deps.docker.imageId(newest.tag);
      labels = id === undefined ? undefined : await this.deps.docker.imageLabels(id);
    } catch (error) {
      const warning = `The labels of ${newest.tag} could not be read: ${errorMessage(error)}`;
      return { reason: warning, warning };
    }
    const found = labels === undefined ? undefined : imageBuildRecord(labels, env, newest.tag, newest.number);
    if (id === undefined || found === undefined) {
      const why = found === undefined ? 'its labels do not fit' : 'it is gone';
      return {
        reason: `its devspace image ${newest.tag} has no build record of it (${why})`,
        warning: `The devspace image ${newest.tag} has no build record of ${env.repository} (${why}). The devspace is built again.`,
      };
    }
    return { record: { ...found, imageId: id }, tag: newest.tag };
  }

  /**
   * Step 7: digests of the registries, compared with the build record. `localDevspace`: a devspace image or a
   * container exists, which starts without a registry. The digest of an image reference whose answer of the Session
   * Monitor's registry check is fresh (monitorDigests) is that answer; the open asks the registry only for the other
   * references (with the credentials of the computer), and not at all when there are none. `fresh`: the open asks the
   * registry for every reference (a rebuild).
   */
  private async checkImages(
    ctx: PipelineContext,
    loaded: Pick<LoadedConfiguration, 'references'>,
    record: BuildRecord | undefined,
    localDevspace: boolean,
    fresh = false,
  ): Promise<ImageCheckState> {
    ctx.steps.step('checkingImage');
    let outcome: CheckOutcome;
    try {
      const monitor = fresh ? undefined : await this.monitorDigests(ctx, loaded.references.images);
      const own: ConfigReferences = monitor === undefined ? loaded.references : { images: monitor.others, features: loaded.references.features };
      const asked = own.images.length > 0 || own.features.length > 0 || monitor === undefined;
      outcome = asked
        ? await this.deps.imageChecker.check(own, { signal: ctx.signal })
        : { status: 'checked', images: {}, features: {}, authRequired: [], failed: [] };
      if (monitor !== undefined && outcome.status === 'checked') outcome = { ...outcome, images: { ...monitor.digests, ...outcome.images } };
    } catch (error) {
      if (this.isCancellation(error, ctx.signal)) throw error;
      this.logger.error('The image check failed. The update step is skipped.', error);
      return { kind: 'unreachable' };
    }
    if (outcome.status === 'unreachable') {
      const registries = outcome.registries.map(registryDisplayName).join(', ');
      this.logger.info(`No connection to ${registries}. The update step is skipped.`);
      if (localDevspace) this.deps.ui.info(Messages.registryUnreachable);
      return { kind: 'unreachable' };
    }
    for (const registry of outcome.authRequired) this.deps.ui.registrySignIn(registryDisplayName(registry));
    const comparison = compareWithBuildRecord(record, outcome);
    if (!comparison.upToDate) {
      const changed = [...comparison.changedImages, ...comparison.changedFeatures];
      this.logger.info(`Changed since the last build: ${changed.length > 0 ? changed.join(', ') : '(no build record)'}`);
    }
    return { kind: 'checked', outcome, ...comparison };
  }

  /**
   * The image references of `images` whose answer of the Monitor's registry check is fresh
   * (freshRegistryDigests: younger than the time between two runs of its schedule plus REGISTRY_ANSWER_SLACK_MS), with
   * their digests, and the others (`others`), which the open checks itself; `undefined` when no answer is used (none
   * fresh, no file, or no reference). Never throws (a failed read is no answer).
   */
  private async monitorDigests(ctx: PipelineContext, images: readonly string[]): Promise<{ digests: Record<string, string>; others: string[] } | undefined> {
    if (images.length === 0 || this.deps.registryAnswers === undefined) return undefined;
    const answers = await this.deps.registryAnswers().catch(() => undefined);
    this.throwIfCancelled(ctx.signal);
    if (answers === undefined) return undefined;
    const fresh = freshRegistryDigests(answers, images, this.deps.clock.now());
    if (fresh.oldest === undefined) return undefined;
    this.logger.info(`The Monitor's registry check of ${answerTimeText(fresh.oldest, answers.timeZone)} is used.`);
    if (fresh.others.length > 0) this.logger.info(`The registry is asked for the image references without a fresh answer of the Monitor: ${listSome(fresh.others, 20)}.`);
    return { digests: fresh.digests, others: fresh.others };
  }

  /** What identifies an update (RefusedUpdate): the configuration and the digests that the new build record would get. */
  private updateKey(
    ctx: PipelineContext,
    loaded: LoadedConfiguration,
    record: BuildRecord | undefined,
    outcome: CheckedOutcome,
  ): Omit<RefusedUpdate, 'items'> {
    return {
      configPath: loaded.configPath,
      configHash: loaded.configHash,
      images: recordDigests(loaded.references.images, outcome.images, record?.images),
      features: recordDigests(loaded.references.features, outcome.features, record?.features),
      // The switch of the host access checks is part of the update: a refusal with one state does not block the other.
      ...(ctx.hostAccessChecks === 'off' ? { hostAccessChecks: 'off' as const } : {}),
    };
  }

  /**
   * Step 8, the update order: pull, build, replace the container, write the build record, remove the old images. A
   * working container is never removed before the new devspace image is ready. Returns `undefined` when the pull or
   * the build failed and the old container or image is used instead.
   */
  private async buildAndReplace(
    ctx: PipelineContext,
    loaded: LoadedConfiguration,
    plan: UpdatePlan,
    record: BuildRecord | undefined,
    imagePresent: boolean,
    container: ContainerInfo | undefined,
  ): Promise<ContainerOutcome | undefined> {
    const env = ctx.env;
    const oldImageUsable = record !== undefined && imagePresent;
    // A container of an older setup is no fallback by itself: it must be created again, from an image that exists.
    const containerUsable =
      container !== undefined &&
      (containerIsCurrent(container.labels, true, ctx.hostAccessChecks) ||
        (await this.containerImage(container)) !== undefined);
    const canFallBack = containerUsable || oldImageUsable;
    // An update that only follows newer digests keeps the old devspace when a download fails. Otherwise a build is
    // needed anyway, and an image that exists locally is good enough when its download fails.
    const toleratePullFailure = !(oldImageUsable && !plan.forced);
    await this.markBusy(ctx, ctx.firstOpen ? 'create' : plan.forced ? 'rebuild' : 'update');

    // An update takes the image that a background prepare built for it, without a pull and a build; every check of the
    // new image before `up` stays (runUp).
    const prepared = await this.preparedImage(ctx, loaded, plan, record, imagePresent);
    const stale = new Set<string>();
    // Docker Compose pulls as without a prepare, with the credentials of the computer: the prepare pulled only the base
    // images of the dev service (the same digests again: no download), and the images of the other services (for
    // example `postgres:16`) and the bases of their builds change only now, after Continue or Update Now.
    const pulls =
      prepared !== undefined && loaded.compose === undefined
        ? []
        : imagesToPull({
            images: loaded.references.images,
            check: plan.check,
            hasRecord: record !== undefined,
            imagePresent,
            forced: plan.forced,
          });
    if (pulls.length > 0) {
      ctx.steps.step('downloadingImage');
      // The reason, when the comparison with the build record found a newer image.
      if (record !== undefined && plan.updateAvailable) ctx.steps.detail(Messages.newerImage);
      try {
        for (const reference of pulls) await this.pull(ctx, reference, toleratePullFailure, stale);
      } catch (error) {
        return this.updateFailed(ctx, error, canFallBack, plan.check);
      }
    }

    ctx.steps.step('preparing');
    const buildNumber = await this.nextBuildNumber(env);
    const imageName = devspaceImageName(env.repository, env.id, buildNumber);
    this.entryUpdated(ctx, await this.openRecords.build(ctx.env.id, { kind: 'number', buildNumber }));
    // The build record of the new image, before the build, so that the image carries it (imageRecordLabels); its pinned
    // ID follows after the labels.
    const current = plan.check.kind === 'checked' ? plan.check.outcome : undefined;
    const builtRecord: BuildRecord = {
      builtAt: isoTime(this.deps.clock),
      devspaceImage: imageName,
      buildNumber,
      configPath: loaded.configPath,
      configHash: loaded.configHash,
      ...(loaded.defaultImage !== undefined ? { defaultImage: loaded.defaultImage } : {}),
      images: recordDigests(loaded.references.images, current?.images, record?.images, stale),
      features: recordDigests(loaded.references.features, current?.features, record?.features),
      ...(loaded.compose
        ? {
            compose: {
              service: loaded.compose.service,
              images: builtServiceImages(loaded.compose.output.model, loaded.compose.project, loaded.compose.service),
              serviceImages: composeServiceImageReferences(loaded.compose.output.model, loaded.compose.service),
              version: loaded.compose.output.version,
              inputsHash: loaded.compose.inputsHash,
              // The paths that other services mount are in Devspace.serviceFolders.
            },
          }
        : {}),
    };
    let builtImageId: string;
    try {
      await this.requireVolume(env);
      builtImageId =
        prepared !== undefined ? await this.takePreparedImage(ctx, prepared, imageName, builtRecord) : await this.buildDevspaceImage(ctx, loaded, imageName, builtRecord);
    } catch (error) {
      // The helper image of the open is gone; no "started instead" and no buildFailed.
      if (isHelperFailed(error)) return this.helperFailedInUpdate(ctx, error);
      return this.updateFailed(ctx, error, canFallBack, plan.check);
    }

    // Replace the container, with the same workspace volume.
    ctx.steps.step('starting');
    // A newer image names the replacement already (Messages.newerImage); otherwise the user learns it here.
    if (container !== undefined && !containerIsCurrent(container.labels, true, ctx.hostAccessChecks) && !plan.updateAvailable) {
      this.announceRecreation(ctx, container);
    }
    let result: DevcontainerResult;
    try {
      result = await this.runUp(ctx, imageName, loaded.config, container !== undefined, true, loaded.compose);
    } catch (error) {
      if (error instanceof AnalysisFailedError) {
        // The check of the new image failed (for example a worker that ran out of time on a busy computer): no refusal
        // of the policy, so the update is not remembered as refused; the next open tries again.
        await this.quietly(`remove the image ${imageName}`, () => this.deps.docker.removeImage(imageName));
        if (!canFallBack) throw error;
        // A size limit fails the same update the same way at every open: remembered, with its own text, like a refused
        // update (a changed digest or configuration, or a rebuild, tries again). A time or memory limit and an internal
        // failure stay not remembered.
        if (error.failure.kind === 'size') {
          await this.rememberRefusedUpdate(ctx, loaded, record, plan.check, error, 'size');
          return undefined;
        }
        this.logger.warn(`The new devspace image of ${env.repository} could not be checked. The existing devspace is started; the next open tries the update again.`);
        this.deps.ui.warn(Messages.updateCheckFailed(error.item));
        return undefined;
      }
      if (isHostAccess(error)) {
        // The new image needs access to the computer (for example a Feature of a newer version): it is not used. The
        // check runs before `up`, so the old container is unchanged. Like a failed update, the devspace starts with
        // the old container or image; without them, the open ends here.
        await this.quietly(`remove the image ${imageName}`, () => this.deps.docker.removeImage(imageName));
        if (!canFallBack) throw error;
        await this.rememberRefusedUpdate(ctx, loaded, record, plan.check, error);
        return undefined;
      }
      if (this.isCancellation(error, ctx.signal) || isFilesMissing(error)) throw error;
      // The helper image of the open is gone; the new image is not the cause.
      const helperFailed = isHelperFailed(error);
      if (helperFailed) ctx.helperUnavailable = true;
      else this.logger.error(`The container of ${env.repository} could not be created from ${imageName}.`, error);
      // The build switched the kind of the devspace (Docker Compose or a single container). The previous kind is not
      // started from here: its image is not an image of the new kind, and the configuration is of the new kind. The
      // next build tries again. The kind as existingCompose decides it.
      const previousCompose = this.existingCompose(ctx, record);
      // A helperFailed before the switch removed or moved a container (and before `up` ran) ends the open without the
      // detail of a switch (helperFailedInUpdate: never opened as it is).
      if (helperFailed && (ctx.kindSwitchRemoved ?? []).length === 0 && ctx.devServiceMoved !== true && ctx.upStarted !== true) {
        await this.quietly(`remove the image ${imageName}`, () => this.deps.docker.removeImage(imageName));
        return this.helperFailedInUpdate(ctx, error);
      }
      if ((record !== undefined || container !== undefined) && previousCompose !== (loaded.compose !== undefined)) {
        await this.quietly(`remove the image ${imageName}`, () => this.deps.docker.removeImage(imageName));
        // The containers that the failed `up` of Docker Compose created (for example of a database) go, so that no
        // later `up` of a single container takes one of them for its dev container (they carry the ID label). Their
        // volumes stay. Only when the single container was removed in this run, and only those that did not exist
        // before `up` (an earlier switch that was cancelled may have created containers that the user worked with
        // since).
        const failed = loaded.compose !== undefined ? await this.removeFailedComposeContainers(ctx) : { removed: [], kept: [], removedIds: [] };
        // `up` returned, and the lifecycle commands of its container could not run: runUp or runComposeUp removed (or
        // stopped) that container already (withdrawAfterHelperFailed), and the detail says so.
        let withdrawn = helperFailed ? ctx.upWithdrawn : undefined;
        let removedAgain = failed.removed;
        // removeFailedComposeContainers removed the dev container that withdrawAfterHelperFailed only stopped (or
        // kept): it was removed, and it is not named again among the others.
        const index = withdrawn !== undefined ? failed.removedIds.findIndex((id) => sameContainer(id, withdrawn!.id)) : -1;
        if (withdrawn !== undefined && index >= 0) {
          await this.clearLifecycleMark(ctx, withdrawn.id);
          withdrawn = { outcome: 'removed', id: withdrawn.id, created: withdrawn.created, name: withdrawn.name };
          removedAgain = failed.removed.filter((_, other) => other !== index);
        }
        const detail = kindSwitchFailure(
          loaded.compose !== undefined,
          ctx.kindSwitchRemoved ?? [],
          helperFailed ? causeOf(error) : errorDetail(error),
          removedAgain,
          failed.kept,
          withdrawn !== undefined ? withdrawnOutcome(withdrawn, true) : undefined,
          // runUp ran with --remove-existing-container only when there was a container.
          container !== undefined,
          // "created or started" when the listing before `up` failed.
          withdrawn !== undefined ? createdOrStarted(withdrawn) : undefined,
          // A (dev) container that ran before `up` "runs already".
          withdrawn?.ranBefore === true,
        );
        // The cleanup of the switch above stays (the containers of the other kind are gone, so nothing opens as it is),
        // but the open ends with helperFailed, with the detail of the switch.
        if (helperFailed) {
          this.logger.error(`The workspace helper is not available for ${env.repository}. The switch of its configuration could not be completed.`, error);
          throw helperFailedError(error, detail);
        }
        throw new UserFacingError('startFailed', PipelineTexts.startFailed, detail);
      }
      // The build switched the dev service of the Docker Compose project (a changed `service` in the compose
      // configuration of the devspace). The previous dev container was renamed out of the way and stopped
      // (movePreviousDevContainer); an `up` with the new configuration would take it for another service (and Compose
      // would create it again, losing its files outside the volumes). It stays as it is, stopped: the previous
      // configuration stays selected (open), so the next open starts it again. The next build tries again. The guard
      // follows what happened in this run (movePreviousDevContainer moved the previous dev container), with the service
      // from its label; the build record only adds to it, read by its key (an older record that composeRecordOf
      // rejects, or none, must not skip the guard: the restore would run `up` with the new configuration next to the
      // renamed previous dev container, whose files outside the volumes would be lost).
      const moved = ctx.devServiceMoved === true || ctx.previousDevContainer !== undefined;
      const previousService = ctx.previousDevContainer?.service ?? ctx.devServiceMovedFrom ?? recordedComposeService(record);
      if (
        loaded.compose !== undefined &&
        previousService !== undefined &&
        (moved || previousService !== loaded.compose.service)
      ) {
        await this.quietly(`remove the image ${imageName}`, () => this.deps.docker.removeImage(imageName));
        if (ctx.previousDevContainer?.removed !== true) {
          this.logger.info(`The previous dev container of the service ${previousService} of ${env.repository} is kept, stopped; it is not started with the configuration of the service ${loaded.compose.service}.`);
        }
        // The helper image of the open is gone: helperFailed, with the detail of the switch.
        if (helperFailed) {
          this.logger.error(`The workspace helper is not available for ${env.repository}. The switch of its dev service could not be completed.`, error);
          // After `up` returned, the dev container of the new service (its lifecycle commands did not run) was removed
          // already (withdrawAfterHelperFailed); the detail says what happened to it and to the previous dev container.
          const change = `The dev service changed from ${previousService} to ${loaded.compose.service}.`;
          const previous = await this.previousDevContainerAfterFailedSwitch(ctx, previousService);
          const withdrawn = ctx.upWithdrawn;
          throw helperFailedError(
            error,
            withdrawn !== undefined
              ? // afterUpClause, "runs already" for a container that ran before `up`.
                `${change} ${afterUpClause(`The dev container of the service ${loaded.compose.service}`, withdrawn)} ${withdrawnOutcome(withdrawn, true)} ${previous} The previous configuration stays selected. ${causeOf(error)}`
              : `${change} ${previous} ${causeOf(error)}`,
          );
        }
        throw new UserFacingError('startFailed', PipelineTexts.startFailed, errorDetail(error));
      }
      // The helper image of the open is gone, so the old devspace image cannot be started either (that needs the
      // helper too): no buildFailed warning and no restore; the open ends with helperFailed (not startFailed: a running
      // container is not opened as it is).
      if (helperFailed) {
        // `up` returned (the helperFailed branch above takes the rest), and the lifecycle commands of its container did
        // not run. runUp or runComposeUp removed that container already (withdrawAfterHelperFailed; stopped when the
        // removal failed), so that the next open creates (or starts) it again with all lifecycle commands, instead of
        // opening it as it is. Then the new image can be removed, too.
        const withdrawn = ctx.upWithdrawn;
        await this.quietly(`remove the image ${imageName}`, () => this.deps.docker.removeImage(imageName));
        return this.helperFailedInUpdate(ctx, error, withdrawn !== undefined ? this.updateWithdrawnDetail(ctx, withdrawn, container, error) : undefined);
      }
      // Assumption: `up --remove-existing-container` removes the old container before it creates the new one, so after
      // a failure the old container may be gone. It is created again from the old devspace image.
      const previousImage =
        oldImageUsable && record
          ? record.devspaceImage
          : container
            ? await this.containerImage(container)
            : undefined;
      if (!previousImage) throw new UserFacingError('startFailed', PipelineTexts.startFailed, errorDetail(error));
      this.deps.ui.warn(Messages.buildFailed);
      // The old container is started when it still exists; a missing or half-created one is replaced.
      const survivor = await this.deps.docker.findContainer(env.id, env.containerName).catch(() => undefined);
      const keep =
        // previousImage may be the ID of the container's image (containerImage).
        survivor !== undefined && (survivor.image === previousImage || survivor.imageId === previousImage) && containerIsCurrent(survivor.labels, true, ctx.hostAccessChecks);
      this.logger.info(
        keep
          ? `The previous container ${survivor.name} is started again.`
          : `The container is created again from the previous devspace image ${previousImage}.`,
      );
      await this.quietly(`remove the image ${imageName}`, () => this.deps.docker.removeImage(imageName));
      try {
        result = await this.runUp(ctx, previousImage, loaded.config, !keep, !keep, loaded.compose);
      } catch (restoreError) {
        if (this.isCancellation(restoreError, ctx.signal) || isFilesMissing(restoreError) || isHostAccess(restoreError)) throw restoreError;
        // The helper image of the open is gone: helperFailed, not startFailed. When the restore's `up` returned, its
        // container (whose lifecycle commands did not run) was removed or stopped (withdrawAfterHelperFailed), and the
        // detail says so.
        if (isHelperFailed(restoreError)) {
          const withdrawn = ctx.upWithdrawn;
          const detail =
            withdrawn === undefined
              ? undefined
              : withdrawn.ranBefore === true
                ? // It ran before this open, so this `up` did not start it (as in Step 9); the next open runs its
                  // lifecycle commands only while the mark names it.
                  withdrawn.outcome !== 'unchanged'
                  ? `The update failed. The previous container runs; its lifecycle commands could not run. ${withdrawnOutcome(withdrawn)} ${causeOf(restoreError)}`
                  : withdrawn.marked === true
                    ? `The update failed. The previous container runs; its lifecycle commands could not run and run at the next open. ${causeOf(restoreError)}`
                    : `The update failed. The previous container runs as before this open. ${causeOf(restoreError)}`
                : keep
                  ? `The update failed, and the previous container was started again, but its lifecycle commands could not run. ${withdrawnOutcome(withdrawn)} ${causeOf(restoreError)}`
                  : `The update failed, and the container was created again from the previous devspace image, but its lifecycle commands could not run. ${withdrawnOutcome(withdrawn)} ${causeOf(restoreError)}`;
          return this.helperFailedInUpdate(ctx, restoreError, detail);
        }
        throw new UserFacingError('startFailed', PipelineTexts.startFailed, errorDetail(restoreError));
      }
      return keep ? { result, created: false, container: survivor } : { result, created: true };
    }

    // The new build record (with the ID of the labelled image), then the old images go.
    const newRecord: BuildRecord = { ...builtRecord, imageId: builtImageId };
    this.entryUpdated(ctx, await this.openRecords.build(ctx.env.id, { kind: 'record', record: newRecord, dropRefused: true }));
    this.logger.info(`New devspace image of ${env.repository}: ${imageName}.`);
    // A prepared image replaced the build of the dev service, so its `<project>-<service>` of the last build is an old
    // image: it goes with the old images (the next build makes it again; nothing runs from it).
    const devServiceImage = prepared !== undefined && loaded.compose !== undefined ? composeServiceImage(loaded.compose.project, loaded.compose.service) : undefined;
    await this.removeDevspaceImages(ctx.env, imageName, record, (newRecord.compose?.images ?? []).filter((image) => image !== devServiceImage));
    return { result, created: true };
  }

  /**
   * Step 8: builds the devspace image `imageName` with the build record `record` on its labels; resolves with the ID
   * that the record pins. Apart from buildAndReplace, which takes a prepared image instead when it fits.
   */
  private async buildDevspaceImage(ctx: PipelineContext, loaded: LoadedConfiguration, imageName: string, record: BuildRecord): Promise<string> {
    const env = ctx.env;
    this.logger.info(`Building the devspace image ${imageName} of ${env.repository}.`);
    await this.deps.helper.build({
      volumeName: env.volumeName,
      repository: env.repository,
      configPath: loaded.configPath,
      imageName,
      // Docker Compose builds our copy of the configuration; the default image its synthesized configuration.
      ...(loaded.compose ? this.composeBuildOptions(env, loaded.compose) : this.defaultImageBuildOptions(loaded)),
      // Only masked in the build's output, like for `up`.
      token: ctx.session.token,
      onOutput: this.output,
      image: ctx.helperImage,
      signal: ctx.signal,
    });
    // The container is made only from an image that the engine has (a build that ended without its image, for example
    // on a remote host whose connection broke at the end, is a failed build). When the check itself fails, the built
    // image is removed like after any later failure.
    const present = await this.deps.docker.imageExists(imageName).catch(async (error: unknown) => {
      await this.quietly(`remove the image ${imageName}`, () => this.deps.docker.removeImage(imageName));
      throw error;
    });
    if (!present) throw new Error(`The devspace image ${imageName} is missing after the build.`);
    // The labels of the devspace image (its devspace ID, repository, owner, and build record), and its ID after
    // them, which the record pins. A failure removes the image like a failed build.
    return this.labelDevspaceImage(ctx, imageName, imageRecordLabels(env, record));
  }

  /** Gives the devspace image `imageName` the labels `labels` and resolves with its ID after them; a failure removes it. */
  private async labelDevspaceImage(ctx: PipelineContext, imageName: string, labels: Record<string, string>): Promise<string> {
    try {
      await this.deps.docker.labelImage(imageName, labels, ctx.signal);
      const id = await this.deps.docker.imageId(imageName);
      if (id === undefined) throw new Error(`The devspace image ${imageName} is missing after its labels.`);
      return id;
    } catch (error) {
      if (!this.isCancellation(error, ctx.signal)) await this.quietly(`remove the image ${imageName}`, () => this.deps.docker.removeImage(imageName));
      throw error;
    }
  }

  /**
   * The ID of the prepared devspace image (preparedImageName) that this update takes instead of a pull and a build,
   * or `undefined`: the open builds the image. Only for an update that the image check found for an existing
   * devspace image (not a rebuild, a first build, or a missing image), after the answer Continue or Update Now
   * (updateContainer); for Docker Compose too (the prepared image is the devspace image of the dev service; the open
   * pulls the images of the other services and `up` builds and recreates them as without a prepare); never with the
   * host access checks off. A prepare that runs (its prepare lock is held) is waited for, with its detail (until it
   * ends, without a limit of its own, since the prepare stops itself after PREPARE_LIMIT_MS; the detail names the
   * minutes of the wait); a cancel ends the open. The image must fit (preparedImageMismatch): the labels of the
   * devspace, the key of this update (updateKey: the configuration and the digests that this open checked), and the
   * helper image of this open. The image comes from the engine: its labels only skip the build, and the image is
   * checked before `up` as any new devspace image (runUp, checkImageHostAccess). One that does not fit is left; the
   * removal of the old images at the end of the update removes it.
   */
  private async preparedImage(
    ctx: PipelineContext,
    loaded: LoadedConfiguration,
    plan: UpdatePlan,
    record: BuildRecord | undefined,
    imagePresent: boolean,
  ): Promise<string | undefined> {
    if (plan.forced || !plan.updateAvailable || record === undefined || !imagePresent || plan.check.kind !== 'checked') return undefined;
    // Docker Compose too (its key has the hash of the model and the digests of every service).
    if (ctx.hostAccessChecks !== 'on') return undefined;
    const env = ctx.env;
    const name = preparedImageName(env.repository, env.id);
    const prepareLock = this.deps.prepareLock;
    if (prepareLock !== undefined && (await prepareLock.held(env.id, ctx.signal))) {
      this.logger.info(`A newer image of ${env.repository} is being prepared. The update waits for it.`);
      ctx.steps.detail(PipelineTexts.preparingNewerImage(0));
      // Until the prepare ends (it stops itself after PREPARE_LIMIT_MS), in waits of PREPARE_WAIT_STEP_SECONDS, after
      // each of which the detail names the minutes; a cancel ends it.
      let waits = 0;
      while (!(await prepareLock.waitFree(env.id, PREPARE_WAIT_STEP_SECONDS, ctx.signal))) {
        this.throwIfCancelled(ctx.signal);
        waits += 1;
        ctx.steps.detail(PipelineTexts.preparingNewerImage(Math.floor((waits * PREPARE_WAIT_STEP_SECONDS) / 60)));
      }
      this.throwIfCancelled(ctx.signal);
      this.logger.info(`The prepare of the newer image of ${env.repository} ended (the update waited about ${Math.floor((waits * PREPARE_WAIT_STEP_SECONDS) / 60)} min).`);
    }
    let id: string | undefined;
    let labels: Record<string, string> | undefined;
    try {
      id = await this.deps.docker.imageId(name);
      // By its ID, so that the image whose labels were read is the one that is used.
      labels = id === undefined ? undefined : await this.deps.docker.imageLabels(id);
    } catch (error) {
      if (this.isCancellation(error, ctx.signal)) throw error;
      this.logger.warn(`The prepared image ${name} could not be read: ${errorMessage(error)}`);
      return undefined;
    }
    if (id === undefined || labels === undefined) return undefined;
    const mismatch = preparedImageMismatch(labels, env, this.updateKey(ctx, loaded, record, plan.check.outcome), ctx.helperImage?.id);
    if (mismatch !== undefined) {
      this.logger.info(`The prepared image ${name} is not used for ${env.repository}: ${mismatch}. The devspace image is built.`);
      return undefined;
    }
    this.logger.info(`The prepared image ${name} (${id}) fits the update of ${env.repository}: it is used without a build.`);
    return id;
  }

  /**
   * Makes the prepared image with the ID `preparedId` the devspace image `imageName` of the update: its tag, the
   * labels of the devspace image with the build record `record` (LABEL_PREPARED set empty: the labels of an image
   * can only be added to), and then the tag of the prepared image goes. Resolves with the ID that the record pins (the
   * labels make a new image). A failure removes `imageName` again, like a failed build.
   */
  private async takePreparedImage(ctx: PipelineContext, preparedId: string, imageName: string, record: BuildRecord): Promise<string> {
    const env = ctx.env;
    ctx.steps.detail(Messages.newerImage);
    try {
      await this.deps.docker.tagImage(preparedId, imageName, ctx.signal);
    } catch (error) {
      // The engine may have tagged it although the answer failed.
      if (!this.isCancellation(error, ctx.signal)) await this.quietly(`remove the image ${imageName}`, () => this.deps.docker.removeImage(imageName));
      throw error;
    }
    const id = await this.labelDevspaceImage(ctx, imageName, { ...imageRecordLabels(env, record), [LABEL_PREPARED]: '' });
    const prepared = preparedImageName(env.repository, env.id);
    await this.quietly(`remove the image ${prepared}`, () => this.deps.docker.removeImage(prepared));
    return id;
  }

  // -------------------------------------------------------------------------------------------------------------------
  // The headless prepare

  /**
   * The headless prepare of the next devspace image of the devspace `devspaceId` on the engine of the worker,
   * steps 5 to 8a of the open without a question, `up`, or a change of any container: the build of
   * `<resource>:prepared` (preparedImageName) with the labels that the swap of the open checks (preparedImageLabels:
   * the key of the update as the open computes it, updateKey, and the helper image). It reads nothing from a computer:
   * the devspace from the labels of its workspace volume (the deps of a prepare, headlessServiceDeps in the worker),
   * the approved build record from the labels of its newest devspace image, the configuration from the volume; the
   * registries anonymously. Docker Compose too: the devspace image of the dev service only, with a build model whose
   * images all have prepared names (never `<project>-<service>`), and pulls of the base images of the dev service only
   * (preparePulls), so the existing setup keeps its images until the open; the other services stay to the open. It is
   * skipped, with one line of the log, for a container created with the host access checks off (the worker cannot know
   * the setting, so the label of the container decides), a configuration other than the one of the record (its hash), a
   * configuration that the host access policy refuses (checks on), no update (checked on the references of the record
   * first, before anything is read from the volume), a held prepare lock (tried at the next pass; taken without a
   * wait), a key that the time limit stopped or whose build failed before, and a prepared image that fits already. Only
   * the prepare lock is held (never the devspace lock: an open that waits for the prepare holds that one). At most
   * one prepared image per devspace: an older one is removed first. The build uses `--frozen-lockfile` (Docker
   * Compose: a copy of the lockfile in the helper, as at the open) and no token; after it, the volume must still be
   * there and the configuration still the approved one, else the image is removed. After `run.limitMs`
   * (PREPARE_LIMIT_MS) the prepare stops: its build helper ends with the batch helper, its image is removed, and its
   * key is recorded (run.recordStopped). So is the key of a prepare that failed from its build on. A stop request of a
   * Delete (run.signal) ends it the same way, without the record. Never throws; the outcome and its duration are
   * logged.
   */
  async prepare(devspaceId: string, run: PrepareRun): Promise<PrepareResult> {
    const started = this.deps.clock.now();
    const limitMs = run.limitMs ?? PREPARE_LIMIT_MS;
    const limit = new AbortController();
    const timer = setTimeout(() => limit.abort(), limitMs);
    const signal = AbortSignal.any([run.signal, limit.signal]);
    const state: { building: boolean; keyHash?: string } = { building: false };
    let repository = devspaceId;
    const end = (outcome: PrepareResult['outcome'], detail: string): PrepareResult => {
      const durationMs = Math.max(0, this.deps.clock.now() - started);
      const took = durationText(durationMs);
      switch (outcome) {
        case 'prepared':
          this.logger.info(`${repository}: ${detail} in ${took}.`);
          break;
        case 'skipped':
          this.logger.info(`${repository}: no prepare: ${detail}.`);
          break;
        case 'stopped':
          this.logger.warn(`${repository}: ${detail}`);
          break;
        case 'cancelled':
          this.logger.info(`${repository}: the prepare was stopped after ${took}: ${detail}.`);
          break;
        case 'failed':
          this.logger.warn(`${repository}: the prepare failed after ${took}: ${detail}`);
          break;
      }
      return { outcome, detail, durationMs };
    };
    try {
      const env = await this.deps.registry.get(devspaceId);
      if (env === undefined) return end('skipped', 'it has no workspace volume on this engine');
      repository = env.repository;
      const held = await run.takeLock(env.id, signal);
      if (held === undefined) return end('skipped', 'its prepare lock is held (it is tried again at the next pass)');
      try {
        try {
          return end('prepared', await runWithBatchScope(held, env.volumeName, this.logger, () => this.prepareLocked(env, run, signal, state)));
        } catch (error) {
          // Under the prepare lock, after the batch helper (and with it the build) ended: an image of this prepare that is
          // not complete goes, before an open that waits for the lock can read it.
          if (state.building) {
            const name = preparedImageName(env.repository, env.id);
            await this.quietly(`remove the image ${name}`, () => this.deps.docker.removeImage(name));
          }
          throw error;
        }
      } finally {
        await held.release();
      }
    } catch (error) {
      if (limit.signal.aborted && !run.signal.aborted) {
        if (state.keyHash !== undefined) await run.recordStopped(devspaceId, state.keyHash);
        return end('stopped', `the prepare was stopped after ${Math.round(limitMs / 60_000)} minutes; the next open builds it.`);
      }
      if (run.signal.aborted) return end('cancelled', 'it was asked to stop');
      if (error instanceof PrepareSkipped) return end('skipped', error.reason);
      if (error instanceof HostAccessError) return end('skipped', `the host access policy refuses its configuration (${error.items.join(', ')})`);
      // A build that failed for a key is not tried again until the key changes (no daily build that fails the same way,
      // such as a lockfile that does not match), recorded as a stop is.
      if (state.building && state.keyHash !== undefined) await run.recordStopped(devspaceId, state.keyHash);
      return end('failed', errorMessage(error));
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * The prepare of `env` under its prepare lock and in its batch helper (prepare): resolves with what it prepared; a
   * skip throws PrepareSkipped. `state.building` from the build on (its image is removed on a failure);
   * `state.keyHash`, the hash of the prepare once it is known (for the record of the time limit).
   */
  private async prepareLocked(env: Devspace, run: PrepareRun, signal: AbortSignal, state: { building: boolean; keyHash?: string }): Promise<string> {
    const { docker } = this.deps;
    // The worker does not know the setting of the computer; a container created with the checks off says so.
    if ((await docker.devspaceContainers(env.id)).some((container) => isUnrestrictedContainer(container.labels))) {
      throw new PrepareSkipped('the host access checks are off for it (its container was created without them)');
    }
    // The approved build record: the one of the newest devspace image (its labels), with its ID pinned.
    const newest = await this.newestImageRecord(env);
    if ('reason' in newest) throw new PrepareSkipped(newest.reason);
    const record = newest.record;
    // A record of Docker Compose must be complete (its dev service, the Compose version and the hash of its files
    // decide whether the configuration is still the approved one).
    if (hasComposeRecord(record) && composeRecordOf(record) === undefined) throw new PrepareSkipped('its build record of Docker Compose is incomplete');
    const container = await docker.findContainer(env.id, env.containerName);
    const ctx: PipelineContext = {
      env: { ...env, configPath: record.configPath, buildRecord: record },
      configPath: record.configPath,
      // The source of the approved record.
      ...(record.defaultImage !== undefined ? { defaultImage: record.defaultImage } : {}),
      firstOpen: false,
      forced: false,
      steps: new StepReporter(silentProgress, this.logger),
      signal,
      announceConfigFallback: false,
      cloned: false,
      ownershipPrepared: false,
      busy: false,
      helperUnavailable: false,
      session: prepareSession(env.owner),
      gitPrepared: false,
      identity: prepareIdentity(),
      // Always with the checks on.
      hostAccessChecks: 'on',
      composeContainer: container !== undefined && isComposeContainer(container.labels, composeProjectName(env.repository, env.id)),
      prepare: { record },
    };
    // The Monitor asks every devspace of its engine each run, so the references of the record are checked
    // first (anonymously, with the monitor's fresh registry answers), before the batch helper, the Dev Container CLI
    // and the analyses: when none of them moved, nothing is to prepare (the configuration is the record's, checked
    // below whenever one moved, so its references are the record's; a base image that moved is one of them). The full
    // check of step 7 below runs as at the open.
    const quick = await this.checkImages(ctx, { references: { images: Object.keys(record.images ?? {}), features: Object.keys(record.features ?? {}) } }, record, true);
    if (quick.kind !== 'checked') throw new PrepareSkipped('the registries could not be asked');
    if (quick.upToDate) throw new PrepareSkipped('its images are current (no update)');
    // Step 5 as at the open: the host access policy with the checks on (a refusal is a HostAccessError: skipped).
    const loaded = await this.loadConfiguration(ctx, true, container);
    const compose = loaded.compose;
    // Docker Compose as the open compares it (composeConfigurationChange: the same files that another version of the
    // Compose plugin prints as another model are the approved configuration; the key then has the hash of the model of
    // this helper, which the open computes the same way with the same helper image).
    const approved =
      compose !== undefined
        ? composeConfigurationChange(record, { configHash: loaded.configHash, inputsHash: compose.inputsHash, version: compose.output.version }) !== 'changed'
        : loaded.configHash === record.configHash;
    if (loaded.configPath !== record.configPath || (compose !== undefined) !== hasComposeRecord(record) || !approved) {
      throw new PrepareSkipped('its configuration changed since its last build (only the approved configuration is prepared)');
    }
    // Step 7 as at the open, anonymously (the registry answers of the Monitor where they are fresh).
    const check = await this.checkImages(ctx, loaded, record, true);
    if (check.kind !== 'checked') throw new PrepareSkipped('the registries could not be asked');
    if (check.upToDate) throw new PrepareSkipped('its images are current (no update)');
    const helperImage = ctx.helperImage?.id;
    if (helperImage === undefined) throw new Error('The helper image of the prepare has no ID.');
    const key: PrepareKey = this.updateKey(ctx, loaded, record, check.outcome);
    const hash = prepareKeyHash(key, helperImage);
    state.keyHash = hash;
    if ((await run.stoppedKey(env.id)) === hash) {
      throw new PrepareSkipped('a prepare of the same update failed or was stopped by the time limit before (it is tried again when the update changes)');
    }
    // At most one prepared image: one that fits stays; another one goes before the build.
    const name = preparedImageName(env.repository, env.id);
    const existing = await docker.imageId(name);
    if (existing !== undefined) {
      const labels = await docker.imageLabels(existing);
      if (labels !== undefined && preparedImageMismatch(labels, env, key, helperImage) === undefined) throw new PrepareSkipped(`the newer image is prepared already (${name})`);
      this.logger.info(`The older prepared image ${name} (${existing}) of ${env.repository} is replaced.`);
      await this.quietly(`remove the image ${name}`, () => docker.removeImage(name));
    }
    // Step 8a: the pulls of the changed images, anonymously; a failed pull ends the prepare (no build on an older
    // base). Of Docker Compose only the base images of the dev service (preparePulls).
    const stale = new Set<string>();
    for (const reference of this.preparePulls(loaded, imagesToPull({ images: loaded.references.images, check, hasRecord: true, imagePresent: true, forced: false }))) {
      await this.pull(ctx, reference, false, stale);
    }
    state.building = true;
    // No token, and the lockfile of the repository stays as it is. Docker Compose builds with our copy of
    // devcontainer.json, next to which WRITE_AND_RUN_SCRIPT writes a copy of the lockfile (the CLI writes only there,
    // in the helper), as at the open; the batch step takes `--frozen-lockfile` only without that copy. The build model
    // names the images of a prepare (composeBuildOptions): the dev service builds `name` itself.
    // The default image builds its synthesized configuration (our copy, like Docker Compose: the lockfile copy next to
    // it, without `--frozen-lockfile`).
    await this.deps.helper.build({
      volumeName: env.volumeName,
      repository: env.repository,
      configPath: loaded.configPath,
      imageName: name,
      ...(compose !== undefined
        ? this.composeBuildOptions(env, compose, true)
        : loaded.defaultImage !== undefined
          ? this.defaultImageBuildOptions(loaded)
          : { frozenLockfile: true as const }),
      onOutput: this.output,
      image: ctx.helperImage,
      signal,
    });
    if (!(await docker.imageExists(name))) throw new Error(`The prepared image ${name} is missing after the build.`);
    // The devspace may be deleted meanwhile (a Delete that did not wait for the end of the prepare), and the
    // configuration may change in the volume during the build: then the image goes (the catch of prepare). The
    // synthesized configuration of the default image is not in the volume: it cannot change there.
    if ((await this.workspaceVolumeOwnership(env)) !== 'own') throw new PrepareSkipped('its workspace volume is gone (the devspace was deleted)');
    if (loaded.defaultImage === undefined) {
      const after = await this.resolveConfigFiles(env, loaded.configPath, signal, ctx.helperImage);
      if (after === undefined || after.fallback || (await this.configHashAfterPrepare(ctx, loaded, after.files)) !== loaded.configHash) {
        throw new PrepareSkipped('its configuration changed during the prepare');
      }
    }
    this.throwIfCancelled(signal);
    await docker.labelImage(name, preparedImageLabels(env, { key, helperImage }), signal);
    const id = await docker.imageId(name);
    return `the newer image was prepared as ${name}${id !== undefined ? ` (${id})` : ''}`;
  }

  /**
   * Of the images `pulls` of a prepare (imagesToPull), those that it pulls. A single container: all of them. Docker
   * Compose: only the base images of the dev service (composeDevServiceBaseImages), which its build needs; the images
   * of the other services (for example `postgres:16`) and the base images of the other built services stay as the
   * existing setup has them, so that a later `up` of it ("Later", a start) never finds a tag moved by a prepare; the
   * open pulls them after Continue or Update Now. A changed base image of the dev service that another service uses too
   * (as its image, or as a base of its build) would be moved by the pull: then nothing is prepared (PrepareSkipped),
   * and the open builds the image.
   */
  private preparePulls(loaded: LoadedConfiguration, pulls: readonly string[]): string[] {
    const compose = loaded.compose;
    if (compose === undefined) return [...pulls];
    const bases = new Set(composeDevServiceBaseImages(compose.output.model, compose.output.dockerfiles, compose.service));
    // The local tag that a pull moves, whatever the spelling (`postgres:16`, `docker.io/library/postgres:16`).
    const tagOf = (reference: string): string => {
      const parsed = parseImageReference(reference);
      return parsed === undefined ? reference.trim() : `${parsed.registry}/${parsed.repository}:${parsed.tag}`;
    };
    const others = new Set(composeOtherServiceImages(compose.output.model, compose.output.dockerfiles, compose.service).map(tagOf));
    const shared = pulls.filter((reference) => bases.has(reference) && others.has(tagOf(reference)));
    if (shared.length > 0) {
      throw new PrepareSkipped(`the base image ${listSome(shared, 5)} of its dev service is also an image of another service, which only the open pulls`);
    }
    return pulls.filter((reference) => bases.has(reference));
  }

  /**
   * The configuration hash of the files `files` that a prepare reads again after its build, as `loaded` computed it: a
   * single container with its Dockerfile (configHash); Docker Compose with the model that Compose prints now for the
   * same compose files (composeConfigHash). `undefined` when it cannot be computed.
   */
  private async configHashAfterPrepare(ctx: PipelineContext, loaded: LoadedConfiguration, files: ConfigFiles): Promise<string | undefined> {
    const env = ctx.env;
    const compose = loaded.compose;
    if (compose === undefined) {
      const dockerfile = await this.resolvedDockerfile(env, loaded.configPath, loaded.config, files, ctx.signal, ctx.helperImage);
      return configHash(files.configText, dockerfile.text);
    }
    // The text of devcontainer.json is part of the hash, so the compose files that it names are those of `loaded`.
    const composeFiles = resolveComposeFiles(loaded.configPath, splitRepository(env.repository).name, loaded.config.dockerComposeFile);
    if ('problem' in composeFiles) return undefined;
    await this.requireVolume(env);
    const output = await this.deps.helper.composeModel({
      volumeName: env.volumeName,
      repository: env.repository,
      files: composeFiles.files,
      project: compose.project,
      image: ctx.helperImage,
      signal: ctx.signal,
    });
    return 'error' in output ? undefined : composeConfigHash(files.configText, output.model, output.dockerfiles);
  }

  /**
   * `devcontainer build` with the default image: the synthesized configuration (defaultImageConfiguration) as our
   * copy of the configuration (`--config` names it in the helper, as for Docker Compose; the repository's lockfile, if
   * any, is copied next to it). Nothing for a run with the configuration of the repository.
   */
  private defaultImageBuildOptions(loaded: LoadedConfiguration): { override?: Record<string, unknown> } {
    return loaded.defaultImage !== undefined ? { override: defaultImageConfiguration(loaded.defaultImage).config } : {};
  }

  /**
   * `devcontainer build` of a Docker Compose configuration: our copy of devcontainer.json (`build` has no
   * `--override-config`, buildArgs), whose only compose file is the build model (composeBuildModel: the dev service
   * builds `<project>-<service>`, which the CLI tags as the devspace image), and the project name of the
   * devspace. For a prepare (`prepared`), the build model names the images of a prepare (ComposePreparedImages): the
   * dev service builds the prepared devspace image itself, and the other built services carry prepared names.
   */
  private composeBuildOptions(env: Devspace, compose: LoadedCompose, prepared = false): { override: Record<string, unknown>; files: HelperFiles; env: Record<string, string> } {
    const mounts = this.composeMountVolumes(env, compose, compose.mounts);
    const build = composeBuildModel(
      compose.output.model,
      this.composeParams(env, compose, mounts.sources),
      prepared
        ? { dev: preparedImageName(env.repository, env.id), service: (service) => preparedServiceImageName(env.repository, env.id, service) }
        : undefined,
    );
    return {
      override: composeConfigOverride(compose.raw, COMPOSE_MODEL_PATH),
      files: composeBuildFiles(build),
      env: { COMPOSE_PROJECT_NAME: compose.project },
    };
  }

  /**
   * The new devspace image of an update needs access to the computer (host access checks): the user learns what it
   * needs (only here: the later opens of the same update log it, planUpdate), the existing devspace starts, and the
   * same update is not built again (planUpdate) until a digest or the configuration changes. Only an update after an
   * image check can be recognized again.
   */
  private async rememberRefusedUpdate(
    ctx: PipelineContext,
    loaded: LoadedConfiguration,
    record: BuildRecord | undefined,
    check: ImageCheckState,
    error: unknown,
    reason?: 'size',
  ): Promise<void> {
    // At most MAX_REFUSED_ITEMS_LENGTH characters: the text is kept in the registry.
    const items = truncated(error instanceof HostAccessError ? error.items.join(', ') : errorMessage(error), MAX_REFUSED_ITEMS_LENGTH);
    this.logger.info(`The existing devspace of ${ctx.env.repository} is started without the update. A changed digest or configuration tries it again.`);
    this.deps.ui.warn(reason === 'size' ? Messages.updateTooLarge(items) : Messages.updateRefused(items));
    if (check.kind !== 'checked') return;
    const refusedUpdate: RefusedUpdate = { ...this.updateKey(ctx, loaded, record, check.outcome), items, ...(reason !== undefined ? { reason } : {}) };
    this.entryUpdated(ctx, await this.openRecords.build(ctx.env.id, { kind: 'refused', refusedUpdate }));
  }

  /**
   * A helper run of Step 8 (the build, `up`, or the restore with the previous devspace image) failed with
   * helperFailed: the helper image of the open is gone. A helperFailed during an update fails the open: `error` ends
   * the open, also when the container still runs; the devspace is never opened as it is after Step 5, and the rest
   * of the open uses no helper. A cancellation passes through.
   */
  private helperFailedInUpdate(ctx: PipelineContext, error: unknown, detail?: string): never {
    ctx.helperUnavailable = true;
    this.throwIfCancelled(ctx.signal);
    this.logger.error(`The workspace helper is not available for ${ctx.env.repository}. The build or start of its devspace could not be completed; the open ends.`, error);
    // With `detail`, the error says what happened to the container. The refusal of the batch scope keeps its message
    // (batchHelperUnavailable).
    if (detail !== undefined) {
      throw helperFailedError(error, detail);
    }
    throw error;
  }

  /**
   * The detail of a helperFailed of run-user-commands after the `up` of an update or a rebuild returned. On a first
   * open, the whole new devspace is removed afterwards (removeFailedFirstOpen).
   */
  private updateWithdrawnDetail(ctx: PipelineContext, withdrawn: UpWithdrawn, container: ContainerInfo | undefined, error: unknown): string {
    if (ctx.firstOpen) {
      return `The container was created, but its lifecycle commands could not run. The new devspace is removed again; open the repository again to create it. ${causeOf(error)}`;
    }
    const what = container === undefined ? 'The container was created from the devspace image' : 'The container was created again from the new devspace image';
    return `${what}, but its lifecycle commands could not run. ${withdrawnOutcome(withdrawn)} ${causeOf(error)}`;
  }

  /**
   * A failed pull or build: with an old container or devspace image, the devspace starts with them and the next
   * connection tries again (returns `undefined`). Without, the error ends the pipeline.
   */
  private updateFailed(ctx: PipelineContext, error: unknown, canFallBack: boolean, check: ImageCheckState): undefined {
    if (this.isCancellation(error, ctx.signal) || isFilesMissing(error)) throw error;
    const detail = errorDetail(error);
    this.logger.error(`The devspace image of ${ctx.env.repository} could not be built.`, error);
    if (canFallBack) {
      this.logger.info('The existing devspace is started instead. The next connection tries the update again.');
      this.deps.ui.warn(Messages.buildFailed);
      return undefined;
    }
    if (ctx.firstOpen && (check.kind === 'unreachable' || isNetworkFailure(detail))) {
      throw new UserFacingError('firstOpenOffline', Messages.firstOpenOffline, detail);
    }
    if (isUserFacingError(error)) throw error;
    throw new UserFacingError('buildFailed', Messages.buildFailed, detail);
  }

  private async pull(ctx: PipelineContext, reference: string, tolerateFailure: boolean, stale: Set<string>): Promise<void> {
    try {
      // The worker's EngineDocker asks for the login of the registry of the reference itself, when the pull needs it.
      await this.deps.docker.pullImage(reference, { onOutput: this.output, signal: ctx.signal });
    } catch (error) {
      if (this.isCancellation(error, ctx.signal) || !tolerateFailure) throw error;
      const local = await this.deps.docker.imageExists(reference).catch(() => false);
      if (!local) throw error;
      this.logger.warn(`${reference} could not be downloaded. The local image is used: ${errorMessage(error)}`);
      stale.add(reference);
    }
  }

  /** Step 9: start or create the container from the existing devspace image. Also the fallback after a failed update. */
  private async startContainer(
    ctx: PipelineContext,
    container: ContainerInfo | undefined,
    record: BuildRecord | undefined,
    imagePresent: boolean,
    loaded: LoadedConfiguration | undefined,
  ): Promise<ContainerOutcome> {
    // A container of an older setup (label nimblescape.devspaces.container-version) is created again from its
    // devspace image, like a missing one. The volume stays. So is a container that was created without the
    // configuration (it could not be read then), once the configuration can be read: it lacks its runArgs and appPort.
    // So is a container that was created while the host access checks were off, once they are on again: it is created
    // again when the checks pass (the image metadata before `up`), and never started as it is.
    const configKnown = loaded !== undefined;
    // A Docker Compose devspace: also when its configuration cannot be read now (its build record, or its container).
    const compose = loaded?.compose !== undefined || (loaded === undefined && this.isComposeDevspace(ctx.env, record, container));
    let outdated = container !== undefined && !containerIsCurrent(container.labels, configKnown, ctx.hostAccessChecks);
    // Why a current dev container is created again all the same: the log line and the progress detail.
    let recreation: { log: string; detail: string } | undefined;
    // The container of another service that makes the devspace outdated.
    let unrestrictedService: string | undefined;
    if (container !== undefined && !outdated && compose && ctx.hostAccessChecks === 'on') {
      // The containers of the other services follow the same rule (containerIsCurrent): one that was created while the
      // checks were off makes the devspace outdated; `up` then creates the dev container again, and Compose the
      // services whose model changed (the label nimblescape.devspaces.host-access is gone from it).
      const unrestricted = await this.unrestrictedServiceContainer(ctx);
      if (unrestricted) {
        outdated = true;
        unrestrictedService = unrestricted.name;
        recreation = {
          log: `The container ${unrestricted.name} was created while the host access checks were off. They are on now: the containers of ${ctx.env.repository} are created again; the files in the volumes are kept.`,
          detail: Messages.containerHostAccessChecksOn,
        };
      }
    }
    // A configuration that is no Docker Compose configuration any more for a container of Docker Compose (or the other
    // way round) does not get here: without a build, the devspace keeps its kind (configurationOfKind);
    // buildAndReplace switches it (runUp, runComposeUp). A running container whose lifecycle commands did not run (the
    // workspace helper failed, and it could be neither removed nor stopped: Devspace.lifecycleIncomplete) is not
    // opened as it is: `up` (without removal) and run-user-commands run for it below.
    const incomplete = this.decideOnLifecycleMark(ctx, container);
    if (container?.state === 'running' && incomplete) {
      this.logger.info(`The container ${container.name} runs, but its lifecycle commands did not run. They run now.`);
    }
    if (container?.state === 'running' && !outdated && !incomplete) {
      this.logger.info(`The container ${container.name} runs already.`);
      // Recreate offer: a running container that the remote user cannot use (for example its /etc/passwd lacks the user,
      // or a failed `up` of an earlier open left it running) is not opened as it is: the window could not attach.
      const fault = await this.runningContainerFault(ctx, container, loaded);
      if (fault !== undefined) {
        const image = await this.recreationImage(ctx, container, record, imagePresent, loaded, compose);
        if (image !== undefined) return this.offerRecreation(ctx, container, image, loaded, compose, fault);
      }
      // The Dev Container CLI does not call Compose for a running dev container, so a stopped service stays stopped.
      if (compose) await this.startStoppedServices(ctx);
      await this.quietly('record the volumes of the container', () => this.recordContainerVolumes(ctx, compose));
      await this.prepareGit(ctx);
      return { created: false, container };
    }
    ctx.steps.step('starting');
    // No docker start fallback: every start runs through the Dev Container CLI (`up` and run-user-commands), so
    // postStartCommand always runs. Without the workspace helper nothing starts.
    if (ctx.helperUnavailable) throw new UserFacingError('helperFailed', Messages.helperFailed);
    if (compose && loaded === undefined) {
      // Without the configuration there is no model, so no `up`, and the containers are not started (no start of the
      // containers as they are). A configuration that was read, but that could not be checked (for example Docker did
      // not answer for its images), is not called unreadable.
      const failure = ctx.configurationUnchecked ? 'could not be checked' : 'cannot be read';
      const reason = ctx.kindKept ? 'The configuration no longer uses Docker Compose, which applies with a rebuild' : `The Docker Compose configuration ${failure}`;
      if (!ctx.kindKept) this.logger.warn(`The Docker Compose configuration of ${ctx.env.repository} ${failure}. Its containers are not started.`);
      throw new UserFacingError(
        'startFailed',
        PipelineTexts.startFailed,
        container && outdated
          ? unrestrictedService !== undefined
            ? `${reason}, and the containers of the devspace must be created again (the container ${unrestrictedService} was created while the host access checks were off), which needs the configuration.`
            : `${reason}, and the container ${container.name} must be created again (it was created while the host access checks were off, or by an older version), which needs the configuration.`
          : container && ctx.kindKept && ctx.composeContainer !== true
            ? // A single container that a failed switch from Docker Compose left over.
              `${reason}. The container ${container.name} is no container of Docker Compose; it is not started until the rebuild.`
            : container
              ? `${reason}. The containers of Docker Compose start only through the Dev Container CLI, which needs the Docker Compose configuration.`
            : `${reason}, and the devspace has no container.`,
      );
    }
    // Assumption: `up` finds an existing container by --id-label and starts it without using the image of the override
    // configuration; a missing container is created from the devspace image, without network access. A container
    // that must be created again only from the image it was created from (containerImage), never from another image
    // under its name.
    const image = record && imagePresent ? record.devspaceImage : container === undefined ? undefined : outdated ? await this.containerImage(container) : container.image;
    if (!image) throw new UserFacingError('buildFailed', Messages.buildFailed, 'There is no devspace image.');
    if (outdated && container && recreation) {
      this.logger.info(recreation.log);
      ctx.steps.detail(recreation.detail);
    } else if (outdated && container) {
      this.logger.info(
        this.recreatedForHostAccess(ctx, container)
          ? `The container ${container.name} was created while the host access checks were off. They are on now: it is created again from ${image}; the files in the volume are kept.`
          : containerIsCurrent(container.labels, false, ctx.hostAccessChecks)
            ? `The container ${container.name} was created without the configuration, which can be read now. It is created again from ${image}; the files in the volume are kept.`
            : `The container ${container.name} was created by an older version of Devspaces. It is created again from ${image}; the files in the volume are kept.`,
      );
      this.announceRecreation(ctx, container);
    }
    if (!configKnown && (container === undefined || outdated)) {
      this.logger.warn(
        `The container of ${ctx.env.repository} is created without the configuration, which cannot be read. Its runArgs and published ports apply once it can be read; the container is then created again.`,
      );
    }
    // Step 9 holds no busy mark, so `up --remove-existing-container` of an existing container needs the busy mark
    // first, and no other window that uses the devspace (when in doubt, it stays).
    if (outdated && container !== undefined) {
      await this.requireNoOtherWindow(ctx, `To start the devspace, the container ${container.name} must be created again`);
    }
    try {
      const result = await this.runUp(ctx, image, loaded?.config, outdated, container === undefined || outdated, loaded?.compose);
      return { result, created: container === undefined || outdated, container: outdated ? undefined : container };
    } catch (error) {
      // Another window uses the devspace; nothing was changed.
      if (error instanceof OtherWindowUsesError) throw error;
      if (this.isCancellation(error, ctx.signal) || isFilesMissing(error) || isHostAccess(error)) throw error;
      // No docker start fallback: a workspace helper that failed during `up` fails the open. When `up` returned, the
      // container whose lifecycle commands did not run was stopped (or removed, when this `up` created it) by
      // withdrawAfterHelperFailed, and the detail says so.
      if (isHelperFailed(error)) {
        const withdrawn = ctx.upWithdrawn;
        if (withdrawn === undefined) throw error;
        // A container that ran before `up` (for example one of the mark Devspace.lifecycleIncomplete) was neither
        // created nor started by it.
        if (withdrawn.ranBefore === true) {
          const text =
            withdrawn.outcome !== 'unchanged'
              ? `The container runs, but its lifecycle commands could not run. ${withdrawnOutcome(withdrawn)}`
              : withdrawn.marked === true
                ? 'The container runs; its lifecycle commands could not run and run at the next open.'
                : 'The container runs as before this open; its lifecycle commands could not run.';
          throw new UserFacingError('helperFailed', Messages.helperFailed, `${text} ${causeOf(error)}`);
        }
        const what = container === undefined ? 'The container was created' : outdated ? 'The container was created again' : 'The container was started';
        throw new UserFacingError('helperFailed', Messages.helperFailed, `${what}, but its lifecycle commands could not run. ${withdrawnOutcome(withdrawn)} ${causeOf(error)}`);
      }
      this.logger.error(`The container of ${ctx.env.repository} could not be started.`, error);
      // Recreate offer: `up` or run-user-commands of the existing container failed because the container itself is
      // damaged. Never for a container that this run creates (it is created again anyway).
      if (container && !outdated && (await this.upFailedForContainer(ctx, error))) {
        // Docker Compose: the fault must be the dev container's (the other services, for example a database, are never
        // recreated): the check as the remote user in the dev container, which the failed `up` left running, must find
        // it. When the fault cannot be tied to the dev container, nothing is offered.
        const cause = compose ? await this.composeDevContainerFault(ctx, loaded) : errorDetail(error);
        const damaged = compose ? await this.deps.docker.findContainer(ctx.env.id, ctx.env.containerName).catch(() => undefined) : container;
        const recreationImage =
          cause !== undefined && damaged !== undefined ? await this.recreationImage(ctx, damaged, record, imagePresent, loaded, compose) : undefined;
        if (recreationImage !== undefined && damaged !== undefined && cause !== undefined) {
          return this.offerRecreation(ctx, damaged, recreationImage, loaded, compose, cause);
        }
      }
      throw new UserFacingError('startFailed', PipelineTexts.startFailed, errorDetail(error));
    }
  }

  /**
   * Recreate offer: whether a failed `up` of an existing container (or the run-user-commands after it) failed because
   * the container itself is damaged (isContainerFault): only an error of the Dev Container CLI (so the workspace helper
   * and Docker ran), not a failed lifecycle command (the configuration's), and only while Docker answers. Any other
   * failure (Docker not running or not reachable, also on a remote host, a refusal of the policy, a cancel, a missing
   * image, the network) keeps its message.
   */
  private async upFailedForContainer(ctx: PipelineContext, error: unknown): Promise<boolean> {
    if (this.isCancellation(error, ctx.signal) || !(error instanceof DevcontainerCommandError)) return false;
    if (lifecycleHookFailure(error.result) !== undefined) return false;
    return this.isDamagedContainer(ctx, `${error.message}\n${error.stderr}\n${error.stdout}`);
  }

  /**
   * Recreate offer, Docker Compose: after a failed `up`, the fault of the dev container (runningContainerFault of the
   * dev container, when it runs), else `undefined`: a fault of another service, or one of a dev container that did not
   * start, cannot be told apart from the text of Compose.
   */
  private async composeDevContainerFault(ctx: PipelineContext, loaded: LoadedConfiguration | undefined): Promise<string | undefined> {
    const dev = await this.deps.docker.findContainer(ctx.env.id, ctx.env.containerName).catch(() => undefined);
    if (dev?.state !== 'running') {
      this.logger.info(`The dev container of ${ctx.env.repository} does not run after the failed start; the fault cannot be tied to it.`);
      return undefined;
    }
    return this.runningContainerFault(ctx, dev, loaded);
  }

  /** The text names a damaged container (isContainerFault), and Docker still answers: its engine is not the cause. */
  private async isDamagedContainer(ctx: PipelineContext, text: string): Promise<boolean> {
    if (!isContainerFault(text)) return false;
    try {
      return await this.deps.docker.isRunning(ctx.signal);
    } catch (error) {
      if (this.isCancellation(error, ctx.signal)) throw error;
      return false;
    }
  }

  /**
   * Recreate offer: `docker exec` of a shell as the remote user in the running container (the Dev Containers extension
   * attaches as that user; the script `check` of the registry). The text of the failure when it names a damaged
   * container (isDamagedContainer), otherwise `undefined`, also when the remote user is not known or the check itself
   * fails (the open goes on).
   */
  private async runningContainerFault(ctx: PipelineContext, container: ContainerInfo, loaded: LoadedConfiguration | undefined): Promise<string | undefined> {
    // The user of the container itself (its label devcontainer.metadata, by which the Dev Containers extension
    // attaches), never the user that the registry recorded (it can be of an earlier container) or that the
    // configuration names now; when the label does not tell it, there is no check, and no offer.
    const user = containerMetadataUser(container.labels, helperCliVariables(ctx.env.repository));
    if (user === undefined) this.logger.info(`The label devcontainer.metadata of ${container.name} names no user; the container is not checked.`);
    if (user === undefined || ctx.helperUnavailable) return undefined;
    let text: string;
    try {
      const result = await runScript(this.deps.docker, container.id, 'check', [], { user, timeoutMs: BRANCH_EXEC_TIMEOUT_MS, signal: ctx.signal });
      if (result.exitCode === 0 || result.timedOut) return undefined;
      text = `${result.stderr}\n${result.stdout}`.trim();
    } catch (error) {
      if (this.isCancellation(error, ctx.signal)) throw error;
      this.logger.info(`The container ${container.name} could not be checked: ${errorMessage(error)}`);
      return undefined;
    }
    return (await this.isDamagedContainer(ctx, text)) ? text : undefined;
  }

  /**
   * Recreate offer: the devspace image from which a damaged `container` can be created again without a build (the
   * image of the build record, else the image of the container), when it exists. `undefined` when the container cannot
   * be created again here: without the workspace helper, while the configuration is of the other kind than the
   * devspace (configurationOfKind), or for Docker Compose without its configuration (no model).
   */
  private async recreationImage(
    ctx: PipelineContext,
    container: ContainerInfo,
    record: BuildRecord | undefined,
    imagePresent: boolean,
    loaded: LoadedConfiguration | undefined,
    compose: boolean,
  ): Promise<string | undefined> {
    if (ctx.helperUnavailable || ctx.kindKept || (compose && loaded?.compose === undefined)) return undefined;
    // Docker Compose: only the dev container of the service that the configuration names is ever recreated.
    if (compose && container.labels[COMPOSE_SERVICE_LABEL] !== loaded?.compose?.service) return undefined;
    if (compose && loaded?.compose !== undefined && !(await this.composeServicesStay(ctx, loaded.compose, record))) return undefined;
    // The pinned image (imagePresent), else the image the container was created from.
    const image = record && imagePresent ? record.devspaceImage : await this.containerImage(container);
    if (image !== undefined && (await this.deps.docker.imageExists(image).catch(() => false))) return image;
    this.logger.info(`The devspace image ${image ?? container.image} of ${ctx.env.repository} does not exist; the container cannot be created again without a build.`);
    return undefined;
  }

  /**
   * Recreate offer: right before the `up` that creates the removed dev container again, and before anything is removed,
   * the direct check that Docker Compose leaves every other service as it is. Without its dev container, the CLI runs
   * `docker compose up` without `--no-recreate`, and Compose creates a container again when its label
   * com.docker.compose.config-hash differs from the hash of its service in the model, or its label
   * com.docker.compose.image from the ID of the image of the service now. So for each container of another service of
   * the project (not a one-off container) that the model has: the hash that the Compose of the workspace helper (the
   * one that runs `up`) computes from exactly `model` (WorkspaceHelper.composeServiceHashes) must equal its label, and
   * the local ID of the image of the service must equal its image label; and (as composeServicesStay) no other service
   * that `up` builds first (builtOtherServices). The hashes of one Compose binary cover every change of the model (the
   * host access checks, a changed configuration) and of the hash method (another Compose version); the image ID covers
   * a tag that moved (also while the question was open). A difference, a missing label, or an error: startFailed
   * (composeServicesWouldBeRecreated), and nothing is changed.
   */
  private async requireOtherServicesKept(ctx: PipelineContext, compose: LoadedCompose, model: ComposeModel): Promise<void> {
    const env = ctx.env;
    const others = (await this.composeContainers(env)).filter(
      (c) => c.labels[COMPOSE_SERVICE_LABEL] !== compose.service && c.labels[COMPOSE_ONEOFF_LABEL] !== 'True' && model.services[c.labels[COMPOSE_SERVICE_LABEL] ?? ''] !== undefined,
    );
    const problems: Array<{ name: string; why: string }> = [];
    // Defense in depth, as composeServicesStay: services that `up` builds first.
    for (const name of builtOtherServices(model, compose.service, compose.runServices)) {
      problems.push({ name, why: 'its image is built by `up` first (build:), and a new image would make Docker Compose create its container again' });
    }
    if (others.length === 0 && problems.length === 0) return;
    let hashes: Map<string, string> | undefined;
    try {
      if (others.length > 0) hashes = await this.deps.helper.composeServiceHashes({
        volumeName: env.volumeName,
        repository: env.repository,
        model: JSON.stringify(model, null, 2),
        project: compose.project,
        image: ctx.helperImage,
        signal: ctx.signal,
      });
    } catch (error) {
      if (this.isCancellation(error, ctx.signal) || isHelperFailed(error)) throw error;
      this.logger.warn(`The configuration hashes of the services of ${env.repository} could not be computed: ${errorDetail(error)}`);
    }
    for (const other of others) {
      const service = other.labels[COMPOSE_SERVICE_LABEL] ?? '';
      const expected = hashes?.get(service);
      const actual = other.labels[COMPOSE_CONFIG_HASH_LABEL];
      if (expected === undefined || actual !== expected) {
        problems.push({ name: service, why: `the container ${other.name} has the configuration hash ${actual ?? '(none)'}, the model of this start gives ${expected ?? '(not known)'}` });
        continue;
      }
      const reference = typeof model.services[service].image === 'string' ? (model.services[service].image as string) : other.image;
      const imageId = await this.deps.docker.imageId(reference).catch(() => undefined);
      if (imageId === undefined || other.labels[COMPOSE_IMAGE_LABEL] !== imageId) {
        problems.push({ name: service, why: `the container ${other.name} has the image ${other.labels[COMPOSE_IMAGE_LABEL] ?? '(none)'}, ${reference} is ${imageId ?? 'missing'} now` });
      }
    }
    if (problems.length === 0) return;
    for (const problem of problems) this.logger.warn(`Docker Compose would create the service ${problem.name} of ${env.repository} again: ${problem.why}.`);
    this.logger.info(`The dev container of ${env.repository} is not created again; nothing was changed.`);
    throw new UserFacingError('startFailed', PipelineTexts.startFailed, Messages.composeServicesWouldBeRecreated(listSome([...new Set(problems.map((p) => p.name))])));
  }

  /**
   * Recreate offer: after the answer and with the busy mark of this run, the container of the devspace (for Docker
   * Compose its dev container) is still the damaged one (the same ID), and the image of the recreation (of the build
   * record of the current entry when it exists, else of the container) is still `image`. Otherwise startFailed, and
   * nothing is changed (the mark goes in the `finally` of the open).
   */
  private async requireUnchangedSinceQuestion(ctx: PipelineContext, damaged: ContainerInfo, image: string): Promise<void> {
    const env = ctx.env;
    const current = await this.deps.docker.findContainer(env.id, env.containerName);
    const record = env.buildRecord;
    // As recreationImage decides it (the pinned image, else the container's own image).
    const imagePresent = record !== undefined && (await this.pinnedImagePresent(record).catch(() => false));
    const currentImage = current === undefined ? undefined : record && imagePresent ? record.devspaceImage : await this.containerImage(current);
    if (current !== undefined && current.id === damaged.id && currentImage === image) return;
    this.logger.info(
      `The devspace ${env.repository} changed while the question was open (container ${current?.name ?? 'missing'}, image ${currentImage ?? 'none'}). The container is not created again; nothing was changed.`,
    );
    throw new UserFacingError('startFailed', PipelineTexts.startFailed, Messages.containerChangedMeanwhile);
  }

  /**
   * Recreate offer: whether the `up` that creates the removed dev container again leaves the containers of the other
   * services as they are. Without its dev container, the Dev Container CLI runs `docker compose up` without
   * `--no-recreate` (CLI 0.89.0: `(s||e.expectExistingContainer)&&b.push("--no-recreate")`, `s` the existing dev
   * container; `--expect-existing-container` fails without it: "The expected container does not exist."), so Compose
   * recreates each other service whose configuration hash or image differs (label com.docker.compose.image). So the
   * offer needs: the model of this run is the one of the build record (modelOfContainers: no changed configuration, no
   * newer image, no build), the same Compose version as the build record, and each container of another service has the
   * image that its reference names now (com.docker.compose.image is the ID of the local image). Otherwise nothing is
   * offered, and the log says why.
   */
  private async composeServicesStay(ctx: PipelineContext, compose: LoadedCompose, record: BuildRecord | undefined): Promise<boolean> {
    const env = ctx.env;
    const refuse = (why: string): false => {
      this.logger.info(`The dev container of ${env.repository} is not offered to be created again: ${why} Docker Compose would create the other services again too.`);
      return false;
    };
    if (ctx.modelOfContainers !== true) return refuse('the configuration or the images differ from those of the last build (for example after "Rebuild later" or a failed update).');
    // A shared namespace or `volumes_from` of another service never passes the direct check.
    const shared = sharedNamespaceServices(compose.output.model, compose.service);
    if (shared.length > 0) return refuse(`other services share a namespace or the volumes of another service (${shared.join('; ')}).`);
    // Without its dev container, `up` builds the other services with `build:` first.
    const built = builtOtherServices(compose.output.model, compose.service, compose.runServices);
    if (built.length > 0) return refuse(`other services build their images (${built.join(', ')}), which \`up\` builds again first; a new image would make Docker Compose create them again, and a failed build would end \`up\` after the dev container is gone.`);
    const recorded = composeRecordOf(record);
    if (recorded === undefined || recorded.version !== compose.output.version) return refuse('the version of Docker Compose differs from the one of the last build.');
    const others = (await this.composeContainers(env)).filter((c) => c.labels[COMPOSE_SERVICE_LABEL] !== compose.service);
    for (const other of others) {
      const imageId = await this.deps.docker.imageId(other.image).catch(() => undefined);
      if (imageId === undefined || other.labels[COMPOSE_IMAGE_LABEL] !== imageId) return refuse(`the container ${other.name} does not have the current image ${other.image}.`);
    }
    return true;
  }

  /**
   * Recreate offer: the existing container is damaged (`cause`). The modal question names what is kept (the repository
   * and all files in the volumes) and what is lost (everything else in the container; the setup commands run again).
   * Nothing is removed before the answer. Cancel: startFailed with the cause, nothing changed. Recreate: like the other
   * recreations of an existing container (a container of an older setup), from the devspace image, without a build:
   * `up --remove-existing-container` (the CLI removes the container with `docker rm -f`, without its volumes); for
   * Docker Compose, runComposeUp first stops and removes only the dev container, after the checks
   * (PipelineContext.recreateDevContainer), so the other services keep running with their data. No volume is removed.
   * The busy mark keeps the Monitor and other windows away meanwhile. No safety check of the repository: it
   * stays in the volume. No busy mark of Step 9 is held during the question (only the mark that requireNoOtherWindow
   * set is cleared), and after the answer, with the mark of the recreation set, the files of the other windows are read
   * (otherWindowOf, with a fresh anyContainerRuns): another window that uses the devspace, or that cannot be ruled
   * out, ends the open with startFailed (OtherWindowUsesError), and nothing is removed.
   */
  private async offerRecreation(
    ctx: PipelineContext,
    container: ContainerInfo,
    image: string,
    loaded: LoadedConfiguration | undefined,
    compose: boolean,
    cause: string,
  ): Promise<ContainerOutcome> {
    const env = ctx.env;
    this.logger.warn(`The container ${container.name} of ${env.repository} is damaged, so it cannot be started or used: ${cause}`);
    // Its volumes without a name are not carried over; the question and the progress name them.
    const unnamed = unnamedVolumeFolders(container);
    if (!compose && loaded === undefined) {
      // As for any container that is created without the configuration.
      this.logger.warn(
        `The container of ${env.repository} is created without the configuration, which cannot be read. Its runArgs and published ports apply once it can be read; the container is then created again.`,
      );
    }
    if (unnamed.length > 0) this.logger.info(`Volumes without a name of ${container.name}, not carried over by a recreation: ${unnamed.join(', ')}.`);
    // The busy mark that requireNoOtherWindow set for this run (Step 9) is not held while the question is open (it may
    // stay open for long, and other windows would find the devspace busy): only that mark is cleared, and only when
    // it is gone does this run count as holding none. The mark of the recreation comes after the answer (markBusy),
    // with requireUnchangedSinceQuestion and the check of the other windows.
    const stepMark = ctx.stepMark;
    if (ctx.busy && stepMark !== undefined) {
      ctx.stepMark = undefined;
      if (await this.releaseStepMark(ctx, stepMark)) ctx.busy = false;
    }
    const confirmed = await this.deps.ui.recreateContainer(env.repository, {
      message: Messages.containerRecreateQuestion(env.repository, compose),
      detail: Messages.containerRecreateDetail(compose, unnamed, !compose && loaded === undefined),
    });
    this.throwIfCancelled(ctx.signal);
    if (!confirmed) {
      this.logger.info(`The container ${container.name} of ${env.repository} is not created again. Nothing was changed.`);
      throw new UserFacingError('startFailed', PipelineTexts.startFailed, `${cause}\nThe container was not created again; nothing was changed.`);
    }
    await this.markBusy(ctx, 'rebuild');
    // The question had no busy mark, so another window may have changed the devspace meanwhile (a new, healthy
    // container, or a new devspace image). Only the same damaged container, from the same image, is created again;
    // otherwise nothing is changed.
    await this.requireUnchangedSinceQuestion(ctx, container, image);
    // No busy mark was held during the question, so another window may have connected to the devspace (or begun to
    // open it) meanwhile: with the mark set, the files of the windows are read as in requireNoOtherWindow (a status
    // file counts when a container runs; a file that cannot be read means "not known").
    const user = await this.otherWindowOf(env, { runs: await this.anyContainerRuns(ctx.env) });
    if (user !== undefined) this.refuseForOtherWindow(`To create the damaged container ${container.name} again, it must be removed`, user);
    ctx.steps.step('starting');
    ctx.steps.detail(Messages.containerRecreatedDamaged(unnamed));
    this.logger.info(`The container ${container.name} of ${env.repository} is created again from ${image}; the files in the volumes are kept.`);
    if (compose) ctx.recreateDevContainer = container;
    try {
      const result = await this.runUp(ctx, image, loaded?.config, true, true, loaded?.compose);
      return { result, created: true };
    } catch (error) {
      if (this.isCancellation(error, ctx.signal) || isFilesMissing(error) || isHostAccess(error)) throw error;
      if (isHelperFailed(error)) {
        // `up` returned, and the lifecycle commands of the new container could not run: it was removed
        // (withdrawAfterHelperFailed), and the detail says so.
        const withdrawn = ctx.upWithdrawn;
        if (withdrawn === undefined) throw error;
        throw new UserFacingError(
          'helperFailed',
          Messages.helperFailed,
          `The damaged container was created again, but its lifecycle commands could not run. ${withdrawnOutcome(withdrawn)} ${causeOf(error)}`,
        );
      }
      // The direct check refused it (requireOtherServicesKept), with its own detail.
      if (isUserFacingError(error) && error.code === 'startFailed') throw error;
      this.logger.error(`The container of ${env.repository} could not be created again from ${image}.`, error);
      throw new UserFacingError('startFailed', PipelineTexts.startFailed, errorDetail(error));
    }
  }

  /**
   * An existing container is created again without an update of its image: the files outside the workspace volume, for
   * example the home folder, are lost. The progress says so, as it names a newer image.
   */
  private announceRecreation(ctx: PipelineContext, container: ContainerInfo): void {
    if (this.recreatedForHostAccess(ctx, container)) {
      ctx.steps.detail(Messages.containerHostAccessChecksOn);
      return;
    }
    // Current apart from the configuration: it was created while the configuration could not be read.
    const withoutConfiguration = containerIsCurrent(container.labels, false, ctx.hostAccessChecks);
    ctx.steps.detail(withoutConfiguration ? Messages.containerConfigApplied : Messages.containerRecreated);
  }

  /**
   * True when the container is created again only because it was created while the host access checks were off, and
   * they are on now (a container of the current version otherwise).
   */
  private recreatedForHostAccess(ctx: PipelineContext, container: ContainerInfo): boolean {
    return (
      ctx.hostAccessChecks === 'on' &&
      isUnrestrictedContainer(container.labels) &&
      containerIsCurrent(container.labels, false, 'off')
    );
  }

  /**
   * The switch of the host access checks for `repository`, read from the settings at each open (hostAccessChecks). The
   * log states it when the checks are off.
   */
  private hostAccessChecksFor(repository: string): HostAccessChecks {
    const checks = hostAccessChecks(repository, this.deps.settings());
    if (checks === 'off') {
      this.logger.warn(
        `The host access checks are off for ${repository} (setting devspaces.hostAccessChecksOff): its configuration may use files, devices, and Docker of the computer. Account separation, the identity of the owner account, and the options that Devspaces does not support are still checked.`,
      );
    }
    return checks;
  }

  /**
   * Whether startContainer opens `container` as it is when the configuration could not be used: it runs, its lifecycle
   * commands ran (no Devspace.lifecycleIncomplete for it), and it is current (containerIsCurrent without the
   * configuration, and for Docker Compose with the host access checks on, no container of another service that was
   * created while they were off).
   */
  private async opensAsItIs(ctx: PipelineContext, container: ContainerInfo | undefined, record: BuildRecord | undefined, configKnown: boolean): Promise<boolean> {
    if (container?.state !== 'running' || !containerIsCurrent(container.labels, configKnown, ctx.hostAccessChecks)) return false;
    // Its lifecycle commands did not run (Devspace.lifecycleIncomplete).
    if (this.decideOnLifecycleMark(ctx, container)) return false;
    if (ctx.hostAccessChecks !== 'on' || !this.isComposeDevspace(ctx.env, record, container)) return true;
    return (await this.unrestrictedServiceContainer(ctx)) === undefined;
  }

  /** A container of another Docker Compose service of the devspace that was created while the host access checks were off. */
  private async unrestrictedServiceContainer(ctx: PipelineContext): Promise<ContainerInfo | undefined> {
    return (await this.deps.docker.devspaceContainers(ctx.env.id)).find(
      (other) => other.labels[LABEL_COMPOSE_SERVICE] !== undefined && isUnrestrictedContainer(other.labels),
    );
  }

  /**
   * opensAsItIs for the handling of an error at Step 5: a failure of its Docker listing is logged and counts as
   * `false`, so the caller goes on with its own error; a cancellation passes through.
   */
  private async opensAsItIsOrFalse(ctx: PipelineContext, container: ContainerInfo | undefined, record: BuildRecord | undefined, configKnown: boolean): Promise<boolean> {
    try {
      return await this.opensAsItIs(ctx, container, record, configKnown);
    } catch (error) {
      if (this.isCancellation(error, ctx.signal)) throw error;
      this.logger.warn(`The containers of ${ctx.env.repository} could not be listed: ${errorDetail(error)}`);
      return false;
    }
  }

  /**
   * A Docker Compose devspace: its build record says so, or its container belongs to the project of the devspace.
   */
  private isComposeDevspace(env: Devspace, record: BuildRecord | undefined, container: ContainerInfo | undefined): boolean {
    // The key decides the kind (hasComposeRecord), not the validity of its fields.
    if (hasComposeRecord(record)) return true;
    return container !== undefined && isComposeContainer(container.labels, composeProjectName(env.repository, env.id));
  }

  /**
   * The containers of the other services of a Docker Compose devspace that do not run are started with `docker
   * start` (the dev container runs). A failure is a warning: the dev container runs, and the user can see why.
   */
  private async startStoppedServices(ctx: PipelineContext): Promise<void> {
    const stopped = (await this.deps.docker.devspaceContainers(ctx.env.id)).filter(
      (container) => container.labels[LABEL_COMPOSE_SERVICE] !== undefined && container.state !== 'running',
    );
    for (const container of stopped) {
      this.logger.info(`Starting the container ${container.name} of the service ${container.labels[LABEL_COMPOSE_SERVICE]} of ${ctx.env.repository}.`);
      try {
        // By the worker that holds the lock, over the Engine API.
        await this.deps.docker.startContainer(container.id, { timeoutMs: DOCKER_START_TIMEOUT_MS, signal: ctx.signal });
      } catch (error) {
        if (this.isCancellation(error, ctx.signal)) throw error;
        this.logger.warn(`The container ${container.name} could not be started: ${errorDetail(error)}`);
      }
    }
  }

  /**
   * `devcontainer up` with the override configuration. `createsContainer`: `up` creates a container from `image` (no
   * container, or `removeExistingContainer`); only then the image metadata is checked, because `up` starts an existing
   * container without the image, and that container passed the check when it was created. `compose`: a Docker Compose
   * configuration (runComposeUp).
   */
  private async runUp(
    ctx: PipelineContext,
    image: string,
    config: DevcontainerConfig | undefined,
    removeExistingContainer: boolean,
    createsContainer: boolean,
    compose?: LoadedCompose,
  ): Promise<DevcontainerResult> {
    // Set only by this `up` (a restore after a failed update runs a second one).
    ctx.upWithdrawn = undefined;
    if (compose) return this.runComposeUp(ctx, image, config, compose, removeExistingContainer, createsContainer);
    const env = ctx.env;
    // Without the configuration, the container gets no runArgs and appPort of the repository. Its label makes the next
    // open with a readable configuration create it again (containerIsCurrent).
    const runArgs = config ? (stringList(config.runArgs) ?? []) : ['--label', CONTAINER_CONFIG_UNKNOWN_LABEL];
    // Host access checks: the flags that the override configuration does not pass to Docker, read with the parser of
    // the policy.
    const removed = removedRunArgs(runArgs);
    if (removed.length > 0) {
      const list = removed.map((entry) => `${entry.arg} (${entry.reason})`).join(', ');
      this.logger.info(`Removed from the runArgs of ${env.repository}: ${list}.`);
    }
    const override = buildOverrideConfig({
      devspaceImage: image,
      volumeName: env.volumeName,
      repositoryName: splitRepository(env.repository).name,
      containerName: env.containerName,
      runArgs,
      appPort: config?.appPort,
      hostAccessChecks: ctx.hostAccessChecks,
      // reconcileFromVolumes restores the configuration path from it.
      configPath: env.configPath,
      // The shared VS Code server store, read-only, for an open that carries a server (only a container that `up`
      // creates gets it; an existing one is started as it is).
      ...(this.deps.vscodeServer !== undefined ? { vscodeStoreVolume: this.vscodeStoreVolume() } : {}),
    });
    // Host access checks: the arguments and published ports that Docker gets, after the changes of the override
    // configuration, pass the policy too (the check of the configuration covers them as read-configuration returned
    // them; the CLI substitutes both again at `up`).
    let finalRunArgs: HostAccessReport;
    try {
      finalRunArgs = await this.check(ctx, 'finalRunArgs', await this.hostAccessInput(env, { config: { runArgs: override.runArgs, appPort: override.appPort } }), ctx.hostAccessChecks);
    } catch (error) {
      // `up` only starts the existing container, which passed the check when it was created, and applies no runArgs: an
      // analysis that could not run does not keep it from starting.
      if (createsContainer || !isInternalAnalysisFailure(error)) throw error;
      this.logger.warn(`The runArgs of ${env.repository} could not be checked (${error.failure.reason}). The existing container is started as it is.`);
      finalRunArgs = { hostAccess: [], unsupported: [] };
    }
    // What Docker gets: its last --user decides the user of the container (imageRemoteUser).
    const dockerRunArgs = stringList(override.runArgs) ?? [];
    if (isRefused(finalRunArgs)) {
      this.logger.warn(`The runArgs of the container of ${env.repository} are refused by the host access policy: ${describeRefusal(finalRunArgs)}`);
      throw new HostAccessError(finalRunArgs);
    }
    // The container is in use from its start on.
    await this.deps.sessionFiles.writePending(env.id, this.deps.owner.windowId);
    await this.requireVolume(env);
    if (createsContainer) {
      const metadataVolumes = await this.checkImageHostAccess(ctx, image);
      const configVolumes = mountedVolumeNames({
        ownVolume: env.volumeName,
        config: { mounts: config?.mounts, runArgs: dockerRunArgs },
        variables: helperCliVariables(env.repository),
      });
      await this.createAdditionalVolumes(ctx, [...configVolumes, ...metadataVolumes]);
    }
    if (ctx.cloned && !ctx.ownershipPrepared) await this.prepareOwnership(ctx, image, dockerRunArgs);
    // After the ownership fix (the files get the owner of the repository folder), and before `up`, so that the lifecycle
    // commands have the Git configuration (the token goes into the container after `up`, before them: runUserCommands).
    await this.prepareGit(ctx, true);
    // The devspace was a Docker Compose devspace: `up` finds the container by the ID label, which the containers
    // of the other services have too, so they go first. Also the containers of other services that exist without a
    // Docker Compose dev container or record (for example after a failed switch to Docker Compose).
    let services = (await this.deps.docker.devspaceContainers(env.id)).filter((container) => container.labels[LABEL_COMPOSE_SERVICE] !== undefined);
    if (!createsContainer && services.length > 0) {
      // `up` without a new container would take one of them for the dev container. Next to a single dev container (no
      // container of Docker Compose), they are strays (for example of a failed switch to Docker Compose): they go
      // (`docker rm -f`, their volumes stay), and the single container starts as usual; a rebuild would not help when
      // the configuration cannot be used.
      const dev = await this.deps.docker.findContainer(env.id, env.containerName);
      const single = dev !== undefined && dev.labels[LABEL_COMPOSE_SERVICE] === undefined && !isComposeContainer(dev.labels, composeProjectName(env.repository, env.id));
      if (!single) {
        // The caller reports it as startFailed.
        throw new Error(
          `Containers of other Docker Compose services of ${env.repository} exist (${services.map((container) => container.name).join(', ')}), and it is not known whether its dev container is a single container: rebuild the devspace.`,
        );
      }
      // Without a busy mark (Step 9), only with it and no other window.
      await this.requireNoOtherWindow(ctx, `To start the devspace, the containers ${services.map((container) => container.name).join(', ')} of other Docker Compose services must be removed`);
      for (const container of services) {
        this.logger.info(
          `The container ${container.name} of the service ${container.labels[LABEL_COMPOSE_SERVICE]} of ${env.repository} is left over next to its single container. It is removed; its volumes are kept.`,
        );
        await this.stopServiceBeforeRemoval(container, env);
        await this.deps.docker.removeContainer(container.id);
      }
      services = [];
    }
    const leftovers = createsContainer && (ctx.composeContainer === true || composeRecordOf(env.buildRecord) !== undefined || services.length > 0);
    if (leftovers) {
      // Without a busy mark (Step 9), only with it and no other window.
      await this.requireNoOtherWindow(ctx, 'To start the devspace, the containers of its other Docker Compose services must be removed');
      this.logger.info(
        `The devspace ${env.repository} was a Docker Compose devspace. The container is created again for the configuration, and the containers of the other services are removed; the files in the volumes are kept.`,
      );
      // Named volumes of the services stay; their volumes without a name are not used any more.
      ctx.steps.detail(Messages.containerComposeReplaced);
      await this.removeComposeServices(ctx);
    }
    // The recorded paths of the services stay: their data is still in the volume. finish drops those that no longer
    // exist.
    let result: DevcontainerResult & { lifecycleCommandFailure?: unknown };
    // The containers right before `up`, so that a helperFailed of run-user-commands can tell a container that this `up`
    // created from one that it only started (withdrawAfterHelperFailed).
    const before = await this.containersBeforeUp(ctx, false);
    let upContainer: string | undefined;
    try {
      result = await this.deps.helper.up({
        volumeName: env.volumeName,
        repository: env.repository,
        override,
        devspaceId: env.id,
        removeExistingContainer,
        token: ctx.session.token,
        onOutput: this.output,
        image: ctx.helperImage,
        signal: ctx.signal,
      });
      ctx.upStarted = true;
      upContainer = nonEmptyString(result.containerId);
      // The container runs now; the monitor again, before the lifecycle commands.
      await this.ensureSessionMonitorAfterStart(ctx);
      // Lifecycle token: `up` ran no lifecycle command; they run now, with the token.
      result = await this.runUserCommands(ctx, result, { override }, configRemoteUser(config, runArgs));
    } catch (error) {
      // A failed `up` may have left a container running (once per run).
      if (!this.isCancellation(error, ctx.signal)) await this.ensureSessionMonitorAfterStart(ctx).catch(() => undefined);
      if (upContainer !== undefined && isHelperFailed(error)) await this.withdrawAfterHelperFailed(ctx, upContainer, before, false);
      const kept = await this.keptAfterLifecycleFailure(ctx, error);
      if (!kept) {
        // A container that `up` created before it failed or was cancelled mounts its volumes already.
        await this.quietly('record the volumes of the container', () => this.recordContainerVolumes(ctx));
        throw error;
      }
      result = kept;
    }
    // Its lifecycle commands ran.
    ctx.lifecycleRanFor = nonEmptyString(result.containerId) ?? upContainer;
    // A volume named with ${devcontainerId} gets its name only at `up`, so neither the configuration nor the image
    // metadata named it: the container does. Also for an existing container, whose volumes an earlier failed or cancelled
    // `up` may not have recorded.
    await this.quietly('record the volumes of the container', () => this.recordContainerVolumes(ctx));
    // `up` replaced the dev container of Docker Compose: the networks of the project are no longer used.
    if (leftovers) await this.quietly('remove the networks of the Docker Compose project', () => this.removeComposeNetworks(env));
    const failure = nonEmptyString(result.lifecycleCommandFailure);
    return failure === undefined ? result : this.openAfterLifecycleFailure(ctx, result, failure, image, dockerRunArgs);
  }

  /**
   * `devcontainer up` of a Docker Compose configuration: the up model (composeUpModel: the checked model with the
   * devspace image for the dev service, ports on 127.0.0.1, the labels of the devspace on every container,
   * external volumes) as the only compose file of the override configuration (buildComposeOverrideConfig), with the
   * project name of the devspace. When `up` creates the dev container (`createsContainer`, host access checks): the
   * model is checked again with the labels of its volumes now, the image metadata of the devspace image is checked,
   * and the named volumes of the model and of the `mounts` are created with the labels of the devspace
   * (nimblescape.devspaces.volume=compose for the volumes of the project, `additional` for the others). The Dev
   * Container CLI finds the dev container by the project and the service; `up` replaces only the dev container
   * (removeExistingContainer), and Compose recreates the other services whose model or image changed.
   */
  private async runComposeUp(
    ctx: PipelineContext,
    image: string,
    config: DevcontainerConfig | undefined,
    compose: LoadedCompose,
    removeExistingContainer: boolean,
    createsContainer: boolean,
  ): Promise<DevcontainerResult> {
    const env = ctx.env;
    const { docker } = this.deps;
    // The container is in use from its start on.
    await this.deps.sessionFiles.writePending(env.id, this.deps.owner.windowId);
    await this.requireVolume(env);
    // A container of the devspace that Compose did not create (the configuration was no Docker Compose configuration
    // before) has the name of the dev container: it goes after the checks, and `up` creates the containers.
    const found = await docker.findContainer(env.id, env.containerName);
    const replaced = found !== undefined && !isComposeContainer(found.labels, compose.project) ? found : undefined;
    const creates = createsContainer || replaced !== undefined;
    // The `mounts` of the image metadata (Features) become volumes of the project too.
    let metadata: unknown[] = [];
    let labels: Record<string, string> = {};
    try {
      ({ metadata, labels } = await this.imageMetadataAndLabels(image, ctx.signal));
    } catch (error) {
      if (creates || this.isCancellation(error, ctx.signal)) throw error;
      this.logger.info(`The metadata of ${image} could not be read: ${errorMessage(error)}`);
    }
    // The metadata as written in the label, substituted as the CLI substitutes it at `up`.
    const mounts = this.composeMountVolumes(env, compose, [...compose.mounts, ...metadata.map((entry) => (isRecord(entry) ? entry.mounts : undefined))]);
    if (creates) {
      const { report } = await this.composeReport(ctx, compose, config ?? {});
      if (isRefused(report)) {
        this.logger.warn(`The Docker Compose configuration of ${env.repository} is refused by the host access policy: ${describeRefusal(report)}`);
        throw new HostAccessError(report);
      }
      const serviceLabels = await this.serviceImageLabelItems(ctx, compose);
      await this.checkMetadataHostAccess(ctx, image, metadata, compose.hostAccessChecks, labels, serviceLabels, true);
    }
    // Also when `up` only adds containers (a service that the model gained, after a "Rebuild later"): Compose would
    // refuse an external volume that does not exist. Only the missing ones are created.
    await this.createComposeVolumes(ctx, compose, mounts);
    // Every container carries the configuration path (reconcileFromVolumes).
    const { model, rewrites, createFolders, serviceFolders } = composeUpModel(compose.output.model, {
      ...this.composeParams(env, compose, mounts.sources),
      image,
      configPath: env.configPath,
      // The shared VS Code server store, read-only in the dev service, for an open that carries a server (Docker
      // Compose creates the dev container with it; `up` keeps an existing one, --no-recreate of the CLI).
      ...(this.deps.vscodeServer !== undefined ? { vscodeStoreVolume: this.vscodeStoreVolume() } : {}),
    });
    // Before `up` (also before the first build record, so that a failed `up` leaves them recorded), with the paths that
    // the existing containers mount; the list never shrinks before `up` (after it, finish drops what nothing names any
    // more).
    ctx.modelServiceFolders = serviceFolders ?? [];
    const before = await this.serviceFolderFacts(ctx.env, ctx.modelServiceFolders);
    ctx.serviceFolders = before.overflow ? 'repository' : before.folders;
    await this.recordServiceFolders(ctx, before);
    if (rewrites.length > 0) {
      this.logger.info(`Changed in the Docker Compose model of ${env.repository}: ${rewrites.map((rewrite) => `${rewrite.item} (${rewrite.reason})`).join(', ')}.`);
    }
    // The folders of the repository that bind mounts name and that do not exist yet (for example a data folder in
    // .gitignore): Docker would create them; the subpath of the workspace volume must exist.
    if (createFolders !== undefined && createFolders.length > 0) {
      await this.requireVolume(env);
      await this.deps.helper.createRepositoryFolders({
        volumeName: env.volumeName,
        repository: env.repository,
        folders: createFolders,
        image: ctx.helperImage,
        signal: ctx.signal,
      });
    }
    // The user of the dev service decides the owner of the files (imageRemoteUser reads `--user`).
    const userArgs = composeUserArgs(compose.output.model.services[compose.service]);
    // Before anything is removed, stopped or renamed (as in runUp), so that a helperFailed of the Git setup leaves the
    // running containers as they are.
    if (ctx.cloned && !ctx.ownershipPrepared) await this.prepareOwnership(ctx, image, userArgs);
    await this.prepareGit(ctx, true);
    // The dev container of another service of the project (the configuration of the devspace changed its `service`):
    // it holds the name that the new dev service gets.
    const previousService = found !== undefined && replaced === undefined ? found.labels[COMPOSE_SERVICE_LABEL] : undefined;
    const movesPrevious = found !== undefined && previousService !== undefined && previousService !== compose.service;
    // Without a busy mark (Step 9, for example for a container of the mark Devspace.lifecycleIncomplete that a
    // failed switch left running for another window), a container is removed or renamed only with the busy mark set and
    // no other window that uses the devspace; else nothing is changed.
    if (replaced) {
      await this.requireNoOtherWindow(ctx, `To start the devspace with its Docker Compose configuration, the container ${replaced.name}, which Docker Compose did not create, must be removed`);
    } else if (movesPrevious) {
      await this.requireNoOtherWindow(ctx, `To start the devspace, the dev container ${found.name} of the service ${previousService} must be renamed and stopped`);
    }
    if (replaced) {
      this.logger.info(
        `The container ${replaced.name} of ${env.repository} was not created by Docker Compose. It is replaced by the containers of the Docker Compose configuration; the files in the volume are kept.`,
      );
      // As for the other recreations, the user learns that the files outside the repository go.
      ctx.steps.detail(Messages.containerComposeCreated);
      // Stopped first, so that it can shut down cleanly, as the side services.
      await this.stopServiceBeforeRemoval(replaced, env);
      await docker.removeContainer(replaced.id);
      (ctx.kindSwitchRemoved ??= []).push(`the container ${replaced.name}`);
      // The containers of Docker Compose that exist now (for example of an earlier switch that was cancelled, which the
      // user may have used since) are not new, whatever the failed `up` does.
      ctx.composeSwitch = { existing: await this.composeContainerIds(env) };
    }
    if (movesPrevious) {
      await this.movePreviousDevContainer(ctx, compose, found, previousService, removeExistingContainer);
    }
    // Recreate offer: the user chose to create the damaged dev container again. After the checks above (a refusal
    // leaves it as it is), and only when Docker Compose would leave every other service as it is
    // (requireOtherServicesKept, with this very model), only it goes: stopped first, then `docker rm -f` without its
    // volumes. `up` creates it again; the containers of the other services and their volumes stay as they are.
    const damaged = ctx.recreateDevContainer;
    if (damaged !== undefined) {
      ctx.recreateDevContainer = undefined;
      await this.requireOtherServicesKept(ctx, compose, model);
      this.logger.info(`The dev container ${damaged.name} of ${env.repository} is removed to be created again. The other services and all volumes are kept.`);
      await this.stopServiceBeforeRemoval(damaged, env);
      await docker.removeContainer(damaged.id);
    }
    const override = buildComposeOverrideConfig({
      modelPath: COMPOSE_MODEL_PATH,
      service: compose.service,
      ...(compose.runServices !== undefined ? { runServices: compose.runServices } : {}),
      repositoryName: splitRepository(env.repository).name,
    });
    let result: DevcontainerResult & { lifecycleCommandFailure?: unknown };
    const inputs = {
      override,
      files: { [COMPOSE_MODEL_PATH]: JSON.stringify(model, null, 2) },
      env: { COMPOSE_PROJECT_NAME: compose.project },
    };
    // As in runUp, with the containers of the project.
    const containersBefore = await this.containersBeforeUp(ctx, true);
    let upContainer: string | undefined;
    try {
      result = await this.deps.helper.up({
        volumeName: env.volumeName,
        repository: env.repository,
        devspaceId: env.id,
        removeExistingContainer,
        ...inputs,
        token: ctx.session.token,
        onOutput: this.output,
        image: ctx.helperImage,
        signal: ctx.signal,
      });
      ctx.upStarted = true;
      upContainer = nonEmptyString(result.containerId);
      // As in runUp.
      await this.ensureSessionMonitorAfterStart(ctx);
      // Lifecycle token: as for a single container (runUp). The CLI ignores runArgs for Compose.
      result = await this.runUserCommands(ctx, result, inputs, configRemoteUser(config, undefined));
    } catch (error) {
      // As in runUp.
      if (!this.isCancellation(error, ctx.signal)) await this.ensureSessionMonitorAfterStart(ctx).catch(() => undefined);
      if (upContainer !== undefined && isHelperFailed(error)) await this.withdrawAfterHelperFailed(ctx, upContainer, containersBefore, true);
      const kept = await this.keptAfterLifecycleFailure(ctx, error);
      if (!kept) {
        await this.quietly('record the volumes of the containers', () => this.recordContainerVolumes(ctx, true));
        throw error;
      }
      result = kept;
    }
    // Its lifecycle commands ran.
    ctx.lifecycleRanFor = nonEmptyString(result.containerId) ?? upContainer;
    await this.quietly('record the volumes of the containers', () => this.recordContainerVolumes(ctx, true));
    // The CLI finds the dev container again only by the project; another project would be a second devspace.
    if (result.composeProjectName !== undefined && result.composeProjectName !== compose.project) {
      throw new Error(`devcontainer up used the Docker Compose project ${String(result.composeProjectName)}, not ${compose.project}.`);
    }
    const failure = nonEmptyString(result.lifecycleCommandFailure);
    return failure === undefined ? result : this.openAfterLifecycleFailure(ctx, result, failure, image, userArgs);
  }

  /**
   * The containers of the devspace (with `compose`, also those of its Docker Compose project) right before `up`, by
   * ID, with whether each ran. `undefined` when they cannot be listed (logged): then a container of `up` whose
   * lifecycle commands could not run is only stopped, never removed (withdrawAfterHelperFailed).
   */
  private async containersBeforeUp(ctx: PipelineContext, compose: boolean): Promise<ReadonlyMap<string, boolean> | undefined> {
    try {
      return new Map((await this.upContainers(ctx.env, compose)).map((container) => [container.id, container.state === 'running']));
    } catch (error) {
      if (this.isCancellation(error, ctx.signal)) throw error;
      this.logger.warn(
        `The containers of ${ctx.env.repository} could not be listed before up: ${errorMessage(error)}. If the lifecycle commands cannot run, its container is only stopped, never removed.`,
      );
      return undefined;
    }
  }

  /** The containers with the ID label of the devspace and, with `compose`, those of its Docker Compose project, once each. */
  private async upContainers(env: Devspace, compose: boolean): Promise<ContainerInfo[]> {
    const all = [...(await this.deps.docker.devspaceContainers(env.id)), ...(compose ? await this.deps.docker.listProjectContainers(composeProjectName(env.repository, env.id)) : [])];
    const seen = new Set<string>();
    return all.filter((container) => {
      if (seen.has(container.id)) return false;
      seen.add(container.id);
      return true;
    });
  }

  /**
   * Never opened as it is after the helper was prepared: `up` returned the container `containerId`, and
   * run-user-commands then failed with helperFailed, so its lifecycle commands did not run. So that no later open opens
   * it as it is: a container that this `up` created (not among `before`) is removed (the files are in the volumes), and
   * stopped when that fails; one that existed and did not run before `up` is stopped again (the next open starts it and
   * runs its lifecycle commands); one that ran before `up` is left as it is (it ran before this open). With `before`
   * unknown, it is only stopped, and the containers of the other services are left as they are (it is not known which
   * of them `up` created or started). The containers of the other services that did not run before `up` (new ones, or
   * stopped ones that `up` started) are stopped too. When another window is connected to the devspace (its window
   * status file or its pending connection file, otherWindowUsesDevspace), nothing is touched: that window uses the
   * containers; so too when those files cannot be read (when in doubt, nothing is stopped or removed). A container that
   * could be neither removed nor stopped, or that was left running for another window (and did not run before `up`), is
   * named in Devspace.lifecycleIncomplete, so that the next open runs its lifecycle commands. Every failure is
   * logged; a cancellation does not stop the cleanup. The result goes to PipelineContext.upWithdrawn.
   *
   * Without a busy mark of this run (Step 9), a busy mark is set first, before the files of the windows are read, and
   * held until the withdrawal ends: another window that begins to open the devspace meanwhile waits for it
   * (waitForOtherOperation) instead of opening the container that is about to be stopped or removed. When it cannot be
   * set (another window holds one, or the mark of this window is there already, which is never overwritten), the
   * containers stay as they are, as with another window connected (`inUse`); when the registry fails, as when the files
   * cannot be read (`useUnknown`). Only the mark set here is cleared, in `finally`; nothing waits for another window
   * while it is held.
   */
  private async withdrawAfterHelperFailed(
    ctx: PipelineContext,
    containerId: string,
    before: ReadonlyMap<string, boolean> | undefined,
    compose: boolean,
  ): Promise<void> {
    let own: BusyMark | undefined;
    let blocked: WindowUse | undefined;
    if (!ctx.busy) {
      const taken = await this.takeStepMark(ctx, 'update');
      if ('mark' in taken) own = taken.mark;
      else blocked = taken.user;
    }
    try {
      await this.withdrawContainer(ctx, containerId, before, compose, blocked);
    } finally {
      if (own !== undefined) await this.releaseStepMark(ctx, own);
    }
  }

  /** withdrawAfterHelperFailed, with the busy mark set (or `blocked`: why it could not be set). */
  private async withdrawContainer(
    ctx: PipelineContext,
    containerId: string,
    before: ReadonlyMap<string, boolean> | undefined,
    compose: boolean,
    blocked: WindowUse | undefined,
  ): Promise<void> {
    const env = ctx.env;
    const { docker } = this.deps;
    let current: ContainerInfo[] | undefined;
    try {
      current = await this.upContainers(env, compose);
    } catch (error) {
      this.logger.warn(`The containers of ${env.repository} could not be listed after its lifecycle commands could not run: ${errorMessage(error)}`);
    }
    const found = current?.find((container) => sameContainer(container.id, containerId));
    const id = found?.id ?? containerId;
    const name = found?.name ?? env.containerName;
    const known = before === undefined ? undefined : [...before.keys()].find((other) => sameContainer(other, id));
    // Not known when the listing before `up` failed.
    const created = before === undefined ? undefined : known === undefined;
    const ranBefore = known !== undefined && before?.get(known) === true;
    // Step 9 holds no busy mark, so another window may have started this container (its `up`) and connected to it
    // meanwhile. When the files cannot be read, it is not known: the containers stay too (when in doubt, nothing is
    // stopped or removed). Read with the busy mark of this run set; without it (`blocked`), nothing is touched either.
    const user = blocked ?? (await this.otherWindowOf(env));
    // A mark of an earlier open that names this container (it ran before `up`) stays.
    const mark = ctx.env.lifecycleIncomplete;
    const markedBefore = ranBefore && mark !== undefined && sameContainer(mark, id);
    if (user !== undefined) {
      const what = created === undefined ? 'created or started' : created ? 'created' : 'started';
      this.logger.info(
        ranBefore
          ? `The container ${name} ran before this open; its lifecycle commands could not run now. ${user.text} It is left running, and so are the containers of the other services.`
          : `The container ${name} was ${what}, but its lifecycle commands did not run. ${user.text} It is left running, and so are the containers of the other services.`,
      );
      // A container that did not run before `up` runs without its lifecycle commands: the mark makes the next open run
      // them. One that ran before this open runs as before. Nothing is stopped here, also when the mark cannot be
      // written (another window may use it).
      const marked = ranBefore ? markedBefore : await this.markLifecycleIncomplete(ctx, id, name);
      const markFailed = !ranBefore && !marked;
      if (markFailed) await this.lifecycleNotRecorded(ctx, id, name);
      ctx.upWithdrawn = {
        outcome: user.known ? 'inUse' : 'useUnknown',
        id,
        created,
        name,
        ...(marked ? { marked } : {}),
        ...(markFailed ? { markFailed } : {}),
        ...(user.known && user.use !== undefined ? { use: user.use } : {}),
        ...(ranBefore ? { ranBefore } : {}),
      };
      return;
    }
    const stop = async (): Promise<boolean> => {
      try {
        await docker.stopContainer(id);
        return true;
      } catch (error) {
        this.logger.warn(`The container ${name} could not be stopped: ${errorMessage(error)}`);
        return false;
      }
    };
    let outcome: UpWithdrawn['outcome'];
    if (ranBefore) {
      this.logger.info(`The container ${name} ran before this open; its lifecycle commands could not run now. It is left as it is.`);
      outcome = 'unchanged';
    } else if (created === true) {
      this.logger.info(`The container ${name} was created, but its lifecycle commands did not run. It is removed; the next open creates it again.`);
      try {
        await docker.removeContainer(id);
        outcome = 'removed';
      } catch (error) {
        this.logger.warn(`Could not remove the container ${name}: ${errorMessage(error)}. It is stopped instead.`);
        outcome = (await stop()) ? 'stoppedAfterRemovalFailed' : 'kept';
      }
    } else {
      this.logger.info(
        `The container ${name} was ${created === undefined ? 'created or started' : 'started'}, but its lifecycle commands did not run. It is stopped; the next open starts it again.`,
      );
      outcome = (await stop()) ? 'stopped' : 'kept';
    }
    // The other services (Docker Compose) that `up` created or started are stopped again; those that ran before stay.
    // Without the list before `up`, they are left as they are.
    if (before !== undefined) {
      for (const other of current ?? []) {
        if (sameContainer(other.id, id) || other.state !== 'running') continue;
        const ran = [...before.entries()].some(([known, running]) => running && sameContainer(known, other.id));
        if (ran) continue;
        await this.quietly(`stop the container ${other.name}`, () => docker.stopContainer(other.id));
      }
    } else if (compose) {
      this.logger.info(`The containers of the other services of ${env.repository} are left as they are: it is not known which of them ran before up.`);
    }
    // The container runs without its lifecycle commands: the mark makes the next open run them.
    let marked = markedBefore;
    let markFailed = false;
    if (outcome === 'kept') {
      marked = await this.markLifecycleIncomplete(ctx, id, name);
      // The mark could not be written: the stop of this container (which this `up` created or started, and which no
      // other window uses) is tried once more; when it still runs, this window remembers it, and the detail and a
      // warning say that it could not be recorded.
      if (!marked) {
        if (await stop()) {
          outcome = created === true ? 'stoppedAfterRemovalFailed' : 'stopped';
        } else {
          markFailed = true;
          await this.lifecycleNotRecorded(ctx, id, name);
        }
      }
    } else if (outcome === 'removed') {
      await this.clearLifecycleMark(ctx, id);
    }
    ctx.upWithdrawn = { outcome, id, created, name, ...(marked ? { marked } : {}), ...(markFailed ? { markFailed } : {}), ...(ranBefore ? { ranBefore } : {}) };
  }

  /**
   * Sets a busy mark for a step of a run that holds none (Step 9), unless the entry has a mark already that is not an
   * ended one: a live mark of another window, and any mark of this window or process (an outer mark is never
   * overwritten). Never waits. Returns the mark that was set, or else how the devspace is used (`busy`; `known:
   * false` when the registry could not be written, logged).
   */
  private async takeStepMark(ctx: PipelineContext, operation: BusyOperation): Promise<{ mark: BusyMark } | { user: WindowUse }> {
    try {
      // The mark of this window, with its clock and its view of the windows (OpenRecords.takeStepMark).
      const taken = await this.openRecords.takeStepMark(ctx.env.id, operation);
      if (!taken) {
        this.logger.warn(`The registry entry of ${ctx.env.repository} is missing; no busy mark was set.`);
        return { user: { known: false, text: `It is not known whether another window uses ${ctx.env.repository}.` } };
      }
      ctx.env = taken.devspace;
      if ('conflict' in taken) {
        const other = taken.conflict;
        return { user: { known: true, use: 'busy', text: `The window ${other.windowId} (process ${other.pid}) holds the busy mark ${other.operation} since ${other.since}.` } };
      }
      this.logger.info(`${ctx.env.repository} is marked as busy (${operation}).`);
      return { mark: taken.mark };
    } catch (error) {
      this.logger.warn(`The busy mark of ${ctx.env.repository} could not be set: ${errorMessage(error)}.`);
      return { user: { known: false, text: `It is not known whether another window uses ${ctx.env.repository}.` } };
    }
  }

  /**
   * Before a step of a run without a busy mark (Step 9) stops, removes, or renames a container (`change` says which and
   * why): the busy mark is set (takeStepMark, never over another mark), and then the files of the windows are read.
   * When another window uses the devspace, when its busy mark is there, or when that cannot be checked, nothing is
   * changed and the open ends with startFailed (OtherWindowUsesError); the mark Devspace.lifecycleIncomplete stays.
   * Otherwise the mark is held for the rest of this run (PipelineContext.busy: releaseBusy in `finally`, or finish,
   * clears it), so that no other window opens the devspace meanwhile. With a busy mark of this run already, nothing
   * is checked.
   *
   * With the mark held, the containers of the devspace are listed again (anyContainerRuns; never the listing of Step
   * 9). When none of them runs, a status file of another window does not count (its connection is lost: it cannot be
   * attached to a stopped container), only its pending connection file, a busy mark, and files that cannot be read.
   * When one runs, or when that is not known, the strict rule applies, and a status file of a live window that is not
   * fresh any more, but not stale either, counts as "not known".
   */
  private async requireNoOtherWindow(ctx: PipelineContext, change: string): Promise<void> {
    if (ctx.busy) return;
    const taken = await this.takeStepMark(ctx, 'update');
    let user: WindowUse | undefined;
    if ('mark' in taken) {
      ctx.busy = true;
      ctx.stepMark = taken.mark;
      user = await this.otherWindowOf(ctx.env, { runs: await this.anyContainerRuns(ctx.env) });
    } else {
      user = taken.user;
    }
    if (user !== undefined) this.refuseForOtherWindow(change, user);
  }

  /** Ends the open with startFailed (OtherWindowUsesError): `user` uses the devspace. */
  private refuseForOtherWindow(change: string, user: WindowUse): never {
    this.logger.warn(`${change}. ${user.text} Nothing is changed, and the open ends.`);
    const who = !user.known
      ? 'it could not be checked whether another window uses the devspace'
      : user.use === 'opening'
        ? 'another window is opening the devspace'
        : user.use === 'busy'
          ? 'another window is working on the devspace'
          : 'another window is connected to the devspace';
    throw new OtherWindowUsesError(`${change}, but ${who}. Nothing was stopped, removed, or renamed. Open or rebuild the devspace again when that window is closed.`);
  }

  /**
   * Whether a container of the devspace runs, listed now: every container with its ID label (the dev container and
   * the other services of Docker Compose) and every container of its Compose project. Every state but `exited` and
   * `created` counts as running (`running`, `restarting`, `paused`, and any other). When the listing (or an inspect in
   * it) fails, it is not known: true (when in doubt, the strict rule stays).
   */
  private async anyContainerRuns(env: Devspace): Promise<boolean> {
    let containers: ContainerInfo[];
    try {
      containers = await this.upContainers(env, true);
    } catch (error) {
      this.logger.warn(`The containers of ${env.repository} could not be listed: ${errorMessage(error)}. They count as running.`);
      return true;
    }
    const running = containers.filter((container) => !NOT_RUNNING_STATES.has((container.rawState ?? '').toLowerCase()));
    if (running.length > 0) {
      this.logger.info(`Containers of ${env.repository} run: ${running.map((container) => `${container.name} (${container.rawState})`).join(', ')}.`);
      return true;
    }
    this.logger.info(`No container of ${env.repository} runs.`);
    return false;
  }

  /**
   * Clears the busy mark `mark` that takeStepMark set, and no other. Never throws. Returns whether that mark is gone
   * from the entry afterwards (false when the registry could not be written).
   */
  private async releaseStepMark(ctx: PipelineContext, mark: BusyMark): Promise<boolean> {
    let gone = false;
    await this.quietly('clear the busy mark', async () => {
      const updated = await this.openRecords.releaseStepMark(ctx.env.id, mark);
      if (updated) {
        ctx.env = updated;
        gone = updated.busy === undefined || !sameBusyMark(updated.busy, mark);
      }
    });
    return gone;
  }

  /**
   * Records `id` in Devspace.lifecycleIncomplete (the container runs without its lifecycle commands, so the next
   * open runs them). Whether that worked; a failure is logged.
   */
  private async markLifecycleIncomplete(ctx: PipelineContext, id: string, name: string): Promise<boolean> {
    // Written twice at most, with a short pause; "the next open runs them" only once it is written.
    for (let attempt = 1; ; attempt++) {
      try {
        this.entryUpdated(ctx, await this.openRecords.lifecycleMark(ctx.env.id, { set: id }));
        this.logger.warn(`The container ${name} runs without its lifecycle commands. The next open runs them.`);
        return true;
      } catch (error) {
        this.logger.warn(`Could not record the container whose lifecycle commands did not run: ${errorMessage(error)}`);
        if (attempt >= 2) return false;
      }
      await this.sleepFn(LIFECYCLE_MARK_RETRY_MS).catch(() => undefined);
    }
  }

  /**
   * The container `id` runs without its lifecycle commands, and the registry could not record it: this window remembers
   * it (unrecordedLifecycle), and the log and a warning say so.
   */
  private async lifecycleNotRecorded(ctx: PipelineContext, id: string, name: string): Promise<void> {
    ctx.unrecordedLifecycle = id;
    // In the memory of the window (in the worker, a request): a failure is logged, the warning still says it.
    await this.lifecycleMemory.remember(ctx.env.id, id).catch((error: unknown) => this.logger.warn(`The window could not remember the container ${name}: ${errorMessage(error)}`));
    this.logger.error(
      `The container ${name} of ${ctx.env.repository} runs without its lifecycle commands, and this could not be recorded. Stop or rebuild the devspace before working in it.`,
    );
    this.deps.ui.warn(Messages.lifecycleNotRecorded(ctx.env.repository));
  }

  /**
   * Whether another window uses the devspace (otherWindowUsesDevspace, with the window status files and the
   * pending connection files), with a sentence for the log; `undefined` when none does. `known: false`: a file could
   * not be read (logged), so it is not known, and the caller keeps the containers as when another window uses them
   * (when in doubt, nothing is stopped or removed).
   */
  private async otherWindowOf(env: Devspace, check?: { runs: boolean }): Promise<WindowUse | undefined> {
    let unreadable = false;
    let windowStatuses: readonly WindowStatus[] | undefined;
    if (this.deps.windowStatuses) {
      try {
        windowStatuses = await this.deps.windowStatuses();
      } catch (error) {
        unreadable = true;
        this.logger.warn(`The window status files could not be read: ${errorMessage(error)}.`);
      }
    }
    let pendings: readonly PendingConnection[] | undefined;
    try {
      pendings = await this.deps.sessionFiles.readPendings();
    } catch (error) {
      unreadable = true;
      this.logger.warn(`The pending connection files could not be read: ${errorMessage(error)}.`);
    }
    const now = this.deps.clock.now();
    // For a destructive check while no container of the devspace runs (`check.runs` false), the status files of
    // other windows do not count (their files are still read: one that cannot be read keeps the answer "not known").
    const windows = check?.runs === false ? [] : windowStatuses;
    // Whether the processes of the windows run is asked first (in the worker, the extension answers). Only for the
    // windows that the rules can count (another window, active, of this devspace), and none when no status file
    // counts: a pid not asked counts as running, but is never looked at.
    const candidates = (windowStatuses ?? []).filter((status) => status.windowId !== this.deps.owner.windowId && statusNamesDevspace(status, env.id) && status.state === 'active');
    const isAlive = await this.processesAlive((check?.runs === false ? [] : candidates).map((status) => status.pid));
    const other = otherWindowUsesDevspace(env.id, this.deps.owner.windowId, { now, isAlive, windowStatuses: windows, pendings });
    if (other !== undefined) {
      // A pending connection file: that window opens the devspace (it may still wait or build).
      return 'window' in other
        ? { known: true, use: 'connected', text: `The window ${other.window.windowId} is connected to it.` }
        : { known: true, use: 'opening', text: `The window ${other.pending.windowId} is opening the devspace.` };
    }
    // For a destructive check while a container runs, a live window whose status file is not fresh any more, but not
    // stale by the Monitor's rule (its waiting time, and the sleep grace), may only have missed its updates
    // (computer sleep): it is not known whether it is connected.
    if (check?.runs === true && !unreadable) {
      const late = otherWindowMayUseDevspace(env.id, this.deps.owner.windowId, {
        now,
        isAlive,
        windowStatuses,
        waitingMs: WINDOW_STATUS_SLACK_MS,
        grace: sleepGraceOfWindow(windowStatuses, this.deps.owner, now),
      });
      if (late !== undefined) {
        return { known: false, text: `The window ${late.windowId} (process ${late.pid}) last wrote its status at ${late.updatedAt}; it may still be connected to ${env.repository}.` };
      }
    }
    return unreadable ? { known: false, text: `It is not known whether another window is connected to ${env.repository}.` } : undefined;
  }

  /**
   * Whether Devspace.lifecycleIncomplete names `container`: its lifecycle commands did not run, so it is not opened
   * as it is.
   */
  private lifecycleIncomplete(ctx: PipelineContext, container: ContainerInfo | undefined): boolean {
    if (container === undefined) return false;
    // Also a container that this window remembers because the mark could not be written (or any one, when the window
    // does not know which: LIFECYCLE_UNKNOWN).
    if (ctx.env.lifecycleIncomplete !== undefined && sameContainer(ctx.env.lifecycleIncomplete, container.id)) return true;
    return ctx.unrecordedLifecycle !== undefined && rememberedFor(ctx.unrecordedLifecycle, container.id);
  }

  /**
   * lifecycleIncomplete for a decision whether `container` opens as it is; the value that the decision used is kept
   * (PipelineContext.lifecycleMarkRead), so that finish clears only that one.
   */
  private decideOnLifecycleMark(ctx: PipelineContext, container: ContainerInfo | undefined): boolean {
    // The value that an earlier decision of this run read (the start of the pipeline, or Step 5) counts too, so that Step 5
    // and Step 9 decide with the same snapshot at least; a newer mark in the entry counts as well (when in doubt, `up`).
    const earlier = ctx.lifecycleMarkRead;
    ctx.lifecycleMarkRead = ctx.env.lifecycleIncomplete;
    if (container !== undefined && earlier !== undefined && sameContainer(earlier, container.id)) return true;
    return this.lifecycleIncomplete(ctx, container);
  }

  /**
   * Forgets the container that the window remembers for the devspace when it is `containerId` (in the worker, a
   * request); a failure is logged (the next open runs the lifecycle commands once more, when in doubt).
   */
  private async forgetUnrecordedLifecycle(ctx: PipelineContext, containerId: string): Promise<void> {
    const unrecorded = ctx.unrecordedLifecycle;
    if (unrecorded === undefined || !rememberedFor(unrecorded, containerId)) return;
    ctx.unrecordedLifecycle = undefined;
    await this.lifecycleMemory.forget(ctx.env.id, containerId).catch((error: unknown) => this.logger.warn(`The window could not forget the container ${containerId}: ${errorMessage(error)}`));
  }

  /** Clears Devspace.lifecycleIncomplete when it names `containerId` (the container is gone). */
  private async clearLifecycleMark(ctx: PipelineContext, containerId: string): Promise<void> {
    // Also the mark that this window remembers.
    await this.forgetUnrecordedLifecycle(ctx, containerId);
    const mark = ctx.env.lifecycleIncomplete;
    if (mark === undefined || !sameContainer(mark, containerId)) return;
    await this.quietly('clear the mark of the container whose lifecycle commands did not run', async () =>
      this.entryUpdated(ctx, await this.openRecords.lifecycleMark(ctx.env.id, 'clear')),
    );
  }

  /**
   * The sentence of the detail of a failed switch of the dev service about the previous dev container
   * (PipelineContext.previousDevContainer): removed when its rename failed; else kept, stopped (it is stopped here when
   * it runs); or created again by Docker Compose as its own service (`up` returned), stopped too.
   */
  private async previousDevContainerAfterFailedSwitch(ctx: PipelineContext, previousService: string): Promise<string> {
    const previous = ctx.previousDevContainer;
    if (previous === undefined) return 'The previous dev container is kept, stopped.';
    if (previous.removed) return `The previous dev container ${previous.name} could not be renamed and was removed; its volumes are kept.`;
    let containers: ContainerInfo[];
    try {
      containers = await this.composeContainers(ctx.env);
    } catch (error) {
      if (this.isCancellation(error, ctx.signal)) throw error;
      this.logger.warn(`The containers of ${ctx.env.repository} could not be listed: ${errorMessage(error)}`);
      return `The state of the previous dev container ${previous.name} is not known.`;
    }
    const stopped = async (container: ContainerInfo): Promise<boolean> => {
      if (container.state !== 'running') return true;
      try {
        await this.deps.docker.stopContainer(container.id);
        return true;
      } catch (error) {
        this.logger.warn(`The container ${container.name} could not be stopped: ${errorMessage(error)}`);
        return false;
      }
    };
    const same = containers.find((container) => container.id === previous.id);
    if (same !== undefined) return (await stopped(same)) ? 'The previous dev container is kept, stopped.' : 'The previous dev container is kept, but it could not be stopped.';
    const again = containers.find((container) => container.labels[COMPOSE_SERVICE_LABEL] === previousService);
    if (again !== undefined) {
      const state = (await stopped(again)) ? '' : ' It could not be stopped.';
      return `Docker Compose created the previous dev container again as the service ${previousService} (${again.name}); the files outside its volumes are gone.${state}`;
    }
    return `The previous dev container ${previous.name} is gone.`;
  }

  /**
   * The dev container `previous` of the service `previousService` of the project, while the configuration names another
   * dev service (compose.service), which gets the name of the devspace. It is renamed to the default name of Compose
   * for its service, so that Compose creates it again as another service (and keeps its volumes without a name, for
   * example `node_modules`) and stopped (when the configuration does not start that service, it stays as it is); when
   * the rename fails, it is stopped and removed (its volumes stay), as at a switch of the kind, and the user learns it.
   * A container that an earlier failed attempt of Compose left in the state `created` (`<id>_<name>`) is removed. The
   * container of the new dev service is stopped before the Dev Container CLI removes it
   * (`--remove-existing-container`).
   */
  private async movePreviousDevContainer(
    ctx: PipelineContext,
    compose: LoadedCompose,
    previous: ContainerInfo,
    previousService: string,
    removeExistingContainer: boolean,
  ): Promise<void> {
    // From here on, the switch of the dev service may have changed the containers.
    ctx.devServiceMoved = true;
    // For the guard of a failed switch, whatever the build record holds.
    ctx.devServiceMovedFrom = previousService;
    const env = ctx.env;
    const { docker } = this.deps;
    const number = previous.labels[COMPOSE_CONTAINER_NUMBER_LABEL] ?? '1';
    const name = `${compose.project}-${previousService}-${number}`;
    this.logger.info(`The dev container ${previous.name} of ${env.repository} is of the service ${previousService}; the configuration uses the service ${compose.service}.`);
    let renamed = false;
    try {
      // An earlier attempt (for example a failed switch) renamed it already; Docker refuses a rename to the current
      // name, and the container must never be removed for that.
      if (previous.name !== name) await docker.renameContainer(previous.id, name);
      renamed = true;
      // For the detail of a failed switch.
      ctx.previousDevContainer = { id: previous.id, name, removed: false, service: previousService };
      this.logger.info(`The container ${previous.name} is now ${name}; Docker Compose creates it again as the service ${previousService} when the configuration starts it.`);
    } catch (error) {
      if (this.isCancellation(error, ctx.signal)) throw error;
      this.logger.info(`The container ${previous.name} could not be renamed (${errorMessage(error)}). It is removed; its volumes are kept.`);
      ctx.steps.detail(Messages.containerComposeDevServiceChanged);
      ctx.previousDevContainer = { id: previous.id, name: previous.name, removed: false, service: previousService };
      await this.stopServiceBeforeRemoval(previous, env);
      await docker.removeContainer(previous.id);
      ctx.previousDevContainer = { id: previous.id, name: previous.name, removed: true, service: previousService };
      (ctx.kindSwitchRemoved ??= []).push(`the container ${previous.name} of the service ${previousService}`);
    }
    // A renamed one is stopped (never removed, nor its volumes), as it keeps the labels of a dev container: when the
    // new configuration does not start its service (runServices, depends_on), Compose leaves it alone, and a running
    // one would outlive Stop. A failed switch leaves it startable: the next open with the previous configuration starts
    // it again.
    if (renamed) await this.stopContainerGracefully(ctx, { ...previous, name });
    for (const container of await this.composeContainers(env)) {
      if (container.id === previous.id) continue;
      if (container.rawState === 'created' && isComposeRecreateLeftoverName(container.name)) {
        this.logger.info(`The container ${container.name} that an earlier start of Docker Compose left behind is removed. Its volumes are kept.`);
        await docker.removeContainer(container.id);
      } else if (removeExistingContainer && container.labels[COMPOSE_SERVICE_LABEL] === compose.service) {
        await this.stopServiceBeforeRemoval(container, env);
      }
    }
  }

  /**
   * The paths of the repository that the ownership fixes leave to the services, computed from facts
   * (boundServiceFolders), in this order: `model` (the paths of the model of this run, with their real paths), the
   * paths that the existing containers of the other services mount (liveServiceFolders; read with the list of the
   * containers, one `docker inspect` for all of them), and the recorded paths (Devspace.serviceFolders, of earlier
   * runs). With `existing` (after `up`, in the running dev container), a recorded path that neither the model nor a
   * container names is kept only while it still exists in the volume (existingServiceFolders). When the containers
   * cannot be read, the recorded list is kept whole: it never shrinks on an error.
   */
  private async serviceFolderFacts(
    env: Devspace,
    model: readonly string[],
    existing?: { ctx: PipelineContext; container: string },
  ): Promise<{ folders: string[]; overflow: boolean }> {
    const repoFolder = repositoryFolder(env.repository);
    let live: string[] | undefined;
    try {
      live = liveServiceFolders(await this.composeContainers(env), env);
    } catch (error) {
      if (existing !== undefined && this.isCancellation(error, existing.ctx.signal)) throw error;
      this.logger.warn(`The mounts of the containers of the Docker Compose project of ${env.repository} could not be read: ${errorMessage(error)}`);
    }
    let recorded = serviceFoldersOf(env);
    if (existing !== undefined && live !== undefined) {
      const named = new Set([...model, ...live]);
      const retired = recorded.filter((folder) => !named.has(folder));
      if (retired.length > 0) {
        const found = await this.existingServiceFolders(existing.ctx, existing.container, retired);
        if (found !== undefined) {
          const dropped = retired.filter((folder) => !found.has(folder));
          if (dropped.length > 0) this.logger.info(`No longer in the volume of ${env.repository}, so no longer left to the services: ${dropped.join(', ')}.`);
          recorded = recorded.filter((folder) => named.has(folder) || found.has(folder));
        }
      }
    }
    const result = boundServiceFolders(repoFolder, [model, live, recorded], env.serviceFoldersOverflow === true);
    if (result.overflow && env.serviceFoldersOverflow !== true) {
      this.logger.warn(
        `More than ${MAX_SERVICE_FOLDERS} paths of ${env.repository} are mounted by other services: the ownership fixes give only the files of root in the repository their owner.`,
      );
    }
    return result;
  }

  /**
   * Of `folders`, those that exist in the volume (the script `existingPaths` of the registry, EXISTING_PATHS_SCRIPT,
   * with `docker exec -u root` in the running dev container `container`); `undefined` when that fails (the caller keeps
   * them all).
   */
  private async existingServiceFolders(ctx: PipelineContext, container: string, folders: readonly string[]): Promise<Set<string> | undefined> {
    const found = new Set<string>();
    // In calls of at most EXISTING_PATHS_CHARACTERS characters of paths (the command line on Windows).
    const batches: string[][] = [[]];
    let characters = 0;
    for (const folder of folders) {
      if (characters + folder.length > EXISTING_PATHS_CHARACTERS && batches[batches.length - 1].length > 0) {
        batches.push([]);
        characters = 0;
      }
      batches[batches.length - 1].push(folder);
      characters += folder.length + 1;
    }
    try {
      for (const batch of batches) {
        const result = await runScript(this.deps.docker, container, 'existingPaths', batch, { user: 'root', signal: ctx.signal, timeoutMs: OWNERSHIP_TIMEOUT_MS });
        if (result.exitCode !== 0) {
          this.logger.warn(`The recorded paths of the services of ${ctx.env.repository} could not be checked: ${(result.stderr || result.stdout).trim()}`);
          return undefined;
        }
        for (const folder of parseExistingPaths(result.stdout)) found.add(folder);
      }
    } catch (error) {
      if (this.isCancellation(error, ctx.signal)) throw error;
      this.logger.warn(`The recorded paths of the services of ${ctx.env.repository} could not be checked: ${errorMessage(error)}`);
      return undefined;
    }
    return found;
  }

  /**
   * Writes `facts` (serviceFolderFacts) to Devspace.serviceFolders and Devspace.serviceFoldersOverflow when they
   * differ.
   */
  private async recordServiceFolders(ctx: PipelineContext, facts: { folders: string[]; overflow: boolean }): Promise<void> {
    const next = facts.folders;
    const own = ctx.env.serviceFolders ?? [];
    const sameOverflow = (ctx.env.serviceFoldersOverflow === true) === facts.overflow;
    if (sameOverflow && own.length === next.length && own.every((folder, i) => folder === next[i])) return;
    this.entryUpdated(ctx, await this.openRecords.configuration(ctx.env.id, { serviceFolders: { folders: next, overflow: facts.overflow } }));
  }

  /**
   * After `up` (finish), the list of the paths of the services from facts, written back to the entry, for the ownership
   * fix after `up`. `undefined` for a devspace that neither is of Docker Compose nor has recorded paths.
   */
  private async refreshServiceFolders(ctx: PipelineContext, container: string, loaded: LoadedConfiguration | undefined): Promise<ServiceFolders | undefined> {
    const env = ctx.env;
    const compose = loaded?.compose !== undefined || ctx.composeContainer === true || ctx.modelServiceFolders !== undefined;
    if (!compose && serviceFoldersOf(env).length === 0 && env.serviceFoldersOverflow !== true) return undefined;
    const facts = await this.serviceFolderFacts(env, ctx.modelServiceFolders ?? [], { ctx, container });
    await this.recordServiceFolders(ctx, facts);
    return facts.overflow ? 'repository' : facts.folders;
  }

  /**
   * The paths of the repository with data of the services, relative to the repository folder (`./data/postgres`), for
   * the confirmation of Delete: the recorded paths and those that the existing containers of the other services mount.
   * Never throws: without Docker, the recorded paths.
   */
  async repositoryServiceData(devspaceId: string): Promise<string[]> {
    const env = await this.deps.registry.get(devspaceId);
    if (!env || !(await this.isOnCurrentHost(env))) return [];
    let folders: string[];
    try {
      folders = (await this.serviceFolderFacts(env, [])).folders;
    } catch (error) {
      this.logger.warn(`The paths of the services of ${env.repository} could not be read: ${errorMessage(error)}`);
      folders = serviceFoldersOf(env);
    }
    return repositoryServiceDataFolders({ repository: env.repository, serviceFolders: folders });
  }

  /**
   * The labels of the images of the other services that exist (the images that Compose pulls or that the pipeline
   * pulled, not those that Compose builds during `up`), as imageLabelItems names them.
   */
  private async serviceImageLabelItems(ctx: PipelineContext, compose: LoadedCompose): Promise<string[]> {
    const items: string[] = [];
    for (const reference of composeServiceImageReferences(compose.output.model, compose.service)) {
      let labels: Record<string, string>;
      try {
        labels = (await this.imageMetadataAndLabels(reference, ctx.signal)).labels;
      } catch (error) {
        if (this.isCancellation(error, ctx.signal)) throw error;
        // Not here yet: Compose pulls it in the workspace helper (a limit: its labels are not checked here).
        continue;
      }
      // The images of the account's own devspaces may be used: an image with the labels of another devspace of
      // the same account (a registry entry) carries that devspace's labels.
      const labelled = labels[LABEL_DEVSPACE_ID];
      const sameAccount =
        labelled !== undefined && labelled !== ctx.env.id
          ? (await this.deps.registry.list().catch(() => [])).find((entry) => entry.id === labelled && entry.owner.id === ctx.env.owner.id)
          : undefined;
      // That devspace's image carries its build record too (labelImage writes it).
      items.push(...imageLabelItems(reference, labels, sameAccount !== undefined ? { ...ownImageLabels(sameAccount), devspaceImage: true } : ownImageLabels(ctx.env)));
    }
    return items;
  }

  /**
   * Before `up` creates the containers of a Docker Compose configuration: the named volumes of the model and the
   * volumes of the `mounts` (composeMountVolumes) that do not exist are created with the labels of the devspace, so
   * that they are its own and our model can declare them external: nimblescape.devspaces.volume=compose for a volume of
   * the project (`<project>_<key>` of the model, the data of the services, and `<project>_<source>` of a `mounts`
   * entry, which the CLI puts into the project), `additional` for the other ones (a volume that the model or a mount
   * names itself, which another devspace of the same owner may share). A `compose` volume is never shared with
   * another devspace (isSameOwnerAdditionalVolume needs `additional`).
   */
  private async createComposeVolumes(ctx: PipelineContext, compose: LoadedCompose, mounts: { names: readonly string[]; sources: readonly string[] }): Promise<void> {
    const kinds = new Map<string, string>();
    for (const volume of composeVolumeNames(compose.output.model, compose.project)) {
      kinds.set(volume.name, volume.project ? VOLUME_KIND_COMPOSE : VOLUME_KIND_ADDITIONAL);
    }
    for (const source of mounts.sources) {
      const name = `${compose.project}_${source}`;
      if (!kinds.has(name)) kinds.set(name, VOLUME_KIND_COMPOSE);
    }
    for (const name of mounts.names) if (!kinds.has(name)) kinds.set(name, VOLUME_KIND_ADDITIONAL);
    // The volumes of the other services hold their data (whatever their kind): the label says so also after a lost
    // registry.
    const serviceData = new Set(composeServiceVolumeNames(compose.output.model, compose.project, compose.service));
    await this.createAdditionalVolumes(ctx, [...kinds.keys()], (name) => ({
      [LABEL_VOLUME]: kinds.get(name) ?? VOLUME_KIND_ADDITIONAL,
      ...(serviceData.has(name) ? { [LABEL_SERVICE_DATA]: SERVICE_DATA } : {}),
    }));
  }

  /**
   * The named volumes that the container of the devspace mounts join its additional volumes (recordedVolumes).
   * `all`: the volumes of every container of the devspace (the services of a Docker Compose configuration).
   */
  private async recordContainerVolumes(ctx: PipelineContext, all = false): Promise<void> {
    const containers = all ? await this.deps.docker.devspaceContainers(ctx.env.id) : [await this.deps.docker.findContainer(ctx.env.id, ctx.env.containerName)];
    const volumes = await this.recordedVolumes(
      containers.flatMap((container) => container?.volumes ?? []),
      ctx.env,
    );
    await this.recordAdditionalVolumes(ctx, volumes);
  }

  /**
   * The volumes of `names` that the pipeline records as additional volumes of `env`: existing volumes, other than the
   * workspace volume, whose labels make them its own (isOwnVolume: nimblescape.devspaces.id and
   * nimblescape.devspaces.owner-id), and existing additional volumes of other devspaces of the same owner
   * (isSameOwnerAdditionalVolume), which the devspaces of one account share (for example
   * `${localWorkspaceFolderBasename}-node_modules` of a fork and its upstream repository). Such a record only protects
   * the shared volume: the Delete of the other devspace keeps a volume that another entry records, and the Delete of
   * this one never removes it (removableVolumes: not its own). Any other volume (an anonymous volume, a volume of
   * another program or account, a volume that Docker created at `up`) is never recorded, so Delete never removes it.
   */
  private async recordedVolumes(names: readonly string[], env: Pick<Devspace, 'id' | 'volumeName' | 'owner'>): Promise<string[]> {
    // Never the shared VS Code server store.
    const candidates = [...new Set(names)].filter((name) => name !== env.volumeName && !this.isVscodeStore(name));
    if (candidates.length === 0) return [];
    const volumes = await this.deps.docker.inspectVolumes(candidates);
    const recorded = new Set(
      volumes
        .filter((volume) => isOwnVolume(volume.labels, env.id, env.owner.id) || isSameOwnerAdditionalVolume(volume.labels, env.owner.id))
        .map((volume) => volume.name),
    );
    return candidates.filter((name) => recorded.has(name));
  }

  /**
   * Before `up` creates a container: each named volume that it mounts (the configuration, the `runArgs` that Docker
   * gets, and the image metadata) and that does not exist yet is created with the labels of the devspace
   * (additionalVolumeLabels), so that it is the devspace's own; then the own volumes and the existing additional
   * volumes of other devspaces of the same owner are recorded (recordedVolumes). An existing volume keeps its labels
   * (Docker does not change them). A name with `${devcontainerId}` is not among them: the Dev Container CLI 0.89.0
   * resolves it only at `up` (read-configuration substitutes it only for an existing container), so Docker creates that
   * volume without labels, and it is never the devspace's (for a single container; the volumes of the `mounts` of
   * Docker Compose come with the real ID, composeMountVolumes). A volume that cannot be created is logged: Docker
   * creates it at `up` without the labels, and Delete keeps it.
   */
  private async createAdditionalVolumes(ctx: PipelineContext, names: readonly string[], labelsOf?: (name: string) => Record<string, string>): Promise<void> {
    const env = ctx.env;
    // The shared VS Code server store, which the override configuration mounts, is never created with the labels of the
    // devspace, nor recorded (it is no devspace's volume).
    const candidates = [...new Set(names)].filter((name) => name !== env.volumeName && !this.isVscodeStore(name));
    if (candidates.length === 0) return;
    const inspected = await this.deps.docker.inspectVolumes(candidates);
    const existing = new Set(inspected.map((volume) => volume.name));
    // A known limit (docs/security.md "Known limits"): an existing volume without labels is nobody's, so every
    // devspace that mounts it by the same name shares it, also of another account.
    for (const volume of inspected) {
      if (Object.keys(volume.labels).length === 0) {
        this.logger.info(`The volume ${volume.name} exists without labels (created by Docker at a start, or by hand): it is not the devspace's, and every devspace that mounts it shares it.`);
      }
    }
    for (const name of candidates) {
      if (existing.has(name)) continue;
      this.throwIfCancelled(ctx.signal);
      try {
        await this.deps.docker.createVolume(name, labelsOf ? { ...volumeLabels(env), ...labelsOf(name) } : additionalVolumeLabels(env));
      } catch (error) {
        this.logger.warn(`The volume ${name} could not be created with the labels of the devspace. Docker creates it at the start without them, and Delete keeps it: ${errorMessage(error)}`);
      }
    }
    await this.recordAdditionalVolumes(ctx, await this.recordedVolumes(candidates, env));
  }

  /**
   * Lifecycle token: after `up --skip-post-create` (upArgs), the token goes into the container of `result`
   * (writeGitToken: a failure is a warning, and the commands run without the token), then `devcontainer
   * run-user-commands` runs the lifecycle commands with the inputs of `up` (WorkspaceHelper.runUserCommands), as `up`
   * would have run them. The result of `up`, with `lifecycleCommandFailure` when a command failed and the container
   * runs (WorkspaceHelper.runUserCommands); throws the other failures, which the callers handle as failures of `up`
   * (keptAfterLifecycleFailure covers a failed command reported as an error). A result of `up` that reports a failed
   * command, or has no container, is returned as it is. `configUser`: the remote user of the configuration, when `up`
   * names none (as finish reads it).
   */
  private async runUserCommands(
    ctx: PipelineContext,
    result: DevcontainerResult & { lifecycleCommandFailure?: unknown },
    inputs: { override: Record<string, unknown>; files?: Record<string, string>; env?: Record<string, string> },
    configUser: string | undefined,
  ): Promise<DevcontainerResult & { lifecycleCommandFailure?: unknown }> {
    const containerId = nonEmptyString(result.containerId);
    if (containerId === undefined || nonEmptyString(result.lifecycleCommandFailure) !== undefined) return result;
    const env = ctx.env;
    const remoteUser = nonEmptyString(result.remoteUser) ?? env.remoteUser ?? configUser ?? 'root';
    await this.writeGitToken(ctx, containerId, remoteUser);
    ctx.tokenWrittenTo = containerId;
    // Git older than 2.31 ignores GIT_CONFIG_COUNT and GIT_CONFIG_GLOBAL and reaches the credential helper of the
    // container only through ~/.gitconfig, so it is prepared before the commands (the script writes only a missing or
    // empty file, so also a started container gets it; a failure is logged, and the commands run all the same).
    await this.runHomeGitConfigScript(ctx, containerId, remoteUser);
    ctx.homeGitConfigWrittenTo = containerId;
    const commands = await this.deps.helper.runUserCommands({
      volumeName: env.volumeName,
      repository: env.repository,
      devspaceId: env.id,
      containerId,
      ...inputs,
      // The commands can read the token; the helper removes it from their output and from its errors.
      token: ctx.session.token,
      onOutput: this.output,
      image: ctx.helperImage,
      signal: ctx.signal,
    });
    const failure = nonEmptyString(commands.lifecycleCommandFailure);
    return failure === undefined ? result : { ...result, lifecycleCommandFailure: failure };
  }

  /**
   * `up` or run-user-commands failed because a lifecycle command failed (lifecycleHookFailure), and the container that it
   * created or started runs: the result for that container, with the description of the CLI in `lifecycleCommandFailure`.
   * Otherwise `undefined`. (WorkspaceHelper.up and runUserCommands return such a result themselves; this covers one that
   * is reported as an error.)
   */
  private async keptAfterLifecycleFailure(
    ctx: PipelineContext,
    error: unknown,
  ): Promise<(DevcontainerResult & { lifecycleCommandFailure: string }) | undefined> {
    if (this.isCancellation(error, ctx.signal) || !(error instanceof DevcontainerCommandError) || !error.result) return undefined;
    const containerId = nonEmptyString(error.result.containerId);
    if (containerId === undefined || lifecycleHookFailure(error.result) === undefined) return undefined;
    const container = await this.deps.docker.findContainer(ctx.env.id, ctx.env.containerName).catch(() => undefined);
    if (container?.state !== 'running' || !sameContainerId(container.id, containerId)) return undefined;
    this.logger.error(`A lifecycle command failed in the container ${container.name} of ${ctx.env.repository}. It runs and is kept.`, error);
    return { outcome: 'success', containerId, lifecycleCommandFailure: String(error.result.description) };
  }

  /**
   * A lifecycle command of the configuration (for example postStartCommand) failed, but its container runs. As with the
   * Dev Containers extension, the devspace opens anyway, so the user can fix the command inside; the failure is a
   * warning. Otherwise a stopped container would never start again, and a first open would remove the new devspace.
   * The result of a failed `up` names no remote user: it comes from the metadata of the image, as `up` resolves it.
   */
  private async openAfterLifecycleFailure(
    ctx: PipelineContext,
    result: DevcontainerResult,
    description: string,
    image: string,
    runArgs: readonly string[],
  ): Promise<DevcontainerResult> {
    this.logger.warn(`${description} The devspace of ${ctx.env.repository} is opened anyway.`);
    this.deps.ui.warn(PipelineTexts.lifecycleCommandFailed(lifecycleHookName(description)));
    if (nonEmptyString(result.remoteUser) !== undefined) return result;
    try {
      // Not known when the label names it with a variable whose value is not known: then none.
      const remoteUser = await this.imageUser(ctx, image, runArgs);
      return remoteUser === undefined ? result : { ...result, remoteUser };
    } catch (error) {
      if (this.isCancellation(error, ctx.signal)) throw error;
      this.logger.info(`The remote user of ${image} could not be read: ${errorMessage(error)}`);
      return result;
    }
  }

  /**
   * The user that `devcontainer up` gives a container of `image` with the `runArgs` that it passes to Docker (label
   * devcontainer.metadata, as the CLI substitutes it at `up`, `--user` of the runArgs, and the user of the image; see
   * imageRemoteUser). `undefined` when it depends on a variable whose value is not known.
   */
  private async imageUser(ctx: PipelineContext, image: string, runArgs: readonly string[]): Promise<string | undefined> {
    return imageRemoteUser(await this.imageConfig(image, ctx.signal), runArgs, helperCliVariables(ctx.env.repository));
  }

  /** `Config` of `docker image inspect`. */
  private async imageConfig(image: string, signal: AbortSignal | undefined): Promise<unknown> {
    return this.deps.docker.imageConfig(image, { timeoutMs: IMAGE_INSPECT_TIMEOUT_MS, signal });
  }

  /**
   * Host access checks: what the policy checks for `env`, with what it needs to know about the named volumes that the
   * configuration mounts: the volumes of the devspaces of other accounts (their additional volumes), and the volumes
   * that the Delete of a devspace of another account kept while they exist, except the volumes that `env` recorded
   * itself; and the labels of the volumes that exist.
   */
  private async hostAccessInput(
    env: Devspace,
    input: Omit<HostAccessInput, 'ownVolume'>,
    moreVolumes: readonly string[] = [],
    moreNetworks: readonly string[] = [],
  ): Promise<HostAccessInput> {
    // Checked as the Dev Container CLI resolves the variables at `up` (helperCliVariables). The runs of Docker Compose
    // (composeMounts) get COMPOSE_PROJECT_NAME with the project name of the devspace.
    const composeEnv: Record<string, string> = input.composeMounts === true ? { COMPOSE_PROJECT_NAME: composeProjectName(env.repository, env.id) } : {};
    const checked: HostAccessInput = {
      ...input,
      ownVolume: env.volumeName,
      variables: helperCliVariables(env.repository, composeEnv),
      // The store of the worker, whose mount the override configuration adds (default VSCODE_STORE_VOLUME).
      ...(this.deps.vscodeStoreVolume !== undefined ? { vscodeStoreVolume: this.deps.vscodeStoreVolume } : {}),
    };
    const file = await this.deps.registry.read();
    const otherOwner = (owner: GitHubAccount) => owner.id !== env.owner.id;
    const others = file.devspaces.filter((other) => other.id !== env.id && otherOwner(other.owner));
    // `moreVolumes`: the named volumes of a Docker Compose model, whose labels its check needs too.
    const names = [...new Set([...mountedVolumeNames(checked), ...moreVolumes])];
    const volumeLabels: Record<string, Record<string, string>> = {};
    if (names.length > 0) for (const volume of await this.deps.docker.inspectVolumes(names)) volumeLabels[volume.name] = volume.labels;
    // A kept volume that was removed since (for example by `docker volume prune`) is no longer anybody's: a new one of that
    // name is empty. Its records are dropped, so that they do not protect the volume of that name that this start creates.
    const gone = names.filter((name) => !(name in volumeLabels) && (file.keptVolumes ?? []).some((record) => record.name === name));
    if (gone.length > 0) await this.deps.registry.forgetKeptVolumes(gone);
    const kept = (file.keptVolumes ?? []).filter((record) => otherOwner(record.owner) && record.name in volumeLabels);
    // A volume that the devspace recorded itself stays its own: after a lost registry, the restored entries of two
    // accounts can both record a volume without labels of Devspace that their containers mount
    // (protectedMountedVolumes).
    const own = new Set(env.additionalVolumes ?? []);
    const foreignVolumes = [...others.flatMap((other) => other.additionalVolumes ?? []), ...kept.map((record) => record.name)].filter(
      (name) => !own.has(name),
    );
    const devspace = { id: env.id, ownerId: env.owner.id };
    // The networks that the configuration names, with their labels and containers, so that the network of another
    // devspace is refused also under a name of its own.
    const networkNames = [...new Set([...runArgsNetworks(input.config?.runArgs), ...runArgsNetworks(input.merged?.runArgs), ...moreNetworks])];
    const networks = await this.networkStates(env, networkNames, file.devspaces);
    return { ...checked, foreignVolumes, volumeLabels, devspace, networks };
  }

  /**
   * The networks of `names` (the references that the configuration writes) that exist (`docker network inspect`), each
   * under its reference (a name, an ID, or a unique prefix of an ID, resolveNetworkReference), with its name, its
   * labels, and the devspaces of the containers attached to it (label nimblescape.devspaces.id), of which
   * those of entries of the owner of `env`, for foreignNetworkItem.
   */
  private async networkStates(env: Devspace, names: readonly string[], entries: readonly Devspace[]): Promise<Record<string, NetworkState>> {
    const states: Record<string, NetworkState> = {};
    if (names.length === 0) return states;
    const networks: NetworkInfo[] = await this.deps.docker.inspectNetworks(names);
    const devspaces = new Map<string, string>();
    if (networks.some((network) => network.containers.length > 0)) {
      for (const container of await this.deps.docker.listDevspaceContainers()) {
        const id = container.labels[LABEL_DEVSPACE_ID];
        if (id !== undefined) devspaces.set(container.id, id);
      }
    }
    // A devspace of no entry is never of the same owner.
    const owner = env.owner.id;
    const sameOwner = (id: string): boolean => entries.some((entry) => entry.id === id && entry.owner.id === owner);
    for (const reference of names) {
      const network = resolveNetworkReference(reference, networks);
      if (!network) continue;
      const ids = [...new Set(network.containers.map((id) => devspaces.get(id)).filter((id): id is string => id !== undefined))];
      states[reference] = { name: network.name, labels: network.labels, devspaces: ids, sameOwnerDevspaces: ids.filter(sameOwner) };
    }
    return states;
  }

  /**
   * Host access checks, before every `up`: the label devcontainer.metadata of the devspace image holds what `up`
   * applies from the base image, the Features, and the configuration of the build (mounts, privileged mode,
   * capabilities). It also covers a configuration that could not be read, and Features that a build added after the
   * merged configuration was read. Throws UserFacingError('hostAccess'). Returns the named volumes that the metadata
   * mounts.
   */
  private async checkImageHostAccess(ctx: PipelineContext, image: string): Promise<string[]> {
    const { metadata, labels } = await this.imageMetadataAndLabels(image, ctx.signal);
    // The same switch as the check of the configuration (read at the start of this open).
    return this.checkMetadataHostAccess(ctx, image, metadata, ctx.hostAccessChecks, labels);
  }

  /** The entries of the label devcontainer.metadata of `image` (none when it has no valid label), and all its labels. */
  private async imageMetadataAndLabels(image: string, signal: AbortSignal | undefined): Promise<{ metadata: unknown[]; labels: Record<string, string> }> {
    const config = await this.imageConfig(image, signal);
    const labels = isRecord(config) && isRecord(config.Labels) ? config.Labels : {};
    const stringLabels: Record<string, string> = {};
    for (const [key, value] of Object.entries(labels)) if (typeof value === 'string') stringLabels[key] = value;
    const text = labels['devcontainer.metadata'];
    let metadata: unknown[] = [];
    if (typeof text === 'string') {
      try {
        const parsed: unknown = JSON.parse(text);
        metadata = Array.isArray(parsed) ? parsed : [parsed];
      } catch {
        this.logger.warn(`The label devcontainer.metadata of ${image} is not valid JSON.`);
      }
    }
    return { metadata, labels: stringLabels };
  }

  /**
   * checkImageHostAccess for the metadata of `image` that was read already. `labels`: the labels of the image; those by
   * which the extension, the CLI, and Compose find containers stay refused whatever the switch says (imageLabelItems),
   * and so do `moreItems` (the labels of the images of the other services of Docker Compose). `composeMounts`: the
   * image of the dev service of Docker Compose (HostAccessInput.composeMounts).
   */
  private async checkMetadataHostAccess(
    ctx: PipelineContext,
    image: string,
    metadata: readonly unknown[],
    checks: HostAccessChecks,
    labels: Readonly<Record<string, string>> = {},
    moreItems: readonly string[] = [],
    composeMounts = false,
  ): Promise<string[]> {
    // For Docker Compose, the `mounts` of the metadata also as the CLI writes them (composeMounts).
    const checked = await this.hostAccessInput(ctx.env, { metadata, ...(composeMounts ? { composeMounts: true } : {}) });
    const report = addRefusedItems(await this.check(ctx, 'imageMetadata', checked, checks), 'hostAccess', [...imageLabelItems(image, labels, { ...ownImageLabels(ctx.env), devspaceImage: true }), ...moreItems]);
    if (!isRefused(report)) return mountedVolumeNames(checked);
    this.logger.warn(`The devspace image ${image} of ${ctx.env.repository} is refused by the host access policy: ${describeRefusal(report)}`);
    throw new HostAccessError(report);
  }

  /**
   * Recorded volumes (recordedVolumes) join the additional volumes of the entry: Delete offers to remove the own ones
   * that no other entry records, and the policy refuses them to the devspaces of other accounts too.
   */
  private async recordAdditionalVolumes(ctx: PipelineContext, names: readonly string[]): Promise<void> {
    const added = names.filter((name) => name !== ctx.env.volumeName && !(ctx.env.additionalVolumes ?? []).includes(name));
    if (added.length === 0) return;
    this.entryUpdated(ctx, await this.openRecords.configuration(ctx.env.id, { addVolumes: added }));
  }

  /**
   * Git inside the container: the Git configuration of the container, written into the volume once per run, before `up`
   * (without the token, which goes into the memory of the container after its start, writeGitToken). A failure is a
   * warning: the devspace opens, but Git may not reach GitHub. Before `up` (`beforeUp`), a helperFailed (the helper
   * image of the open is gone) ends the step instead, as `up` would fail the same way: nothing is removed for it.
   */
  private async prepareGit(ctx: PipelineContext, beforeUp = false): Promise<void> {
    if (ctx.gitPrepared || ctx.helperUnavailable) return;
    ctx.gitPrepared = true;
    const env = ctx.env;
    try {
      await this.requireVolume(env);
      // Asked for when the session became known; a Cancel does not wait for GitHub.
      const identity = await waitUnlessAborted(ctx.identity, ctx.signal);
      await this.deps.helper.prepareGit({
        volumeName: env.volumeName,
        repository: env.repository,
        identity,
        onOutput: this.output,
        image: ctx.helperImage,
        signal: ctx.signal,
      });
    } catch (error) {
      if (this.isCancellation(error, ctx.signal) || isFilesMissing(error)) throw error;
      // Before `up`, the caller handles the helperFailed (the open ends with it), without the warning about the Git
      // configuration.
      if (beforeUp && isHelperFailed(error)) {
        ctx.helperUnavailable = true;
        throw error;
      }
      // The refusal of the batch scope is no warning about the Git configuration; it refuses the operation, also for a
      // running container that would open as it is.
      if (isBatchHelperUnavailable(error)) throw error;
      this.logger.error(`The Git configuration of ${env.repository} could not be written.`, error);
      this.deps.ui.warn(Messages.gitSetupFailed);
    }
  }

  /**
   * Git inside the container: the token of the owner account and the sign-in of the GitHub CLI as that account go into
   * the tmpfs TOKEN_FOLDER of the running dev container (the script `tokenWrite` of the registry, TOKEN_WRITE_SCRIPT:
   * `docker exec -i -u root`, the token on stdin only), owned by `user`. They stay there while the container runs, also
   * without a window, and are gone when it stops. A failure is a warning: the devspace opens, but Git and the GitHub
   * CLI in it cannot reach GitHub as the owner account. The exec gets the token as the secret of the operation by its
   * name (the entry's `secretInputName`), never as an argument or a value of the call; the token of the session is
   * checked first, and is masked in the output and in the reason of a failure.
   */
  private async writeGitToken(ctx: PipelineContext, container: string, user: string): Promise<void> {
    const { token, account } = ctx.session;
    // The devspace belongs to the account of the session: the GitHub CLI there is signed in as it.
    if (!isGitHubLogin(account.login)) {
      this.logger.warn(`The GitHub login ${JSON.stringify(account.login)} is no valid GitHub login; the GitHub CLI in the container is not signed in.`);
    }
    try {
      // The one token check (isValidToken).
      if (!isValidToken(token)) throw new Error('No valid GitHub token.');
      const result = await runScript(this.deps.docker, container, 'tokenWrite', [user, tokenLogin(account.login)], {
        user: 'root',
        signal: ctx.signal,
        timeoutMs: GIT_EXEC_TIMEOUT_MS,
      });
      if (result.exitCode !== 0) throw new Error(tokenRunMessage(result, token));
      // The standard output of a successful write, masked; a write without output logs nothing.
      const output = redact(result.stdout.trim(), token);
      if (output !== '') this.logger.info(output);
    } catch (error) {
      if (this.isCancellation(error, ctx.signal)) throw error;
      this.logger.error(`The GitHub token could not be written into the container of ${ctx.env.repository}: ${errorMessage(error)}`);
      this.deps.ui.warn(Messages.gitSetupFailed);
    }
  }

  /** The shared VS Code server store of the engine (DevspaceServiceDeps.vscodeStoreVolume). */
  private vscodeStoreVolume(): string {
    return this.deps.vscodeStoreVolume ?? VSCODE_STORE_VOLUME;
  }

  /** `name` is the shared VS Code server store: its fixed name, or the store of the worker. */
  private isVscodeStore(name: string): boolean {
    return name === VSCODE_STORE_VOLUME || name === this.vscodeStoreVolume();
  }

  /**
   * Starts the fetch of the shared VS Code server of the open (DevspaceServiceDeps.vscodeServer) with the signal of
   * the open, once per open (`options`: openFirst and the openExisting that it may hand over to share it); `undefined`
   * without a server. Never rejects.
   */
  private startVscodeServer(options: OpenOptions): VscodeServerFetch | undefined {
    const server = this.deps.vscodeServer;
    if (server === undefined) return undefined;
    const started = this.vscodeServerFetches.get(options);
    if (started !== undefined) return started;
    const fetch: VscodeServerFetch = { ready: Promise.resolve(undefined), settled: false };
    const signal = options.signal ?? new AbortController().signal;
    fetch.ready = server
      .fetch(signal)
      .catch(() => undefined)
      .finally(() => {
        fetch.settled = true;
      });
    this.vscodeServerFetches.set(options, fetch);
    return fetch;
  }

  /**
   * The open needs the VS Code server of the same commit as the VS Code window: before the window connects, the server
   * of the store is linked into the dev container. Only when the dev container mounts the store read-only at
   * VSCODE_STORE_TARGET (its inspect): the open waits for its fetch (ctx.vscodeServer; with the detail "Downloading the
   * VS Code server." while it still runs; a cancel of the open ends the wait), and when the store has the server, the
   * script `vscodeServerLink` runs as the remote user (it decides the platform of the container, and whether a link is
   * made; one line in the log). A failure is a line in the log and `skipped` or `missing`: the Dev Containers extension
   * then installs the server into the container itself; only a cancel of the open ends the open. `undefined` without a
   * server of the open.
   */
  private async linkVscodeServer(ctx: PipelineContext, container: string, containerName: string, user: string): Promise<VscodeServerLink | undefined> {
    const vscode = this.deps.vscodeServer;
    if (vscode === undefined) return undefined;
    const { commit, quality } = vscode.server;
    const store = this.vscodeStoreVolume();
    try {
      const found = await this.deps.docker.findContainer(ctx.env.id, containerName);
      // The one check of the mount, shared with the Monitor's link (mountsVscodeStore).
      const mounted = found !== undefined && (sameContainer(found.id, container) || found.name === container) && mountsVscodeStore(found.mountTargets, store);
      if (!mounted) {
        this.logger.info(`The VS Code server ${commit} is not linked: the container of ${ctx.env.repository} does not mount the shared store (it was created before; a rebuild adds it).`);
        return { outcome: 'skipped' };
      }
      const fetch: VscodeServerFetch = ctx.vscodeServer ?? { ready: Promise.resolve(undefined), settled: true };
      // A container that has the server of the window already (the Dev Containers extension installed it at an earlier
      // connect) keeps it (the link answers `present`), so the open does not wait for a fetch that still runs; the
      // fetch goes on for the store.
      if (!fetch.settled && (await this.vscodeServerInContainer(container, commit, quality, user, ctx.signal))) {
        this.logger.info(`The VS Code server ${commit} is in the container of ${ctx.env.repository} already; the open does not wait for its download into the shared store.`);
        return { outcome: 'present' };
      }
      // The detail only while the fetch still runs (a present server: no wait, no detail).
      const shown = !fetch.settled;
      if (shown) ctx.steps.detail(PipelineTexts.downloadingVscodeServer);
      let platform: VscodePlatform | undefined;
      try {
        platform = await waitUnlessAborted(fetch.ready, ctx.signal);
      } finally {
        if (shown) ctx.steps.clearDetail();
      }
      if (platform === undefined) {
        this.logger.info(`The shared store does not have the VS Code server ${commit}; the Dev Containers extension installs it into the container of ${ctx.env.repository}.`);
        return { outcome: 'missing' };
      }
      const result = await runScript(this.deps.docker, container, 'vscodeServerLink', [commit, quality, platform], {
        user,
        signal: ctx.signal,
        timeoutMs: GIT_EXEC_TIMEOUT_MS,
      });
      const outcome = vscodeServerLinkOutcome(result);
      switch (outcome.kind) {
        case 'linked':
          this.logger.info(`The VS Code server ${commit} is linked from the shared store into the container of ${ctx.env.repository}.`);
          return { outcome: 'linked' };
        case 'present':
          this.logger.info(`The VS Code server ${commit} is in the container of ${ctx.env.repository} already; it is left as it is.`);
          return { outcome: 'present' };
        case 'failed':
          this.logger.warn(`The VS Code server ${commit} could not be linked into the container of ${ctx.env.repository} (${outcome.reason}); the Dev Containers extension installs it.`);
          return { outcome: 'skipped' };
        default:
          this.logger.info(`The VS Code server ${commit} is not linked into the container of ${ctx.env.repository} (${outcome.kind}: ${outcome.reason}); the Dev Containers extension installs it.`);
          return { outcome: 'skipped' };
      }
    } catch (error) {
      if (this.isCancellation(error, ctx.signal)) throw error;
      this.logger.warn(`The VS Code server ${commit} could not be linked into the container of ${ctx.env.repository} (${errorMessage(error)}); the Dev Containers extension installs it.`);
      return { outcome: 'skipped' };
    }
  }

  /**
   * The home folder of the remote user in the container has the server of the window (the script `vscodeServerPresent`,
   * as that user). A failure is false (the open then waits for the fetch); only a cancel of the open ends it.
   */
  private async vscodeServerInContainer(container: string, commit: string, quality: string, user: string, signal: AbortSignal | undefined): Promise<boolean> {
    try {
      const result = await runScript(this.deps.docker, container, 'vscodeServerPresent', [commit, quality], { user, signal, timeoutMs: GIT_EXEC_TIMEOUT_MS });
      return vscodeServerPresent(result);
    } catch (error) {
      if (this.isCancellation(error, signal)) throw error;
      return false;
    }
  }

  /**
   * The open never downloads extensions and never waits for them. With a VS Code server of the open and the extension
   * cache of the worker (DevspaceServiceDeps.vscodeServer .extensions), records the extension list of the open (the
   * configuration's extensions of `loaded`, else the recorded ones, and the user's defaults; recordExtensions), and,
   * when the dev container mounts the store read-only at VSCODE_STORE_TARGET (mountsVscodeStore), runs the script
   * `vscodeExtensionSeed` as the remote user once with the cached files of the store for that list and the
   * dependencies of its entries (seedSelection: the newest of each entry for the engine's platform, which the fetch of
   * the server found, or universal), which copies
   * them into its extension cache without replacing a file. No files: no script. Every failure is one line in the log
   * and never fails the open; only a cancel of the open ends it.
   */
  private async seedVscodeExtensions(ctx: PipelineContext, container: string, containerName: string, user: string, loaded: LoadedConfiguration | undefined): Promise<void> {
    const vscode = this.deps.vscodeServer;
    const cache = vscode?.extensions;
    if (vscode === undefined || cache === undefined) return;
    try {
      const list = await cache.record(ctx.env.id, loaded?.extensions);
      if (list.length === 0) return;
      const found = await this.deps.docker.findContainer(ctx.env.id, containerName);
      if (found === undefined || !(sameContainer(found.id, container) || found.name === container) || !mountsVscodeStore(found.mountTargets, this.vscodeStoreVolume())) return;
      // The fetch of the server settled before the link (linkVscodeServer): its platform is the engine's, or unknown.
      const platform = ctx.vscodeServer !== undefined && ctx.vscodeServer.settled ? await ctx.vscodeServer.ready : undefined;
      const files = await cache.seedFiles(list, platform);
      if (files.length === 0) {
        this.logger.info(`The shared extension cache has none of the ${list.length} extension(s) of ${ctx.env.repository} yet; the Monitor downloads them in the background.`);
        return;
      }
      const result = await runScript(this.deps.docker, container, 'vscodeExtensionSeed', [vscode.server.quality, platform ?? 'none', ...files], {
        user,
        signal: ctx.signal,
        timeoutMs: GIT_EXEC_TIMEOUT_MS,
      });
      const outcome = vscodeExtensionSeedOutcome(result);
      if (outcome.kind === 'seeded') {
        this.logger.info(
          `The shared extension cache seeded the container of ${ctx.env.repository}: ${outcome.copied} copied, ${outcome.present} present, ${outcome.skipped} skipped, ${outcome.failed} failed (of ${list.length} extension(s) and their dependencies).`,
        );
      } else {
        this.logger.info(`The shared extension cache did not seed the container of ${ctx.env.repository} (${outcome.kind}: ${outcome.reason}).`);
      }
    } catch (error) {
      if (this.isCancellation(error, ctx.signal)) throw error;
      this.logger.warn(`The shared extension cache could not seed the container of ${ctx.env.repository}: ${errorMessage(error)}`);
    }
  }

  /**
   * user.name and user.email of a new Git configuration: the profile of the account on GitHub, or, when GitHub does not
   * answer within 5 seconds, the login and the ID of the session. The opens of this window share one question per
   * account: its answer counts for the window; after a failed question, the fallback counts for 10 minutes, so an open
   * without a connection does not wait again. The question does not end with the open that started it (another open may
   * wait for it too); its time limit ends it. Never rejects.
   */
  private identityOf(session: GitHubSession): Promise<GitIdentity> {
    const { account } = session;
    const cached = this.identities.get(account.id);
    if (cached && (cached.retryAfter === undefined || this.deps.clock.now() < cached.retryAfter)) return cached.identity;
    const fallback = gitIdentity({ databaseId: account.id, login: account.login, name: null });
    const viewer = this.deps.viewer;
    if (!viewer) return Promise.resolve(fallback);
    const timeoutMs = this.deps.viewerTimeoutMs ?? VIEWER_TIMEOUT_MS;
    const entry: { identity: Promise<GitIdentity>; retryAfter?: number } = { identity: Promise.resolve(fallback) };
    entry.identity = (async () => {
      try {
        const timeout = AbortSignal.timeout(timeoutMs);
        const profile = await waitUnlessAborted(viewer(session.token, timeout), timeout);
        if (String(profile.databaseId) === account.id) return gitIdentity(profile);
        this.logger.info(`GitHub returned the profile of another account than ${account.login}.`);
      } catch (error) {
        this.logger.info(`The profile of ${account.login} could not be read from GitHub: ${errorMessage(error)}`);
      }
      entry.retryAfter = this.deps.clock.now() + IDENTITY_RETRY_MS;
      return fallback;
    })();
    this.identities.set(account.id, entry);
    return entry.identity;
  }

  /**
   * In a new container before the first attach (runUserCommands runs the script before the lifecycle commands,
   * runHomeGitConfigScript): the ~/.gitconfig of the remote user (HOME_GIT_CONFIG_CONTENT: an include of the
   * configuration of the volume, for Git older than 2.32 and for processes without the variables of the container).
   * Then the Git version of the container (checkGitVersion). A failure is logged. Root may not write into the home
   * folder of the user when the configuration takes rights away from the container (for example `--cap-drop ALL`): then
   * the user writes the file itself.
   */
  private async prepareHomeGitConfig(ctx: PipelineContext, container: string, user: string): Promise<void> {
    await this.runHomeGitConfigScript(ctx, container, user);
    await this.checkGitVersion(ctx, container, user);
  }

  /** The ~/.gitconfig of prepareHomeGitConfig, without the check of the Git version. A failure is logged. */
  private async runHomeGitConfigScript(ctx: PipelineContext, container: string, user: string): Promise<void> {
    let failure = await this.runHomeGitConfig(ctx, container, user, 'root');
    if (failure !== undefined && !isRootUser(user)) {
      this.logger.info(`The Git configuration of ${user} in the container could not be prepared as root: ${failure}. ${user} prepares it.`);
      failure = await this.runHomeGitConfig(ctx, container, user, user);
    }
    if (failure !== undefined) this.logger.warn(`The Git configuration of ${user} in the container could not be prepared: ${failure}`);
  }

  /**
   * HOME_GIT_CONFIG_SCRIPT (the script `homeGitConfig` of the registry) for `user`, run as `runAs`. The reason of a
   * failure, or `undefined`.
   */
  private async runHomeGitConfig(ctx: PipelineContext, container: string, user: string, runAs: string): Promise<string | undefined> {
    try {
      const result = await runScript(this.deps.docker, container, 'homeGitConfig', [user], {
        user: runAs,
        signal: ctx.signal,
        timeoutMs: GIT_EXEC_TIMEOUT_MS,
      });
      return result.exitCode === 0 ? undefined : (result.stderr || result.stdout).trim();
    } catch (error) {
      if (this.isCancellation(error, ctx.signal)) throw error;
      return errorMessage(error);
    }
  }

  /**
   * What Git of a new container supports of container-only Git (containerGitSupport). Git before 2.9 may use the
   * forwarding credential helper of the Dev Containers extension (forwardingHelperReachesGit), so the user gets a
   * warning; Git 2.9 to 2.31 ignores GIT_CONFIG_GLOBAL and gets the configuration of the volume only through
   * ~/.gitconfig, which is logged. A container without Git needs nothing. Never fails the open. The script `gitVersion`
   * of the registry (`git --version`).
   */
  private async checkGitVersion(ctx: PipelineContext, container: string, user: string): Promise<void> {
    let output: string;
    try {
      const result = await runScript(this.deps.docker, container, 'gitVersion', [], {
        user,
        signal: ctx.signal,
        timeoutMs: BRANCH_EXEC_TIMEOUT_MS,
      });
      if (result.exitCode !== 0) return;
      output = result.stdout;
    } catch (error) {
      if (this.isCancellation(error, ctx.signal)) throw error;
      this.logger.info(`The Git version in the container could not be read: ${errorMessage(error)}`);
      return;
    }
    const support = containerGitSupport(output);
    const version = output.trim();
    if (support === 'unsafe') {
      this.logger.warn(`${version} in the container of ${ctx.env.repository} is older than 2.9: its credential requests may reach the computer.`);
      this.deps.ui.warn(Messages.oldGit(version.replace(/^git version\s+/, '')));
    } else if (support === 'noGlobalVariable') {
      this.logger.info(
        `${version} in the container of ${ctx.env.repository} ignores GIT_CONFIG_GLOBAL: Git reads the configuration of the volume through ~/.gitconfig.`,
      );
    }
  }

  /** Steps 10 and 11: ownership, Git state, registry entry, pending connection file. */
  private async finish(ctx: PipelineContext, outcome: ContainerOutcome, loaded: LoadedConfiguration | undefined): Promise<OpenResult> {
    const env = ctx.env;
    // A container that was only started keeps its name; a new one got the name of the entry (override runArgs).
    const containerName = outcome.created ? env.containerName : outcome.container?.name ?? env.containerName;
    const containerRef = nonEmptyString(outcome.result?.containerId) ?? outcome.container?.id ?? containerName;
    const remoteUser =
      nonEmptyString(outcome.result?.remoteUser) ??
      env.remoteUser ??
      // The Dev Container CLI ignores runArgs for Docker Compose.
      configRemoteUser(loaded?.config, loaded?.compose ? undefined : stringList(loaded?.config.runArgs));
    const folder = repositoryFolder(env.repository);

    // The paths of the services from facts, written back after each `up`.
    const serviceFolders = await this.refreshServiceFolders(ctx, containerRef, loaded);
    if ((outcome.created || ctx.cloned) && remoteUser && !isRootUser(remoteUser)) {
      // Without the paths that the other services mount (their data keeps its owner), nor the paths where the dev
      // container mounts other volumes. The targets of the mounts are marked one by one (DevMountPaths), not the whole
      // list.
      const dev = await this.withDevMountFolders(ctx, containerName, serviceFolders);
      await this.fixOwnership(ctx, containerRef, folder, remoteUser, dev.folders, dev.mounts);
      // The Git configuration was written before `up` with the owner of the repository folder (the token is not there),
      // which is still root when the ownership fix before `up` did not run or failed. In a helper container that mounts
      // only the workspace volume, not in the dev container, whose mounts may lie in the folder.
      await this.fixConfigOwnership(ctx, containerRef, remoteUser);
    }
    if (outcome.created) {
      // runUserCommands prepared ~/.gitconfig already, before the lifecycle commands; the Git version of the new
      // container is checked here (once per new container).
      if (ctx.homeGitConfigWrittenTo !== undefined && sameContainerId(ctx.homeGitConfigWrittenTo, containerRef)) {
        await this.checkGitVersion(ctx, containerRef, remoteUser ?? 'root');
      } else {
        await this.prepareHomeGitConfig(ctx, containerRef, remoteUser ?? 'root');
      }
    }
    // The container runs now, so its tmpfs can take the token (at every open: a new sign-in gives a new token).
    // Lifecycle token: after `up`, runUserCommands wrote it already, before the lifecycle commands.
    if (ctx.tokenWrittenTo === undefined || !sameContainerId(ctx.tokenWrittenTo, containerRef)) {
      await this.writeGitToken(ctx, containerRef, remoteUser ?? 'root');
    }
    // The shared VS Code server, linked at every open before the window connects (the commit changes with each update
    // of VS Code) when the store has it; the open waits for the fetch that it started (linkVscodeServer), and a failure
    // never fails the open.
    const vscodeServer = await this.linkVscodeServer(ctx, containerRef, containerName, remoteUser ?? 'root');
    // The extension list of the open is recorded, and the cached `.vsix` files of the store are copied into the
    // container's extension cache, right after the link (no network, no wait).
    await this.seedVscodeExtensions(ctx, containerRef, containerName, remoteUser ?? 'root', loaded);
    const gitSummary = await this.gitSummaryAfterOpen(ctx, containerRef, remoteUser, folder);
    // A Cancel during the Git read ends the open here, before the window would connect.
    this.throwIfCancelled(ctx.signal);
    const remoteWorkspaceFolder = nonEmptyString(outcome.result?.remoteWorkspaceFolder) ?? env.remoteWorkspaceFolder ?? folder;
    const now = isoTime(this.deps.clock);
    // Read before the lock: the mutator does no I/O. And before the pending file.
    const liveness = await this.markLiveness();
    // First the pending file, then the busy mark goes: the container stays in use without a gap.
    await this.deps.sessionFiles.writePending(env.id, this.deps.owner.windowId);
    const finished = await this.openRecords.openFinished(ctx.env.id, {
      lastUsedAt: now,
      ...(ctx.lifecycleMarkRead !== undefined ? { lifecycleMarkRead: ctx.lifecycleMarkRead } : {}),
      ...(ctx.lifecycleRanFor !== undefined ? { lifecycleRanFor: ctx.lifecycleRanFor } : {}),
      ...(remoteUser ? { remoteUser } : {}),
      remoteWorkspaceFolder,
      ...(gitSummary ? { gitSummary } : {}),
      liveness,
    });
    this.entryUpdated(ctx, finished);
    ctx.busy = false;
    // The mark that this window remembers goes once the lifecycle commands of its container ran.
    if (ctx.lifecycleRanFor !== undefined) await this.forgetUnrecordedLifecycle(ctx, ctx.lifecycleRanFor);
    this.logger.info(`${env.repository} is ready in the container ${containerName}.`);
    return { devspace: ctx.env, containerName, remoteWorkspaceFolder, ...(vscodeServer !== undefined ? { vscodeServer } : {}) };
  }

  /**
   * Ownership, before the container exists: the helper clones as its Git user and the files of the clone then get root,
   * and the lifecycle commands (run-user-commands after `up`) run onCreateCommand and postCreateCommand as the remote
   * user in a new container. A command that writes to the repository (for example `npm install`) would fail, and with
   * it the open. So the files get their owner first. The fix after `up` (fixOwnership) stays for files that `up` itself
   * creates as root. A failure is logged, it does not fail the pipeline. No container of the devspace image runs for
   * it. The numeric IDs of the remote user come from the `/etc/passwd` of the image (DevspaceDocker.imageUserIds,
   * read through the Engine API), and the fix runs as the step repositoryOwnershipFix of the batch helper of the open
   * (WorkspaceHelper.fixRepositoryOwnership). IDs that cannot be read that way (no such entry, a link in place of the
   * file, a user that only a name service knows) skip the fix: the fix after `up` gives the files their owner then.
   * Assumption: the label devcontainer.metadata of the devspace image names the remote user as the Dev Container CLI
   * resolves it.
   */
  private async prepareOwnership(ctx: PipelineContext, image: string, runArgs: readonly string[]): Promise<void> {
    ctx.ownershipPrepared = true;
    const env = ctx.env;
    const folder = repositoryFolder(env.repository);
    try {
      const user = await this.imageUser(ctx, image, runArgs);
      if (user === undefined) {
        // The fix after `up` gives the files to the remote user that `up` reports.
        this.logger.info(`The remote user of ${image} is not known before the container is created (the label devcontainer.metadata names it with a variable of the Dev Container CLI): the files in ${folder} get their owner after the start.`);
        return;
      }
      if (isRootUser(user)) return;
      // The IDs from the /etc/passwd of the image, without a container of it.
      const ids = await this.deps.docker.imageUserIds(image, user, { signal: ctx.signal, timeoutMs: IMAGE_INSPECT_TIMEOUT_MS });
      if (ids === undefined) {
        this.logger.info(`The user ${user} is not in /etc/passwd of ${image}: the files in ${folder} get their owner after the start.`);
        return;
      }
      // A user with the user ID of root needs no fix, as root itself.
      if (ids.uid === '0') return;
      this.logger.info(`Giving the files in ${folder} to ${user} (${ids.uid}:${ids.gid}) before the container is created.`);
      // After a new clone, no service has run on the files yet: every file gets its owner (also the source folders that
      // a service mounts). After a resumed clone, the paths of the services are left out. On the path of a single
      // container, runComposeUp has not computed them: from the facts (serviceFolderFacts: the recorded paths and those
      // of the existing containers).
      if (ctx.resumedClone === true && ctx.serviceFolders === undefined) {
        const facts = await this.serviceFolderFacts(env, []);
        ctx.serviceFolders = facts.overflow ? 'repository' : facts.folders;
      }
      const serviceFolders = ctx.resumedClone === true ? ctx.serviceFolders : undefined;
      const result = await this.deps.helper.fixRepositoryOwnership({
        volumeName: env.volumeName,
        repository: env.repository,
        uid: ids.uid,
        gid: ids.gid,
        ...(serviceFolders !== undefined ? { serviceFolders } : {}),
        timeoutMs: OWNERSHIP_TIMEOUT_MS,
        image: ctx.helperImage,
        signal: ctx.signal,
      });
      if (result.exitCode !== 0) {
        this.logger.warn(`The owner of the files in ${folder} could not be changed before the container was created: ${(result.stderr || result.stdout).trim()}`);
      }
    } catch (error) {
      if (this.isCancellation(error, ctx.signal)) throw error;
      // As in fixConfigOwnership, the refusal of the batch scope refuses the operation.
      if (isBatchHelperUnavailable(error)) throw error;
      this.logger.warn(`The owner of the files in ${folder} could not be changed before the container was created: ${errorDetail(error)}`);
    }
  }

  /**
   * `serviceFolders` with the paths of the repository at which the dev container mounts something else than the
   * workspace volume (devMountFolders, from `docker inspect` of the dev container: this covers the model of Docker
   * Compose, the `mounts` of devcontainer.json, and runArgs, for a single container too). They are not recorded: they
   * matter only in the dev container, where they are mounted. When the dev container cannot be read, the whole
   * repository (only the files of root change). Also the mounts of the workspace volume below the repository, but not
   * the anonymous volumes of the dev container while the host access checks are on. With the targets of the mounts
   * (`mounts`), which the fix marks one by one: a real path in `.git` of a target is kept, that of a path of the
   * services is not.
   */
  private async withDevMountFolders(
    ctx: PipelineContext,
    containerName: string,
    serviceFolders: ServiceFolders | undefined,
  ): Promise<{ folders: ServiceFolders | undefined; mounts: ReadonlySet<string> }> {
    const none: ReadonlySet<string> = new Set();
    if (serviceFolders === 'repository') return { folders: serviceFolders, mounts: none };
    const repository = repositoryFolder(ctx.env.repository);
    // The paths of the services without `.git` (their filter), before the targets of the mounts, which may lie in
    // `.git` (the list is passed to the fix with `gitPaths`).
    const records = serviceFolders === undefined ? undefined : serviceFolderPaths(repository, serviceFolders);
    let mounts: string[];
    try {
      const container = await this.deps.docker.findContainer(ctx.env.id, containerName);
      mounts = devMountFolders(container, ctx.env, ctx.hostAccessChecks, await this.workspaceIdentities(ctx, container));
    } catch (error) {
      if (this.isCancellation(error, ctx.signal)) throw error;
      this.logger.warn(`The mounts of the container of ${ctx.env.repository} could not be read: ${errorMessage(error)}`);
      return { folders: 'repository', mounts: none };
    }
    if (mounts.length === 0) return { folders: records, mounts: none };
    const bounded = boundServiceFolders(repository, [records, mounts], false, true);
    return bounded.overflow ? { folders: 'repository', mounts: none } : { folders: bounded.folders, mounts: new Set(mounts) };
  }

  /**
   * The targets of the mounts of the workspace volume in the dev container that show their folder at its own canonical
   * path (workspaceIdentityMounts), checked with `/proc/self/mountinfo` of the container (the script `mountInfo` of the
   * registry, as root; verifiedIdentityTargets). When it cannot be read, none: the mounts stay protected.
   */
  private async workspaceIdentities(ctx: PipelineContext, container: ContainerInfo | undefined): Promise<Set<string>> {
    const candidates = workspaceIdentityMounts(container, ctx.env);
    if (container === undefined || candidates.length === 0) return new Set();
    try {
      const result = await runScript(this.deps.docker, container.id, 'mountInfo', [], { user: 'root', signal: ctx.signal, timeoutMs: OWNERSHIP_TIMEOUT_MS });
      if (result.exitCode === 0) return verifiedIdentityTargets(candidates, result.stdout);
      this.logger.info(`The mounts of the container of ${ctx.env.repository} could not be read: ${(result.stderr || result.stdout).trim()}`);
    } catch (error) {
      if (this.isCancellation(error, ctx.signal)) throw error;
      this.logger.info(`The mounts of the container of ${ctx.env.repository} could not be read: ${errorMessage(error)}`);
    }
    return new Set();
  }

  /**
   * The ownership fix of the extension's internal folder (CONFIG_FOLDER: the token, the Git configuration, the folders
   * of Docker and the GitHub CLI) runs in a container of the workspace helper that mounts only the workspace volume
   * (WorkspaceHelper.fixConfigOwnership), with the numeric user and group IDs of the remote user, which `id -u` and `id
   * -g` print as root in the dev container. In the dev container, a mount could lie in the folder although no
   * configuration may name a target there (configFolderTarget checks the text only): a link of the repository in a
   * target (`x -> ../.devspace+`, followed by the runtime inside the container), `volumes_from` of a service that
   * mounts there, or a tmpfs; there the fix would walk it in full and give its files (for example the data of a
   * database, uid 999) to the remote user. The helper sees only the folder of the volume. Such a mount can still hide
   * the token and the Git configuration in the dev container, which breaks only the Git authentication of the owner.
   * IDs that are not decimal numbers skip the fix. A failure is logged, it does not fail the pipeline (as
   * fixOwnership). The IDs come from the scripts `userId` and `groupId` of the registry.
   */
  private async fixConfigOwnership(ctx: PipelineContext, container: string, user: string): Promise<void> {
    const folder = CONFIG_FOLDER;
    try {
      const ids: string[] = [];
      for (const script of ['userId', 'groupId'] as const) {
        const result = await runScript(this.deps.docker, container, script, [user], { user: 'root', signal: ctx.signal, timeoutMs: OWNERSHIP_TIMEOUT_MS });
        const id = result.stdout.trim();
        if (result.exitCode !== 0 || !isNumericId(id)) {
          this.logger.warn(
            `The owner of the files in ${folder} could not be changed: \`${scriptCommand(script, [user]).join(' ')}\` in the container gave no user or group ID (${JSON.stringify((result.stderr || result.stdout).trim().slice(0, 200))}).`,
          );
          return;
        }
        ids.push(id);
      }
      const [uid, gid] = ids;
      this.logger.info(`Giving the files in ${folder} to ${user} (${uid}:${gid}) in a helper container.`);
      const result = await this.deps.helper.fixConfigOwnership({
        volumeName: ctx.env.volumeName,
        folder,
        uid,
        gid,
        timeoutMs: OWNERSHIP_TIMEOUT_MS,
        image: ctx.helperImage,
        signal: ctx.signal,
      });
      if (result.exitCode !== 0) {
        this.logger.warn(`The owner of the files in ${folder} could not be changed: ${(result.stderr || result.stdout).trim()}`);
      }
    } catch (error) {
      if (this.isCancellation(error, ctx.signal)) throw error;
      // The refusal of the batch scope refuses the operation, also after `up`.
      if (isBatchHelperUnavailable(error)) throw error;
      this.logger.warn(`The owner of the files in ${folder} could not be changed: ${errorMessage(error)}`);
    }
  }

  /**
   * Ownership: the helper clones as its Git user, and the files of the clone then get root. A failure is logged, it
   * does not fail the pipeline. The script `ownershipFix` of the registry, as root, with the repository folder, the
   * user, and the arguments of the paths of the services (servicePathArguments; `gitPaths` as in serviceFolderPaths).
   */
  private async fixOwnership(
    ctx: PipelineContext,
    container: string,
    folder: string,
    user: string,
    serviceFolders?: ServiceFolders,
    gitPaths: DevMountPaths = false,
  ): Promise<void> {
    const except =
      serviceFolders === 'repository'
        ? ' of root only (more paths of the repository are mounted by other services than the ownership fix can name)'
        : serviceFolders !== undefined && serviceFolders.length > 0
          ? `, except ${serviceFolders.length > 20 ? `${serviceFolders.slice(0, 20).join(', ')} and ${serviceFolders.length - 20} more` : serviceFolders.join(', ')} (mounted by other services)`
          : '';
    this.logger.info(`Giving the files in ${folder} to ${user}${except}.`);
    try {
      const result = await runScript(this.deps.docker, container, 'ownershipFix', [folder, user, ...servicePathArguments(folder, serviceFolders, gitPaths)], {
        user: 'root',
        signal: ctx.signal,
        timeoutMs: OWNERSHIP_TIMEOUT_MS,
      });
      if (result.exitCode !== 0) {
        this.logger.warn(`The owner of the files in ${folder} could not be changed: ${(result.stderr || result.stdout).trim()}`);
      }
    } catch (error) {
      if (this.isCancellation(error, ctx.signal)) throw error;
      this.logger.warn(`The owner of the files in ${folder} could not be changed: ${errorMessage(error)}`);
    }
  }

  /** The branch from the running container; the change counts stay. After a clone, the full summary. */
  private async gitSummaryAfterOpen(
    ctx: PipelineContext,
    container: string,
    user: string | undefined,
    folder: string,
  ): Promise<GitSummary | undefined> {
    const previous = ctx.env.gitSummary;
    if (!previous || ctx.cloned) return (await this.gitSummaryInContainer(container, user, folder, ctx.signal)) ?? previous;
    const branch = await this.branchInContainer(container, user, folder, ctx.signal);
    return branch === undefined ? previous : { ...previous, branch };
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Other operations

  /**
   * The containers of the other services of a Docker Compose devspace (label nimblescape.devspaces.compose-service) are
   * removed, before `up` creates a single container for a configuration that no longer uses Docker Compose. Their
   * volumes stay.
   */
  private async removeComposeServices(ctx: PipelineContext): Promise<void> {
    const services = (await this.deps.docker.devspaceContainers(ctx.env.id)).filter((container) => container.labels[LABEL_COMPOSE_SERVICE] !== undefined);
    for (const container of services) {
      this.logger.info(
        `The configuration of ${ctx.env.repository} no longer uses Docker Compose: the container ${container.name} of the service ${container.labels[LABEL_COMPOSE_SERVICE]} is removed. Its volumes are kept.`,
      );
      await this.stopServiceBeforeRemoval(container, ctx.env);
      await this.deps.docker.removeContainer(container.id);
      (ctx.kindSwitchRemoved ??= []).push(`the container ${container.name} of the service ${container.labels[LABEL_COMPOSE_SERVICE]}`);
    }
  }

  /**
   * After a failed `up` that switched a single container to Docker Compose, the containers of the project that Compose
   * created (composeContainers) are removed, and the networks of the project; their volumes stay. Never a container of
   * another devspace, and never the previous single container (it is no container of Compose). Only when
   * runComposeUp removed the single container in this run (PipelineContext.composeSwitch), and never a container of
   * Docker Compose that existed before its `up`; with such a container, the networks stay too. Returns the removed ones
   * (with their IDs) and the kept ones, for kindSwitchFailure; a failure is logged.
   */
  private async removeFailedComposeContainers(ctx: PipelineContext): Promise<{ removed: string[]; kept: string[]; removedIds: string[] }> {
    const env = ctx.env;
    const removed: string[] = [];
    const kept: string[] = [];
    // The IDs of the removed containers, in the order of `removed`.
    const removedIds: string[] = [];
    // Only after a switch that removed the single container in this run; only the containers that did not exist before
    // its `up`.
    const existing = ctx.composeSwitch?.existing;
    if (existing === undefined) return { removed, kept, removedIds };
    const describe = (container: ContainerInfo): string =>
      container.labels[LABEL_COMPOSE_SERVICE] !== undefined ? `the container ${container.name} of the service ${container.labels[LABEL_COMPOSE_SERVICE]}` : `the container ${container.name}`;
    await this.quietly('remove the containers that the failed up of Docker Compose created', async () => {
      for (const container of await this.composeContainers(env)) {
        if (existing.has(container.id)) {
          kept.push(describe(container));
          continue;
        }
        this.logger.info(`The container ${container.name} that the failed start of Docker Compose created is removed. Its volumes are kept.`);
        // Stopped first, as at Delete.
        await this.stopServiceBeforeRemoval(container, env);
        await this.deps.docker.removeContainer(container.id);
        removed.push(describe(container));
        removedIds.push(container.id);
      }
    });
    if (kept.length === 0) await this.quietly('remove the networks of the Docker Compose project', () => this.removeComposeNetworks(env));
    return { removed, kept, removedIds };
  }

  /**
   * The containers of Docker Compose of the project of the devspace (isComposeContainer), with the ID label of the
   * devspace or without one; never a container of another devspace, and never a single container.
   */
  private async composeContainers(env: Devspace): Promise<ContainerInfo[]> {
    const project = composeProjectName(env.repository, env.id);
    // The one listing of the containers by the label and the project, once each (upContainers), of which only those of
    // the project count.
    return (await this.upContainers(env, true)).filter((container) => {
      const owner = container.labels[LABEL_DEVSPACE_ID];
      return (owner === undefined || owner === env.id) && isComposeContainer(container.labels, project);
    });
  }

  private async composeContainerIds(env: Devspace): Promise<ReadonlySet<string>> {
    return new Set((await this.composeContainers(env)).map((container) => container.id));
  }

  /**
   * The networks that Docker Compose created for the project of the devspace (label com.docker.compose.project), once
   * no container of the project uses them. A network that cannot be removed is logged.
   */
  private async removeComposeNetworks(env: Devspace): Promise<void> {
    for (const network of await this.deps.docker.listProjectNetworks(composeProjectName(env.repository, env.id))) {
      try {
        await this.deps.docker.removeNetwork(network);
      } catch (error) {
        this.logger.warn(`The network ${network} could not be removed: ${errorMessage(error)}`);
      }
    }
  }

  /**
   * A running container of another service of Docker Compose (label nimblescape.devspaces.compose-service) is stopped
   * before `docker rm -f` removes it (also a dev container), so that it can shut down cleanly (for example a database
   * whose volume is kept) instead of a SIGKILL. `docker stop` gives it its own stop time (`stop_grace_period`, which
   * the policy caps at 20 s, else 10 s). A failed stop is logged; the removal follows anyway.
   */
  private async stopServiceBeforeRemoval(container: ContainerInfo, env: Devspace): Promise<void> {
    if (container.state !== 'running') return;
    // The dev container too (its stop time is capped by the policy as well: `--stop-timeout`).
    const service = container.labels[LABEL_COMPOSE_SERVICE];
    this.logger.info(`Stopping the container ${container.name}${service !== undefined ? ` of the service ${service}` : ''} of ${env.repository} before it is removed.`);
    try {
      await this.deps.docker.stopContainer(container.id);
    } catch (error) {
      this.logger.warn(`The container ${container.name} could not be stopped, it is removed anyway: ${errorMessage(error)}`);
    }
  }

  /**
   * `docker stop` of a container that is kept, with its own stop time (capped by the policy, as for
   * stopServiceBeforeRemoval). A failed stop is logged; a cancellation throws.
   */
  private async stopContainerGracefully(ctx: PipelineContext, container: ContainerInfo): Promise<void> {
    if (container.state !== 'running') return;
    this.logger.info(`Stopping the container ${container.name} of ${ctx.env.repository}.`);
    try {
      await this.deps.docker.stopContainer(container.id);
    } catch (error) {
      if (this.isCancellation(error, ctx.signal)) throw error;
      this.logger.warn(`The container ${container.name} could not be stopped: ${errorMessage(error)}`);
    }
    this.throwIfCancelled(ctx.signal);
  }

  /**
   * Safety check before Delete. Delete needs no Git: it removes the container with the volumes; uncommitted changes are
   * only flagged and never hinder the Delete. So Delete runs no Git in a workspace helper (nor a batch step). The
   * result is the Git state recorded in the registry (after an open or a stop, and by the window before its release:
   * recordGitState); when the dev container runs, it is refreshed first in the container as its user
   * (gitSummaryInContainer, as after a stop) and the new state is recorded. A refresh that fails falls back to the
   * recorded state and never refuses Delete. Starts Docker if needed. `undefined` when the volume is missing (the files
   * of the devspace are missing: plain confirmation) or nothing is recorded. A cancel stays a cancel.
   */
  async safetyCheck(devspaceId: string, options: OperationOptions): Promise<GitSummary | undefined> {
    const env = await this.deps.registry.get(devspaceId);
    if (!env) return undefined;
    await this.requireCurrentHost(env);
    const steps = new StepReporter(options.progress, this.logger);
    try {
      await this.requireOwnAccount(env, true);
      await this.startDocker(steps, options.signal);
      if (!(await this.deps.docker.volumeExists(env.volumeName))) return undefined;
      const refreshed = await this.gitSummaryBeforeDelete(env, options.signal);
      this.throwIfCancelled(options.signal);
      if (refreshed === undefined) return env.gitSummary;
      // One specific write (record recordGitSummary from the worker).
      await this.quietly('record the Git state', () => this.deps.recordGitSummary(env.id, refreshed));
      return refreshed;
    } catch (error) {
      throw this.toUserError(error, options.signal);
    }
  }

  /**
   * The Git state from the running dev container before Delete's confirmation (the path of Stop, gitSummaryInContainer,
   * as `remoteUser`), or `undefined` when the container does not run or the refresh fails (Delete then names the
   * recorded state). No lock: it only reads in the container, and must never hold Delete up.
   */
  private async gitSummaryBeforeDelete(env: Devspace, signal: AbortSignal | undefined): Promise<GitSummary | undefined> {
    let container: ContainerInfo | undefined;
    try {
      container = await this.deps.docker.findContainer(env.id, env.containerName);
    } catch (error) {
      if (this.isCancellation(error, signal)) throw error;
      this.logger.info(`The container of ${env.repository} could not be found: ${errorMessage(error)}. The recorded Git state is used.`);
      return undefined;
    }
    if (!container || container.state !== 'running') return undefined;
    return this.gitSummaryInContainer(container.id, env.remoteUser, repositoryFolder(env.repository), signal);
  }

  /**
   * The window records the Git state of the devspace that it leaves (it closes, or switches) just before its short
   * release, the way Delete refreshes it: in the running dev container as its user (gitSummaryInContainer, as
   * `remoteUser`), on the Docker engine of the caller's operation. Nothing is done when the devspace is not in the
   * registry or not on that engine, or its container does not run. Never starts Docker, takes no lock, and never throws
   * (a failure is logged; the recorded state stays). True when a new state was recorded. Runs in the worker (the
   * operation `recordGitState`).
   */
  async recordGitState(devspaceId: string, signal?: AbortSignal): Promise<boolean> {
    try {
      const env = await this.deps.registry.get(devspaceId);
      if (!env) return false;
      const target = await this.dockerTarget();
      if (target.kind === 'unsupported' || !isOnDockerHost(env, target.host)) return false;
      const container = await this.deps.docker.findContainer(env.id, env.containerName);
      if (!container || container.state !== 'running' || signal?.aborted) return false;
      const summary = await this.gitSummaryInContainer(container.id, env.remoteUser, repositoryFolder(env.repository), signal);
      if (!summary || signal?.aborted) return false;
      // In the worker, through `record recordGitSummary` (the operation `recordGitState`).
      await this.deps.recordGitSummary(env.id, summary);
      return true;
    } catch (error) {
      this.logger.info(`The Git state could not be recorded: ${errorMessage(error)}`);
      return false;
    }
  }

  /**
   * The check of Delete and its questions (deleteCheck.ts): the Git state (safetyCheck), the data of services in the
   * repository, and the volumes that Delete may remove; the questions go to the user (PipelineUi, from the worker as
   * its requests). `repository` is the name that the user sees; `otherWindow`: a window of this computer is connected
   * to the devspace. Runs in the worker (deleteCheckInWorker sends it there). A devspace that is not in the
   * registry is not deleted (cancel).
   */
  async deleteCheck(devspaceId: string, options: OperationOptions & { repository: string; otherWindow: boolean }): Promise<DeleteDecision> {
    const devspace = await this.deps.registry.get(devspaceId);
    if (!devspace) {
      this.logger.info(`The devspace ${devspaceId} does not exist anymore. Nothing is deleted.`);
      return { decision: 'cancel' };
    }
    const decision = await deleteCheck(
      {
        summary: () => this.safetyCheck(devspaceId, options),
        devspace: () => this.deps.registry.get(devspaceId),
        repositoryServiceData: () => this.repositoryServiceData(devspaceId),
        // One read of the removable volumes for both questions.
        removableVolumes: () => this.removableVolumesOf(devspaceId),
        ui: this.deps.ui,
      },
      devspace,
      options.repository,
      options.otherWindow,
    );
    this.throwIfCancelled(options.signal);
    return decision;
  }

  /**
   * Delete. The caller made the safety check and closed a connected window. Runs in the worker (deleteInWorker sends it
   * there).
   */
  async delete(devspaceId: string, options: OperationOptions & { additionalVolumesToRemove: readonly string[] }): Promise<void> {
    const devspace = await this.deps.registry.get(devspaceId);
    if (!devspace) {
      await this.removeDevspaceFiles(devspaceId);
      return;
    }
    await this.requireCurrentHost(devspace);
    await this.exclusive(sourceOperationKey(devspace.repository, sourceOf(devspace)), options.signal, async () => {
      try {
        const current = await this.deps.registry.get(devspaceId);
        if (!current) {
          await this.removeDevspaceFiles(devspaceId);
          return;
        }
        await this.requireOwnAccount(current, true);
        await this.deleteLocked(current, options);
      } catch (error) {
        throw this.toUserError(error, options.signal);
      }
    });
  }

  private async deleteLocked(
    devspace: Devspace,
    options: OperationOptions & { additionalVolumesToRemove: readonly string[] },
  ): Promise<void> {
    const { docker } = this.deps;
    const steps = new StepReporter(options.progress, this.logger);
    await this.startDocker(steps, options.signal);
    this.throwIfCancelled(options.signal);
    this.logger.info(`Deleting the devspace of ${devspace.repository} (${devspace.id}).`);
    // The wait for the operation of another window and the mark in one (markBusyWaiting).
    const env = await this.markBusyWaiting(devspace, 'delete', options.signal);
    let removed = false;
    try {
      // The busy mark first, then the lock of the devspace on the Docker host; both are released in `finally`.
      await this.withDevspaceLock(env, options.signal, async () => {
        // Delete removes nothing of the name of the devspace (its dev container, the Compose project, the images,
        // the volume) when the volume of that name is another devspace's; it stops when Docker cannot say whose it
        // is.
        const ownership = await this.workspaceVolumeOwnership(env);
        if (ownership === 'unreadable') throw new Error(`The labels of the volume ${env.volumeName} could not be read; nothing was removed.`);
        const byName = ownership !== 'foreign';
        // A running prepare of the devspace stops first, so that its batch helper does not mount the volume any
        // more.
        if (byName) await this.stopPrepare(env, options.signal);
        // Step 3: container, devspace image, unused base images.
        const containers = await docker.devspaceContainers(env.id);
        for (const container of containers) {
          await this.stopServiceBeforeRemoval(container, env);
          await docker.removeContainer(container.id);
        }
        // A dev container of the name without the ID label (for example relabelled by hand) is stopped first too.
        if (byName) {
          const dev = await docker.findContainer(env.id, env.containerName).catch(() => undefined);
          if (dev !== undefined) await this.stopServiceBeforeRemoval(dev, env);
          await docker.removeContainer(env.containerName);
          // Docker Compose: the other containers, the networks, and the built images of the project too.
          const compose = composeRecordOf(env.buildRecord) !== undefined || containers.some((c) => isComposeContainer(c.labels, composeProjectName(env.repository, env.id)));
          if (compose) await this.removeComposeProject(env, false);
          await this.removeDevspaceImages(env, undefined, env.buildRecord);
          // Step 4: the workspace volume; additional volumes only when the user confirmed it.
          await this.removeVolumeWithRetry(env.volumeName);
        }
        const removedVolumes =
          options.additionalVolumesToRemove.length > 0 ? await this.removeAdditionalVolumes(env, options.additionalVolumesToRemove) : [];
        // Step 5: the registry entry and the files that reference the devspace. The additional volumes that stay
        // keep their owner in the registry: the devspaces of other accounts must not mount them.
        const keptVolumes = await this.existingVolumes((env.additionalVolumes ?? []).filter((name) => !removedVolumes.includes(name)));
        await this.deps.registry.remove(env.id, { kept: keptVolumes, removed: removedVolumes });
        removed = true;
      });
      await this.removeDevspaceFiles(env.id);
      // The heartbeat record of this computer in the Monitor of the engine (best effort), on every engine,
      // local and remote: the worker's Monitor.
      const sessionMonitor = this.deps.sessionMonitor;
      if (sessionMonitor) await this.quietly('remove the heartbeat record from the Monitor', () => sessionMonitor.forget(env.id));
      this.logger.info(`The devspace of ${env.repository} was deleted.`);
    } finally {
      if (!removed) await this.clearOwnMark(env.id);
    }
  }

  /**
   * Delete stops a running prepare of `env` (its prepare lock is held): it asks it to stop (PrepareLock.stop) and waits
   * at most PREPARE_STOP_WAIT_SECONDS; then it goes on in any case, so a Delete never hangs. A prepare that ends after
   * the Delete finds the volume gone and removes its image (prepare). A lock that cannot be asked counts as free
   * (PrepareLock). Rejects only with a cancel.
   */
  private async stopPrepare(env: Devspace, signal: AbortSignal | undefined): Promise<void> {
    const prepareLock = this.deps.prepareLock;
    if (prepareLock?.stop === undefined || !(await prepareLock.held(env.id, signal))) return;
    this.logger.info(`A newer image of ${env.repository} is being prepared; the prepare is stopped first.`);
    const stopped = await prepareLock.stop(env.id, PREPARE_STOP_WAIT_SECONDS, signal);
    this.throwIfCancelled(signal);
    if (stopped) this.logger.info(`The prepare of ${env.repository} stopped.`);
    else this.logger.warn(`The prepare of ${env.repository} did not stop within ${PREPARE_STOP_WAIT_SECONDS} s; the Delete goes on.`);
  }

  /**
   * Whether the containers of a devspace use Docker Compose, as the pipeline tells them before a switch of the
   * kind: its dev container `container`, or else a container of another service of Docker Compose (true); `undefined`
   * without either.
   */
  private async containersUseCompose(env: Devspace, container: ContainerInfo | undefined): Promise<boolean | undefined> {
    if (container !== undefined) return isComposeContainer(container.labels, composeProjectName(env.repository, env.id));
    return (await this.deps.docker.devspaceContainers(env.id)).some((other) => other.labels[LABEL_COMPOSE_SERVICE] !== undefined) ? true : undefined;
  }

  /**
   * Configuration paths in the volume (current branch), in the order of precedence. Runs in the worker (the operation
   * `listConfigurations`). No command of the extension sends it since version 0.6.0 (each configuration is its own
   * devspace); the tests of the worker's pipeline use it as its simplest operation under the lock and the batch helper.
   */
  async listConfigurations(devspaceId: string, options: OperationOptions): Promise<string[]> {
    const env = await this.deps.registry.get(devspaceId);
    if (!env) return [];
    await this.requireCurrentHost(env);
    const steps = new StepReporter(options.progress, this.logger);
    try {
      await this.requireOwnAccount(env, true);
      await this.startDocker(steps, options.signal);
      await this.requireVolume(env);
      // The listing runs as the step listConfigs of the batch helper of the volume (as the owner of the repository)
      // under the lock of the devspace, released before the answer (refused when either cannot be had; busy after 10
      // s).
      return await this.withDevspaceLock(
        env,
        options.signal,
        async () => {
          // Never the configurations of a volume of the name that is not its own.
          await this.requireOwnVolume(env);
          return this.deps.helper.listConfigurations({ volumeName: env.volumeName, repository: env.repository, signal: options.signal });
        },
        { batchVolume: env.volumeName },
      );
    } catch (error) {
      throw this.toUserError(error, options.signal);
    }
  }

  /**
   * Registry lost: adds an entry for each volume with the label nimblescape.devspaces.id that the registry
   * lacks, with the owner of its label nimblescape.devspaces.owner-id and the source of its labels
   * nimblescape.devspaces.default-image or nimblescape.devspaces.config-path (devspaceOfVolume); a volume without a
   * valid owner label is skipped. A volume of version 0.5.0 or older has no source label: the build record of the
   * newest devspace image of the entry (newestImageRecord) says whether it was built from a default image, and the
   * entry keeps that kind (so that the Start of the `default` row of its repository finds it, and no second
   * default-image devspace is created). A volume of a repository of which the owner account has a devspace of the
   * same source already is not added: one devspace per repository, account and source. The additional volumes of an
   * entry are its own labelled volumes
   * (nimblescape.devspaces.volume, isOwnVolume), the additional volumes of other devspaces of the same owner that its
   * surviving container mounts (isSameOwnerAdditionalVolume), and the volumes without labels of Devspace that it
   * mounts (protectedMountedVolumes), which protect them from other accounts and from the Delete of the other
   * devspaces; Delete removes only the own ones. The entries have no build record, so the next connection with
   * internet access rebuilds the container. Returns the number of added entries. Does not start Docker. Runs in the
   * worker (reconcileInWorker sends it there), and in the first open.
   */
  async reconcileFromVolumes(): Promise<number> {
    const { docker } = this.deps;
    // Never on an endpoint that is neither local nor SSH (it would be recorded as the host of the entries).
    const readable = await this.readableDockerHost();
    if (readable === undefined) return 0;
    if (!(await docker.isRunning())) return 0;
    // The volumes of the current Docker host only; the restored entries record it.
    const dockerHost = readable;
    const volumes = await docker.listDevspaceVolumes();
    const now = isoTime(this.deps.clock);
    const candidates: Devspace[] = [];
    const additional: VolumeInfo[] = [];
    for (const volume of volumes) {
      // An additional volume (nimblescape.devspaces.volume) joins the entry of its devspace below.
      if (volume.labels[LABEL_VOLUME] !== undefined) {
        additional.push(volume);
        continue;
      }
      const candidate = devspaceOfVolume(volume, now, dockerHost);
      if ('skipped' in candidate) {
        this.logger.warn(candidate.skipped);
        continue;
      }
      // A volume without the configuration path in its labels: the configuration of the devspace from the build record
      // of its newest devspace image (for a default-image devspace, the path its synthesized configuration is read
      // under: the first configuration of the repository); for a volume of version 0.5.0 or older (no source label at
      // all), its kind too. The label of its dev container, when it still exists, decides the configuration path below.
      if (volume.labels[LABEL_CONFIG_PATH] === undefined) {
        const found = await this.newestImageRecord(candidate);
        if ('record' in found) {
          candidate.configPath = found.record.configPath;
          if (volume.labels[LABEL_DEFAULT_IMAGE] !== undefined) {
            // The kind of the label; the record of a default-image devspace names its default image too.
          } else if (found.record.defaultImage !== undefined) {
            candidate.defaultImage = found.record.defaultImage;
            this.logger.info(`The volume ${candidate.volumeName} is the default-image devspace of ${candidate.repository}, as its devspace image ${found.tag} records: it was built from ${found.record.defaultImage}.`);
          } else if (found.record.configPath !== DEFAULT_CONFIG_PATH) {
            this.logger.info(`The volume ${candidate.volumeName} is the devspace of the configuration ${found.record.configPath} of ${candidate.repository}, as its devspace image ${found.tag} records.`);
          }
        }
      }
      candidates.push(candidate);
    }
    if (candidates.length === 0) return 0;
    // The additional volumes are not on the workspace volume: they are found by their labels, which make them the
    // devspace's own (isOwnVolume), as the pipeline records them.
    const containers = await docker.listDevspaceContainers();
    for (const candidate of candidates) {
      const labelled = additional
        .filter((volume) => isOwnVolume(volume.labels, candidate.id, candidate.owner.id))
        .map((volume) => volume.name)
        .filter((name) => name !== candidate.volumeName);
      const mounted = containers
        .filter((container) => container.labels[LABEL_DEVSPACE_ID] === candidate.id)
        .flatMap((container) => container.volumes ?? []);
      // An additional volume of another devspace of the same owner that the container mounts: recorded again, so that
      // the Delete of that devspace keeps it, as the pipeline records it (recordedVolumes).
      const shared = additional
        .filter((volume) => mounted.includes(volume.name) && isSameOwnerAdditionalVolume(volume.labels, candidate.owner.id))
        .map((volume) => volume.name)
        .filter((name) => name !== candidate.volumeName);
      const volumes = [...new Set([...labelled, ...shared, ...(await this.protectedMountedVolumes(mounted, candidate.volumeName))])];
      if (volumes.length > 0) candidate.additionalVolumes = volumes;
      // The volumes that the pipeline created for the other services of Docker Compose.
      const serviceVolumes = additional
        .filter((volume) => labelled.includes(volume.name) && volume.labels[LABEL_SERVICE_DATA] === SERVICE_DATA)
        .map((volume) => volume.name);
      if (serviceVolumes.length > 0) candidate.serviceVolumes = serviceVolumes;
      // The paths of the repository that the containers of the other services mount, so that the ownership fixes leave
      // their data alone before the next open writes the list.
      const serviceFolders = boundServiceFolders(repositoryFolder(candidate.repository), [
        liveServiceFolders(
          containers.filter((container) => container.labels[LABEL_DEVSPACE_ID] === candidate.id),
          candidate,
        ),
      ]);
      if (serviceFolders.folders.length > 0) candidate.serviceFolders = serviceFolders.folders;
      if (serviceFolders.overflow) candidate.serviceFoldersOverflow = true;
      // The configuration path of the label nimblescape.devspaces.config-path of its dev container, when it is a
      // configuration path of a repository (isConfigPathLabelValue); else the default one. Only the dev container (a
      // container without nimblescape.devspaces.compose-service) counts; the label of another service can come from its
      // image.
      const labelledPath = containers.find(
        (container) =>
          container.labels[LABEL_DEVSPACE_ID] === candidate.id && container.labels[LABEL_COMPOSE_SERVICE] === undefined && container.labels[LABEL_CONFIG_PATH] !== undefined,
      )?.labels[LABEL_CONFIG_PATH];
      if (labelledPath !== undefined) {
        if (isConfigPathLabelValue(labelledPath)) candidate.configPath = labelledPath;
        else this.logger.warn(`The containers of the volume ${candidate.volumeName} name the configuration ${JSON.stringify(labelledPath)}, which is no configuration path. The default configuration is used.`);
      }
    }
    // The registry adds them under its lock (`record restore` in the worker).
    const { added, skipped } = await this.deps.registry.restore(candidates);
    for (const name of skipped) {
      this.logger.warn(`The volume ${name} belongs to a repository that has another devspace of the same owner and source. It is not added.`);
    }
    if (added > 0) this.logger.info(`${added} devspaces were restored from the labels of their volumes.`);
    return added;
  }

  /**
   * Registry lost: the named volumes without labels of Devspace that the container of a restored devspace
   * mounts (the container, which a lost registry does not remove, still mounts them), for example volumes that Docker
   * created at `up` without labels. Recorded again, they protect the data of the devspace: without them, the
   * devspace of another account could mount them (the host access policy refuses the recorded volumes of other
   * accounts). Delete never removes them (removableVolumes: they are not the devspace's own). Not a volume that the
   * policy gives to something else by its name (the workspace volume, an anonymous volume, a volume of the Dev
   * Containers extension, of the helper, or of another devspace, foreignVolumeName) or by its labels
   * (volumeLabelOwner: Docker Compose, the Dev Containers extension, an anonymous volume, a volume of a devspace),
   * and not a volume that does not exist.
   */
  private async protectedMountedVolumes(names: readonly string[], workspaceVolume: string): Promise<string[]> {
    // Never the shared VS Code server store (by its name, or the store of the worker).
    const candidates = [...new Set(names)].filter((name) => name !== workspaceVolume && foreignVolumeName(name) === undefined && !this.isVscodeStore(name));
    if (candidates.length === 0) return [];
    const labels = new Map((await this.deps.docker.inspectVolumes(candidates)).map((volume) => [volume.name, volume.labels]));
    return candidates.filter((name) => {
      const volumeLabelsOf = labels.get(name);
      return volumeLabelsOf !== undefined && volumeLabelOwner(volumeLabelsOf) === undefined;
    });
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Steps and helpers

  /**
   * A new devspace ID. The names of a devspace end in the pair of its ID (namePair), and the pair is unique on
   * the Docker engine: an ID is not used when an entry of the registry or a volume of a devspace on the engine
   * (nimblescape.devspaces.id) has its pair, or when its volume or its container exists (`docker volume
   * create` would take the existing volume, and a failed first open would remove it).
   */
  private async unusedDevspaceId(repository: string, segment: string): Promise<string> {
    const file = await this.deps.registry.read();
    // Nor a name that an entry records as an additional volume, or that the registry keeps for an account after a
    // Delete (the extension refuses an entry of such a name: createDevspace).
    const recorded = new Set([...file.devspaces.flatMap((devspace) => devspace.additionalVolumes ?? []), ...(file.keptVolumes ?? []).map((kept) => kept.name)].map((name) => name.toLowerCase()));
    const known = [
      ...file.devspaces.map((devspace) => devspace.id),
      ...(await this.deps.docker.listDevspaceVolumes()).map((volume) => volume.labels[LABEL_DEVSPACE_ID]).filter((id): id is string => id !== undefined),
    ];
    const used = new Set(known.map(namePair));
    const create = this.deps.newDevspaceId ?? newDevspaceId;
    for (let attempt = 1; ; attempt++) {
      const id = create();
      // The names of the devspace (with the word of its source) and of its images (without it; also the name of a
      // devspace of version 0.5.0 or older, whose volume and container the engine may still have).
      const name = resourceName(repository, id, segment);
      const image = resourceName(repository, id);
      if (
        !used.has(namePair(id)) &&
        !recorded.has(name.toLowerCase()) &&
        !recorded.has(image.toLowerCase()) &&
        !(await this.deps.docker.volumeExists(name)) &&
        !(await this.deps.docker.volumeExists(image)) &&
        (await this.deps.docker.containerState(name)) === 'missing' &&
        (await this.deps.docker.containerState(image)) === 'missing'
      ) {
        return id;
      }
      if (attempt >= DEVSPACE_ID_ATTEMPTS) throw new Error(`No unused devspace ID was found for ${repository}.`);
    }
  }

  /**
   * Resolves the helper image of the run: in the worker that is its own image (WorkspaceHelper.ownImageUse), so nothing
   * is built or checked here. The first call of a run resolves the helper image of the run (ctx.helperImage); later
   * calls do nothing.
   */
  private async prepareHelper(ctx: PipelineContext): Promise<void> {
    // The helper image is resolved once per run.
    if (ctx.helperImage !== undefined) return;
    // The helper image of the open is the one that this call awaited (its return value), never learned from a callback,
    // so a reset of the cache of the window meanwhile cannot lose the ID of the image. No catch of its own; the own
    // image fails only on a cancel. A helperFailed (only a test's helper throws one here) marks the run where the
    // calling step catches it (loadConfiguration), else ends it.
    const image = await this.deps.helper.ownImageUse(ctx.signal);
    // The Monitor first; when it cannot be ensured, the open is refused, and the helper image is not taken for
    // resolved, so no later step of this run goes on without the monitor.
    await this.ensureSessionMonitor(ctx);
    // Pinned by the ID of its image, for the current tag too.
    ctx.helperImage = { ...image };
  }

  /**
   * The Monitor container of the engine, and the first heartbeat of this computer for the devspace, once per
   * run and before the container is created or started: the monitor acts only on devspaces with a record, so this
   * keeps the stop without contact for every devspace. The keep-running flag follows keptWhenClosed. The worker's
   * monitor runs the worker's own helper image, so the helper image of the open is not passed. On every engine, local
   * and remote. When the monitor cannot be ensured, the open is refused (UserFacingError sessionMonitorFailed with the
   * cause); the image settings, the references in use, and the first heartbeat stay best effort (logged; the window's
   * heartbeats try again).
   */
  private async ensureSessionMonitor(ctx: PipelineContext): Promise<void> {
    const sessionMonitor = this.deps.sessionMonitor;
    if (!sessionMonitor || ctx.sessionMonitorEnsured) return;
    const target = await this.dockerTarget();
    if (target.kind !== 'remote' && target.kind !== 'local') return;
    const engine = target.kind === 'local' ? 'the local Docker' : target.host;
    try {
      await sessionMonitor.ensure(ctx.signal);
    } catch (error) {
      if (this.isCancellation(error, ctx.signal)) throw error;
      const cause = errorMessage(error);
      this.logger.warn(`The Monitor on ${engine} could not be started; the open of ${ctx.env.repository} is refused: ${cause}`);
      throw new UserFacingError('sessionMonitorFailed', Messages.sessionMonitorUnavailable(ctx.env.repository, cause), cause);
    }
    ctx.sessionMonitorEnsured = true;
    this.throwIfCancelled(ctx.signal);
    // For the image maintenance of the monitor: the image settings and the image references in use.
    try {
      await sessionMonitor.images(ctx.signal);
    } catch (error) {
      if (this.isCancellation(error, ctx.signal)) throw error;
      this.logger.warn(`The image settings and the images in use for the Monitor on ${engine} could not be sent: ${errorMessage(error)}`);
    }
    this.throwIfCancelled(ctx.signal);
    // `seq` is the time at which the flags are read; the entry is read again for them.
    const seq = this.deps.clock.now();
    const env = (await this.deps.registry.get(ctx.env.id)) ?? ctx.env;
    const keepRunning = keptWhenClosed(keepFlagsOf(env), this.deps.settings());
    try {
      const sent = await sessionMonitor.heartbeat(env.id, keepRunning, seq);
      if (!sent.ok) {
        this.logger.warn(`The first heartbeat for ${env.repository} to the Monitor on ${engine} failed; the window tries again. ${sent.detail}`);
      }
    } catch (error) {
      this.logger.warn(`The first heartbeat for ${env.repository} to the Monitor on ${engine} failed: ${errorMessage(error)}`);
    }
  }

  /**
   * The Monitor of the engine again, right after `up` created or started the container of this run (once per
   * run, only when ensureSessionMonitor ran in it). The monitor may have exited when idle between the ensure before the
   * clone and build and this start: the window's heartbeat repair starts it again only once the container exists, and a
   * sleep, quit or crash before that would leave the container running without a monitor. A cheap check when it runs
   * (`docker inspect`); it starts or creates it when it is missing. A failure does not refuse the open (unlike a
   * failure before the start): the container runs already, and a refusal would not stop it, while the open's window,
   * once connected, repairs the monitor with its heartbeats. It is logged, and the user is warned
   * (Messages.sessionMonitorAfterStartFailed). Throws only an AbortError of the run.
   */
  private async ensureSessionMonitorAfterStart(ctx: PipelineContext): Promise<void> {
    const sessionMonitor = this.deps.sessionMonitor;
    if (!sessionMonitor || !ctx.sessionMonitorEnsured || ctx.sessionMonitorEnsuredAfterStart || ctx.helperImage === undefined) return;
    ctx.sessionMonitorEnsuredAfterStart = true;
    // The target is read inside the try, so that a failure to read it is a warning too, never the refusal of an open
    // whose container runs already. `undefined` while the engine is not known.
    let engine: string | undefined;
    try {
      const target = await this.dockerTarget();
      if (target.kind !== 'remote' && target.kind !== 'local') return;
      engine = target.kind === 'local' ? 'the local Docker' : target.host;
      await sessionMonitor.ensure(ctx.signal);
    } catch (error) {
      if (this.isCancellation(error, ctx.signal)) throw error;
      const cause = errorMessage(error);
      this.logger.warn(
        `The Monitor on ${engine ?? 'the Docker engine'} could not be started again after the container of ${ctx.env.repository} started; the heartbeats of the window try again: ${cause}`,
      );
      this.deps.ui.warn(Messages.sessionMonitorAfterStartFailed(ctx.env.repository, engine, cause));
    }
  }

  private async clone(ctx: PipelineContext, token: string, branch: string | undefined): Promise<void> {
    const env = ctx.env;
    try {
      await this.deps.helper.clone({
        volumeName: env.volumeName,
        repository: env.repository,
        branch,
        token,
        image: ctx.helperImage,
        onOutput: this.output,
        signal: ctx.signal,
      });
    } catch (error) {
      this.reportIfTokenRejected(error, token);
      if (this.isCancellation(error, ctx.signal) || isUserFacingError(error)) throw error;
      const detail = errorDetail(error);
      this.logger.error(`${env.repository} could not be cloned.`, error);
      if (isNetworkFailure(detail)) throw new UserFacingError('firstOpenOffline', Messages.firstOpenOffline, detail);
      throw new UserFacingError('cloneFailed', Messages.cloneFailed, detail);
    }
  }

  /**
   * A Git run of the helper with `token` failed because github.com rejected the token (HTTP 401): reported to the one
   * place of the sign-in state (GitHubAuth.reportRejectedToken), so that Sign in with GitHub replaces it.
   */
  private reportIfTokenRejected(error: unknown, token: string): void {
    const text = isUserFacingError(error) ? `${error.message}\n${error.detail ?? ''}` : errorDetail(error);
    if (!isGitHubTokenRejected(text)) return;
    this.logger.warn('GitHub rejected the token of the sign-in (HTTP 401).');
    this.deps.auth.reportRejectedToken?.(token);
  }

  /**
   * Writes the pending connection file of the devspace every `pendingRefreshMs` until the returned function is
   * called; that function also waits for a write in progress, so that no write comes after a removal.
   */
  private keepPendingFresh(devspaceId: string): () => Promise<void> {
    let writing: Promise<void> = Promise.resolve();
    const timer = setInterval(() => {
      writing = writing.then(() =>
        this.quietly('refresh the pending connection file', () =>
          this.deps.sessionFiles.writePending(devspaceId, this.deps.owner.windowId),
        ),
      );
    }, this.pendingRefreshMs);
    timer.unref?.();
    return async () => {
      clearInterval(timer);
      await writing;
    };
  }

  /**
   * Whose the workspace volume of `env` is, by its label nimblescape.devspaces.id: `own`, `missing`, or
   * `foreign` (another devspace's, or a volume of its name without the label); `unreadable` when Docker cannot
   * answer. A volume of its name that is not its own is never used or removed by name.
   */
  private async workspaceVolumeOwnership(env: Devspace): Promise<'own' | 'missing' | 'foreign' | 'unreadable'> {
    let volumes: VolumeInfo[];
    try {
      volumes = await this.deps.docker.inspectVolumes([env.volumeName]);
    } catch (error) {
      this.logger.warn(`The labels of the volume ${env.volumeName} could not be read: ${errorMessage(error)}`);
      return 'unreadable';
    }
    const volume = volumes.find((candidate) => candidate.name === env.volumeName);
    if (volume === undefined) return 'missing';
    if (volume.labels[LABEL_DEVSPACE_ID] === env.id) return 'own';
    this.logger.warn(`The volume ${env.volumeName} carries the devspace ID ${volume.labels[LABEL_DEVSPACE_ID] ?? 'none'}, not ${env.id}. It is not used.`);
    return 'foreign';
  }

  /** The workspace volume of `env` is its own (workspaceVolumeOwnership), else startFailed. */
  private async requireOwnVolume(env: Devspace): Promise<void> {
    const ownership = await this.workspaceVolumeOwnership(env);
    if (ownership === 'own') return;
    throw new UserFacingError(
      'startFailed',
      PipelineTexts.startFailed,
      ownership === 'unreadable' ? `The labels of the volume ${env.volumeName} could not be read.` : `The volume ${env.volumeName} belongs to another devspace.`,
    );
  }

  /** A helper run on a missing volume would create an empty one without labels, which must never happen. */
  private async requireVolume(env: Devspace): Promise<void> {
    if (!(await this.deps.docker.volumeExists(env.volumeName))) {
      throw new UserFacingError('filesMissing', Messages.filesMissing, `The volume ${env.volumeName} does not exist.`);
    }
  }

  private async nextBuildNumber(env: Devspace): Promise<number> {
    const repository = devspaceImageRepository(env.repository, env.id);
    let tags: string[] = [];
    try {
      tags = await this.deps.docker.listImageTags(repository);
    } catch (error) {
      this.logger.warn(`The tags of ${repository} could not be listed: ${errorMessage(error)}`);
    }
    return nextBuildNumber({ lastBuildNumber: env.lastBuildNumber, recordBuildNumber: env.buildRecord?.buildNumber, tags, repository });
  }

  /**
   * Removes every tag of the devspace image repository except `keep`, and the image of `oldRecord`; then the base
   * images of `oldRecord` that no build record of a devspace uses anymore (disk space). Best effort. Docker
   * Compose: the images that Compose built for the project (BuildRecord.compose.images of `oldRecord`) go too, except
   * those of `keepCompose` (the images of the new build record, which have the same names).
   */
  private async removeDevspaceImages(
    env: Devspace,
    keep: string | undefined,
    oldRecord: BuildRecord | undefined,
    keepCompose: readonly string[] = [],
  ): Promise<void> {
    const repository = devspaceImageRepository(env.repository, env.id);
    const images = new Set<string>();
    try {
      for (const tag of await this.deps.docker.listImageTags(repository)) images.add(tag);
    } catch (error) {
      this.logger.warn(`The tags of ${repository} could not be listed: ${errorMessage(error)}`);
    }
    if (oldRecord) images.add(oldRecord.devspaceImage);
    for (const image of await this.ownComposeImages(env, (composeRecordOf(oldRecord)?.images ?? []).filter((image) => !keepCompose.includes(image)))) images.add(image);
    if (keep) images.delete(keep);
    for (const image of images) {
      await this.quietly(`remove the image ${image}`, () => this.deps.docker.removeImage(image));
    }
    if (oldRecord) await this.removeUnusedBaseImages(oldRecord, keep ? undefined : env.id);
  }

  /**
   * Of the images `names` that Docker Compose built for `env` (BuildRecord.compose), those that carry the label
   * nimblescape.devspaces.id of `env`: a name `<project>-<service>` can also be the name of an image of
   * another devspace whose name starts with `<project>-`, and such an image is never removed. An image whose labels
   * cannot be read is kept.
   */
  private async ownComposeImages(env: Devspace, names: readonly string[]): Promise<string[]> {
    const own: string[] = [];
    for (const name of names) {
      const labels = await this.deps.docker.imageLabels(name).catch(() => undefined);
      if (labels?.[LABEL_DEVSPACE_ID] === env.id) own.push(name);
      else if (labels !== undefined) this.logger.info(`The image ${name} does not carry the devspace ID of ${env.repository}; it is not removed.`);
    }
    return own;
  }

  private async removeUnusedBaseImages(oldRecord: BuildRecord, excludeDevspaceId: string | undefined): Promise<void> {
    let devspaces: Devspace[];
    try {
      devspaces = await this.deps.registry.list();
    } catch (error) {
      this.logger.warn(`Base images are not removed: ${errorMessage(error)}`);
      return;
    }
    const inUse = new Set<string>();
    for (const other of devspaces) {
      if (other.id === excludeDevspaceId) continue;
      for (const [reference, digest] of Object.entries(other.buildRecord?.images ?? {})) inUse.add(baseImageKey(reference, digest));
    }
    // The images of the other services of Docker Compose that are not built (for example `postgres:16`) are images of
    // the user, not base images of the devspace image (the cleanup for disk space removes only base images).
    const serviceImages = new Set(composeRecordOf(oldRecord)?.serviceImages ?? []);
    for (const [reference, digest] of Object.entries(oldRecord.images)) {
      if (inUse.has(baseImageKey(reference, digest)) || serviceImages.has(reference)) continue;
      const image = digestReference(reference, digest);
      if (!image) continue;
      await this.quietly(`remove the base image ${image}`, () => this.removeBaseImage(image, reference));
    }
  }

  /**
   * Removes a base image by its digest reference `<name>@<digest>`. Assumption: a pulled base image keeps the registry
   * digest of the check as its repository digest, so this reference finds it. The containerd image store then removes
   * the image with its tag; the classic image store of Docker Engine removes only the digest reference, and the tag
   * keeps the image. So the tag is removed too when it still names the same image (a tag that a pull moved to a newer
   * image stays). Docker refuses to remove an image that a container or another image uses (removeImage then returns
   * false).
   */
  private async removeBaseImage(image: string, reference: string): Promise<void> {
    const { docker } = this.deps;
    const id = await docker.imageId(image);
    if (!(await docker.removeImage(image)) || id === undefined) return;
    if ((await docker.imageId(reference)) === id) await docker.removeImage(reference);
  }

  /**
   * The volumes of `devspaceId` that Delete would remove, for the two questions of Delete, from one read
   * (removableVolumesByKind), so the two questions see the same state. Empty lists when the devspace or Docker does
   * not answer.
   * - `additional`: the additional volumes that Delete would remove (removableVolumes), for the question of Delete: it
   *   lists only these, and keeps the others; without the volumes of a Docker Compose project
   *   (nimblescape.devspaces.volume=compose), which `serviceData` has for a question of their own.
   * - `serviceData`: the volumes of the Docker Compose project that Delete would remove: the data of its services,
   *   for example of a database. The question of Delete lists them apart, none ticked: they are removed only when the
   *   user ticks them.
   * - `possibly`: of `serviceData`, the volumes that are there only because the entry knows neither
   *   the volumes of its services nor its build: additional volumes that may hold data of services,
   *   or not (for example of a single container restored from its volumes). The question names them so.
   */
  async removableVolumesOf(devspaceId: string): Promise<RemovableVolumes> {
    const volumes = await this.removableVolumesByKind(devspaceId);
    return {
      additional: volumes.filter((volume) => volume.kind !== VOLUME_KIND_COMPOSE).map((volume) => volume.name),
      serviceData: volumes.filter((volume) => volume.kind === VOLUME_KIND_COMPOSE).map((volume) => volume.name),
      possibly: volumes.filter((volume) => volume.possibly === true).map((volume) => volume.name),
    };
  }

  /**
   * removableVolumes of the additional volumes of `devspaceId`, each with its kind: VOLUME_KIND_COMPOSE for a volume
   * that holds data of the services of Docker Compose (classified by use, whatever its label
   * nimblescape.devspaces.volume; a volume with `name:` in the model has the label `additional`): the label `compose`, a
   * volume that the open recorded as mounted by another service (Devspace.serviceVolumes), or a volume that a
   * container of another service mounts now. Otherwise its label nimblescape.devspaces.volume.
   */
  private async removableVolumesByKind(devspaceId: string): Promise<Array<{ name: string; kind: string | undefined; possibly?: boolean }>> {
    const env = await this.deps.registry.get(devspaceId);
    if (!env || (env.additionalVolumes ?? []).length === 0 || !(await this.isOnCurrentHost(env))) return [];
    try {
      const { removable, labels } = await this.removableVolumes(env, env.additionalVolumes ?? []);
      const services = new Set(env.serviceVolumes ?? []);
      const containers = await this.deps.docker.devspaceContainers(env.id);
      for (const container of containers) {
        if (!isDevContainer(container, env.containerName)) for (const name of container.volumes ?? []) services.add(name);
      }
      // An entry that knows neither the volumes of its services nor its build (for example one restored from its
      // volumes, or whose service volume Docker created at `up` without the label nimblescape.devspaces.service-data):
      // every volume may hold the data of a service, so each goes to that question, none ticked (the conservative
      // side).
      const unknown = env.serviceVolumes === undefined && env.buildRecord === undefined;
      const known = (name: string): boolean => services.has(name) || labels.get(name)?.[LABEL_SERVICE_DATA] === SERVICE_DATA;
      return removable.map((name) =>
        known(name) || !unknown
          ? { name, kind: known(name) ? VOLUME_KIND_COMPOSE : labels.get(name)?.[LABEL_VOLUME] }
          : // Perhaps data of a service, perhaps not; the question names it so.
            { name, kind: VOLUME_KIND_COMPOSE, possibly: true },
      );
    } catch (error) {
      this.logger.warn(`The additional volumes of ${env.repository} could not be read: ${errorMessage(error)}`);
      return [];
    }
  }

  /**
   * Of the additional volumes `names` that `env` records, those that Delete may remove, and the reason for each other
   * one. Removable is only an existing volume whose labels make it the devspace's own (isOwnVolume) and that no other
   * devspace records and no Delete of another account kept. Kept, with its reason: every other volume, among them a
   * volume without the labels of the devspace (the user removes it), a volume of another program (for example of
   * Docker Compose, which took a name that the devspace used before), and a volume of another devspace.
   */
  private async removableVolumes(
    env: Devspace,
    names: readonly string[],
  ): Promise<{ removable: string[]; kept: Array<{ name: string; reason: string }>; labels: ReadonlyMap<string, Record<string, string>> }> {
    const volumes = (env.additionalVolumes ?? []).filter((name) => names.includes(name) && name !== env.volumeName);
    const labels = new Map<string, Record<string, string>>();
    const result = { removable: [] as string[], kept: [] as Array<{ name: string; reason: string }>, labels };
    if (volumes.length === 0) return result;
    const file = await this.deps.registry.read();
    const others = file.devspaces.filter((other) => other.id !== env.id);
    // A volume that the Delete of a devspace of another account kept holds that account's data.
    const keptByOthers = (file.keptVolumes ?? []).filter((record) => record.owner.id !== env.owner.id).map((record) => record.name);
    for (const volume of await this.deps.docker.inspectVolumes(volumes)) labels.set(volume.name, volume.labels);
    for (const name of volumes) {
      const volumeLabelsOf = labels.get(name);
      if (volumeLabelsOf === undefined) continue;
      if (others.some((other) => other.volumeName === name || (other.additionalVolumes ?? []).includes(name)) || keptByOthers.includes(name)) {
        result.kept.push({ name, reason: 'another devspace uses it too' });
      } else if (!isOwnVolume(volumeLabelsOf, env.id, env.owner.id)) {
        const owner = volumeLabelOwner(volumeLabelsOf);
        result.kept.push({
          name,
          reason:
            owner !== undefined
              ? `${owner} created it`
              : 'its labels do not show that this devspace created it',
        });
      } else {
        result.removable.push(name);
      }
    }
    return result;
  }

  /**
   * Delete: the additional volumes that the user confirmed (`confirmed`, as the question listed them) and that the
   * devspace still records, when removableVolumes allows it; each other one is kept with a log line that names why.
   * Returns the names of the removed volumes.
   */
  private async removeAdditionalVolumes(env: Devspace, confirmed: readonly string[]): Promise<string[]> {
    const { removable, kept } = await this.removableVolumes(env, confirmed);
    for (const { name, reason } of kept) this.logger.info(`The volume ${name} is kept, because ${reason}.`);
    const removed: string[] = [];
    for (const name of removable) {
      try {
        await this.deps.docker.removeVolume(name);
        removed.push(name);
      } catch (error) {
        this.logger.warn(`Could not remove the volume ${name}: ${errorMessage(error)}`);
      }
    }
    return removed;
  }

  /** The volumes of `names` that exist. */
  private async existingVolumes(names: readonly string[]): Promise<string[]> {
    if (names.length === 0) return [];
    const existing = new Set((await this.deps.docker.inspectVolumes(names)).map((volume) => volume.name));
    return names.filter((name) => existing.has(name));
  }

  private async removeVolumeWithRetry(name: string): Promise<void> {
    // The batch helper of the open mounts the volume; it ends first (a later step would open a new one).
    const scope = currentBatchScope();
    if (scope !== undefined && scope.volume === name) await scope.closeSession();
    for (let attempt = 1; ; attempt++) {
      try {
        await this.deps.docker.removeVolume(name);
        return;
      } catch (error) {
        if (attempt >= VOLUME_REMOVE_ATTEMPTS) throw error;
        await this.sleepFn(VOLUME_REMOVE_DELAY_MS);
      }
    }
  }

  /**
   * Delete and a failed first open of a Docker Compose devspace, after the containers with the label
   * nimblescape.devspaces.id: the containers of the project that have no such label (for example one-off
   * containers of `docker compose run`), the networks of the project, and the images that Compose built for it
   * (`<project>-<service>`, found by their names: the build record may be missing, after a failed first open or a lost
   * registry). Its volumes are the devspace's own and follow the rules of Delete (removeAdditionalVolumes). `quiet`:
   * every failure is logged, not thrown (a failed first open).
   */
  private async removeComposeProject(env: Devspace, quiet: boolean): Promise<void> {
    const { docker } = this.deps;
    const project = composeProjectName(env.repository, env.id);
    const run = (what: string, fn: () => Promise<unknown>): Promise<unknown> => (quiet ? this.quietly(what, fn) : fn());
    await run('remove the containers of the Docker Compose project', async () => {
      for (const container of await docker.listProjectContainers(project)) {
        // The label of the project can come from an image (a container of another devspace, for example a single
        // container whose image has the label): never a container of another devspace.
        const owner = container.labels[LABEL_DEVSPACE_ID];
        if (owner !== undefined && owner !== env.id) {
          this.logger.warn(`The container ${container.name} has the label of the Docker Compose project ${project} but belongs to another devspace. It is not removed.`);
          continue;
        }
        // Stopped first, as at Delete.
        await this.stopServiceBeforeRemoval(container, env);
        await docker.removeContainer(container.id);
      }
    });
    await this.quietly('remove the networks of the Docker Compose project', () => this.removeComposeNetworks(env));
    await this.quietly('remove the images of the Docker Compose project', async () => {
      const images = new Set([...(await this.ownComposeImages(env, composeRecordOf(env.buildRecord)?.images ?? [])), ...(await docker.listProjectImages(project, env.id))]);
      for (const image of images) await this.quietly(`remove the image ${image}`, () => docker.removeImage(image));
    });
  }

  /** A failed first open leaves nothing behind, so the next Start begins cleanly. `compose`: a Docker Compose configuration. */
  private async removeFailedFirstOpen(env: Devspace, compose = false): Promise<boolean> {
    const { docker } = this.deps;
    this.logger.info(`Removing what the failed first open of ${env.repository} created.`);
    // A volume of the name with the labels of another devspace (two first opens on one engine whose IDs got the same
    // pair at the same moment) is that devspace's: nothing of that name is removed, neither its images nor its
    // Compose project; and a volume whose labels cannot be read is treated the same way (the entry stays, so the next
    // open completes the clone or Delete removes it). The same rule as an open and Delete (workspaceVolumeOwnership): a
    // volume of the name without the ID label of this devspace is not its own either.
    const ownership = await this.workspaceVolumeOwnership(env);
    const readable = ownership !== 'unreadable';
    const foreignName = ownership === 'foreign' || ownership === 'unreadable';
    if (foreignName) this.logger.warn(`Nothing of the name ${env.volumeName} is removed: the volume is not the devspace's own (${ownership}).`);
    await this.quietly('remove the container', async () => {
      const containers = await docker.devspaceContainers(env.id);
      for (const container of containers) {
        // A running side service is stopped first, as at Delete.
        await this.stopServiceBeforeRemoval(container, env);
        await docker.removeContainer(container.id);
      }
      if (foreignName) return;
      await docker.removeContainer(env.containerName);
      if (compose || containers.some((c) => isComposeContainer(c.labels, composeProjectName(env.repository, env.id)))) await this.removeComposeProject(env, true);
    });
    if (!foreignName) await this.quietly('remove the devspace images', () => this.removeDevspaceImages(env, undefined, undefined));
    if (!readable) {
      await this.quietly('remove the pending connection file', () => this.deps.sessionFiles.removePending(env.id));
      return false;
    }
    try {
      if (!foreignName) await this.removeVolumeWithRetry(env.volumeName);
    } catch (error) {
      this.logger.warn(`Could not remove the volume ${env.volumeName}: ${errorMessage(error)}. The devspace is kept; open it again to complete the clone, or delete it.`);
      await this.quietly('remove the pending connection file', () => this.deps.sessionFiles.removePending(env.id));
      return false;
    }
    // The additional volumes that the failed open recorded stay (a known limit), with their account: the devspaces
    // of other accounts must not mount them, as after a Delete that kept them.
    await this.quietly('remove the registry entry', async () => {
      const current = (await this.deps.registry.get(env.id)) ?? env;
      await this.deps.registry.remove(env.id, { kept: await this.existingVolumes(current.additionalVolumes ?? []) });
    });
    await this.quietly('remove the pending connection file', () => this.deps.sessionFiles.removePending(env.id));
    return true;
  }

  /**
   * The Git summary from the running container (the script `gitSummary` of the registry), or `undefined` when Git is
   * missing, fails, or `signal` aborts. The one read of the Git state (readGitSummary, as Stop reads it); a cancel is a
   * failed read here (logged).
   */
  private gitSummaryInContainer(container: string, user: string | undefined, folder: string, signal?: AbortSignal): Promise<GitSummary | undefined> {
    return readGitSummary(this.deps.docker, { id: container, name: container }, user, folder, {
      now: () => isoTime(this.deps.clock),
      log: (line) => this.logger.info(line),
      cancel: 'fail',
      signal,
    });
  }

  /**
   * The branch (`null` for a detached HEAD), or `undefined` when Git is missing, fails, or `signal` aborts. The one
   * read of the branch (readBranch, the script `branch` of the registry), as the refresh reads it.
   */
  private branchInContainer(container: string, user: string | undefined, folder: string, signal?: AbortSignal): Promise<string | null | undefined> {
    return readBranch(this.deps.docker, container, user, folder, signal);
  }

  // --- Busy marks ----------------------------------------------------------------------------------------------------

  /**
   * Runs `fn` under the lock of the devspace on the Docker host of the operation: the state is made consistent
   * before the operation, or the operation is refused. The worker takes the lock (its own lock, workerDevspaceLock).
   * When that fails, the operation is refused (devspaceLockUnavailable, with the cause) and `fn` never runs: never
   * without the lock, never the direct way. A lock held by another window or computer is waited for
   * DEVSPACE_LOCK_WAIT_SECONDS, then the operation is refused (devspaceLockBusy); no retry loop. Within `fn` the
   * volume steps run in the batch helper of the lock (devspaceLock.ts); no Docker call goes through the lock, the
   * pipeline of the worker uses its engine. The lock is released in `finally`. Re-entrant: an operation that holds the
   * lock of `env` runs `fn` at once. The caller took its busy mark first (Delete), so a refusal leaves nothing behind
   * that its own `finally` does not clear. Also the opens (openExisting: Start, Rebuild, Clone again; openFirst), see
   * there.
   */
  private async withDevspaceLock<T>(
    env: Devspace,
    signal: AbortSignal | undefined,
    fn: () => Promise<T>,
    // `batchVolume` (the opens): `fn` runs in the batch scope of that volume (batchScope.ts) under the lock; its
    // session is closed before the lock is released.
    options: { batchVolume?: string } = {},
  ): Promise<T> {
    if (holdsDevspaceLock(env.id)) return fn();
    // The worker's own image needs no preparation; a cancel before the lock throws its AbortError.
    if (signal?.aborted) throw abortError();
    let lock: HeldDevspaceLock;
    try {
      lock = await this.deps.devspaceLock(env.id, DEVSPACE_LOCK_WAIT_SECONDS, signal);
    } catch (error) {
      if (this.isCancellation(error, signal)) throw error;
      if (error instanceof DevspaceLockError && error.kind === 'busy') {
        this.logger.info(`${env.repository} is locked on the Docker host by another window or computer: ${error.message}`);
        throw new UserFacingError('startFailed', PipelineTexts.devspaceLockBusy(env.repository), error.message);
      }
      this.logger.warn(`${env.repository}: the lock on the Docker host could not be taken, so nothing is changed: ${errorMessage(error)}`);
      throw new UserFacingError('helperFailed', PipelineTexts.devspaceLockUnavailable(env.repository, errorMessage(error)), errorMessage(error));
    }
    this.logger.info(`${env.repository} is locked on the Docker host.`);
    const batchVolume = options.batchVolume;
    try {
      return await runWithDevspaceLock(lock, batchVolume === undefined ? fn : () => runWithBatchScope(lock, batchVolume, this.logger, fn));
    } finally {
      await lock.release();
      this.logger.info(`${env.repository} is unlocked on the Docker host.`);
    }
  }

  /**
   * Sets a busy mark, unless another live window holds one (checked under the registry lock), through the busy marks of
   * the window that runs the operation (busyMarks).
   */
  private async setBusyMark(env: Devspace, operation: BusyOperation): Promise<Devspace> {
    const result = await this.busyMarks.mark(env.id, operation);
    if (result === undefined) throw devspaceMissing(env.repository);
    if ('conflict' in result) throw devspaceBusy(env.repository, result.conflict);
    this.logger.info(`${env.repository} is marked as busy (${operation}).`);
    return result.devspace;
  }

  /**
   * setBusyMark, waiting while another live window holds a mark (as waitForOtherOperation, at most `busyWaitMs`), for
   * the pipeline in the worker too: the window that runs the operation decides whether a mark is live.
   */
  private async markBusyWaiting(env: Devspace, operation: BusyOperation, signal: AbortSignal | undefined): Promise<Devspace> {
    const attempts = Math.ceil(this.busyWaitMs / BUSY_POLL_MS);
    for (let attempt = 0; ; attempt++) {
      const result = await this.busyMarks.mark(env.id, operation);
      if (result === undefined) throw devspaceMissing(env.repository);
      if (!('conflict' in result)) {
        this.logger.info(`${env.repository} is marked as busy (${operation}).`);
        return result.devspace;
      }
      const mark = result.conflict;
      if (attempt >= attempts) throw devspaceBusy(env.repository, mark);
      if (attempt === 0) this.logger.info(`${env.repository} is busy (${mark.operation}) in another window (process ${mark.pid}). Waiting.`);
      await this.sleepFn(BUSY_POLL_MS, signal);
      this.throwIfCancelled(signal);
    }
  }

  private async markBusy(ctx: PipelineContext, operation: BusyOperation): Promise<void> {
    ctx.env = await this.setBusyMark(ctx.env, operation);
    ctx.busy = true;
    ctx.stepMark = undefined;
  }

  /** Clears the busy mark of this run. Never throws: it runs in `finally` blocks. */
  private async releaseBusy(ctx: PipelineContext): Promise<void> {
    if (!ctx.busy) return;
    ctx.busy = false;
    ctx.stepMark = undefined;
    await this.clearOwnMark(ctx.env.id);
  }

  // --- General ---------------------------------------------------------------------------------------------------------

  /** The entry that an OpenRecords write returned becomes ctx.env; a missing one is devspaceMissing. */
  private entryUpdated(ctx: PipelineContext, updated: Devspace | undefined): void {
    if (!updated) throw devspaceMissing(ctx.env.repository);
    ctx.env = updated;
  }

}

/**
 * A helperFailed of Step 8 with `detail`; the refusal of the batch scope keeps its message
 * (Messages.batchHelperUnavailable) and its kind (isBatchHelperUnavailable).
 */
function helperFailedError(error: unknown, detail: string): UserFacingError {
  return isBatchHelperUnavailable(error) ? new BatchHelperUnavailableError(error.message, detail) : new UserFacingError('helperFailed', Messages.helperFailed, detail);
}
