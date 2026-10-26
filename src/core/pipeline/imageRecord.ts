// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The labels of a devspace image: the devspace ID, its repository and owner, and the build record of the image,
// so that another computer (or this one after a lost registry) takes the record over from the newest image of the
// devspace. Pure functions, no I/O.
import {
  LABEL_BUILD_RECORD,
  LABEL_DEVSPACE_ID,
  LABEL_OWNER_ID,
  LABEL_PREPARED,
  LABEL_REPOSITORY,
  composeProjectName,
  isConfigPathLabelValue,
} from '../names';
import { isBuildRecord } from '../storage/registry';
import type { BuildRecord, Devspace, RefusedUpdate } from '../types';
import { hasOnlyKeys, isRecord } from '../valueChecks';

/**
 * The largest build record (as JSON) that the label takes; a larger one is written as an empty label (the next computer
 * builds). 8 KiB, so that the labels on the command line of `docker build` stay far below the 32,767 characters of a
 * command line on Windows.
 */
export const MAX_RECORD_LABEL_LENGTH = 8 * 1024;

/**
 * The labels that DevspaceDocker.labelImage gives the devspace image of `env` with the build record `record`
 * (without its pinned image ID, which the labels change). The label of the record is always set, empty when the record
 * is longer than MAX_RECORD_LABEL_LENGTH, so that no such label of the base image or of the Dockerfile stays on the
 * image.
 */
export function imageRecordLabels(env: Pick<Devspace, 'id' | 'repository' | 'owner'>, record: BuildRecord): Record<string, string> {
  const { imageId: _pinned, ...stored } = record;
  const json = JSON.stringify(stored);
  return {
    [LABEL_DEVSPACE_ID]: env.id,
    [LABEL_REPOSITORY]: env.repository,
    [LABEL_OWNER_ID]: env.owner.id,
    [LABEL_BUILD_RECORD]: json.length <= MAX_RECORD_LABEL_LENGTH ? json : '',
  };
}

/**
 * The build record in the labels `labels` of the image `tag` (build number `buildNumber`) of `env`, or `undefined`
 * when they do not fit: the devspace ID, the repository, and the owner must be those of `env`; the record must be
 * valid (isBuildRecord), name exactly `tag` and `buildNumber`, have a configuration path of a repository, and name only
 * images of the Compose project of `env`. The pinned image ID is never taken from the labels.
 */
export function imageBuildRecord(
  labels: Readonly<Record<string, string>>,
  env: Pick<Devspace, 'id' | 'repository' | 'owner'>,
  tag: string,
  buildNumber: number,
): BuildRecord | undefined {
  if (labels[LABEL_DEVSPACE_ID] !== env.id || labels[LABEL_REPOSITORY] !== env.repository || labels[LABEL_OWNER_ID] !== env.owner.id) return undefined;
  const text = labels[LABEL_BUILD_RECORD];
  if (text === undefined || text.length > MAX_RECORD_LABEL_LENGTH) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isBuildRecord(value) || !buildRecordFits(value, env, tag, buildNumber)) return undefined;
  const { imageId: _ignored, ...record } = value;
  return record;
}

/**
 * The checks of imageBuildRecord on a valid build record (isBuildRecord): it names exactly `tag` and `buildNumber`, has a
 * configuration path of a repository, and names only images of the Compose project of `env`. Also for the build record
 * of a `record build` request of the worker (src/core/worker/openRequests.ts).
 */
export function buildRecordFits(record: BuildRecord, env: Pick<Devspace, 'id' | 'repository'>, tag: string, buildNumber: number): boolean {
  if (record.devspaceImage !== tag || record.buildNumber !== buildNumber || !isConfigPathLabelValue(record.configPath)) return false;
  if (record.compose !== undefined) {
    const prefix = `${composeProjectName(env.repository, env.id)}-`;
    const compose = record.compose as unknown;
    if (typeof compose !== 'object' || compose === null) return false;
    const images = (compose as { images?: unknown }).images;
    if (!Array.isArray(images) || !images.every((image) => typeof image === 'string' && image.startsWith(prefix))) return false;
  }
  return true;
}

/**
 * What identifies the update that a prepared devspace image was built for, as the open computes it for its own
 * update (updateKey): the configuration path and hash, and the digests of the images and Features. A prepare runs with
 * the host access checks on only, so its key never has `off`.
 */
export type PrepareKey = Omit<RefusedUpdate, 'items' | 'reason'>;

/** The value of LABEL_PREPARED (as JSON): the prepare key and the ID of the helper image that built the image. */
export interface PreparedImageLabel {
  key: PrepareKey;
  helperImage: string;
}

