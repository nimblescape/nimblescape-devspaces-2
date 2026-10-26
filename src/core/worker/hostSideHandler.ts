// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The worker is the deputy of the window; this is the extension's side of the requests of a flow in the worker
// (`OperationOptions.onAsk`). It checks every request, calls the HostSide of this computer, and answers with its value;
// a `secret` request answers with the secret in `secrets`, never in the value. No `vscode` here: the extension passes
// its own HostSide (src/vscode).
import { DETAILED_REQUESTS, HOST_SECRET_NAMES, HOST_SESSION_FILES, SCOPED_REQUESTS, parseHostRequest, type HostCall, type HostSecretAnswer, type HostSessionFile, type HostSide } from './hostSide';
import { BUSY_OPERATIONS } from '../pipeline/busyMarks';
import type { DeleteConfirmation } from '../pipeline/deleteCheck';
import { sameBusyMark } from '../pipeline/openRecords';
import type { BusyMark, BusyOperation, Devspace, DevspaceSource } from '../types';
import {
  VOLUME_NAME,
  busyMarkFields,
  checkedBuildChange,
  checkedBusyMark,
  checkedConfigurationChange,
  checkedCreateRequest,
  checkedGitSummary,
  checkedLifecycleChange,
  checkedOpenFinish,
  isDefaultImage,
  type OpenRequestScope,
} from './openRequests';
import { sourceSegment } from '../devspaceSource';
import { MAX_RESTORE_ENTRIES, parseDevspaceSource } from '../helperChannel/protocol';
import { parseConfigCheckEntry } from '../storage/configCheckEntry';
import { isConfigPathLabelValue, repositoryFolder, resourceName } from '../names';
import { DEFAULT_CONFIG_PATH, isRepositoryName } from '../pipeline/recordRules';
import { boundServiceFolders, MAX_SERVICE_FOLDERS, MAX_SERVICE_PATH_LENGTH } from '../git/gitSummary';
import { dockerHostField } from '../docker/dockerHost';
import { isStorageId } from '../storage/paths';
import { HelperOperationError, type OperationOptions } from '../helperChannel/helperChannel';
import type { AskKind, Secrets } from '../helperChannel/protocol';
import { errorMessage } from '../errors';
import { isLoginReference, registryDisplayName } from '../imageCheck/reference';
import type { Logger } from '../ports';

/** The answer of a request: its value, and the secrets that the operation gets with it. */
type Answer = { value: unknown; secrets?: Secrets };

/** A registry as Docker names it: a host name, with a port. */
const REGISTRY_HOST = /^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?(:[0-9]{1,5})?$/i;
/** The longest text of a message of a flow. */
const MAX_MESSAGE_CHARACTERS = 2000;

function stringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

/**
 * `onAsk` of an operation that runs a flow: it answers the requests of `HostSide` of this computer. A request that it
 * does not know, or whose arguments do not fit, is refused with the code `invalid`; a call that throws is refused with
 * `failed` (its message), so the flow in the worker sees the failure of its call. Only the requests in `allowed`
 * (FLOW_REQUESTS of the operation) are answered; everything else is refused before this computer is touched.
 */
