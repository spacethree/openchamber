// Where the connector's platform identity lives on disk.
//
// The file holds a long-lived bearer, so it is written the way the paired-client
// and tunnel-token stores are written: owner-only directory, owner-only file,
// temp file plus rename so a reader never sees a half-written config. The mode
// is re-applied on every save because `writeFile`'s mode argument only applies
// when the file is created, and an operator who once copied this file into place
// would otherwise keep whatever permissions it arrived with.

import fsPromises from 'node:fs/promises';
import path from 'node:path';

const CONFIG_FILENAME = 'platform-connector.json';
const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;

// Everything the connector persists. A field outside this list is dropped on
// save and ignored on load, so a future platform response cannot smuggle extra
// state into the file.
const PERSISTED_FIELDS = ['platformUrl', 'siteId', 'serverId', 'serverToken', 'name', 'enrolledAt', 'revokedAt'];

const asNonEmptyString = (value) => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

/**
 * A config without a platform URL, a server id, and a bearer cannot address or
 * authenticate anything, so it is not a config. Answering `null` puts the
 * connector back in its unenrolled state instead of leaving it half-identified.
 */
const parseConfig = (raw) => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const platformUrl = asNonEmptyString(raw.platformUrl);
  const serverId = asNonEmptyString(raw.serverId);
  const serverToken = asNonEmptyString(raw.serverToken);
  if (!platformUrl || !serverId || !serverToken) return null;
  return {
    platformUrl,
    siteId: asNonEmptyString(raw.siteId),
    serverId,
    serverToken,
    name: asNonEmptyString(raw.name),
    enrolledAt: asNonEmptyString(raw.enrolledAt),
    revokedAt: asNonEmptyString(raw.revokedAt),
  };
};

const serializeConfig = (config) => {
  const persisted = {};
  for (const field of PERSISTED_FIELDS) {
    const value = asNonEmptyString(config?.[field]);
    if (value) persisted[field] = value;
  }
  return persisted;
};

export const createPlatformConnectorConfigStore = (dependencies) => {
  const { dataDir, logger = console } = dependencies;
  const filePath = path.join(dataDir, CONFIG_FILENAME);

  const load = async () => {
    try {
      return parseConfig(JSON.parse(await fsPromises.readFile(filePath, 'utf8')));
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        // The message names the file, never its contents: the contents are the
        // bearer.
        logger.warn?.(`[platform-connector] ignoring unreadable ${CONFIG_FILENAME}: ${error?.message || error}`);
      }
      return null;
    }
  };

  const save = async (config) => {
    const persisted = serializeConfig(config);
    await fsPromises.mkdir(path.dirname(filePath), { recursive: true, mode: DIRECTORY_MODE });
    const temporaryPath = `${filePath}.${process.pid}.tmp`;
    try {
      await fsPromises.writeFile(temporaryPath, JSON.stringify(persisted, null, 2), { encoding: 'utf8', mode: FILE_MODE });
      await fsPromises.chmod(temporaryPath, FILE_MODE);
      await fsPromises.rename(temporaryPath, filePath);
    } catch (error) {
      await fsPromises.rm(temporaryPath, { force: true });
      throw error;
    }
    return parseConfig(persisted);
  };

  return { filePath, load, save };
};
