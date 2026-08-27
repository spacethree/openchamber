// The outbound link from this OpenChamber instance to a Humble Good Site.
//
// Outbound only, by design: the box lives on a tailnet the platform cannot dial,
// so the instance introduces itself and then keeps saying it is alive. Two calls
// make up the whole protocol. Enrollment redeems a one-time token from the
// Site's settings panel for a long-lived per-server bearer. The heartbeat proves
// the instance is still there and reports what it can currently run.
//
// Enrollment happens at most once per process. A rejected token is not retried
// on a timer: the operator mints a new one and restarts the unit, and a retry
// loop against a single-use credential is just noise the platform has to
// rate-limit. Revocation is the platform's decision and arrives as a 401 on a
// heartbeat, which is persisted so a restart does not resurrect the loop.

import os from 'node:os';

import { createPlatformConnectorConfigStore } from './config.js';

const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;
const REQUEST_TIMEOUT_MS = 15_000;

const STATUS_UNENROLLED = 'unenrolled';
const STATUS_CONNECTED = 'connected';
const STATUS_REVOKED = 'revoked';
const STATUS_ERROR = 'error';

const asNonEmptyString = (value) => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const platformEndpoint = (platformUrl, endpoint) => `${platformUrl.replace(/\/+$/, '')}/api/work/mill/${endpoint}`;

const errorMessage = (error) => (error instanceof Error ? error.message : String(error));