export function hostSideHandler(
  host: HostSide,
  logger: Logger,
  allowed: readonly HostCall[],
  // The devspace of the operation, for the requests that change one (SCOPED_REQUESTS). The name of the repository
  // that the questions must name, and the observer of the answers of the user (the extension checks the decision of the
  // flow against them).
  scope: {
    devspaceId?: string;
    repository?: string;
    // The Docker host of the operation, the only one whose entries `record restore` adds.
    dockerHost?: string;
    onAnswer?: (call: string, args: unknown[], value: unknown) => void;
    // A question of the flow is asked (`asked`) and has its answer or failed (`settled`).
    onQuestion?: (state: 'asked' | 'settled') => void;
  } = {},
): NonNullable<OperationOptions['onAsk']> {
  const permitted = new Set<string>(allowed);
  // The requests that an operation sends at most once.
  const sent = new Set<string>();
  // The marks that a `record markBusy` of this operation replaced, the only ones that `record createMark` `previous`
  // gives back.
  const replaced: BusyMark[] = [];
  // The devspace of the operation; a first open has none until its `record createDevspace` binds it (`created`:
  // the entry that this operation created, the only one that `record dropCreated` removes).
  const devspace: OperationDevspace = { id: scope.devspaceId };
  // The registry logins of the operation (`secret registry`).
  const logins: OperationLogins = { given: new Set(), requests: 0, pending: false };
  return async (kind, payload, signal) => {
    const request = parseHostRequest(payload, kind);
    if (request === undefined) {
      logger.warn(`The worker sent a request of the kind ${kind} that is invalid.`);
      throw new HelperOperationError('invalid', 'The request of the operation is invalid.', false);
    }
    const name = `${request.kind} ${request.call}` as HostCall;
    // An allowance can name the kind of a request (its session file, its busy operation).
    const detailAt = Object.hasOwn(DETAILED_REQUESTS, name) ? DETAILED_REQUESTS[name] : undefined;
    const detail = detailAt !== undefined ? request.args[detailAt] : undefined;
    if (!permitted.has(name) && !(typeof detail === 'string' && permitted.has(`${name}.${detail}`))) {
      logger.warn(`The worker sent the request ${request.kind} ${request.call}, which its operation may not send.`);
      throw new HelperOperationError('invalid', `The operation may not send the request ${request.kind} ${request.call}.`, false);
    }
    const scoped = Object.hasOwn(SCOPED_REQUESTS, name) ? SCOPED_REQUESTS[name] : undefined;
    if (scoped !== undefined && (devspace.id === undefined || request.args[scoped] !== devspace.id)) {
      logger.warn(`The worker sent the request ${request.kind} ${request.call} for another devspace than the one of its operation.`);
      throw new HelperOperationError('invalid', `The request ${request.kind} ${request.call} is for another devspace than the one of the operation.`, false);
    }
    if (ONCE_REQUESTS.has(name)) {
      if (sent.has(name)) {
        logger.warn(`The worker sent the request ${request.kind} ${request.call} again, which its operation sends once.`);
        throw new HelperOperationError('invalid', `The operation sends the request ${request.kind} ${request.call} only once.`, false);
      }
      sent.add(name);
    }
    if (signal.aborted) throw new HelperOperationError('cancelled', 'The operation ended.', false);
    try {
      // A question names the repository of the operation, never a text of the worker. As the registry compares
      // repositories (isDevspaceOf), without case: the entry of the open may spell its repository otherwise than the
      // target of the operation.
      if (request.kind === 'question' && QUESTIONS_WITH_REPOSITORY.has(request.call) && scope.repository !== undefined && !sameRepository(request.args[0], scope.repository)) {
        throw new HelperOperationError('invalid', `The question ${request.call} names another repository than the one of the operation.`, false);
      }
      if (request.kind !== 'question') return await answer(host, request.kind, request.call, request.args, { dockerHost: scope.dockerHost, repository: scope.repository, logger, replaced, devspace, logins });
      scope.onQuestion?.('asked');
      try {
        const answered = await answer(host, request.kind, request.call, request.args);
        scope.onAnswer?.(request.call, request.args, answered.value);
        return answered;
      } finally {
        scope.onQuestion?.('settled');
      }
    } catch (error) {
      if (error instanceof HelperOperationError) throw error;
      logger.warn(`The request ${request.kind} ${request.call} of the worker failed: ${errorMessage(error)}`);
      throw new HelperOperationError('failed', errorMessage(error), false);
    }
  };
}

/**
 * The requests that an operation sends at most once: the restore of the registry adds the entries of one engine, so a
 * worker cannot grow the registry without bound.
 */
const ONCE_REQUESTS: ReadonlySet<string> = new Set([
  'record restore',
  // An open ends once.
  'record openFinished',
  // An operation creates at most one devspace.
  'record createDevspace',
  // One question to GitHub with the user's token per operation (identityOf asks once).
  'local viewer',
]);

/** The devspace of an operation (SCOPED_REQUESTS), and the one that it created. */
interface OperationDevspace {
  id?: string;
  created?: string;
}

/** The registry logins of an operation (`secret registry`). */
interface OperationLogins {
  /** The registries whose login the operation got. */
  given: Set<string>;
  /** The requests of the operation. */
  requests: number;
  /** A request is being answered. */
  pending: boolean;
}

/**
 * The most registries whose login one operation gets. A pull asks for the login of its registry when the registry
 * refused the pull without a login or did not find the image (or Docker Hub limited it), and a check when the registry
 * refused the request without a login (or answered 404), so a registry counts when it answered so and this computer
 * has a login for it: the registry of a private image, of private Features (often ghcr.io, with the GitHub sign-in)
 * and of the private images of a Docker Compose configuration. The extension cannot read the configuration on the
 * Docker engine, so this limit is what bounds the logins that a worker that someone else controls gets in one open.
 */
export const MAX_LOGIN_REGISTRIES = 8;
/** The most requests for a registry login of one operation: at most one for each pull and each registry of a check. */
export const MAX_LOGIN_REQUESTS = 256;

/** What the answer of a request of the extension's side knows of its operation (hostSideHandler). */
interface RequestContext {
  dockerHost?: string;
  repository?: string;
  logger?: Logger;
  replaced: BusyMark[];
  devspace: OperationDevspace;
  logins: OperationLogins;
}

/** The most marks that the handler of an operation remembers as replaced by its `record markBusy`. */
const MAX_REPLACED_MARKS = 8;

/** The same repository, as the registry compares them (isDevspaceOf: without case). */
function sameRepository(value: unknown, repository: string): boolean {
  return typeof value === 'string' && value.toLowerCase() === repository.toLowerCase();
}

/**
 * The questions whose first argument is the name of the repository, those of the open included (a worker never asks the
 * trust, or a rebuild, for another repository than the one of its operation).
 */
const QUESTIONS_WITH_REPOSITORY = new Set([
  'confirmDelete',
  'confirmUntrustedRepository',
  'configurationChanged',
  'configurationKindChanged',
  'filesMissing',
  'recreateContainer',
  'updateContainer',
]);

