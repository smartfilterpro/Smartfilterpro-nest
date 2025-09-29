/* ================================ ROUTES =============================== */

app.get('/health', (_req, res) => res.json({ ok: true, timestamp: new Date().toISOString() }));

// NEW: peek at in-memory state
app.get('/state/:deviceId?', (req, res) => {
  try {
    const deviceId = req.params.deviceId;
    const state = sessions.getDebugState ? sessions.getDebugState(deviceId) : null;
    res.json({ ok: true, deviceId: deviceId || null, state });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Accept both historical and new endpoints to avoid Pub/Sub misconfig issues
app.post(['/webhook', '/nest/events'], async (req, res) => {
  const startTime = Date.now();
  try {
    const source = req.get('x-cloud-trace-context') || req.get('x-forwarded-for') || 'unknown';
    console.log(`\n[INGRESS] ${new Date().toISOString()} | ${source} → ${req.originalUrl}`);

    const decoded = parseSdmPushMessage(req.body);
    if (!decoded) {
      console.warn('[WARN] Could not parse SDM push body; returning 204');
      return res.status(204).end();
    }

    console.log(`[PARSED] ${decoded.events.length} event(s) in message`);

    for (const evt of decoded.events) {
      if (process.env.LOG_TRAITS === 'true') {
        console.log('[RAW TRAITS]', JSON.stringify(evt.traits || {}, null, 2));
      }

      const traits = extractEffectiveTraits(evt);

      if (process.env.LOG_TRAITS === 'true') {
        console.log('[EFFECTIVE TRAITS]', JSON.stringify(traits, null, 2));
      }

      const input = {
        userId: decoded.userId || null,
        projectId: decoded.projectId || null,
        structureId: decoded.structureId || null,
        deviceId: traits.deviceId,
        deviceName: traits.deviceName,
        roomDisplayName: traits.roomDisplayName || '',
        when: traits.timestamp,
        thermostatMode: traits.thermostatMode,
        hvacStatusRaw: traits.hvacStatusRaw,
        hasFanTrait: traits.hasFanTrait,
        fanTimerMode: traits.fanTimerMode,
        fanTimerOn: traits.fanTimerOn,
        currentTempC: traits.currentTempC,
        coolSetpointC: traits.coolSetpointC,
        heatSetpointC: traits.heatSetpointC,
        connectivity: traits.connectivity,
      };

      const result = sessions.process(input);
      ...