export const createPlatformConnectorRuntime = (dependencies) => {
  const {
    logger = console,
    dataDir,
    env = process.env,
    fetchImpl = globalThis.fetch,
    collectCapabilities,
    heartbeatIntervalMs = DEFAULT_HEARTBEAT_INTERVAL_MS,
    now = () => Date.now(),
  } = dependencies;

  const configStore = createPlatformConnectorConfigStore({ dataDir, logger });

  let config = null;
  let status = STATUS_UNENROLLED;
  let lastHeartbeatAt = null;
  let lastError = null;
  let heartbeatTimer = null;
  let heartbeatInFlight = false;
  // What the last log line said about the connection. A tailnet drop would
  // otherwise print the same warning twice a minute for as long as it lasts.
  let lastLoggedCondition = null;

  const timestamp = () => new Date(now()).toISOString();

  const noteCondition = (condition, log) => {
    if (lastLoggedCondition === condition) return;
    lastLoggedCondition = condition;
    log();
  };

  const capabilities = async () => {
    const collected = await collectCapabilities();
    return collected ?? {};
  };

  const stopHeartbeatTimer = () => {
    if (!heartbeatTimer) return;
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  };

  const postToPlatform = async (platformUrl, endpoint, body, headers = {}) => fetchImpl(
    platformEndpoint(platformUrl, endpoint),
    {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    },
  );

  /**
   * Redeems the one-time enrollment token. Any non-200 leaves the instance
   * unenrolled with nothing written: a token the platform refused is spent or
   * wrong either way, and half-writing an identity would make the next start
   * heartbeat with a bearer that does not exist.
   */
  const enroll = async () => {
    const platformUrl = asNonEmptyString(env.OPENCHAMBER_PLATFORM_URL);
    const token = asNonEmptyString(env.OPENCHAMBER_PLATFORM_ENROLL_TOKEN);
    if (!platformUrl || !token) return null;

    const name = asNonEmptyString(env.OPENCHAMBER_PLATFORM_SERVER_NAME) ?? os.hostname();
    let response;
    try {
      response = await postToPlatform(platformUrl, 'enroll', { token, name, capabilities: await capabilities() });
    } catch (error) {
      lastError = errorMessage(error);
      logger.warn?.(`[platform-connector] enrollment could not reach ${platformUrl}: ${lastError}`);
      return null;
    }

    if (response.status !== 200) {
      lastError = `Enrollment rejected with ${response.status}`;
      logger.warn?.(`[platform-connector] ${lastError}; mint a new token and restart to try again`);
      return null;
    }

    const issued = await response.json().catch(() => null);
    const serverToken = asNonEmptyString(issued?.serverToken);
    const serverId = asNonEmptyString(issued?.serverId);
    if (!serverToken || !serverId) {
      lastError = 'Enrollment response carried no server identity';
      logger.warn?.(`[platform-connector] ${lastError}`);
      return null;
    }

    const saved = await configStore.save({
      platformUrl,
      siteId: asNonEmptyString(issued?.siteId),
      serverId,
      serverToken,
      name,
      enrolledAt: timestamp(),
    });
    lastError = null;
    logger.log?.(`[platform-connector] enrolled with ${platformUrl} as ${name} (server ${serverId})`);
    return saved;
  };

  /**
   * Revocation is the platform's decision, so it takes effect in memory whether
   * or not the disk agrees. A failed write costs the instance only its memory of
   * the revocation across a restart, and the next heartbeat's 401 revokes it
   * again; letting the write failure reopen the loop right now would not.
   */
  const revoke = async () => {
    status = STATUS_REVOKED;
    lastError = 'The platform revoked this server';
    stopHeartbeatTimer();
    const revoked = { ...config, revokedAt: timestamp() };
    config = revoked;
    try {
      config = await configStore.save(revoked) ?? revoked;
    } catch (error) {
      logger.warn?.(`[platform-connector] could not record the revocation on disk: ${errorMessage(error)}`);
    }
    noteCondition(STATUS_REVOKED, () => {
      logger.warn?.('[platform-connector] the platform revoked this server; enroll again to reconnect');
    });
  };

  const heartbeat = async () => {
    if (!config?.serverToken || config.revokedAt) return;
    if (heartbeatInFlight) return;
    heartbeatInFlight = true;
    try {
      const response = await postToPlatform(
        config.platformUrl,
        'heartbeat',
        { capabilities: await capabilities() },
        { authorization: `Bearer ${config.serverToken}` },
      );

      if (response.status === 401) {
        await revoke();
        return;
      }

      if (!response.ok) {
        status = STATUS_ERROR;
        lastError = `Heartbeat rejected with ${response.status}`;
        noteCondition(lastError, () => logger.warn?.(`[platform-connector] ${lastError}`));
        return;
      }

      status = STATUS_CONNECTED;
      lastHeartbeatAt = timestamp();
      lastError = null;
      noteCondition(STATUS_CONNECTED, () => {
        logger.log?.(`[platform-connector] connected to ${config.platformUrl} as server ${config.serverId}`);
      });
    } catch (error) {
      status = STATUS_ERROR;
      lastError = errorMessage(error);
      noteCondition(lastError, () => logger.warn?.(`[platform-connector] heartbeat failed: ${lastError}`));
    } finally {
      heartbeatInFlight = false;
    }
  };

  const startHeartbeatTimer = () => {
    stopHeartbeatTimer();
    heartbeatTimer = setInterval(() => { void heartbeat(); }, heartbeatIntervalMs);
    heartbeatTimer.unref?.();
  };

  const start = async () => {
    config = await configStore.load();
    if (!config) config = await enroll();

    if (!config) {
      status = STATUS_UNENROLLED;
      return;
    }

    if (config.revokedAt) {
      // A revoked bearer is dead for good, but the operator can mint a fresh
      // enrollment token and restart: enroll() only acts when the env carries
      // one, and its save() replaces the revoked record outright.
      const fresh = await enroll();
      if (fresh) {
        config = fresh;
      } else {
        status = STATUS_REVOKED;
        lastError = 'The platform revoked this server';
        return;
      }
    }

    await heartbeat();
    // A revocation answered by the very first heartbeat has already stopped the
    // loop; scheduling one now would restart it.
    if (status !== STATUS_REVOKED) startHeartbeatTimer();
  };

  const stop = () => {
    stopHeartbeatTimer();
  };

  const getStatus = () => ({
    enrolled: Boolean(config?.serverToken) && !config?.revokedAt,
    platformUrl: config?.platformUrl ?? null,
    siteId: config?.siteId ?? null,
    serverId: config?.serverId ?? null,
    name: config?.name ?? null,
    status,
    lastHeartbeatAt,
    lastError,
  });

  return { start, stop, getStatus, enroll, heartbeat };
};