/** The most names of a question of Delete. */
const MAX_QUESTION_NAMES = 1000;

// Every caller names its limit.
function plainText(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
}

/** The volume names of a question of Delete. */
function volumeNames(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > MAX_QUESTION_NAMES || !value.every((name) => typeof name === 'string' && VOLUME_NAME.test(name))) {
    throw new HelperOperationError('invalid', 'The volumes of the question are invalid.', false);
  }
  return [...(value as string[])];
}

/** The facts of the confirmation of Delete (DeleteConfirmation), checked; nothing else is passed on. */
function deleteConfirmation(value: unknown): DeleteConfirmation {
  const invalid = () => new HelperOperationError('invalid', 'The confirmation of Delete is invalid.', false);
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw invalid();
  const { changes, recordedAt, lastSeenInUse, repositoryData, otherWindow } = value as Record<string, unknown>;
  if (typeof otherWindow !== 'boolean') throw invalid();
  // Counts, never a text.
  const count = (n: unknown) => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
  let counts: DeleteConfirmation['changes'];
  if (changes !== undefined) {
    if (typeof changes !== 'object' || changes === null || Array.isArray(changes)) throw invalid();
    const { uncommittedFiles, unpushedCommits, stashes } = changes as Record<string, unknown>;
    if (!count(uncommittedFiles) || !count(unpushedCommits) || (stashes !== undefined && !count(stashes))) throw invalid();
    counts = { uncommittedFiles: uncommittedFiles as number, unpushedCommits: unpushedCommits as number, ...(stashes !== undefined ? { stashes: stashes as number } : {}) };
  }
  for (const time of [recordedAt, lastSeenInUse]) if (time !== undefined && !plainText(time, 64)) throw invalid();
  // Folders of the repository, as paths of normal length without `..`.
  const isFolder = (folder: unknown) => plainText(folder, 255) && folder !== '' && !(folder as string).split('/').includes('..');
  if (!Array.isArray(repositoryData) || repositoryData.length > MAX_QUESTION_NAMES || !repositoryData.every(isFolder)) throw invalid();
  return {
    ...(counts !== undefined ? { changes: counts } : {}),
    ...(recordedAt !== undefined ? { recordedAt: recordedAt as string } : {}),
    ...(lastSeenInUse !== undefined ? { lastSeenInUse: lastSeenInUse as string } : {}),
    repositoryData: [...(repositoryData as string[])],
    otherWindow,
  };
}

/** The fields of an entry that the rebuild from the volumes gives it (DevspaceService.reconcileFromVolumes). */
const RESTORED_FIELDS = new Set([
  'id',
  'repository',
  'configPath',
  'defaultImage',
  'volumeName',
  'containerName',
  'createdAt',
  'lastUsedAt',
  'owner',
  'dockerHost',
  'additionalVolumes',
  'serviceVolumes',
  'serviceFolders',
  'serviceFoldersOverflow',
]);

/** Why one restored entry is left out. */
class RefusedEntry extends Error {}

/**
 * The entries that the worker rebuilt from the labels of the volumes, checked as reconcileFromVolumes makes them: the
 * name of the volume that the extension gives the devspace of its labels, an owner without login, the Docker host of
 * the operation, and only the fields of a rebuild (no build record, no Git state, no busy mark). Each entry is rebuilt
 * from its checked fields; nothing else is passed on. An entry that does not fit is left out (logged), never the others
 * with it; only a request that is not a list of at most MAX_RESTORE_ENTRIES is refused.
 */
function restoredEntries(value: unknown, dockerHost: string, logger: Logger | undefined): Devspace[] {
  if (!Array.isArray(value) || value.length > MAX_RESTORE_ENTRIES) {
    throw new HelperOperationError('invalid', `The restored entries are invalid: not a list of at most ${MAX_RESTORE_ENTRIES}.`, false);
  }
  const entries: Devspace[] = [];
  for (const entry of value as unknown[]) {
    try {
      entries.push(restoredEntry(entry, dockerHost));
    } catch (error) {
      if (!(error instanceof RefusedEntry)) throw error;
      // The name only when it is a volume name (the worker's text is never logged as it is).
      const name = typeof entry === 'object' && entry !== null ? (entry as { volumeName?: unknown }).volumeName : undefined;
      const named = typeof name === 'string' && VOLUME_NAME.test(name) ? `of the volume ${name} ` : '';
      logger?.warn(`The worker restored an entry ${named}that is left out: ${error.message}.`);
    }
  }
  return entries;
}

