// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Image references of a configuration: an image of the devspaces of another account, an image ID in place of a name,
// references that Docker's grammar does not accept, and the labels of an image by which Devspaces, the Dev Container
// CLI, and Docker Compose find containers. The pipeline asks Docker about the references (imageReferencesToInspect,
// inspectedImageItems, otherAccountImageItems). Pure functions, no I/O.
import { MAX_REFERENCE_LENGTH } from '../imageCheck/dockerfile';
import { isDockerHub, parseImageReference } from '../imageCheck/reference';
import { LABEL_BUILD_RECORD, LABEL_DEVSPACE_ID, LABEL_OWNER_ID, LABEL_PREPARED, LABEL_REPOSITORY, RESOURCE_NAME_PREFIX, isDevspaceResourceName, resourceName } from '../names';
import type { HostAccessFinding } from './report';
import { isReservedLabel } from './rules';

/** An image reference of a configuration, and how an item names it (for example `FROM image`). */
export interface NamedImageReference {
  reference: string;
  what: string;
}

/**
 * An image ID in place of a name by its form alone: `sha256:<hex>`, or 64 hexadecimal characters. A shorter prefix of an
 * ID looks like a name (for example `a1b2c3d4`, which may also be the name of an image): the pipeline asks Docker which
 * image such a reference names (resolvedByImageId).
 */
const IMAGE_ID = /^(sha256:[0-9a-f]{1,64}|[0-9a-f]{64})$/i;

/**
 * The repository of an image reference as Docker names it locally: Docker Hub's names without the registry and
 * without `library/` (`docker.io/library/devspaces-1:2`, `index.docker.io/devspaces-1`, and `devspaces-1` all give `devspaces-1`),
 * others with the registry. Lower case.
 */
