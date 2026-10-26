// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// One devspace per repository and GitHub account. The devspace service with two accounts that open the same
// repository, and with the names of a new devspace.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UserFacingError } from '../errors';
import { dockerCheckItem } from '../helper/configurationAnalysis';
import { Messages } from '../messages';
import { LABEL_CONFIG_PATH, LABEL_DEVSPACE_ID, LABEL_OWNER_ID, LABEL_REPOSITORY, devspaceImageName, devspaceImageRepository, resourceName } from '../names';
import { namePair } from '../namePairs';
import { availableDevspaces } from '../ownership';
import { otherAccountImageItem } from '../policy';
import type { Devspace, GitHubAccount } from '../types';
import type { RepositoryTarget } from './operationBase';
import {
  ACCOUNT,
  BASE_IMAGE,
  ENV_ID,
  OTHER_ACCOUNT,
  OTHER_ID,
  REPO,
  TOKEN,
  additionalVolumeLabels,
  createHarness,
  seedDevspace,
  type Harness,
  type HarnessOverrides,
} from './devspaceService.testkit';
import { DEFAULT_CONFIG_PATH } from './recordRules';

const OTHER_TOKEN = 'gho_othertoken';
const TARGET: RepositoryTarget = { repository: REPO, defaultBranch: 'main', configPaths: [DEFAULT_CONFIG_PATH], trusted: true };

let h: Harness;

beforeEach(() => {
  h = createHarness();
});

afterEach(() => {
  h.cleanup();
});

function recreate(overrides: HarnessOverrides): void {
  h.cleanup();
  h = createHarness(overrides);
}

function options(): { progress: typeof h.progress } {
  return { progress: h.progress };
}

/** A switch of the GitHub account in VS Code: another account, with a token of its own. */
function signIn(account: GitHubAccount, token: string): void {
  h.account = { ...account };
  h.token = token;
}

async function rejection(promise: Promise<unknown>): Promise<UserFacingError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(UserFacingError);
    return error as UserFacingError;
  }
  throw new Error('The promise did not reject.');
}

describe('two GitHub accounts open the same repository', () => {
  it('gives each account a devspace of its own: clone, volume, container, token, and Git identity', async () => {
    const first = (await h.service.open(TARGET, options())).devspace;
    signIn(OTHER_ACCOUNT, OTHER_TOKEN);
    const second = (await h.service.open(TARGET, options())).devspace;

    expect(second.id).not.toBe(first.id);
    expect([first.owner, second.owner]).toEqual([ACCOUNT, OTHER_ACCOUNT]);
    expect(second.volumeName).toBe(resourceName(REPO, second.id, 'config'));
    expect(second.volumeName).not.toBe(first.volumeName);
    expect(second.containerName).not.toBe(first.containerName);
    expect(h.docker.volumes.get(second.volumeName)).toEqual({
      [LABEL_DEVSPACE_ID]: second.id,
      [LABEL_REPOSITORY]: REPO,
      [LABEL_OWNER_ID]: OTHER_ACCOUNT.id,
      [LABEL_CONFIG_PATH]: DEFAULT_CONFIG_PATH,
    });
    expect(h.helper.clones.map((clone) => [clone.volumeName, clone.token])).toEqual([
      [first.volumeName, TOKEN],
      [second.volumeName, OTHER_TOKEN],
    ]);
    // The volume gets the Git configuration only; the token goes into the memory of the container (tokenWrites).
    expect(h.helper.gitPreparations.map((call) => [call.volumeName, call.identity.email])).toEqual([
      [first.volumeName, '1001+octo@users.noreply.github.com'],
      [second.volumeName, '2002+someone@users.noreply.github.com'],
    ]);
    expect(h.docker.tokenWrites().map((write) => write.token)).toEqual([TOKEN, OTHER_TOKEN]);
    // The GitHub CLI of each devspace is signed in as the account that owns it, with its token.
    expect(h.docker.tokenWrites().map((write) => write.login)).toEqual(['octo', 'someone']);
    expect(h.docker.containersOf(first.id)).toHaveLength(1);
    expect(h.docker.containersOf(second.id)).toHaveLength(1);
    expect([...h.ui.infos, ...h.ui.warnings]).toEqual([]);
  });

  it('lets each account see and open only its own devspace of the repository', async () => {
    const first = (await h.service.open(TARGET, options())).devspace;
    signIn(OTHER_ACCOUNT, OTHER_TOKEN);
    const second = (await h.service.open(TARGET, options())).devspace;

    const entries = await h.registry.list();
    expect(availableDevspaces(entries, ACCOUNT).map((entry) => entry.id)).toEqual([first.id]);
    expect(availableDevspaces(entries, OTHER_ACCOUNT).map((entry) => entry.id)).toEqual([second.id]);
    expect((await h.registry.findForAccount(REPO, ACCOUNT.id))?.id).toBe(first.id);
    expect((await h.registry.findForAccount(REPO, OTHER_ACCOUNT.id))?.id).toBe(second.id);

    // Back to the first account: Start opens its devspace again, without a clone, with its own token.
    signIn(ACCOUNT, TOKEN);
    const again = await h.service.open(TARGET, options());
    expect(again.devspace.id).toBe(first.id);
    expect(h.helper.clones).toHaveLength(2);
    // The token goes into the memory of the container of the first devspace.
    expect(h.helper.gitPreparations.at(-1)).toMatchObject({ volumeName: first.volumeName });
    expect(h.docker.tokenWrites().at(-1)).toMatchObject({ token: TOKEN, login: 'octo' });
    expect(h.docker.containersOf(first.id).map((container) => container.id)).toContain(h.docker.tokenWrites().at(-1)?.container);
    // Only an explicit reference to the devspace of the other account is refused.
    expect((await rejection(h.service.openDevspace(second.id, options()))).code).toBe('otherAccount');
    expect((await rejection(h.operations.stop(second.id))).code).toBe('otherAccount');
  });

  it('creates a devspace of the account when another window created one of another account in the meantime', async () => {
    const original = h.registry.add.bind(h.registry);
    let raced = false;
    h.registry.add = async (devspace: Devspace) => {
      if (!raced) {
        raced = true;
        await seedDevspace(h, { owner: OTHER_ACCOUNT, container: 'stopped' });
      }
      return original(devspace);
    };
    const result = await h.service.open(TARGET, options());
    expect(result.devspace.id).not.toBe(ENV_ID);
    expect(result.devspace.owner).toEqual(ACCOUNT);
    expect(h.helper.clones).toHaveLength(1);
    expect((await h.registry.list()).map((entry) => entry.id).sort()).toEqual([ENV_ID, result.devspace.id].sort());
  });

  it('uses the devspace of the account that another window created in the meantime, never the one of another account', async () => {
    const original = h.registry.add.bind(h.registry);
    let raced = false;
    h.registry.add = async (devspace: Devspace) => {
      if (!raced) {
        raced = true;
        await seedDevspace(h, { id: OTHER_ID, owner: OTHER_ACCOUNT, container: 'stopped' });
        await seedDevspace(h, { container: 'stopped' });
      }
      return original(devspace);
    };
    const result = await h.service.open(TARGET, options());
    expect(result.devspace.id).toBe(ENV_ID);
    expect(h.helper.clones).toEqual([]);
    expect((await h.registry.list()).map((entry) => entry.id)).toEqual([OTHER_ID, ENV_ID]);
  });

  it('writes the token of the session that found the devspace, also when the account changes during the open', async () => {
    let switched = false;
    recreate({
      auth: {
        getToken: async () => (switched ? OTHER_TOKEN : TOKEN),
        getAccount: async () => (switched ? OTHER_ACCOUNT : ACCOUNT),
      },
    });
    await seedDevspace(h);
    const find = h.registry.findForAccount.bind(h.registry);
    h.registry.findForAccount = async (repository: string, accountId: string) => {
      const found = await find(repository, accountId);
      // Another window signs in with the other account right after the lookup.
      switched = true;
      return found;
    };
    const result = await h.service.open(TARGET, options());
    expect(result.devspace.id).toBe(ENV_ID);
    // The token of the open is written into the memory of the container.
    expect(h.docker.tokenWrites().map((write) => write.token)).toEqual([TOKEN]);
  });

  it('asks for the sign-in first, because the account decides which devspace is used', async () => {
    h.token = undefined;
    const error = await rejection(h.service.open({ ...TARGET, trusted: false }, options()));
    expect(error.code).toBe('signInRequired');
    expect(h.ui.prompts).toEqual([]);
    expect(h.dockerStarts).toBe(0);
    expect(await h.registry.list()).toEqual([]);
  });

  it('asks the second account before its first open of a repository of another owner', async () => {
    await seedDevspace(h, { owner: OTHER_ACCOUNT });
    h.ui.trust = false;
    expect((await rejection(h.service.open({ ...TARGET, trusted: false }, options()))).code).toBe('cancelled');
    expect(h.ui.prompts).toEqual([`untrusted ${REPO}`]);
    expect((await h.registry.list()).map((entry) => entry.id)).toEqual([ENV_ID]);
  });

  it('refuses a named volume of the repository that the devspace of another account uses', async () => {
    const SHARED = 'api-node_modules';
    await seedDevspace(h, { owner: OTHER_ACCOUNT, container: null, extra: { additionalVolumes: [SHARED] } });
    h.helper.config = { image: BASE_IMAGE, mounts: [`source=${SHARED},target=/workspaces/api/node_modules,type=volume`] };
    const error = await rejection(h.service.open(TARGET, options()));
    expect(error.code).toBe('hostAccess');
    expect(error.message).toBe(Messages.hostAccess(`volume ${SHARED} of another devspace`));
    expect(h.helper.builds).toEqual([]);
    // The failed first open leaves nothing behind; the devspace of the other account keeps its volume.
    expect((await h.registry.list()).map((entry) => entry.id)).toEqual([ENV_ID]);
    expect([...h.docker.volumes.keys()]).toEqual([resourceName(REPO, ENV_ID)]);
  });
});