/** One restored entry, checked and rebuilt; RefusedEntry when it does not fit. */
function restoredEntry(entry: unknown, dockerHost: string): Devspace {
  const invalid = (why: string) => new RefusedEntry(why);
  const isTime = (time: unknown) => plainText(time, 64) && Number.isFinite(Date.parse(time));
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) throw invalid('it is not an object');
  const fields = entry as Record<string, unknown>;
  const odd = Object.keys(fields).find((key) => !RESTORED_FIELDS.has(key));
  if (odd !== undefined) throw invalid('a field is not one of a restored entry');
  const { id, repository, configPath, defaultImage, volumeName, containerName, createdAt, lastUsedAt, owner } = fields;
  if (!isStorageId(id) || !isRepositoryName(repository) || !plainText(repository, 256)) throw invalid('its ID or repository');
  if (typeof configPath !== 'string' || (configPath !== DEFAULT_CONFIG_PATH && !isConfigPathLabelValue(configPath))) throw invalid('its configuration path');
  // The source of the entry (the label of its volume): the default image of a default-image devspace, a valid image
  // reference; else its configuration.
  if (defaultImage !== undefined && !isDefaultImage(defaultImage)) throw invalid('its default image');
  const source: DevspaceSource = defaultImage !== undefined ? { kind: 'defaultImage', image: defaultImage } : { kind: 'configuration', configPath };
  // Only the volume of the name that the extension gives the devspace of these labels (with the word of its source,
  // or without it: a volume of version 0.5.0 or older), and its container.
  const names = [resourceName(repository, id, sourceSegment(source)), resourceName(repository, id)].map((name) => name.toLowerCase());
  if (typeof volumeName !== 'string' || !names.includes(volumeName.toLowerCase()) || containerName !== volumeName) {
    throw invalid('its volume has not the name of its devspace');
  }
  if (!isTime(createdAt) || !isTime(lastUsedAt)) throw invalid('a time');
  if (typeof owner !== 'object' || owner === null || Array.isArray(owner)) throw invalid('its owner');
  const { id: ownerId, login, ...rest } = owner as Record<string, unknown>;
  // The owner label gives the entry its owner again; its login follows at the next open.
  if (!isStorageId(ownerId) || login !== '' || Object.keys(rest).length > 0) throw invalid('its owner');
  if ((fields.dockerHost ?? '') !== dockerHost || fields.dockerHost === '') throw invalid('its Docker host is not the one of the operation');
  const additional = fields.additionalVolumes === undefined ? [] : volumeList(fields.additionalVolumes, invalid);
  if (fields.additionalVolumes !== undefined && (additional.length === 0 || additional.includes(volumeName) || new Set(additional).size !== additional.length)) {
    throw invalid('its additional volumes');
  }
  const services = fields.serviceVolumes === undefined ? [] : volumeList(fields.serviceVolumes, invalid);
  if (fields.serviceVolumes !== undefined && (services.length === 0 || !services.every((name) => additional.includes(name)))) throw invalid('the volumes of its services');
  const { serviceFolders, serviceFoldersOverflow } = fields;
  if (serviceFoldersOverflow !== undefined && serviceFoldersOverflow !== true) throw invalid('the overflow of its service folders');
  // Service folders that do not fit count as overflow (the whole repository is left to the services, so their data
  // never loses its owner), as the pipeline counts paths beyond its bounds.
  const listed = Array.isArray(serviceFolders) ? serviceFolders.slice(0, MAX_SERVICE_FOLDERS) : [];
  const fitting = listed.filter((folder): folder is string => plainText(folder, MAX_SERVICE_PATH_LENGTH));
  const overflow =
    serviceFoldersOverflow === true || (serviceFolders !== undefined && !Array.isArray(serviceFolders)) || (Array.isArray(serviceFolders) && serviceFolders.length > MAX_SERVICE_FOLDERS) || fitting.length < listed.length;
  // As the pipeline records them: only paths of the repository, within the bounds.
  const folders = boundServiceFolders(repositoryFolder(repository), [fitting], overflow);
  return {
    id,
    repository,
    configPath,
    ...(defaultImage !== undefined ? { defaultImage } : {}),
    volumeName,
    containerName: volumeName,
    createdAt: createdAt as string,
    lastUsedAt: lastUsedAt as string,
    owner: { id: ownerId, login: '' },
    ...dockerHostField(dockerHost),
    ...(additional.length > 0 ? { additionalVolumes: additional } : {}),
    ...(services.length > 0 ? { serviceVolumes: services } : {}),
    ...(folders.folders.length > 0 ? { serviceFolders: folders.folders } : {}),
    ...(folders.overflow ? { serviceFoldersOverflow: true } : {}),
  };
}

/** The names of volumes of a restored entry. */
function volumeList(value: unknown, invalid: (why: string) => Error): string[] {
  if (!Array.isArray(value) || value.length > MAX_QUESTION_NAMES || !value.every((name) => typeof name === 'string' && VOLUME_NAME.test(name))) throw invalid('the names of volumes');
  return [...(value as string[])];
}

function strings(args: unknown[], count: number): string[] {
  const values = args.slice(0, count);
  if (values.length !== count || !values.every((value) => typeof value === 'string')) {
    throw new HelperOperationError('invalid', 'The arguments of the request are invalid.', false);
  }
  return values as string[];
}

async function answer(
  host: HostSide,
  kind: AskKind,
  call: string,
  args: unknown[],
  context: RequestContext = { replaced: [], devspace: {}, logins: { given: new Set(), requests: 0, pending: false } },
): Promise<Answer> {
  switch (kind) {
    case 'question':
      return { value: await question(host, call, args) };
    case 'local':
      return { value: await local(host, call, args) };
    case 'record':
      return { value: await record(host, call, args, context) };
    case 'secret':
      return secret(host, call, args, context);
  }
}