/**
 * The labels of a prepared devspace image of `env` (preparedImageName): those of the devspace (its ID, repository,
 * and owner) and LABEL_PREPARED. The background prepare gives them; the open checks them (preparedImageMismatch).
 */
export function preparedImageLabels(env: Pick<Devspace, 'id' | 'repository' | 'owner'>, label: PreparedImageLabel): Record<string, string> {
  return {
    [LABEL_DEVSPACE_ID]: env.id,
    [LABEL_REPOSITORY]: env.repository,
    [LABEL_OWNER_ID]: env.owner.id,
    [LABEL_PREPARED]: JSON.stringify(label),
  };
}

/**
 * Why the open does not use the prepared image with the labels `labels` for its update of `env` with the key `key`
 * (updateKey), built by the helper image `helperImage` (the ID of the open's own); `undefined` when it fits: the
 * devspace ID, the repository, and the owner are those of `env`, and LABEL_PREPARED (a valid PreparedImageLabel)
 * names the same key (sameUpdateKey) and the same helper image ID. A key with the host access checks off, the open's or
 * the label's, never fits. The labels come from the engine and prove nothing about the content of the image: the open
 * checks the image as any new devspace image before `up` (checkImageHostAccess).
 */
export function preparedImageMismatch(
  labels: Readonly<Record<string, string>>,
  env: Pick<Devspace, 'id' | 'repository' | 'owner'>,
  key: PrepareKey,
  helperImage: string | undefined,
): string | undefined {
  if (labels[LABEL_DEVSPACE_ID] !== env.id || labels[LABEL_REPOSITORY] !== env.repository || labels[LABEL_OWNER_ID] !== env.owner.id) {
    return 'its labels name another devspace';
  }
  const label = preparedImageLabel(labels[LABEL_PREPARED]);
  if (label === undefined) return 'it has no valid prepare label';
  if (key.hostAccessChecks !== undefined || label.key.hostAccessChecks !== undefined) return 'the host access checks are off';
  if (!sameUpdateKey(label.key, key)) return 'it was prepared for another configuration or other images';
  if (helperImage === undefined || label.helperImage.toLowerCase() !== helperImage.toLowerCase()) return 'another helper image prepared it';
  return undefined;
}

/**
 * True when `a` and `b` identify the same update: the same configuration, the same digests (ignoring the case), and the
 * same state of the host access checks (absent: on). The key of a refused update (isRefusedUpdate in pipelineRules.ts)
 * and the prepare key of a prepared devspace image (preparedImageMismatch). Here, not in pipelineRules.ts, because
 * the extension's bundle takes this module (buildRecordFits) and not that one.
 */
export function sameUpdateKey(a: PrepareKey, b: PrepareKey): boolean {
  return (
    (a.hostAccessChecks ?? 'on') === (b.hostAccessChecks ?? 'on') &&
    a.configPath === b.configPath &&
    a.configHash === b.configHash &&
    sameDigests(a.images, b.images) &&
    sameDigests(a.features, b.features)
  );
}

function sameDigests(a: Record<string, string>, b: Record<string, string>): boolean {
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((key) => Object.prototype.hasOwnProperty.call(b, key) && b[key].toLowerCase() === a[key].toLowerCase());
}

/** The PreparedImageLabel of the label text `text`; `undefined` when it is missing, too long, or not of that shape. */
function preparedImageLabel(text: string | undefined): PreparedImageLabel | undefined {
  if (text === undefined || text === '' || text.length > MAX_RECORD_LABEL_LENGTH) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(value) || !hasOnlyKeys(value, ['key', 'helperImage']) || typeof value.helperImage !== 'string' || value.helperImage === '') return undefined;
  const key = value.key;
  if (!isRecord(key) || !hasOnlyKeys(key, ['configPath', 'configHash', 'images', 'features'], ['hostAccessChecks'])) return undefined;
  if (typeof key.configPath !== 'string' || typeof key.configHash !== 'string' || !isDigestMap(key.images) || !isDigestMap(key.features)) return undefined;
  if (key.hostAccessChecks !== undefined && key.hostAccessChecks !== 'off') return undefined;
  return {
    key: {
      configPath: key.configPath,
      configHash: key.configHash,
      images: key.images,
      features: key.features,
      ...(key.hostAccessChecks === 'off' ? { hostAccessChecks: 'off' as const } : {}),
    },
    helperImage: value.helperImage,
  };
}

function isDigestMap(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((digest) => typeof digest === 'string');
}
