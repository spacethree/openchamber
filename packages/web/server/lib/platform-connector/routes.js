// One read-only route. The UI needs to show whether this instance is linked to a
// Site and when it last checked in; it never needs the bearer, so the runtime's
// status object is the whole response.
//
// Registered with the other feature routes, which sit behind the `/api` auth
// gate in `core-routes`. Registering it earlier (the way the agent tool does,
// because that callback carries its own per-child token) would publish the
// connector's platform identity unauthenticated.

export const registerPlatformConnectorRoutes = (app, dependencies) => {
  const { runtime } = dependencies;

  app.get('/api/openchamber/platform-connector/status', (_req, res) => {
    try {
      return res.json(runtime.getStatus());
    } catch (error) {
      // An empty status would read as "not enrolled", which is a different fact
      // than "we could not tell".
      return res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to read connector status' });
    }
  });
};