async function question(host: HostSide, call: string, args: unknown[]): Promise<unknown> {
  const ui = host.questions;
  switch (call) {
    case 'confirmUntrustedRepository':
      return ui.confirmUntrustedRepository(strings(args, 1)[0]);
    case 'configurationChanged': {
      // The second argument, when given, names what changed (ConfigurationChangeKind).
      const [repository] = strings(args, 1);
      const what = args.length === 2 ? args[1] : undefined;
      if (args.length > 2 || (what !== undefined && what !== 'defaultImage')) {
        throw new HelperOperationError('invalid', 'The arguments of the request are invalid.', false);
      }
      return ui.configurationChanged(repository, what);
    }
    case 'configurationKindChanged': {
      const [repository, message] = strings(args, 2);
      return ui.configurationKindChanged(repository, message);
    }
    case 'filesMissing':
      return (await ui.filesMissing(strings(args, 1)[0])) ?? null;
    case 'recreateContainer': {
      const [repository] = strings(args, 1);
      const value = args[1] as { message?: unknown; detail?: unknown } | undefined;
      if (typeof value !== 'object' || value === null || typeof value.message !== 'string' || typeof value.detail !== 'string') {
        throw new HelperOperationError('invalid', 'The question of the recreate offer is invalid.', false);
      }
      return ui.recreateContainer(repository, { message: value.message, detail: value.detail });
    }
    // The repository (QUESTIONS_WITH_REPOSITORY: the one of the operation) and whether the container runs, nothing
    // else; the window words the question after its own setting updateContainer.
    case 'updateContainer': {
      const [repository] = strings(args, 1);
      const running = args[1];
      if (args.length !== 2 || typeof running !== 'boolean' || !plainText(repository, 256) || repository === '') {
        throw new HelperOperationError('invalid', 'The question of the update of a container is invalid.', false);
      }
      return ui.updateContainer(repository, running);
    }
    // The questions of Delete, with their facts checked.
    case 'confirmDelete': {
      const [repository] = strings(args, 1);
      if (!plainText(repository, 256) || repository === '') throw new HelperOperationError('invalid', 'The repository of the question is invalid.', false);
      return (await ui.confirmDelete(repository, deleteConfirmation(args[1]))) ?? null;
    }
    case 'deleteAdditionalVolumes':
      return (await ui.deleteAdditionalVolumes(volumeNames(args[0]))) ?? null;
    case 'deleteServiceData': {
      const volumes = volumeNames(args[0]);
      const possibly = volumeNames(args[1]);
      return (await ui.deleteServiceData(volumes, possibly)) ?? null;
    }
    case 'message': {
      const [kind, text] = strings(args, 2);
      if (kind !== 'info' && kind !== 'warn' && kind !== 'registrySignIn') throw new HelperOperationError('invalid', `The message ${kind} is unknown.`, false);
      // The sign-in hint names a registry (a host name), and no text is longer than a message on screen can be.
      if (kind === 'registrySignIn' && !REGISTRY_HOST.test(text)) throw new HelperOperationError('invalid', 'The registry of the sign-in hint is invalid.', false);
      await ui.message(kind, text.length > MAX_MESSAGE_CHARACTERS ? `${text.slice(0, MAX_MESSAGE_CHARACTERS)}…` : text);
      return null;
    }
    default:
      throw new HelperOperationError('invalid', `The question ${call} is unknown.`, false);
  }
}

async function local(host: HostSide, call: string, args: unknown[]): Promise<unknown> {
  switch (call) {
    case 'windowStatuses':
      return host.state.windowStatuses();
    case 'pendings':
      return host.state.pendings();
    case 'processAlive': {
      const pid = args[0];
      if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0) throw new HelperOperationError('invalid', 'The process id is invalid.', false);
      return host.state.processAlive(pid);
    }
    // The profile of the signed-in account, read by the extension with its own token.
    case 'viewer': {
      argumentCount(args, 0);
      const viewer = await host.state.viewer();
      return viewer === undefined ? null : { databaseId: viewer.databaseId, login: viewer.login, name: viewer.name ?? null };
    }
    // The container that the window remembers for the devspace of the operation (SCOPED_REQUESTS).
    case 'unrecordedLifecycle': {
      strings(args, 1);
      argumentCount(args, 1);
      return (await host.state.unrecordedLifecycle(args[0] as string)) ?? null;
    }
    case 'account': {
      const interactive = args[0];
      if (typeof interactive !== 'boolean') throw new HelperOperationError('invalid', 'The account request is invalid.', false);
      const account = await host.state.account(interactive);
      // The id and the login only.
      return account === undefined ? null : { id: account.id, login: account.login };
    }
    default:
      throw new HelperOperationError('invalid', `The state ${call} is unknown.`, false);
  }
}

/**
 * A container ID as Docker gives it: 64 hexadecimal digits, or a short one of at least 12 (a shorter prefix would name
 * other containers too: sameContainer).
 */