describe('additional volumes that a Delete kept', () => {
  const DATA = 'api-data';
  const MOUNT = `source=${DATA},target=/data,type=volume`;

  /** The devspace of OTHER_ACCOUNT used `DATA`; its Delete keeps it. */
  async function otherAccountDeletesAndKeeps(): Promise<void> {
    await seedDevspace(h, { owner: OTHER_ACCOUNT, container: null, extra: { additionalVolumes: [DATA] } });
    h.docker.volumes.set(DATA, {});
    signIn(OTHER_ACCOUNT, OTHER_TOKEN);
    await h.service.delete(ENV_ID, { progress: h.progress, additionalVolumesToRemove: [] });
    signIn(ACCOUNT, TOKEN);
  }

  it('keeps the volume for its account: the devspace of another account of the repository must not mount it', async () => {
    await otherAccountDeletesAndKeeps();
    expect(await h.registry.list()).toEqual([]);
    expect(h.docker.volumes.has(DATA)).toBe(true);
    expect(await h.registry.keptVolumes()).toEqual([{ name: DATA, owner: OTHER_ACCOUNT, keptAt: expect.any(String) }]);
    h.helper.config = { image: BASE_IMAGE, mounts: [MOUNT] };
    const error = await rejection(h.service.open(TARGET, options()));
    expect(error.code).toBe('hostAccess');
    expect(error.message).toBe(Messages.hostAccess(`volume ${DATA} of another devspace`));
    expect(h.helper.builds).toEqual([]);
    expect(h.docker.volumes.has(DATA)).toBe(true);
  });

  it('lets a new devspace of the same account use the volume again, without taking it for its own', async () => {
    await otherAccountDeletesAndKeeps();
    signIn(OTHER_ACCOUNT, OTHER_TOKEN);
    h.helper.config = { image: BASE_IMAGE, mounts: [MOUNT] };
    const result = await h.service.open(TARGET, options());
    expect(result.devspace.owner).toEqual(OTHER_ACCOUNT);
    expect(h.helper.ups).toHaveLength(1);
    // Its labels name no devspace (created by hand): never recorded, never removed.
    expect(result.devspace.additionalVolumes).toBeUndefined();
  });

  it('lets a new devspace of the same account mount a labeled volume that its Delete kept, and refuses it to another account', async () => {
    await seedDevspace(h, { owner: OTHER_ACCOUNT, container: null, extra: { additionalVolumes: [DATA] } });
    h.docker.volumes.set(DATA, additionalVolumeLabels(ENV_ID, OTHER_ACCOUNT));
    signIn(OTHER_ACCOUNT, OTHER_TOKEN);
    await h.service.delete(ENV_ID, { progress: h.progress, additionalVolumesToRemove: [] });
    h.helper.config = { image: BASE_IMAGE, mounts: [MOUNT] };
    // Without the record of the Delete, the labels alone decide.
    await h.registry.forgetKeptVolumes([DATA]);
    signIn(ACCOUNT, TOKEN);
    const error = await rejection(h.service.open(TARGET, options()));
    expect(error.message).toBe(Messages.hostAccess(`volume ${DATA} of another devspace`));
    signIn(OTHER_ACCOUNT, OTHER_TOKEN);
    const result = await h.service.open(TARGET, options());
    expect(result.devspace.owner).toEqual(OTHER_ACCOUNT);
    // The labels name the deleted devspace: the new one records it only to protect it (an additional volume of the
    // same owner), does not take it for its own or relabel it, and its Delete keeps it.
    expect(result.devspace.additionalVolumes).toEqual([DATA]);
    expect(h.docker.volumes.get(DATA)).toEqual(additionalVolumeLabels(ENV_ID, OTHER_ACCOUNT));
    // The one read of the removable volumes (removableVolumesOf).
    expect((await h.service.removableVolumesOf(result.devspace.id)).additional).toEqual([]);
    await h.service.delete(result.devspace.id, { progress: h.progress, additionalVolumesToRemove: [DATA] });
    expect(h.docker.volumes.get(DATA)).toEqual(additionalVolumeLabels(ENV_ID, OTHER_ACCOUNT));
    expect(h.docker.log.filter((line) => line === `volume rm ${DATA}`)).toEqual([]);
  });

  it('records the volumes that the Delete after missing files keeps without asking', async () => {
    await seedDevspace(h, { owner: OTHER_ACCOUNT, volume: false, container: null, extra: { additionalVolumes: [DATA] } });
    h.docker.volumes.set(DATA, {});
    signIn(OTHER_ACCOUNT, OTHER_TOKEN);
    h.ui.filesMissingAnswer = 'deleteDevspace';
    expect((await rejection(h.service.open(TARGET, options()))).code).toBe('cancelled');
    expect(await h.registry.list()).toEqual([]);
    expect((await h.registry.keptVolumes()).map((record) => [record.name, record.owner])).toEqual([[DATA, OTHER_ACCOUNT]]);
    signIn(ACCOUNT, TOKEN);
    h.helper.config = { image: BASE_IMAGE, mounts: [MOUNT] };
    expect((await rejection(h.service.open(TARGET, options()))).code).toBe('hostAccess');
  });

  it('does not refuse the name once the kept volume is gone: a new volume of that name is empty', async () => {
    await otherAccountDeletesAndKeeps();
    h.docker.volumes.delete(DATA);
    h.helper.config = { image: BASE_IMAGE, mounts: [MOUNT] };
    const result = await h.service.open(TARGET, options());
    expect(result.devspace.owner).toEqual(ACCOUNT);
  });

  it('drops the records of a kept volume that was removed outside the extension, so a new volume of that name is not refused to its account', async () => {
    await otherAccountDeletesAndKeeps();
    // docker volume prune; then a devspace of ACCOUNT creates a new volume of that name.
    h.docker.volumes.delete(DATA);
    h.helper.config = { image: BASE_IMAGE, mounts: [MOUNT] };
    const first = await h.service.open(TARGET, options());
    expect(await h.registry.keptVolumes()).toEqual([]);
    // The new volume of that name carries the labels of the devspace of ACCOUNT, which created it before `up`.
    expect(h.docker.volumes.get(DATA)).toEqual(additionalVolumeLabels(first.devspace.id, ACCOUNT));
    expect(first.devspace.additionalVolumes).toEqual([DATA]);
    // The Delete of ACCOUNT keeps it; its next devspace may use it, but only the Delete of the devspace that
    // created it removes it: the next one keeps it, with a line in the log.
    await h.service.delete(first.devspace.id, { progress: h.progress, additionalVolumesToRemove: [] });
    expect((await h.registry.keptVolumes()).map((record) => [record.name, record.owner?.id])).toEqual([[DATA, ACCOUNT.id]]);
    const result = await h.service.open(TARGET, options());
    expect(h.helper.ups.length).toBeGreaterThan(1);
    // Recorded only to protect it (an additional volume of the same owner); its labels still name the first devspace.
    expect(result.devspace.additionalVolumes).toEqual([DATA]);
    expect(h.docker.volumes.get(DATA)).toEqual(additionalVolumeLabels(first.devspace.id, ACCOUNT));
    await h.registry.updateDevspace(result.devspace.id, (entry) => {
      entry.additionalVolumes = [DATA];
    });
    await h.service.delete(result.devspace.id, { progress: h.progress, additionalVolumesToRemove: [DATA] });
    expect(h.docker.volumes.has(DATA)).toBe(true);
    expect(h.logger.infos.some((line) => line.startsWith(`The volume ${DATA} is kept, because another devspace created it`))).toBe(true);
  });

  it('records no kept volume that does not exist at the Delete', async () => {
    await seedDevspace(h, { owner: OTHER_ACCOUNT, container: null, extra: { additionalVolumes: [DATA, 'gone'] } });
    h.docker.volumes.set(DATA, {});
    signIn(OTHER_ACCOUNT, OTHER_TOKEN);
    await h.service.delete(ENV_ID, { progress: h.progress, additionalVolumesToRemove: [] });
    expect((await h.registry.keptVolumes()).map((record) => record.name)).toEqual([DATA]);
  });

  it('keeps the account of the volumes that a failed first open leaves behind', async () => {
    h.helper.config = { image: BASE_IMAGE, mounts: [MOUNT] };
    // `up` creates the volume of the mount, then fails.
    h.helper.upError = () => {
      h.docker.volumes.set(DATA, {});
      return new Error('postCreateCommand failed');
    };
    await rejection(h.service.open(TARGET, options()));
    expect(await h.registry.list()).toEqual([]);
    expect(h.docker.volumes.has(DATA)).toBe(true);
    expect((await h.registry.keptVolumes()).map((record) => [record.name, record.owner?.id])).toEqual([[DATA, ACCOUNT.id]]);
    h.helper.upError = () => undefined;
    signIn(OTHER_ACCOUNT, OTHER_TOKEN);
    const error = await rejection(h.service.open(TARGET, options()));
    expect(error.code).toBe('hostAccess');
    expect(error.message).toBe(Messages.hostAccess(`volume ${DATA} of another devspace`));
    // Its own account may use it.
    signIn(ACCOUNT, TOKEN);
    expect((await h.service.open(TARGET, options())).devspace.owner).toEqual(ACCOUNT);
  });

  it('forgets the record when a later Delete removes the volume, and never removes a volume that another account kept', async () => {
    await otherAccountDeletesAndKeeps();
    // An entry of one person from before the separation by account recorded the same volume.
    await seedDevspace(h, { id: OTHER_ID, container: null, extra: { additionalVolumes: [DATA, 'web-cache'] } });
    h.docker.volumes.set('web-cache', additionalVolumeLabels(OTHER_ID));
    await h.service.delete(OTHER_ID, { progress: h.progress, additionalVolumesToRemove: [DATA, 'web-cache'] });
    expect(h.docker.volumes.has(DATA)).toBe(true);
    expect(h.docker.volumes.has('web-cache')).toBe(false);
    // The volume that stays keeps the record of the account that kept it, and gets one of this account too; the devspaces
    // of both accounts are refused it now (each may hold data of the other).
    expect((await h.registry.keptVolumes()).map((record) => [record.name, record.owner?.id])).toEqual([
      [DATA, OTHER_ACCOUNT.id],
      [DATA, ACCOUNT.id],
    ]);
    h.helper.config = { image: BASE_IMAGE, mounts: [MOUNT] };
    expect((await rejection(h.service.open(TARGET, options()))).code).toBe('hostAccess');
    signIn(OTHER_ACCOUNT, OTHER_TOKEN);
    expect((await rejection(h.service.open(TARGET, options()))).code).toBe('hostAccess');
  });
});