export function localImageRepository(reference: string): string {
  const text = reference.trim();
  const parsed = parseImageReference(text);
  if (parsed) return isDockerHub(parsed.registry) ? parsed.repository.replace(/^library\//, '') : `${parsed.registry}/${parsed.repository}`;
  // A reference that Docker would not accept either: read as it is written.
  return text
    .toLowerCase()
    .replace(/[@].*$/, '')
    .replace(/:[^/]*$/, '')
    .replace(/^(docker\.io|index\.docker\.io|registry-1\.docker\.io)\//, '')
    .replace(/^library\//, '');
}

/** A reference in an item, cut after 64 characters. */
function shortReference(reference: string): string {
  return reference.length > 64 ? `${reference.slice(0, 64)}…` : reference;
}

/** The finding of a reference longer than MAX_REFERENCE_LENGTH. */
function tooLongFinding(reference: string, what: string): HostAccessFinding {
  return { item: `${what} ${shortReference(reference.trim())} (the image reference is too long)`, class: 'unsupported' };
}

/**
 * An image reference that a configuration may not use by its form alone, with its class: an image ID in place of a name
 * (it can name any local image, also one of another account): `unsupported`; a reference longer than
 * MAX_REFERENCE_LENGTH: `unsupported`. `undefined` for any other reference. `what` names it in the item. Whether a name
 * refers to an image of the devspaces of another account is decided by the ID of the local image that it names, not
 * by its name (otherAccountImageItems): a name like `devspaces-…` of a local image whose ID is not another account's is
 * allowed; only a name of a devspace image that Docker found missing is decided by the name
 * (isOtherDevspaceImageName).
 */
export function imageReferenceFinding(reference: string, what = 'image'): HostAccessFinding | undefined {
  const text = reference.trim();
  if (text.length > MAX_REFERENCE_LENGTH) return tooLongFinding(text, what);
  if (IMAGE_ID.test(text)) return { item: imageIdItem(text, what), class: 'unsupported' };
  return undefined;
}

/**
 * Whether Docker took `reference` for the ID (or a prefix of the ID) of the image that it inspected, not for its name:
 * neither the tags nor the digests of the image (`RepoTags`, `RepoDigests` of `docker image inspect`) name it. Compared
 * normalized (parseImageReference: `postgres` is `docker.io/library/postgres:latest`); a reference with a digest by its
 * digest. `false` for a reference that is no image name (it cannot be compared).
 */
export function resolvedByImageId(reference: string, repoTags: readonly string[], repoDigests: readonly string[]): boolean {
  const parsed = parseImageReference(reference);
  if (!parsed) return false;
  const repository = `${parsed.registry}/${parsed.repository}`;
  const matches = (other: string, byDigest: boolean): boolean => {
    const name = parseImageReference(other);
    if (!name || `${name.registry}/${name.repository}` !== repository) return false;
    return byDigest ? name.digest === parsed.digest : name.tag === parsed.tag;
  };
  return parsed.digest !== undefined ? !repoDigests.some((other) => matches(other, true)) : !repoTags.some((other) => matches(other, false));
}

/**
 * Of `references` (distinct), those that Docker resolves by the ID of an image, from the images that one
 * `docker image inspect` of all of them found (`found`, each with its ID, tags, and digests), as Docker resolves a
 * reference: by its name first (a tag, or a digest of the repository: resolvedByImageId is false for a found image),
 * else by the ID: a prefix of the hexadecimal ID (also with `sha256:`), or a digest that is the ID. A reference that
 * resolves to no found image is missing.
 */
export function imageIdResolvedReferences(
  references: readonly string[],
  found: ReadonlyArray<{ id: string; repoTags: readonly string[]; repoDigests: readonly string[] }>,
): string[] {
  const result: string[] = [];
  for (const reference of references) {
    if (found.some((image) => !resolvedByImageId(reference, image.repoTags, image.repoDigests))) continue;
    const text = reference.trim().toLowerCase();
    const hex = /^(sha256:)?([0-9a-f]+)$/.exec(text)?.[2];
    const digest = /@(sha256:[0-9a-f]{64})$/.exec(text)?.[1];
    const byId = found.some((image) => {
      const id = image.id.toLowerCase();
      return (hex !== undefined && id.startsWith(`sha256:${hex}`)) || (digest !== undefined && id === digest);
    });
    if (byId) result.push(reference);
  }
  return result;
}

/** The item of an image reference that Docker resolved by the ID of the image (resolvedByImageId): not supported. */
export function imageIdItem(reference: string, what = 'image'): string {
  return `${what} ${reference.trim()} (an image ID; name the image)`;
}

/**
 * The item of an image reference that Docker could not inspect (for another reason than a missing image, for example
 * "invalid reference format"): it cannot be told apart from an image ID, so it is not supported.
 */
export function imageUncheckedItem(reference: string, what = 'image'): string {
  return `${what} ${reference.trim()} (the image reference could not be checked)`;
}

/**
 * Whether `reference` follows Docker's reference grammar (github.com/distribution/reference, as parseImageReference
 * reads it: lowercase path components, the separators `.`, `_`, `__`, and `-`, a tag of at most 128 characters, a
 * digest), written without surrounding whitespace. Conservative: a reference that the grammar rejects is never
 * accepted, whatever Docker would make of it. Also the rules of go-digest for the digest (isValidDigest), and the bound
 * of 255 characters on the normalized name (normalizedImageName), as Docker checks them.
 */
export function isValidImageReference(reference: string): boolean {
  if (reference !== reference.trim() || parseImageReference(reference) === undefined) return false;
  // What Docker checks beyond the grammar of parseImageReference (which other callers use).
  const at = reference.indexOf('@');
  if (at >= 0 && !isValidDigest(reference.slice(at + 1))) return false;
  let name = at >= 0 ? reference.slice(0, at) : reference;
  const colon = name.lastIndexOf(':');
  if (colon > name.lastIndexOf('/')) name = name.slice(0, colon);
  return normalizedImageName(name).length <= IMAGE_NAME_MAX_LENGTH;
}

/** The most characters of the normalized name of an image (distribution/reference). */
const IMAGE_NAME_MAX_LENGTH = 255;

/**
 * The digest algorithms that Docker accepts (go-digest, with the lengths of their lowercase hex encodings): any other
 * algorithm, length, or uppercase hex is refused ("unsupported digest algorithm", "invalid checksum digest length",
 * "invalid checksum digest format").
 */
const DIGEST_HEX_LENGTHS: ReadonlyMap<string, number> = new Map([
  ['sha256', 64],
  ['sha384', 96],
  ['sha512', 128],
]);

function isValidDigest(digest: string): boolean {
  const colon = digest.indexOf(':');
  const length = colon > 0 ? DIGEST_HEX_LENGTHS.get(digest.slice(0, colon)) : undefined;
  const hex = digest.slice(colon + 1);
  return length !== undefined && hex.length === length && /^[0-9a-f]+$/.test(hex);
}

/**
 * The name of an image reference (without tag and digest) as Docker normalizes it before it checks its length
 * (distribution/reference ParseNormalizedNamed): a name without a registry, or on `docker.io` or `index.docker.io`,
 * becomes `docker.io/<path>`, with `library/` before a path of one component.
 */
function normalizedImageName(name: string): string {
  const slash = name.indexOf('/');
  let domain: string | undefined;
  let path = name;
  if (slash > 0) {
    const first = name.slice(0, slash);
    if (/[.:]/.test(first) || first === 'localhost' || first !== first.toLowerCase()) {
      domain = first;
      path = name.slice(slash + 1);
    }
  }
  if (domain !== undefined && domain !== 'docker.io' && domain !== 'index.docker.io') return `${domain}/${path}`;
  return `docker.io/${path.includes('/') ? path : `library/${path}`}`;
}

/** The item of an image reference that is not valid in Docker's grammar: not supported. */
export function imageInvalidReferenceItem(reference: string, what = 'image'): string {
  return `${what} ${reference.trim()} (not a valid image reference)`;
}

/**
 * The labels of an image that a container created from it would carry, and that Devspaces, the Dev Container CLI, and
 * Docker Compose use to find and set up containers: the labels of the extension (EXTENSION_LABEL_KEYS),
 * `devcontainer.…`, and `com.docker.compose.…`, except `devcontainer.metadata`, the only label that the Dev Container
 * CLI puts on the images that it builds (CLI 0.89.0: `var EI="devcontainer.metadata"`; `devcontainer.local_folder` and
 * `devcontainer.config_file` are labels of containers). For example `LABEL nimblescape.devspaces.compose-service=x` in a
 * Dockerfile would hide the container from the lookups of the extension. Refused whatever the switch says
 * (HostAccessClass `protected`). The labels of the extension are all those with LABEL_PREFIX (isReservedLabel); labels
 * with the prefix `devspace.` are allowed: other tools use it on their images, and the extension never reads them. The
 * labels of Docker Compose (`com.docker.compose.…`) are not refused: Compose puts them on each image that it builds (an
 * image built for another project inherits them through FROM), and it sets its own on the containers that it creates;
 * the override configuration of a single container sets them empty (COMPOSE_CLEARED_LABELS), so that such an image does
 * not make `docker compose -p <project> down` remove the dev container. `own`: the devspace whose image it is; its
 * own labels are allowed (isOwnImageLabel).
 */
export function imageLabelItems(
  image: string,
  labels: Readonly<Record<string, string>>,
  own?: OwnImageLabels,
): string[] {
  return Object.entries(labels)
    .map(([key, value]) => [key.trim(), value] as const)
    .filter(([key, value]) => key !== 'devcontainer.metadata' && isReservedLabel(key) && !isOwnImageLabel(key, value, own))
    .map(([key]) => `label ${key} of the image ${image}`);
}

/** The devspace whose own image labels imageLabelItems allows. */
export interface OwnImageLabels {
  id: string;
  repository: string;
  ownerId: string;
  /**
   * The checked image is the devspace image, which the extension labels with its build record after each build; on
   * any other image the label of the build record is refused.
   */
  devspaceImage?: boolean;
}

/**
 * The labels that the extension gives the images of the devspace `own` (imageRecordLabels of the devspace image,
 * and nimblescape.devspaces.id of the images that Compose builds for it), with the values of `own`; the
 * build record with any value, only on the devspace image (the extension writes it after each build); the label of a
 * prepared image (LABEL_PREPARED) only empty, only on the devspace image. A container created from such an image
 * carries the same ID, repository, and owner as the devspace.
 */
function isOwnImageLabel(key: string, value: string, own: OwnImageLabels | undefined): boolean {
  if (own === undefined) return false;
  switch (key) {
    case LABEL_DEVSPACE_ID:
      return value === own.id;
    case LABEL_REPOSITORY:
      return value === own.repository;
    case LABEL_OWNER_ID:
      return value === own.ownerId;
    case LABEL_BUILD_RECORD:
      return own.devspaceImage === true;
    // Only empty, only on the devspace image: the open sets it empty when it takes a prepared image over (the labels
    // of an image can only be added to). A prepare key on an image that a container is created from is refused.
    case LABEL_PREPARED:
      return own.devspaceImage === true && value === '';
    default:
      return false;
  }
}

/**
 * Of `references` (of a configuration, ImageReferences of the analysis), each once (by its item), those that Docker is
 * asked about (`named`), and the items of those that are not valid in Docker's grammar (`invalid`,
 * imageInvalidReferenceItem), which are refused before any inspect. A reference that imageReferenceFinding refuses
 * already (an image ID, a reference that is too long) is left out: the check names it.
 */
export function imageReferencesToInspect(references: readonly NamedImageReference[]): { named: NamedImageReference[]; invalid: string[] } {
  const named: NamedImageReference[] = [];
  const invalid: string[] = [];
  const seen = new Set<string>();
  for (const entry of references) {
    if (seen.has(`${entry.what} ${entry.reference}`) || imageReferenceFinding(entry.reference, entry.what) !== undefined) continue;
    seen.add(`${entry.what} ${entry.reference}`);
    if (isValidImageReference(entry.reference)) named.push(entry);
    else invalid.push(imageInvalidReferenceItem(entry.reference, entry.what));
  }
  return { named, invalid };
}

/**
 * The items of the references `named` (imageReferencesToInspect) after one `docker image inspect` of their distinct
 * references: `images`, the images that Docker found, and `unchecked`, the references that it could not inspect
 * (`invalid`: a definitive answer; `transient`: a timeout, a daemon that cannot be reached). `items`: the references that
 * Docker resolves by the ID of an image (imageIdItem) and those with a definitive answer (imageUncheckedItem), in the
 * order of `named`; `transient` and `notChecked` (the references of each kind), for the log and the error of the pipeline.
 */
export function inspectedImageItems(
  named: readonly NamedImageReference[],
  images: ReadonlyArray<{ id: string; repoTags: readonly string[]; repoDigests: readonly string[] }>,
  unchecked: ReadonlyArray<{ reference: string; reason: 'invalid' | 'transient' }>,
): { items: string[]; transient: string[]; notChecked: string[] } {
  const distinct = [...new Set(named.map((entry) => entry.reference))];
  const transient = unchecked.filter((entry) => entry.reason === 'transient').map((entry) => entry.reference);
  // The ID test only over the references with a definitive answer: a transient one was never inspected, so the images
  // of the others (a batch before the failure) say nothing about it (for example `cafe`, with a local cafe:latest, and
  // another image whose ID starts with cafe). It takes the transient path of the pipeline.
  const transientSet = new Set(transient);
  const byId = new Set(imageIdResolvedReferences(distinct.filter((reference) => !transientSet.has(reference)), images));
  // Only a definitive answer (`invalid`) becomes an item; a transient one never does.
  const notChecked = new Set(unchecked.filter((entry) => entry.reason === 'invalid').map((entry) => entry.reference));
  const items = named.flatMap((entry) => [
    ...(byId.has(entry.reference) ? [imageIdItem(entry.reference, entry.what)] : []),
    ...(notChecked.has(entry.reference) ? [imageUncheckedItem(entry.reference, entry.what)] : []),
  ]);
  return { items, transient, notChecked: [...notChecked] };
}

/** A local image as `docker image inspect` gives it (inspectImageNames): its ID, tags, and digests. */
export interface InspectedImage {
  id: string;
  repoTags: readonly string[];
  repoDigests: readonly string[];
}

/**
 * The IDs of the images of the devspaces on one Docker host (the devspace images and the images that Docker
 * Compose built for them, devspaceImageNames), split by owner: `own`, of the devspaces of the account of the
 * checked devspace (also of the checked devspace itself); `others`, of the devspaces of other accounts and of
 * devspaces whose owner is not known (built from another computer and without a volume here, or left behind by a
 * Delete).
 */
export interface DevspaceImageIds {
  own: ReadonlySet<string>;
  others: ReadonlySet<string>;
  /**
   * The names of the devspaces by owner (resourceName, in lower case): of the account of the checked devspace, and
   * of other accounts (for a name without a local image, isOtherDevspaceImageName).
   */
  ownNames?: ReadonlySet<string>;
  otherNames?: ReadonlySet<string>;
}

/**
 * The image of `images` that Docker gives for `reference` by its name (a tag, or a digest of the repository;
 * resolvedByImageId), `undefined` when none of them. A reference that Docker resolves by the ID of an image is refused
 * as an image ID (imageIdResolvedReferences).
 */
export function imageNamedBy(reference: string, images: readonly InspectedImage[]): InspectedImage | undefined {
  if (parseImageReference(reference) === undefined) return undefined;
  return images.find((image) => !resolvedByImageId(reference, image.repoTags, image.repoDigests));
}

/**
 * The names of the devspaces (resourceName, in lower case) whose image `reference` may be, by its repository (also
 * written with Docker Hub's registry or `library/`, localImageRepository): the devspace image `<name>:<build>`
 * (devspaceImageName) and the image `<name>-<service>` that Docker Compose built for a service of the project
 * `<name>` (composeServiceImage). A service name may contain `-`, so each start of the repository up to a `-` that has
 * the shape of a name of a devspace (isDevspaceResourceName) counts; only the devspaces known on the host
 * decide which one it is (devspaceImageClass). Empty for any other name.
 */
export function devspaceImageNames(reference: string): string[] {
  const repository = localImageRepository(reference).toLowerCase();
  if (!repository.startsWith(RESOURCE_NAME_PREFIX) || repository.includes('/')) return [];
  const names: string[] = [];
  for (let end = repository.indexOf('-'); end !== -1; end = repository.indexOf('-', end + 1)) {
    const prefix = repository.slice(0, end);
    if (isDevspaceResourceName(prefix)) names.push(prefix);
  }
  if (isDevspaceResourceName(repository)) names.push(repository);
  return names;
}

/**
 * Whose image the names `names` (devspaceImageNames of one reference) say it is, by the names of the devspaces of
 * the account (`own`) and of other accounts (`other`): `none` without names; `other` when one of them is a devspace
 * of another account, or none of them is a known devspace (an image of no known owner counts as another account's);
 * else `own`. A name with the shape of a name of a devspace that no devspace has is left aside when another one
 * is the account's own (for example a service `x-happy-turing` of the account's own project).
 */
export function devspaceImageClass(names: readonly string[], own: ReadonlySet<string>, other: ReadonlySet<string>): 'none' | 'own' | 'other' {
  if (names.length === 0) return 'none';
  if (names.some((name) => other.has(name))) return 'other';
  return names.some((name) => own.has(name)) ? 'own' : 'other';
}

/** The owner accounts of the devspaces on a host: by name (resourceName, in lower case) and by devspace ID. */
export interface DevspaceOwners {
  byName: ReadonlyMap<string, string>;
  byId: ReadonlyMap<string, string>;
}

/**
 * DevspaceImageIds of `images` (the devspace images of the host, with their references `repository:tag` and the
 * label nimblescape.devspaces.id that the extension gives the images it builds, `devspaceId`), by the
 * owner accounts of the devspaces (`owners`: of the registry entries, and of the labels of the volumes of the host)
 * and the account `accountId`. An image with the label belongs to the devspace of that ID (an ID of no known owner
 * counts as another account's), unless one of its names is the name of a known devspace of another account; an image
 * without it is decided by its names (devspaceImageClass).
 */
export function devspaceImageIds(
  images: ReadonlyArray<{ id: string; tags: readonly string[]; devspaceId?: string }>,
  owners: DevspaceOwners,
  accountId: string,
): DevspaceImageIds {
  const ownNames = new Set([...owners.byName].filter(([, owner]) => owner === accountId).map(([name]) => name));
  const otherNames = new Set([...owners.byName].filter(([, owner]) => owner !== accountId).map(([name]) => name));
  const own = new Set<string>();
  const others = new Set<string>();
  for (const image of images) {
    const names = image.tags.map(devspaceImageNames);
    let kinds: Array<'none' | 'own' | 'other'>;
    if (image.devspaceId !== undefined) {
      const byLabel = owners.byId.get(image.devspaceId) === accountId ? 'own' : 'other';
      kinds = [names.some((list) => list.some((name) => otherNames.has(name))) ? 'other' : byLabel];
    } else {
      kinds = names.map((list) => devspaceImageClass(list, ownNames, otherNames));
    }
    for (const kind of kinds) if (kind !== 'none') (kind === 'own' ? own : others).add(image.id.toLowerCase());
  }
  return { own, others, ownNames, otherNames };
}

/**
 * Whether a reference of `images` (with `ids`, only of the images with one of these IDs: the images that the references
 * of a configuration found) or of `references` belongs to a devspace that `owners` does not know: an image with a
 * devspace ID of no known owner, or names of devspaces (devspaceImageNames) of which none is known. Then the
 * owners of the volumes of the host are read too.
 */
export function hasUnknownDevspace(
  images: ReadonlyArray<{ id: string; tags: readonly string[]; devspaceId?: string }>,
  references: readonly string[],
  owners: DevspaceOwners,
  ids?: ReadonlySet<string>,
): boolean {
  const unknown = (reference: string): boolean => {
    const names = devspaceImageNames(reference);
    return names.length > 0 && !names.some((name) => owners.byName.has(name));
  };
  if (references.some(unknown)) return true;
  return images.some(
    (image) =>
      (ids === undefined || ids.has(image.id.toLowerCase())) &&
      (image.devspaceId !== undefined ? !owners.byId.has(image.devspaceId) : image.tags.some(unknown)),
  );
}

/**
 * The owner account of each devspace name (resourceName, in lower case) and of each devspace ID by the labels of
 * `volumes` (nimblescape.devspaces.id, nimblescape.devspaces.repository, and nimblescape.devspaces.owner-id). A name
 * or ID whose volumes carry different owners is left out: its images count as another account's.
 */
export function volumeOwners(volumes: ReadonlyArray<{ labels: Readonly<Record<string, string>> }>): { byName: Map<string, string>; byId: Map<string, string> } {
  const owners = new Map<string, string | undefined>();
  const ids = new Map<string, string | undefined>();
  for (const volume of volumes) {
    const labelledId = volume.labels[LABEL_DEVSPACE_ID];
    const labelledOwner = volume.labels[LABEL_OWNER_ID];
    if (labelledId && labelledOwner) ids.set(labelledId, ids.has(labelledId) && ids.get(labelledId) !== labelledOwner ? undefined : labelledOwner);
    const id = volume.labels[LABEL_DEVSPACE_ID];
    const repository = volume.labels[LABEL_REPOSITORY];
    const owner = volume.labels[LABEL_OWNER_ID];
    if (!id || !owner || !repository || !repository.includes('/')) continue;
    let name: string;
    try {
      name = resourceName(repository, id).toLowerCase();
    } catch {
      continue;
    }
    owners.set(name, owners.has(name) && owners.get(name) !== owner ? undefined : owner);
  }
  const known = (map: Map<string, string | undefined>): Map<string, string> => new Map([...map].filter((entry): entry is [string, string] => entry[1] !== undefined));
  return { byName: known(owners), byId: known(ids) };
}

/** The item of an image reference that names an image of the devspaces of another account (protected). */
export function otherAccountImageItem(reference: string, what = 'image'): string {
  return `${what} ${reference.trim()} (an image of a devspace of another GitHub account)`;
}

/**
 * The items (otherAccountImageItem) of the references `named` whose image, as Docker gives it by the name
 * (imageNamedBy, of the images that one `docker image inspect` found), is an image of a devspace of another account
 * or of no known owner (`ids.others`) and of none of the account of the checked devspace (`ids.own`); a reference
 * that names no local image and that Docker found missing (`missing`; not one that it could not inspect), by its name
 * (isOtherDevspaceImageName). The image ID says what the image holds, not whose it is: two devspaces with the
 * same configuration can build the same image (the same ID), and an image with the ID of an image of the account's own
 * devspaces holds nothing that the account could not build itself. Not recognized: a copy of such an image with
 * other labels or layers (another ID) and without a name of a devspace. Refused whatever the switch says
 * (HostAccessClass `protected`): account separation.
 */
export function otherAccountImageItems(
  named: readonly NamedImageReference[],
  images: readonly InspectedImage[],
  ids: DevspaceImageIds,
  missing: ReadonlySet<string>,
): string[] {
  const items: string[] = [];
  for (const entry of named) {
    const id = imageNamedBy(entry.reference, images)?.id.toLowerCase();
    const byName = missing.has(entry.reference) && isOtherDevspaceImageName(entry.reference, ids);
    if (id !== undefined ? ids.others.has(id) && !ids.own.has(id) : byName) {
      items.push(otherAccountImageItem(entry.reference, entry.what));
    }
  }
  return items;
}

/**
 * Whether `reference`, which names no local image, is the name of an image of a devspace of another account or of
 * no known owner (devspaceImageClass of its devspaceImageNames; `ids.ownNames`, `ids.otherNames`). No registry
 * has such a name, so it has no use but to catch that devspace's next build between the check and the start.
 */
export function isOtherDevspaceImageName(reference: string, ids: DevspaceImageIds): boolean {
  return devspaceImageClass(devspaceImageNames(reference), ids.ownNames ?? new Set(), ids.otherNames ?? new Set()) === 'other';
}