const CONTAINER_ID = /^[0-9a-f]{12,64}$/;

/** The arguments of a request of the open, exactly `count` of them (no field beyond its closed list). */
function argumentCount(args: unknown[], count: number): void {
  if (args.length !== count) throw new HelperOperationError('invalid', 'The arguments of the request are invalid.', false);
}

/** The scope of a request of the open, from the operation; an operation without a Docker host sends none. */
function openScope(dockerHost: string | undefined): OpenRequestScope {
  if (dockerHost === undefined) throw new HelperOperationError('invalid', 'The operation names no Docker host for the registry writes of the open.', false);
  return { dockerHost };
}

async function record(host: HostSide, call: string, args: unknown[], context: RequestContext): Promise<unknown> {
  const { dockerHost, logger, replaced } = context;
  const records = host.records;
  switch (call) {
    case 'read':
      return records.read();
    case 'list':
      return records.list();
    case 'get':
      return (await records.get(strings(args, 1)[0])) ?? null;
    case 'findForAccount': {
      const [repository, accountId, onHost] = strings(args, 3);
      // The source of the devspace, when the request names one (exactly a DevspaceSource); else any devspace of the
      // repository.
      if (args.length > 4) throw new HelperOperationError('invalid', 'The arguments of the request are invalid.', false);
      const source = args.length === 4 ? parseDevspaceSource(args[3]) : undefined;
      if (args.length === 4 && source === undefined) throw new HelperOperationError('invalid', 'The source of the request is invalid.', false);
      // An operation of a repository without its devspace yet (the open of a repository) is bound to the devspace
      // that it finds for the repository of the operation, the account signed in here and the Docker host of the
      // operation: the existing one, or the one that its `record restore` added. Only then may it change that entry
      // (SCOPED_REQUESTS); an operation that is bound already finds no other one.
      const bindable = context.repository !== undefined && sameRepository(repository, context.repository) && dockerHost !== undefined && onHost === dockerHost;
      if (bindable && context.devspace.id === undefined) {
        const account = await host.state.account(false);
        if (account === undefined || account.id !== accountId) throw new HelperOperationError('invalid', 'The account of the request is not the one signed in.', false);
      }
      const found = await records.findForAccount(repository, accountId, onHost, source);
      if (found !== undefined && bindable) {
        if (context.devspace.id === undefined) context.devspace.id = found.id;
        else if (context.devspace.id !== found.id) throw new HelperOperationError('invalid', 'The operation found another devspace than its own.', false);
      }
      return found ?? null;
    }
    case 'remove': {
      const [id] = strings(args, 1);
      const volumes = (args[1] ?? {}) as { kept?: unknown; removed?: unknown };
      if (typeof volumes !== 'object' || Array.isArray(volumes) || (volumes.kept !== undefined && !stringList(volumes.kept)) || (volumes.removed !== undefined && !stringList(volumes.removed))) {
        throw new HelperOperationError('invalid', 'The volumes of the removal are invalid.', false);
      }
      await records.remove(id, { ...(volumes.kept !== undefined ? { kept: volumes.kept } : {}), ...(volumes.removed !== undefined ? { removed: volumes.removed } : {}) });
      return null;
    }
    case 'forgetKeptVolumes': {
      const names = args[0];
      // Volume names, at most as many as a question names (the worker reads which kept volumes are gone from its
      // engine; it holds that engine anyway, so the records are no more than its word).
      if (!stringList(names) || names.length > MAX_QUESTION_NAMES || !names.every((name) => VOLUME_NAME.test(name))) {
        throw new HelperOperationError('invalid', 'The volume names are invalid.', false);
      }
      await records.forgetKeptVolumes(names as string[]);
      return null;
    }
    case 'sessionFile': {
      const [kind, devspaceId] = strings(args, 2);
      if (!(HOST_SESSION_FILES as readonly string[]).includes(kind)) throw new HelperOperationError('invalid', `The session file ${kind} is unknown.`, false);
      await records.sessionFile(kind as HostSessionFile, devspaceId);
      return null;
    }
    // The busy mark of the window that sent the operation.
    case 'markBusy': {
      const [devspaceId, operation] = strings(args, 2);
      if (!(BUSY_OPERATIONS as readonly string[]).includes(operation)) throw new HelperOperationError('invalid', `The busy operation ${operation} is unknown.`, false);
      // The mark that it replaced is remembered for `record createMark` `previous` of this operation.
      const remember = (mark: BusyMark) => {
        replaced.push(mark);
        if (replaced.length > MAX_REPLACED_MARKS) replaced.shift();
      };
      return (await records.markBusy(devspaceId, operation as BusyOperation, remember)) ?? null;
    }
    case 'clearBusy':
      await records.clearBusy(strings(args, 1)[0]);
      return null;
    // The Git state, checked as the registry checks it.
    case 'recordGitSummary': {
      const [devspaceId] = strings(args, 1);
      // Its five fields only, a bounded branch and a valid time (checkedGitSummary, which `record openFinished` uses
      // too).
      await records.recordGitSummary(devspaceId, checkedGitSummary(args[1]));
      return null;
    }
    // The entries rebuilt from the volumes of the engine of the operation, each rebuilt here from its checked fields.
    case 'restore': {
      if (dockerHost === undefined) throw new HelperOperationError('invalid', 'The operation names no Docker host for the restored entries.', false);
      const entries = restoredEntries(args[0], dockerHost, logger);
      const { added, skipped } = await records.restore(entries);
      return { added, skipped: [...skipped] };
    }
    // The registry writes of the open, each with its closed list of arguments; the extension applies them under its
    // registry lock (requestOpenRecords).
    case 'createMark': {
      const [devspaceId, kind] = strings(args, 2);
      if (kind === 'ended') {
        argumentCount(args, 2);
        return (await records.createMark(devspaceId, 'ended', undefined, openScope(dockerHost))) ?? null;
      }
      if (kind !== 'previous' || args.length > 3) throw new HelperOperationError('invalid', 'The create mark of the request is invalid.', false);
      // `previous` only as a mark that a `record markBusy` of this operation replaced; the remembered one is given
      // back, never the worker's object. It is found by its four fields as the registry held them (the worker read it
      // there); one that is not found ends this window's create mark instead (`ended`), so the mark never stays live
      // for the rest of the window.
      let previous: BusyMark | undefined;
      if (args.length === 3) {
        const sent = busyMarkFields(args[2]);
        previous = sent === undefined ? undefined : replaced.find((mark) => sameBusyMark(mark, sent));
        if (previous === undefined) {
          logger?.warn(`The previous busy mark of ${devspaceId} is not one that the busy mark of this operation replaced; the create mark of this window is ended instead.`);
          return (await records.createMark(devspaceId, 'ended', undefined, openScope(dockerHost))) ?? null;
        }
      }
      return (await records.createMark(devspaceId, 'previous', previous, openScope(dockerHost))) ?? null;
    }
    case 'stepMark': {
      const [devspaceId, kind] = strings(args, 2);
      argumentCount(args, 3);
      if (kind === 'take') {
        // The open takes only an `update` step mark.
        if (args[2] !== 'update') throw new HelperOperationError('invalid', 'The busy operation of the step mark is not update.', false);
        return (await records.takeStepMark(devspaceId, 'update', openScope(dockerHost))) ?? null;
      }
      if (kind !== 'release') throw new HelperOperationError('invalid', 'The step mark of the request is invalid.', false);
      return (await records.releaseStepMark(devspaceId, checkedBusyMark(args[2]), openScope(dockerHost))) ?? null;
    }
    case 'ownerLogin': {
      const [devspaceId] = strings(args, 1);
      // The account is the one signed in in the extension; the worker sends none.
      argumentCount(args, 1);
      return (await records.ownerLogin(devspaceId, openScope(dockerHost))) ?? null;
    }
    case 'lifecycleMark': {
      const [devspaceId] = strings(args, 1);
      argumentCount(args, 2);
      return (await records.lifecycleMark(devspaceId, checkedLifecycleChange(args[1]), openScope(dockerHost))) ?? null;
    }
    case 'openFinished': {
      const [devspaceId] = strings(args, 1);
      argumentCount(args, 2);
      return (await records.openFinished(devspaceId, checkedOpenFinish(args[1]), openScope(dockerHost))) ?? null;
    }
    // The entry of a first open, the worker's ID and the repository of the operation; the extension builds the entry.
    // The operation is bound to the devspace of the answer.
    case 'createDevspace': {
      argumentCount(args, 1);
      if (context.devspace.id !== undefined) throw new HelperOperationError('invalid', 'The operation has a devspace already: it creates none.', false);
      const request = checkedCreateRequest(args[0]);
      // Only an operation of a repository creates its entry.
      if (context.repository === undefined || request.repository !== context.repository) {
        throw new HelperOperationError('invalid', 'The devspace of the request is of another repository than the one of the operation.', false);
      }
      const entry = await records.createDevspace(request.id, request.repository, request.configPath, openScope(dockerHost), request.defaultImage);
      // The new entry, or the one of the repository of the account on the Docker host that another window created
      // meanwhile (the open uses it, as openFirst does): every later request of the operation is for it.
      context.devspace.id = entry.id;
      if (entry.id === request.id) context.devspace.created = entry.id;
      return entry;
    }
    case 'dropCreated': {
      const [devspaceId] = strings(args, 1);
      argumentCount(args, 1);
      if (devspaceId !== context.devspace.created) throw new HelperOperationError('invalid', 'The devspace of the request is not the one that the operation created.', false);
      await records.dropCreated(devspaceId, openScope(dockerHost));
      context.devspace.created = undefined;
      return null;
    }
    case 'configuration': {
      const [devspaceId] = strings(args, 1);
      argumentCount(args, 2);
      return (await records.configuration(devspaceId, checkedConfigurationChange(args[1]), openScope(dockerHost))) ?? null;
    }
    case 'build': {
      const [devspaceId, kind] = strings(args, 2);
      return (await records.build(devspaceId, checkedBuildChange(kind, args.slice(2)), openScope(dockerHost))) ?? null;
    }
    // The remembered check result of the configuration of the devspace of the operation (SCOPED_REQUESTS); the entry
    // that the worker offers is checked (parseConfigCheckEntry) before it is stored, never passed on as it is.
    case 'configCheck': {
      const [devspaceId] = strings(args, 1);
      argumentCount(args, 1);
      return (await records.configCheck(devspaceId, openScope(dockerHost))) ?? null;
    }
    case 'rememberConfigCheck': {
      const [devspaceId] = strings(args, 1);
      argumentCount(args, 2);
      const entry = parseConfigCheckEntry(args[1]);
      if (entry === undefined) throw new HelperOperationError('invalid', 'The check result of the request is invalid.', false);
      await records.rememberConfigCheck(devspaceId, entry, openScope(dockerHost));
      return null;
    }
    // The window's memory of a container of the devspace of the operation whose lifecycle mark could not be
    // recorded; only a container ID.
    case 'rememberLifecycle':
    case 'forgetLifecycle': {
      const [devspaceId, containerId] = strings(args, 2);
      argumentCount(args, 2);
      if (!CONTAINER_ID.test(containerId)) throw new HelperOperationError('invalid', 'The container ID of the request is invalid.', false);
      if (call === 'rememberLifecycle') await records.rememberLifecycle(devspaceId, containerId);
      else await records.forgetLifecycle(devspaceId, containerId);
      return null;
    }
    default:
      throw new HelperOperationError('invalid', `The record ${call} is unknown.`, false);
  }
}