describe('a lost registry: the named volumes without labels that the container of a devspace mounts', () => {
  const PGDATA = 'pgdata';
  const WORKSPACE = resourceName(REPO, OTHER_ID);

  /** The registry is lost; the volume and the container of OTHER_ACCOUNT's devspace are still there. */
  function lostRegistry(mounted: string[]): void {
    h.docker.volumes.set(WORKSPACE, { [LABEL_DEVSPACE_ID]: OTHER_ID, [LABEL_REPOSITORY]: REPO, [LABEL_OWNER_ID]: OTHER_ACCOUNT.id });
    const container = h.docker.addContainer({ devspaceId: OTHER_ID, name: WORKSPACE, state: 'stopped', image: devspaceImageName(REPO, OTHER_ID, 1) });
    h.docker.containers.set(container.id, { ...container, volumes: [WORKSPACE, ...mounted] });
  }

  it('records the unlabelled volume again, so that the devspace of another account is refused it', async () => {
    h.docker.volumes.set(PGDATA, {});
    lostRegistry([PGDATA]);
    expect(await h.service.reconcileFromVolumes()).toBe(1);
    expect((await h.registry.get(OTHER_ID))?.additionalVolumes).toEqual([PGDATA]);
    // ACCOUNT's first open of the repository mounts the volume of OTHER_ACCOUNT's devspace.
    h.helper.config = { image: BASE_IMAGE, mounts: [`source=${PGDATA},target=/var/lib/postgresql/data,type=volume`] };
    const error = await rejection(h.service.open(TARGET, options()));
    expect(error.code).toBe('hostAccess');
    expect(error.message).toBe(Messages.hostAccess(`volume ${PGDATA} of another devspace`));
    expect(h.helper.builds).toEqual([]);
    expect(h.docker.volumes.get(PGDATA)).toEqual({});
  });

  it('keeps the unlabelled volume at the Delete of the restored devspace: not offered, not removed, kept for its account', async () => {
    h.docker.volumes.set(PGDATA, {});
    lostRegistry([PGDATA]);
    expect(await h.service.reconcileFromVolumes()).toBe(1);
    signIn(OTHER_ACCOUNT, OTHER_TOKEN);
    // The one read of the removable volumes (removableVolumesOf).
    expect((await h.service.removableVolumesOf(OTHER_ID)).additional).toEqual([]);
    // Even a confirmation of the name does not remove it: its labels do not make it the devspace's own.
    await h.service.delete(OTHER_ID, { progress: h.progress, additionalVolumesToRemove: [PGDATA] });
    expect(await h.registry.get(OTHER_ID)).toBeUndefined();
    expect(h.docker.volumes.get(PGDATA)).toEqual({});
    expect((await h.registry.keptVolumes()).map((record) => [record.name, record.owner?.id])).toEqual([[PGDATA, OTHER_ACCOUNT.id]]);
  });

  it('records no anonymous volume, no volume of Docker Compose or of another devspace, and no volume that does not exist', async () => {
    const anonymous = 'ef'.repeat(32);
    h.docker.volumes.set(anonymous, { 'com.docker.volume.anonymous': '' });
    h.docker.volumes.set('shop_db', { 'com.docker.compose.project': 'shop', 'com.docker.compose.volume': 'db' });
    h.docker.volumes.set('web-cache', additionalVolumeLabels('f0000001-0000-4000-8000-000000000001', ACCOUNT));
    h.docker.volumes.set('devspaces-acme-web-f0000001', { [LABEL_DEVSPACE_ID]: 'f0000001-0000-4000-8000-000000000001', [LABEL_REPOSITORY]: 'acme/web' });
    lostRegistry([anonymous, 'shop_db', 'web-cache', 'devspaces-acme-web-f0000001', 'gone']);
    expect(await h.service.reconcileFromVolumes()).toBeGreaterThanOrEqual(1);
    expect((await h.registry.get(OTHER_ID))?.additionalVolumes).toBeUndefined();
  });
});

