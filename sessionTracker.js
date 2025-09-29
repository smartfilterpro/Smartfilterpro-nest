/* ============================== SESSIONS =============================== */

class SessionManager {
  constructor() {
    this.byDevice = new Map();
  }

  getPrev(deviceId) {
    if (!this.byDevice.has(deviceId)) {
      log(`Initializing state for device: ${deviceId}`);
      this.byDevice.set(deviceId, {
        isRunning: false,
        startedAt: null,
        startStatus: 'off',
        lastTempC: null,
        lastAt: null,
        lastEquipmentStatus: 'off',
        lastMode: 'OFF',
        lastReachable: true,
        lastRoom: '',
        tailUntil: 0,
      });
    }
    return this.byDevice.get(deviceId);
  }

  /* Quick state peek for /state endpoint (optional) */
  getDebugState(deviceId) {
    if (deviceId) return this.byDevice.get(deviceId) || null;
    const out = {};
    for (const [k, v] of this.byDevice.entries()) out[k] = v;
    return out;
  }

  computeActiveAndStatus(input, prev, now) {
    // ————— RAW INPUT SNAPSHOT —————
    log('RAW INPUT', JSON.stringify({
      deviceId: input.deviceId,
      when: input.when,
      thermostatMode: input.thermostatMode,
      hvacStatusRaw: input.hvacStatusRaw,
      hasFanTrait: input.hasFanTrait,
      fanTimerMode: input.fanTimerMode,
      fanTimerOn: input.fanTimerOn,
      currentTempC: input.currentTempC,
      coolSetpointC: input.coolSetpointC,
      heatSetpointC: input.heatSetpointC,
      connectivity: input.connectivity
    }, null, 2));

    const isReachable = input.connectivity !== 'OFFLINE';
    const isFanRunning = !!(input.hasFanTrait && (input.fanTimerMode === 'ON' || input.fanTimerOn === true));

    let hvacStatus = input.hvacStatusRaw || 'UNKNOWN';
    let isHeating = hvacStatus === 'HEATING';
    let isCooling = hvacStatus === 'COOLING';

    // If status unknown, try to infer from temps
    if (hvacStatus === 'UNKNOWN' || hvacStatus == null) {
      const inferred = inferHvacFromTemps(
        input.thermostatMode,
        input.currentTempC,
        input.coolSetpointC,
        input.heatSetpointC,
        prev.lastTempC
      );
      log(`INFER: mode=${input.thermostatMode} current=${input.currentTempC}C cool=${input.coolSetpointC}C heat=${input.heatSetpointC}C prev=${prev.lastTempC}C → ${inferred}`);
      if (inferred === 'HEATING' || inferred === 'COOLING') {
        hvacStatus = inferred;
        isHeating = inferred === 'HEATING';
        isCooling = inferred === 'COOLING';
      } else {
        hvacStatus = 'OFF';
      }
    }

    // Air moving if heating or cooling or fan running
    const isActive = Boolean(isHeating || isCooling || isFanRunning);

    // Status string + fanOnly
    let equipmentStatus = 'off';
    let isFanOnly = false;
    if (isHeating) equipmentStatus = 'heat';
    if (isCooling) equipmentStatus = 'cool';
    if (!isHeating && !isCooling && isFanRunning) {
      equipmentStatus = 'fan';
      isFanOnly = true;
    }

    // Recent-window smoothing (only if not explicitly OFF)
    const hasExplicitOff = input.hvacStatusRaw === 'OFF';
    const hasExplicitMode = input.thermostatMode != null && input.thermostatMode !== undefined;

    if (!isActive && !hasExplicitOff && prev.isRunning && prev.lastAt && now - prev.lastAt < RECENT_WINDOW_MS) {
      if (hasExplicitMode && input.thermostatMode === 'OFF') {
        log(`SMOOTHING: explicit mode OFF → not maintaining`);
      } else {
        log(`SMOOTHING: within ${RECENT_WINDOW_MS}ms window, maintain previous status=${prev.lastEquipmentStatus}`);
        return {
          isReachable,
          isHvacActive: true,
          equipmentStatus: prev.lastEquipmentStatus,
          isFanOnly: prev.lastEquipmentStatus === 'fan',
        };
      }
    }

    log(`DECISION: reachable=${isReachable} active=${isActive} hvac=${hvacStatus} equip=${equipmentStatus} fanOnly=${isFanOnly} fanTimer=${input.fanTimerMode}`);

    return { isReachable, isHvacActive: isActive, equipmentStatus, isFanOnly };
  }

