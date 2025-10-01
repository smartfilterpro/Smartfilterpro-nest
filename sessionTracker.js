process(input) {
  const prev = this.getPrev(input.deviceId);
  const nowMs = new Date(input.when).getTime();

  // Sticky values
  if (input.currentTempC == null && prev.lastTempC != null) input.currentTempC = prev.lastTempC;
  if (!input.thermostatMode && prev.lastMode) input.thermostatMode = prev.lastMode;
  if (!input.hvacStatusRaw && prev.lastEquipmentStatus) {
    if (Date.now() - prev.lastAt < RECENT_WINDOW_MS) {
      input.hvacStatusRaw =
        prev.lastEquipmentStatus === 'heat' ? 'HEATING' :
        prev.lastEquipmentStatus === 'cool' ? 'COOLING' : 'OFF';
    }
  }

  let { isReachable, isHvacActive, equipmentStatus, isFanOnly } =
    this.computeActiveAndStatus(input, prev);

  // --- Detect mode switch while active (heat <-> cool) ---
  const switchedWhileActive =
    prev.isRunning &&
    (prev.lastEquipmentStatus === 'heat' || prev.lastEquipmentStatus === 'cool') &&
    (equipmentStatus === 'heat' || equipmentStatus === 'cool') &&
    prev.lastEquipmentStatus !== equipmentStatus;

  if (switchedWhileActive) {
    prev.tailUntil = 0;                // cancel any fan tail
    prev.isRunning = true;             // continue session
    prev.startStatus = equipmentStatus; // update status
    // startedAt remains unchanged → runtime continues
  }

  // --- Fan tail logic (only if not switching) ---
  if (!isHvacActive && !switchedWhileActive) {
    const justStopped = prev.isRunning &&
      (prev.lastEquipmentStatus === 'heat' || prev.lastEquipmentStatus === 'cool');
    if (justStopped && FAN_TAIL_MS > 0 && prev.tailUntil === 0) {
      prev.tailUntil = nowMs + FAN_TAIL_MS;
      console.log('[TAIL-START]', input.deviceId, 'until', new Date(prev.tailUntil).toISOString());
    }
    if (prev.tailUntil && nowMs < prev.tailUntil) {
      isHvacActive = true;
      equipmentStatus = prev.lastEquipmentStatus;
    } else if (prev.tailUntil && nowMs >= prev.tailUntil) {
      prev.tailUntil = 0;
    }
  } else if (isHvacActive) {
    if (prev.tailUntil) prev.tailUntil = 0;
  }

  // --- Timeout safeguard ---
  if (prev.isRunning && nowMs - prev.lastAt > SESSION_TIMEOUT_MS) {
    const ms = Math.max(0, nowMs - prev.startedAt);
    const runtimeSeconds = Math.round(ms / 1000);
    console.log('[TIMEOUT-CLOSE]', input.deviceId, 'runtime', runtimeSeconds);
    prev.isRunning = false;
    prev.startedAt = null;
    prev.startStatus = 'off';
    prev.tailUntil = 0;
    return this._buildResult(input, nowMs, 'OFF', 'off', false, false, isReachable, runtimeSeconds, true);
  }

  const becameActive = !prev.isRunning && isHvacActive;
  let becameIdle = prev.isRunning && !isHvacActive;

  if (becameActive) {
    prev.isRunning = true;
    prev.startedAt = nowMs;
    prev.startStatus = equipmentStatus;
    prev.tailUntil = 0;
  }

  let runtimeSeconds = null;
  let isRuntimeEvent = false;

  // --- Explicit OFF handling ---
  if (input.hvacStatusRaw === 'OFF' && prev.isRunning && prev.startedAt && !switchedWhileActive) {
    if (FAN_TAIL_MS > 0) {
      if (prev.tailUntil === 0) {
        prev.tailUntil = nowMs + FAN_TAIL_MS;
        console.log('[TAIL-START]', input.deviceId, 'until', new Date(prev.tailUntil).toISOString());
      }
    } else {
      const ms = Math.max(0, nowMs - prev.startedAt);
      runtimeSeconds = Math.round(ms / 1000);
      isRuntimeEvent = true;
      console.log('[SESSION END - EXPLICIT OFF]', input.deviceId, 'runtime', runtimeSeconds);
      prev.isRunning = false;
      prev.startedAt = null;
      prev.startStatus = 'off';
      prev.tailUntil = 0;
      isHvacActive = false;
      equipmentStatus = 'off';
    }
  }
  // --- Normal idle transition ---
  else if (becameIdle && prev.startedAt && !switchedWhileActive) {
    const ms = Math.max(0, nowMs - prev.startedAt);
    runtimeSeconds = Math.round(ms / 1000);
    isRuntimeEvent = true;
    console.log('[SESSION END - BECAME IDLE]', input.deviceId, 'runtime', runtimeSeconds);
    prev.isRunning = false;
    prev.startedAt = null;
    prev.startStatus = 'off';
    prev.tailUntil = 0;
  }

  // --- Save state ---
  prev.lastTempC = isNum(input.currentTempC) ? input.currentTempC : prev.lastTempC;
  prev.lastAt = nowMs;
  prev.lastEquipmentStatus = equipmentStatus || prev.lastEquipmentStatus;
  prev.lastMode = input.thermostatMode || prev.lastMode;
  prev.lastReachable = isReachable;
  prev.lastRoom = input.roomDisplayName || prev.lastRoom;

  const hvacMode = hvacModeFromEquipment(equipmentStatus);

  const result = {
    userId: input.userId || null,
    thermostatId: input.deviceId,
    deviceName: input.deviceName,
    roomDisplayName: input.roomDisplayName || '',
    timestampISO: new Date(nowMs).toISOString(),
    thermostatMode: input.thermostatMode || 'OFF',
    hvacMode,
    equipmentStatus,
    isHvacActive,
    isFanOnly,
    isReachable,
    currentTempC: isNum(input.currentTempC) ? round2(input.currentTempC) : null,
    coolSetpointC: isNum(input.coolSetpointC) ? round2(input.coolSetpointC) : null,
    heatSetpointC: isNum(input.heatSetpointC) ? round2(input.heatSetpointC) : null,
    runtimeSeconds,
    isRuntimeEvent,
    startTempC: null,
    endTempC: isNum(input.currentTempC) ? round2(input.currentTempC) : null,
  };

  console.log('[STATE]', {
    thermo: input.deviceId,
    mode: input.thermostatMode,
    hvacStatusRaw: input.hvacStatusRaw,
    active: isHvacActive,
    equip: equipmentStatus,
    runtimeSeconds,
    eventTime: input.when,
  });

  return result;
}