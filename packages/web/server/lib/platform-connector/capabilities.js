// What this instance can be asked to run, reported to the platform on every
// heartbeat so the platform can route work without reaching back into the box.
//
// Every field is collected independently. An OpenCode restart, a control-service
// hiccup, or a missing dependency costs the platform that one field, never the
// whole report: a heartbeat that fails outright would read as a dead server.

const asNonEmptyString = (value) => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

// OpenCode has answered `/config/providers` with both shapes over its releases.
const providerModels = (provider) => {
  if (Array.isArray(provider?.models)) return provider.models;
  if (provider?.models && typeof provider.models === 'object') return Object.values(provider.models);
  return [];
};

const sortedUnique = (values) => [...new Set(values)].sort();

/**
 * Runs one field's collector and answers with `fallback` when it fails. Debug,
 * not warn: an unreachable OpenCode is already reported by the health surface,
 * and a heartbeat every 30 seconds would turn one outage into a log flood.
 */
const collectField = async (label, logger, fallback, collect) => {
  try {
    const value = await collect();
    return value ?? fallback;
  } catch (error) {
    logger.debug?.(`[platform-connector] ${label} unavailable for this heartbeat: ${error?.message || error}`);
    return fallback;
  }
};

const modelCatalog = async (openCodeFetch) => {
  const body = await openCodeFetch('/config/providers');
  const providers = Array.isArray(body?.providers) ? body.providers : [];
  return sortedUnique(providers.flatMap((provider) => {
    const providerId = asNonEmptyString(provider?.id);
    if (!providerId) return [];
    return providerModels(provider)
      .map((model) => asNonEmptyString(model?.id))
      .filter(Boolean)
      .map((modelId) => `${providerId}/${modelId}`);
  }));
};

// The catalog is the real answer. Preferences are the consolation prize: they
// are already `provider/model` strings and they are what the operator actually
// uses, so a platform that sees them can still dispatch work while OpenCode is
// restarting.
const preferredModels = async (executeAction) => {
  const preferences = await executeAction('models.list', {});
  return sortedUnique([
    asNonEmptyString(preferences?.defaultModel),
    ...(Array.isArray(preferences?.favoriteModels) ? preferences.favoriteModels : []),
    ...(Array.isArray(preferences?.recentModels) ? preferences.recentModels : []),
  ].map(asNonEmptyString).filter(Boolean));
};

export const collectCapabilities = async (dependencies) => {
  const { executeAction, openCodeFetch, versions = {}, logger = console } = dependencies;

  const catalog = await collectField('model catalog', logger, [], async () => (
    openCodeFetch ? modelCatalog(openCodeFetch) : []
  ));
  const models = catalog.length > 0 || !executeAction
    ? catalog
    : await collectField('model preferences', logger, [], () => preferredModels(executeAction));

  const agents = await collectField('agent list', logger, [], async () => {
    if (!openCodeFetch) return [];
    const body = await openCodeFetch('/agent');
    return sortedUnique((Array.isArray(body) ? body : []).map((agent) => asNonEmptyString(agent?.name)).filter(Boolean));
  });

  // Project directories, not ids: the platform dispatches a session against a
  // checkout path, and an id means nothing outside this instance's settings.
  const projects = await collectField('project list', logger, [], async () => {
    if (!executeAction) return [];
    const body = await executeAction('projects.list', {});
    return (Array.isArray(body?.projects) ? body.projects : [])
      .map((project) => asNonEmptyString(project?.path))
      .filter(Boolean);
  });

  const opencodeVersion = asNonEmptyString(versions.opencodeVersion)
    ?? await collectField('OpenCode version', logger, null, async () => {
      if (!openCodeFetch) return null;
      const health = await openCodeFetch('/global/health');
      return asNonEmptyString(health?.version)?.replace(/^v/, '') ?? null;
    });

  const uiUrl = asNonEmptyString(versions.uiUrl);
  const capabilities = {
    openchamberVersion: asNonEmptyString(versions.openchamberVersion),
    opencodeVersion,
    models,
    agents,
    projects,
  };
  if (uiUrl) capabilities.uiUrl = uiUrl;
  return capabilities;
};