  process(input) {
    const prev = this.getPrev(input.deviceId);
    const now = new Date(input.when).getTime();

    log(`\n=== PROCESS ${input.deviceId} @ ${new Date(now).toISOString()} ===`);
    log(`PREV: running=${prev.isRunning} startedAt=${prev.startedAt ? new Date(prev.startedAt).toISOString() : '—'} last=${prev.lastEquipmentStatus} tailUntil=${prev.tailUntil > 0 ? new Date(prev.tailUntil).toISOString() : '—'}`);

    // Compute base active state
    let { isReachable, isHvacActive, equipmentStatus, isFanOnly } =
      this.computeActiveAndStatus(input, prev, now);

    // Save baseActive to detect end BEFORE fan-tail overrides
    const baseActive = isHvacActive;
    const becameIdle = prev.isRunning && !baseActive;

    let runtimeSeconds = null;
    let isRuntimeEvent = false;

    // END session
    if (becameIdle && prev.startedAt) {
      const ms = Math.max(0, now - prev.startedAt);
      runtimeSeconds = Math.round(ms / 1000);
      isRuntimeEvent = true;
      log(`🔴 END: ${prev.startStatus} ran ${runtimeSeconds}s`);
      prev.isRunning = false;
      prev.startedAt = null;
      prev.startStatus = 'off';
    }

    // FAN TAIL
    if (!baseActive) {
      const justEndedHeatOrCool = isRuntimeEvent && (prev.lastEquipmentStatus === 'heat' || prev.lastEquipmentStatus === 'cool');
      const fanExplicit = (equipmentStatus === 'fan' || isFanOnly);

      if (justEndedHeatOrCool && !fanExplicit && FAN_TAIL_MS > 0 && prev.tailUntil === 0) {
        prev.tailUntil = now + FAN_TAIL_MS;
        log(`⏱️ TAIL scheduled → ${new Date(prev.tailUntil).toISOString()} (+${FAN_TAIL_MS}ms)`);
      }

      if (prev.tailUntil > 0 && now < prev.tailUntil) {
        log(`🌀 TAIL active: remain 'fan' (${prev.tailUntil - now}ms left)`);
        isHvacActive = true;
        equipmentStatus = 'fan';
        isFanOnly = true;
      } else if (prev.tailUntil > 0 && now >= prev.tailUntil) {
        log('✓ TAIL expired');
        prev.tailUntil = 0;
      }
    } else if (prev.tailUntil > 0) {
      log('✓ Cancel TAIL (equipment became active)');
      prev.tailUntil = 0;
    }

    // START session (after tail handling)
    const becameActive = !prev.isRunning && isHvacActive;
    if (becameActive) {
      log(`🟢 START: ${equipmentStatus}`);
      prev.isRunning = true;
      prev.startedAt = now;
      prev.startStatus = equipmentStatus;
    }

    // Persist snapshot
    prev.lastTempC = isNum(input.currentTempC) ? input.currentTempC : prev.lastTempC;
    prev.lastAt = now;
    prev.lastEquipmentStatus = equipmentStatus || prev.lastEquipmentStatus;
    prev.lastMode = input.thermostatMode || prev.lastMode;
    prev.lastReachable = isReachable;
    prev.lastRoom = input.roomDisplayName || prev.lastRoom;

    const hvacMode = hvacModeFromEquipment(equipmentStatus);

    return {
      userId: input.userId || null,
      thermostatId: input.deviceId,
      deviceName: input.deviceName,
      roomDisplayName: input.roomDisplayName || '',
      timestampISO: new Date(now).toISOString(),
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
      startTempC: prev.isRunning && prev.startedAt ? prev.lastTempC : null,
      endTempC: isNum(input.currentTempC) ? round2(input.currentTempC) : null,
    };
  }

  toBubblePayload(result) {
    const c2f = (c) => (c == null ? null : Math.round((c * 9) / 5 + 32));
    return {
      userId: result.userId,
      thermostatId: result.thermostatId,
      deviceName: result.deviceName || '',
      roomDisplayName: result.roomDisplayName || '',
      runtimeSeconds: result.runtimeSeconds,
      runtimeMinutes: result.runtimeSeconds != null ? Math.round(result.runtimeSeconds / 60) : null,
      isRuntimeEvent: Boolean(result.isRuntimeEvent),
      hvacMode: result.hvacMode,
      operatingState: result.equipmentStatus,
      isHvacActive: Boolean(result.isHvacActive),
      thermostatMode: result.thermostatMode,
      isReachable: Boolean(result.isReachable),
      currentTempF: c2f(result.currentTempC),
      coolSetpointF: c2f(result.coolSetpointC),
      heatSetpointF: c2f(result.heatSetpointC),
      startTempF: c2f(result.startTempC) || 0,
      endTempF: c2f(result.endTempC),
      currentTempC: result.currentTempC,
      coolSetpointC: result.coolSetpointC,
      heatSetpointC: result.heatSetpointC,
      startTempC: result.startTempC || 0,
      endTempC: result.endTempC,
      lastIsCooling: result.equipmentStatus === 'cool',
      lastIsHeating: result.equipmentStatus === 'heat',
      lastIsFanOnly: result.equipmentStatus === 'fan',
      lastEquipmentStatus: result.equipmentStatus,
      equipmentStatus: result.equipmentStatus,
      isFanOnly: result.isFanOnly,
      timestamp: result.timestampISO,
      eventId: genUuid(),
      eventTimestamp: Date.parse(result.timestampISO),
    };
  }
}