describe('the ID of a new devspace', () => {
  // The names hold no short ID; an ID is in use when its name pair (namePair) is the pair of an ID of the registry or
  // of a labelled volume, or when its volume or container exists.
  /** An ID other than `id` with the same name pair (found by trying IDs one by one). */
  function samePairAs(id: string, prefix = '3f2a9c1e-0000-4000-8000-'): string {
    for (let n = 0; ; n++) {
      const candidate = `${prefix}${n.toString(16).padStart(12, '0')}`;
      if (candidate !== id && namePair(candidate) === namePair(id)) return candidate;
    }
  }
  const TAKEN = samePairAs(ENV_ID);
  const FREE = '5e5e5e5e-0000-4000-8000-000000000005';

  it('uses IDs with the same name pair and one with another pair', () => {
    expect(namePair(TAKEN)).toBe(namePair(ENV_ID));
    expect(namePair(FREE)).not.toBe(namePair(ENV_ID));
  });

  it('is not one whose name pair a devspace of the registry has (its names would be shared)', async () => {
    const ids = vi.fn().mockReturnValueOnce(TAKEN).mockReturnValue(FREE);
    recreate({ newDevspaceId: ids });
    await seedDevspace(h, { repository: 'acme/web' });
    const result = await h.service.open(TARGET, options());
    expect(result.devspace.id).toBe(FREE);
    expect(ids).toHaveBeenCalledTimes(2);
  });

  it('is not one whose name pair the ID of a labelled volume on the engine has (a devspace of another computer)', async () => {
    const ids = vi.fn().mockReturnValueOnce(TAKEN).mockReturnValue(FREE);
    recreate({ newDevspaceId: ids });
    // An additional volume of a devspace that the registry does not know.
    h.docker.volumes.set('web-data', { [LABEL_DEVSPACE_ID]: ENV_ID, [LABEL_OWNER_ID]: OTHER_ACCOUNT.id });
    const result = await h.service.open(TARGET, options());
    expect(result.devspace.id).toBe(FREE);
    expect(ids).toHaveBeenCalledTimes(2);
  });

  it('never removes a volume of its name that another devspace created meanwhile', async () => {
    recreate({ newDevspaceId: () => FREE });
    const name = resourceName(REPO, FREE, 'config');
    // Another first open on the engine created the volume of the same name between the check and the create.
    vi.spyOn(h.docker, 'volumeExists').mockResolvedValue(false);
    const theirs = { [LABEL_DEVSPACE_ID]: OTHER_ID, [LABEL_REPOSITORY]: REPO, [LABEL_OWNER_ID]: OTHER_ACCOUNT.id };
    h.docker.volumes.set(name, theirs);
    h.helper.cloneError = new Error('clone failed');
    await expect(h.service.open(TARGET, options())).rejects.toBeDefined();
    expect(h.docker.volumes.get(name)).toEqual(theirs);
    // The text of workspaceVolumeOwnership.
    expect(h.logger.warnings.some((line) => line.includes(`carries the devspace ID ${OTHER_ID}, not ${FREE}`))).toBe(true);
  });

  it('is not one whose volume exists, and that volume is never touched', async () => {
    const ids = vi.fn().mockReturnValueOnce(TAKEN).mockReturnValue(FREE);
    recreate({ newDevspaceId: ids });
    const existing = resourceName(REPO, TAKEN, 'config');
    h.docker.volumes.set(existing, {});
    h.helper.cloneError = new Error('clone failed');
    await expect(h.service.open(TARGET, options())).rejects.toBeDefined();
    // The failed first open removed only what it created.
    expect(h.docker.volumes.get(existing)).toEqual({});
    expect(h.docker.log).toContain(`volume rm ${resourceName(REPO, FREE, 'config')}`);
    expect(h.docker.log).not.toContain(`volume rm ${existing}`);
  });

  it('is not one whose container exists, and that container is never touched', async () => {
    const ids = vi.fn().mockReturnValueOnce(TAKEN).mockReturnValue(FREE);
    recreate({ newDevspaceId: ids });
    const existing = resourceName(REPO, TAKEN, 'config');
    const container = h.docker.addContainer({ devspaceId: 'made-by-hand', name: existing, state: 'stopped', image: 'x' });
    const result = await h.service.open(TARGET, options());
    expect(result.devspace.id).toBe(FREE);
    expect(ids).toHaveBeenCalledTimes(2);
    expect(h.docker.containerByRef(container.id)).toBeDefined();
    expect(h.docker.log).not.toContain(`rm ${container.id}`);
  });

  it('gives up after a few IDs in use, before anything is created', async () => {
    const ids = vi.fn(() => TAKEN);
    recreate({ newDevspaceId: ids });
    await seedDevspace(h, { repository: 'acme/web' });
    await expect(h.service.open(TARGET, options())).rejects.toThrow(/No unused devspace ID was found/);
    expect(ids.mock.calls.length).toBeGreaterThan(1);
    // At most 20 attempts.
    expect(ids.mock.calls.length).toBeLessThanOrEqual(20);
    expect((await h.registry.list()).map((entry) => entry.repository)).toEqual(['acme/web']);
    expect(h.docker.log.filter((line) => line.startsWith('volume create'))).toEqual([]);
  });
});