async function secret(host: HostSide, call: string, args: unknown[], context: RequestContext): Promise<Answer> {
  switch (call) {
    case 'token': {
      const token = await host.secrets.token();
      const value: HostSecretAnswer = { given: token !== undefined };
      return token === undefined ? { value } : { value, secrets: { [HOST_SECRET_NAMES.token]: token } };
    }
    case 'registry':
      return registryLogin(host, args, context);
    default:
      throw new HelperOperationError('invalid', `The secret ${call} is unknown.`, false);
  }
}

/**
 * `secret registry`: the login of the registry of one image or Feature, which the request names as its registry and
 * repository, as parseImageReference normalizes them (isLoginReference). The extension gives only the login of that
 * registry, answers one request at a time (it refuses a second request while it answers one), gives the logins of at
 * most MAX_LOGIN_REGISTRIES registries and answers at most MAX_LOGIN_REQUESTS requests of the operation, and logs each
 * request with its answer or the reason of its refusal (never the login).
 */
async function registryLogin(host: HostSide, args: unknown[], context: RequestContext): Promise<Answer> {
  const { logins, logger } = context;
  const refuse = (why: string): never => {
    logger?.warn(`The worker asked for a registry login that is refused: ${why}.`);
    throw new HelperOperationError('invalid', `The registry login of the request is refused: ${why}.`, false);
  };
  const [registry, repository] = args;
  if (args.length !== 2 || typeof registry !== 'string' || typeof repository !== 'string') return refuse('the request does not name a registry and a repository');
  // The texts of the worker in the log: in quotes, on one line, and short.
  const quoted = (text: string) => JSON.stringify(text.slice(0, 100));
  if (!isLoginReference(registry, repository)) return refuse(`${quoted(registry)} and ${quoted(repository)} are not the registry and the repository of an image`);
  const name = registryDisplayName(registry);
  const image = `${name}/${repository}`;
  if (logins.pending) return refuse(`the request for ${image} came while another registry login of the operation was answered`);
  if (logins.requests >= MAX_LOGIN_REQUESTS) return refuse(`the request for ${image} came after ${MAX_LOGIN_REQUESTS} registry logins of the operation`);
  logins.requests += 1;
  const what = `The registry login for ${image}${context.repository !== undefined ? ` (open of ${context.repository})` : ''}`;
  if (!logins.given.has(registry) && logins.given.size >= MAX_LOGIN_REGISTRIES) {
    const given = [...logins.given].map(registryDisplayName).join(', ');
    logger?.warn(`${what} is not given: the operation got the logins of ${MAX_LOGIN_REGISTRIES} registries already (${given}).`);
    return { value: { given: false } satisfies HostSecretAnswer };
  }
  logins.pending = true;
  let login: Awaited<ReturnType<HostSide['secrets']['registry']>>;
  try {
    login = await host.secrets.registry(registry, repository);
  } catch (error) {
    logger?.warn(`${what}: the login could not be read: ${errorMessage(error)}`);
    throw new HelperOperationError('failed', errorMessage(error), false);
  } finally {
    logins.pending = false;
  }
  if (login === undefined) {
    logger?.info(`${what}: this computer has no login for ${name}.`);
    return { value: { given: false } satisfies HostSecretAnswer };
  }
  logins.given.add(registry);
  const { password, from, ...rest } = login;
  logger?.info(`${what}: the worker got ${from === 'github' ? 'the GitHub sign-in as the login' : 'the login that Docker stored'} for ${name}.`);
  const value: HostSecretAnswer = { given: true, ...rest };
  return { value, secrets: { [HOST_SECRET_NAMES.registry]: password } };
}