describe('a named volume that the devspaces of one account share', () => {
  // A fork and its upstream repository both mount `${localWorkspaceFolderBasename}-node_modules`.
  const SHARED = 'web-node_modules';
  const MOUNT = `source=${SHARED},target=/workspaces/web/node_modules,type=volume`;
  const FORK = 'alice/web';
  const UPSTREAM: RepositoryTarget = { ...TARGET, repository: 'acme/web' };
  const FORK_LABELS = additionalVolumeLabels(OTHER_ID, ACCOUNT, FORK);

  /**
   * Devspace A (OTHER_ID, the fork) created and recorded SHARED; then devspace B of the same account (the upstream
   * repository) opens with the same mount. Returns B and what B recorded when `up` started.
   */
  async function openBoth(): Promise<{ b: Devspace; recordedAtUp: readonly string[] | undefined }> {
    await seedDevspace(h, { id: OTHER_ID, repository: FORK, container: null, extra: { additionalVolumes: [SHARED] } });
    h.docker.volumes.set(SHARED, { ...FORK_LABELS });
    h.helper.config = { image: BASE_IMAGE, mounts: [MOUNT] };
    let recordedAtUp: readonly string[] | undefined;
    const up = h.helper.up.bind(h.helper);
    h.helper.up = async (p) => {
      const entry = (await h.registry.list()).find((devspace) => devspace.repository === UPSTREAM.repository);
      recordedAtUp = entry?.additionalVolumes;
      return up(p);
    };
    const result = await h.service.open(UPSTREAM, options());
    return { b: result.devspace, recordedAtUp };
  }

  const kept = (reason: string) => `The volume ${SHARED} is kept, because ${reason}.`;
  const removals = () => h.docker.log.filter((line) => line === `volume rm ${SHARED}`);

  it('opens the second devspace, which records the volume before `up` and neither creates nor relabels it', async () => {
    const { b, recordedAtUp } = await openBoth();
    expect(h.helper.ups).toHaveLength(1);
    expect(recordedAtUp).toEqual([SHARED]);
    expect(b.additionalVolumes).toEqual([SHARED]);
    expect(h.docker.log.filter((line) => line === `volume create ${SHARED}`)).toEqual([]);
    expect(h.docker.volumes.get(SHARED)).toEqual(FORK_LABELS);
  });

  it('keeps the volume at the Delete of the first devspace while the second records it, and does not offer it', async () => {
    await openBoth();
    // The one read of the removable volumes (removableVolumesOf).
    expect((await h.service.removableVolumesOf(OTHER_ID)).additional).toEqual([]);
    await h.service.delete(OTHER_ID, { progress: h.progress, additionalVolumesToRemove: [SHARED] });
    expect(h.docker.volumes.get(SHARED)).toEqual(FORK_LABELS);
    expect(h.logger.infos).toContain(kept('another devspace uses it too'));
    expect(removals()).toEqual([]);
  });

  it('keeps the volume at the Delete of the second devspace: it is not its own', async () => {
    const { b } = await openBoth();
    // The one read of the removable volumes (removableVolumesOf).
    expect((await h.service.removableVolumesOf(b.id)).additional).toEqual([]);
    await h.service.delete(b.id, { progress: h.progress, additionalVolumesToRemove: [SHARED] });
    expect(h.docker.volumes.get(SHARED)).toEqual(FORK_LABELS);
    expect(h.logger.infos).toContain(kept('another devspace uses it too'));
    expect(removals()).toEqual([]);
    expect((await h.registry.get(OTHER_ID))?.additionalVolumes).toEqual([SHARED]);
  });

  it('keeps the volume at the Delete of the second devspace after the Delete of the first kept it', async () => {
    const { b } = await openBoth();
    await h.service.delete(OTHER_ID, { progress: h.progress, additionalVolumesToRemove: [SHARED] });
    // The one read of the removable volumes (removableVolumesOf).
    expect((await h.service.removableVolumesOf(b.id)).additional).toEqual([]);
    await h.service.delete(b.id, { progress: h.progress, additionalVolumesToRemove: [SHARED] });
    expect(h.docker.volumes.get(SHARED)).toEqual(FORK_LABELS);
    expect(h.logger.infos).toContain(kept('another devspace created it'));
    expect(removals()).toEqual([]);
  });

  it('refuses the volume to a devspace of another account while either devspace exists', async () => {
    await openBoth();
    signIn(OTHER_ACCOUNT, OTHER_TOKEN);
    const other: RepositoryTarget = { ...TARGET, repository: 'someone/web' };
    const first = await rejection(h.service.open(other, options()));
    expect(first.code).toBe('hostAccess');
    expect(first.message).toBe(Messages.hostAccess(`volume ${SHARED} of another devspace`));
    signIn(ACCOUNT, TOKEN);
    await h.service.delete(OTHER_ID, { progress: h.progress, additionalVolumesToRemove: [SHARED] });
    signIn(OTHER_ACCOUNT, OTHER_TOKEN);
    const second = await rejection(h.service.open(other, options()));
    expect(second.message).toBe(Messages.hostAccess(`volume ${SHARED} of another devspace`));
    expect(h.helper.ups).toHaveLength(1);
    expect(h.docker.volumes.get(SHARED)).toEqual(FORK_LABELS);
  });
});

describe('images of the devspaces of other accounts', () => {
  /** The devspace image of the devspace of OTHER_ACCOUNT (ENV_ID, REPO), and an ID of its own. */
  const THEIRS = devspaceImageName(REPO, ENV_ID, 1);
  const ID = `sha256:${'a'.repeat(64)}`;
  const WEB = 'acme/web';

  beforeEach(async () => {
    await seedDevspace(h, { owner: OTHER_ACCOUNT, container: null });
    h.docker.imageIds.set(THEIRS, ID);
  });

  async function refused(image: string, config: Record<string, unknown> = { image }, item = otherAccountImageItem(image)): Promise<void> {
    h.helper.config = config;
    const error = await rejection(h.service.open(TARGET, options()));
    expect(error.code).toBe('hostAccess');
    expect(error.message).toBe(Messages.hostAccess(item));
    expect(h.helper.builds).toEqual([]);
  }

  it('refuses the devspace image of a devspace of another account, also written with the registry of Docker Hub', async () => {
    await refused(THEIRS);
    expect((await h.registry.list()).map((entry) => entry.id)).toEqual([ENV_ID]);
    // Docker gives the same image for the name with docker.io/library/.
    h.docker.images.add(`docker.io/library/${THEIRS}`);
    h.docker.imageIds.set(`docker.io/library/${THEIRS}`, ID);
    h.docker.imageRepoNames.set(`docker.io/library/${THEIRS}`, { repoTags: [THEIRS], repoDigests: [] });
    await refused(`docker.io/library/${THEIRS}`);
  });

  it('refuses it whatever the switch says, also as a build context', async () => {
    h.settings = { ...h.settings, hostAccessChecksOff: [REPO] };
    await refused(THEIRS);
    await refused(THEIRS, { build: { dockerfile: 'Dockerfile', options: ['--build-context', `base=docker-image://${THEIRS}`] } }, otherAccountImageItem(THEIRS, 'build option --build-context image'));
  });

  it('refuses a copy of that image under another name (the same ID)', async () => {
    h.docker.images.add('mine:1');
    h.docker.imageIds.set('mine:1', ID);
    await refused('mine:1');
  });

  it('refuses an older build of that devspace that is still there, and a new one before its build record', async () => {
    for (const [build, id] of [
      [0, `sha256:${'b'.repeat(64)}`],
      [2, `sha256:${'c'.repeat(64)}`],
    ] as const) {
      const image = devspaceImageName(REPO, ENV_ID, build);
      h.docker.images.add(image);
      h.docker.imageIds.set(image, id);
      await refused(image);
    }
  });

  it('refuses an image that Docker Compose built for that devspace, also before its build record', async () => {
    const built = `${devspaceImageRepository(REPO, ENV_ID)}-db`;
    h.docker.images.add(built);
    h.docker.imageIds.set(built, `sha256:${'d'.repeat(64)}`);
    await refused(built);
  });

  it('refuses the images of a devspace that another computer created on the host, by the owner label of its volume', async () => {
    const remote = '5e6f7a8b-0000-4000-8000-000000000005';
    const image = devspaceImageName(WEB, remote, 4);
    h.docker.images.add(image);
    h.docker.imageIds.set(image, `sha256:${'f'.repeat(64)}`);
    // An additional volume of that devspace (no repository label): the open does not restore an entry from it, so
    // only the owner label of the volume names the owner.
    h.docker.volumes.set('web-data', { [LABEL_DEVSPACE_ID]: remote, [LABEL_OWNER_ID]: OTHER_ACCOUNT.id });
    await refused(image);
  });

  it('allows the images of a devspace of the same account that another computer created on the host', async () => {
    const remote = '5e6f7a8b-0000-4000-8000-000000000005';
    const image = devspaceImageName(WEB, remote, 4);
    h.docker.images.add(image);
    h.docker.imageIds.set(image, `sha256:${'f'.repeat(64)}`);
    // An additional volume of that devspace (no repository label): the open does not restore an entry from it, so
    // only the owner label of the volume names the owner.
    h.docker.volumes.set('web-data', { [LABEL_DEVSPACE_ID]: remote, [LABEL_OWNER_ID]: ACCOUNT.id });
    // The name of the image does not hold the ID (it holds the repository, which that volume does not name); the label
    // nimblescape.devspaces.id that the extension gives its images links it.
    h.docker.imageConfigs.set(image, { Labels: { [LABEL_DEVSPACE_ID]: remote } });
    h.helper.config = { image };
    await h.service.open(TARGET, options());
    expect(h.helper.builds).toHaveLength(1);
  });

  it('refuses an image labelled with the ID of a devspace of another account, also under an unrelated name', async () => {
    h.docker.images.add('tools:1');
    h.docker.imageIds.set('tools:1', `sha256:${'1'.repeat(64)}`);
    h.docker.imageRepoNames.set('tools:1', { repoTags: ['tools:1', 'devspaces-copy:1'], repoDigests: [] });
    // The devspace ENV_ID of OTHER_ACCOUNT (registry); the image is listed under a devspaces- name of no devspace.
    h.docker.imageConfigs.set('tools:1', { Labels: { [LABEL_DEVSPACE_ID]: ENV_ID } });
    h.docker.images.add('devspaces-copy:1');
    h.docker.imageIds.set('devspaces-copy:1', `sha256:${'1'.repeat(64)}`);
    h.docker.imageConfigs.set('devspaces-copy:1', { Labels: { [LABEL_DEVSPACE_ID]: ENV_ID } });
    await refused('tools:1');
  });

  it('allows an image labelled with the ID of a devspace of the account', async () => {
    await seedDevspace(h, { id: OTHER_ID, repository: WEB, container: null, volume: false, image: false });
    h.docker.images.add('tools:1');
    h.docker.imageIds.set('tools:1', `sha256:${'1'.repeat(64)}`);
    h.docker.imageRepoNames.set('tools:1', { repoTags: ['tools:1', 'devspaces-copy:1'], repoDigests: [] });
    h.docker.imageConfigs.set('tools:1', { Labels: { [LABEL_DEVSPACE_ID]: OTHER_ID } });
    h.docker.images.add('devspaces-copy:1');
    h.docker.imageIds.set('devspaces-copy:1', `sha256:${'1'.repeat(64)}`);
    h.docker.imageConfigs.set('devspaces-copy:1', { Labels: { [LABEL_DEVSPACE_ID]: OTHER_ID } });
    h.helper.config = { image: 'tools:1' };
    await h.service.open(TARGET, options());
    expect(h.helper.builds).toHaveLength(1);
  });

  it('refuses an image of a devspace of no known owner (left behind by a Delete, or of another computer without a volume)', async () => {
    const gone = '9a8b7c6d-0000-4000-8000-000000000009';
    const image = devspaceImageName(WEB, gone, 2);
    h.docker.images.add(image);
    h.docker.imageIds.set(image, `sha256:${'9'.repeat(64)}`);
    await refused(image);
  });

  it('allows the image of a devspace of the same account', async () => {
    await seedDevspace(h, { id: OTHER_ID, repository: WEB, container: null, volume: false });
    h.helper.config = { image: devspaceImageName(WEB, OTHER_ID, 1) };
    await h.service.open(TARGET, options());
    expect(h.helper.builds).toHaveLength(1);
  });

  it('allows an image with the ID of an image of the same account: the same configuration builds the same image', async () => {
    await seedDevspace(h, { id: OTHER_ID, repository: WEB, container: null, volume: false });
    h.docker.imageIds.set(devspaceImageName(WEB, OTHER_ID, 1), ID);
    h.helper.config = { image: THEIRS };
    await h.service.open(TARGET, options());
    expect(h.helper.builds).toHaveLength(1);
  });

  it('allows a name like devspaces-… that is no image of a devspace', async () => {
    h.docker.images.add('devspaces-tools:1');
    h.helper.config = { image: 'devspaces-tools:1' };
    await h.service.open(TARGET, options());
    expect(h.helper.builds).toHaveLength(1);
  });

  it('fails the check, and refuses nothing as another account\'s, when Docker cannot list the images of the devspaces', async () => {
    h.docker.listDevspaceImages = async () => {
      throw new Error('Cannot connect to the Docker daemon');
    };
    h.helper.config = { image: THEIRS };
    const error = await rejection(h.service.open(TARGET, options()));
    expect(error.message).toBe(Messages.configurationCheckDocker(dockerCheckItem('the images of the devspaces on the Docker host could not be read')));
    expect(h.helper.builds).toEqual([]);
  });

  it('fails the check when Docker cannot read the labels of the images of the devspaces', async () => {
    // The labels decide whose image it is: without them the check fails, never by name only.
    h.docker.imageLabelsOf = async () => {
      throw new Error('Cannot connect to the Docker daemon');
    };
    h.helper.config = { image: THEIRS };
    const error = await rejection(h.service.open(TARGET, options()));
    expect(error.message).toBe(Messages.configurationCheckDocker(dockerCheckItem('the images of the devspaces on the Docker host could not be read')));
    expect(h.helper.builds).toEqual([]);
  });

  it('fails the check when Docker cannot list the volumes that name the owner of an image', async () => {
    const gone = '9a8b7c6d-0000-4000-8000-000000000009';
    h.docker.images.add(devspaceImageName(WEB, gone, 2));
    h.docker.imageIds.set(devspaceImageName(WEB, gone, 2), ID);
    // Only the list right after the list of the images fails (the open lists the volumes for other reasons too).
    const listDevspaceImages = h.docker.listDevspaceImages.bind(h.docker);
    const listDevspaceVolumes = h.docker.listDevspaceVolumes.bind(h.docker);
    let failVolumes = false;
    h.docker.listDevspaceImages = async () => {
      failVolumes = true;
      return listDevspaceImages();
    };
    h.docker.listDevspaceVolumes = async () => {
      if (!failVolumes) return listDevspaceVolumes();
      failVolumes = false;
      throw new Error('Cannot connect to the Docker daemon');
    };
    h.helper.config = { image: THEIRS };
    const error = await rejection(h.service.open(TARGET, options()));
    expect(error.message).toBe(Messages.configurationCheckDocker(dockerCheckItem('the owners of the images of the devspaces on the Docker host could not be read')));
  });

  it('keeps a definitive refusal of another kind when Docker cannot list the images of the devspaces', async () => {
    h.docker.listDevspaceImages = async () => {
      throw new Error('Cannot connect to the Docker daemon');
    };
    h.docker.images.add('cafe');
    h.docker.imageRepoNames.set('cafe', { repoTags: [], repoDigests: [] });
    h.helper.config = { image: 'cafe' };
    const error = await rejection(h.service.open(TARGET, options()));
    expect(error.message).toBe(Messages.unsupportedOptions('image cafe (an image ID; name the image)'));
  });

  it('passes a cancellation during the list of the images of the devspaces on as a cancellation', async () => {
    const controller = new AbortController();
    h.docker.listDevspaceImages = async () => {
      controller.abort();
      throw new Error('aborted');
    };
    h.helper.config = { image: THEIRS };
    const error = await rejection(h.service.open(TARGET, { ...options(), signal: controller.signal }));
    expect(error.code).toBe('cancelled');
    // Passed on as a cancellation, not read as a failure of Docker.
    expect(h.logger.warnings.filter((line) => line.includes('could not be read'))).toEqual([]);
  });

  it('passes a cancellation during the list of the volumes that name the owners on as a cancellation', async () => {
    const gone = '9a8b7c6d-0000-4000-8000-000000000009';
    h.docker.images.add(devspaceImageName(WEB, gone, 2));
    h.docker.imageIds.set(devspaceImageName(WEB, gone, 2), ID);
    const controller = new AbortController();
    const listDevspaceVolumes = h.docker.listDevspaceVolumes.bind(h.docker);
    h.docker.listDevspaceVolumes = async () => {
      if (!new Error().stack?.includes('hostDevspaceImageIds')) return listDevspaceVolumes();
      controller.abort();
      throw new Error('aborted');
    };
    h.helper.config = { image: THEIRS };
    const error = await rejection(h.service.open(TARGET, { ...options(), signal: controller.signal }));
    expect(error.code).toBe('cancelled');
    expect(h.logger.warnings.filter((line) => line.includes('could not be read'))).toEqual([]);
  });

  it('refuses the name of an image of a devspace of another account or of no known owner that is not there yet', async () => {
    // The next build of the devspace of the other account: no registry has the name; only that build could make it.
    await refused(devspaceImageName(REPO, ENV_ID, 2));
    await refused(`${devspaceImageRepository(REPO, ENV_ID)}-db`);
    await refused(devspaceImageName(WEB, '9a8b7c6d-0000-4000-8000-000000000009', 1));
  });

  it('fails the check, not refuses by the name, when Docker could not inspect a reference', async () => {
    // By its ID the image would be allowed: a devspace of the account has the same image.
    await seedDevspace(h, { id: OTHER_ID, repository: WEB, container: null, volume: false });
    h.docker.imageIds.set(devspaceImageName(WEB, OTHER_ID, 1), ID);
    h.docker.transientImages = new Set([THEIRS]);
    h.helper.config = { image: THEIRS };
    const error = await rejection(h.service.open(TARGET, options()));
    expect(error.message).toBe(Messages.configurationCheckDocker(dockerCheckItem(THEIRS)));
    // Docker, which could not answer, is not asked for the images of the devspaces either.
    expect(h.docker.devspaceImageLists).toBe(0);
  });

  it('does not refuse the name of an image of a devspace of the same account that is not there', async () => {
    await seedDevspace(h, { id: OTHER_ID, repository: WEB, container: null, volume: false, image: false });
    h.helper.config = { image: devspaceImageName(WEB, OTHER_ID, 5) };
    const error = await h.service.open(TARGET, options()).then(
      () => undefined,
      (caught: unknown) => caught as UserFacingError,
    );
    expect(error?.code).not.toBe('hostAccess');
  });

  it('lists the images of the devspaces only when a reference names a local image or a missing devspace image, once per check', async () => {
    h.helper.config = { image: 'missing:1' };
    await h.service.open(TARGET, options()).catch(() => undefined);
    expect(h.docker.devspaceImageLists).toBe(0);
    h.docker.images.add(BASE_IMAGE);
    h.helper.config = { image: BASE_IMAGE };
    const inspections = h.docker.imageInspections.length;
    await h.service.open(TARGET, options());
    // One list for each `docker image inspect` of the references that found a local image.
    expect(h.docker.devspaceImageLists).toBe(h.docker.imageInspections.length - inspections);
    expect(h.docker.devspaceImageLists).toBeGreaterThan(0);
    expect(h.docker.imageInspections.every((references) => !references.includes(THEIRS))).toBe(true);
    // A missing name of a devspace image is decided with the list too.
    const lists = h.docker.devspaceImageLists;
    h.helper.config = { image: devspaceImageName(REPO, ENV_ID, 9) };
    await rejection(h.service.open(TARGET, options()));
    expect(h.docker.devspaceImageLists).toBe(lists + 1);
  });

  it('lists the volumes only for a short ID that the registry does not know, of a found image or of a missing devspace image', async () => {
    // The open lists the volumes for other reasons too: only the lists of the check of the images count.
    let ownerLists = 0;
    const listDevspaceVolumes = h.docker.listDevspaceVolumes.bind(h.docker);
    h.docker.listDevspaceVolumes = async () => {
      if (new Error().stack?.includes('hostDevspaceImageIds')) ownerLists++;
      return listDevspaceVolumes();
    };
    // The registry knows the owner of THEIRS: no volume list.
    h.helper.config = { image: THEIRS };
    await rejection(h.service.open(TARGET, options()));
    expect(ownerLists).toBe(0);
    // An image left behind by a Delete that no reference names: no volume list either.
    const gone = '9a8b7c6d-0000-4000-8000-000000000009';
    h.docker.images.add(devspaceImageName(WEB, gone, 2));
    h.docker.imageIds.set(devspaceImageName(WEB, gone, 2), `sha256:${'9'.repeat(64)}`);
    h.docker.images.add(BASE_IMAGE);
    h.helper.config = { image: BASE_IMAGE };
    await h.service.open(TARGET, options());
    expect(ownerLists).toBe(0);
    // A reference that names it: one list.
    h.helper.config = { image: devspaceImageName(WEB, gone, 2) };
    await rejection(h.service.open(TARGET, options()));
    expect(ownerLists).toBe(1);
    // A missing name of a devspace image of no known owner: one list.
    h.helper.config = { image: devspaceImageName(WEB, '1b2c3d4e-0000-4000-8000-000000000011', 1) };
    await rejection(h.service.open(TARGET, options()));
    expect(ownerLists).toBe(2);
    // A missing name of the devspace of the other account, which the registry knows: none.
    h.helper.config = { image: devspaceImageName(REPO, ENV_ID, 9) };
    await rejection(h.service.open(TARGET, options()));
    expect(ownerLists).toBe(2);
  });

  it('does not take the owner of a devspace on another Docker host for the owner of an image here', async () => {
    const remote = '5e6f7a8b-0000-4000-8000-000000000005';
    // A devspace of this account with that ID on another host; here, its image has no known owner.
    await seedDevspace(h, { id: remote, repository: WEB, container: null, volume: false, image: false, extra: { dockerHost: 'ssh://build-box' } });
    const image = devspaceImageName(WEB, remote, 4);
    h.docker.images.add(image);
    h.docker.imageIds.set(image, `sha256:${'f'.repeat(64)}`);
    await refused(image);
  });

  it('counts an image as another account\'s when the volumes of its devspace carry different owners', async () => {
    const remote = '5e6f7a8b-0000-4000-8000-000000000005';
    const image = devspaceImageName(WEB, remote, 4);
    h.docker.images.add(image);
    h.docker.imageIds.set(image, `sha256:${'f'.repeat(64)}`);
    h.docker.volumes.set('web-data', { [LABEL_DEVSPACE_ID]: remote, [LABEL_OWNER_ID]: ACCOUNT.id });
    h.docker.volumes.set('web-cache', { [LABEL_DEVSPACE_ID]: remote, [LABEL_OWNER_ID]: OTHER_ACCOUNT.id });
    await refused(image);
  });

  // The registry names the owner of a name; the labels of a volume (which anyone who can use the engine can write)
  // never override it. A volume labelled with the ID and the repository of a devspace of the account, but with
  // another owner, leaves its image the account's own.
  it('keeps the owner of a name from the registry over the owner label of a volume', async () => {
    const remote = '5e6f7a8b-0000-4000-8000-000000000005';
    await seedDevspace(h, { id: OTHER_ID, repository: WEB, container: null, volume: false });
    const own = devspaceImageName(WEB, OTHER_ID, 1);
    // A second reference names the image of a devspace that the registry does not know (of this account by its
    // volume), so the check reads the owners of the volumes.
    const copy = devspaceImageName(WEB, remote, 1);
    h.docker.images.add(copy);
    h.docker.imageIds.set(copy, `sha256:${'e'.repeat(64)}`);
    h.docker.volumes.set('web-remote', { [LABEL_DEVSPACE_ID]: remote, [LABEL_REPOSITORY]: WEB, [LABEL_OWNER_ID]: ACCOUNT.id });
    // A volume of another name with the ID and the repository of the devspace of the account, and another owner.
    h.docker.volumes.set('web-forged', { [LABEL_DEVSPACE_ID]: OTHER_ID, [LABEL_REPOSITORY]: WEB, [LABEL_OWNER_ID]: OTHER_ACCOUNT.id });
    let ownerLists = 0;
    const listDevspaceVolumes = h.docker.listDevspaceVolumes.bind(h.docker);
    h.docker.listDevspaceVolumes = async () => {
      if (new Error().stack?.includes('hostDevspaceImageIds')) ownerLists++;
      return listDevspaceVolumes();
    };
    h.helper.config = { image: own, build: { options: ['--build-context', `copy=docker-image://${copy}`] } };
    await h.service.open(TARGET, options());
    expect(ownerLists).toBeGreaterThan(0);
    expect(h.helper.builds).toHaveLength(1);
  });
});
