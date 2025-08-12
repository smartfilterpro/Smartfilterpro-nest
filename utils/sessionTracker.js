const axios = require('axios');

// ----------------- Config knobs -----------------
const MIN_POST_INTERVAL_MS = 60_000;         // ensure at least one post per device per minute
const TEMP_CHANGE_C_THRESHOLD = 0.1;         // post if ambient temp changes by ≥ 0.1°C
const HEARTBEAT_INTERVAL_MS = 10_000;        // how often to scan for stale devices to post
// ------------------------------------------------

// Session storage (same pattern as Enode)
const sessions = {};
const deviceStates = {}; // Track previous HVAC state + last post info

function toTimestamp(dateStr) {
  return new Date(dateStr).getTime();
}

function celsiusToFahrenheit(celsius) {
  return Math.round((celsius * 9/5) + 32);
}

async function sendToBubble(payload) {
  try {
    await axios.post(process.env.BUBBLE_WEBHOOK_URL, payload);
    console.log('✅ Sent to Bubble:', payload);
    return true;
  } catch (err) {
    console.error('❌ Failed to send to Bubble:', err.response?.data || err.message);

    // Retry logic (network-ish failures)
    if (err.code === 'ECONNABORTED' || err.code === 'ENOTFOUND' || err.code === 'ECONNRESET' || err.code === 'EAI_AGAIN') {
      console.log('🔄 Retrying in 5 seconds...');
      try {
        await new Promise(r => setTimeout(r, 5000));
        await axios.post(process.env.BUBBLE_WEBHOOK_URL, payload);
        console.log('✅ Retry successful:', payload);
        return true;
      } catch (retryErr) {
        console.error('❌ Retry failed:', retryErr.response?.data || retryErr.message);
      }
    }
    return false;
  }
}

function makeKey(userId, deviceId) {
  return `${userId}-${deviceId}`;
}

// Standard payload creator - SAME shape for all events
function createBubblePayload({
  userId,
  deviceId,
  deviceName,
  hvacStatus,          // "HEATING","COOLING","OFF"
  mode,                // "HEAT","COOL","HEAT_COOL","OFF"
  currentTemp,
  coolSetpoint,
  heatSetpoint,
  timestampIso,
  eventId,
  eventTimeMs,
  runtimeSeconds = 0,
  isRuntimeEvent = false,
  sessionData = null
}) {
  return {
    // User and device info
    userId,
    thermostatId: deviceId,
    deviceName,

    // Runtime data (0 for temperature updates, actual for runtime events)
    runtimeSeconds,
    runtimeMinutes: Math.round(runtimeSeconds / 60),
    isRuntimeEvent,

    // Current status
    hvacMode: hvacStatus,     // "HEATING", "COOLING", "OFF"
    thermostatMode: mode,     // "HEAT", "COOL", "HEAT_COOL", "OFF"

    // Temperature data (F)
    currentTempF: currentTemp != null ? celsiusToFahrenheit(currentTemp) : null,
    coolSetpointF: coolSetpoint != null ? celsiusToFahrenheit(coolSetpoint) : null,
    heatSetpointF: heatSetpoint != null ? celsiusToFahrenheit(heatSetpoint) : null,

    // Session start temperatures (only meaningful for runtime events)
    startTempF: sessionData?.startTemp != null ? celsiusToFahrenheit(sessionData.startTemp) : null,
    endTempF: currentTemp != null ? celsiusToFahrenheit(currentTemp) : null,

    // Raw celsius values
    currentTempC: currentTemp ?? null,
    coolSetpointC: coolSetpoint ?? null,
    heatSetpointC: heatSetpoint ?? null,
    startTempC: sessionData?.startTemp ?? null,
    endTempC: currentTemp ?? null,

    // Timestamps
    timestamp: timestampIso,
    eventId,
    eventTimestamp: eventTimeMs
  };
}

async function handleEvent(eventData) {
  // Extract data from Nest event structure
  const userId = eventData.userId;
  const deviceName = eventData.resourceUpdate?.name;
  const traits = eventData.resourceUpdate?.traits;
  const timestampIso = eventData.timestamp;

  // Extract device ID from the long device name
  const deviceId = deviceName?.split('/').pop();

  // Get HVAC status and temperature data
  const hvacStatus = traits?.['sdm.devices.traits.ThermostatHvac']?.status; // "HEATING", "COOLING", "OFF"
  const currentTemp = traits?.['sdm.devices.traits.Temperature']?.ambientTemperatureCelsius;
  const coolSetpoint = traits?.['sdm.devices.traits.ThermostatTemperatureSetpoint']?.coolCelsius;
  const heatSetpoint = traits?.['sdm.devices.traits.ThermostatTemperatureSetpoint']?.heatCelsius;
  const mode = traits?.['sdm.devices.traits.ThermostatMode']?.mode;

  // Validation
  if (!userId || !deviceId || !hvacStatus || !timestampIso) {
    console.warn('⚠️ Skipping incomplete Nest event');
    return;
  }

  const key = makeKey(userId, deviceId);
  const eventTimeMs = toTimestamp(timestampIso);

  // Determine activity
  const isActive = hvacStatus === 'HEATING' || hvacStatus === 'COOLING';
  const wasActive = deviceStates[key]?.isActive || false;

  // Sessions
  let payload;

  if (isActive && !wasActive) {
    // Turned on — start session
    sessions[key] = {
      startTime: eventTimeMs,
      startStatus: hvacStatus,
      startTemp: currentTemp
    };
    console.log(`🟢 Starting ${hvacStatus} session for ${key}`);

    payload = createBubblePayload({
      userId, deviceId, deviceName,
      hvacStatus, mode, currentTemp, coolSetpoint, heatSetpoint,
      timestampIso, eventId: eventData.eventId, eventTimeMs,
      runtimeSeconds: 0, isRuntimeEvent: false
    });

  } else if (!isActive && wasActive) {
    // Turned off — end session
    const session = sessions[key];
    if (session) {
      const runtimeSeconds = Math.floor((eventTimeMs - session.startTime) / 1000);
      if (runtimeSeconds > 0 && runtimeSeconds < 86400) {
        delete sessions[key];
        payload = createBubblePayload({
          userId, deviceId, deviceName,
          hvacStatus, mode, currentTemp, coolSetpoint, heatSetpoint,
          timestampIso, eventId: eventData.eventId, eventTimeMs,
          runtimeSeconds, isRuntimeEvent: true, sessionData: session
        });
      } else {
        console.warn(`⚠️ Invalid runtime ${runtimeSeconds}s for ${key}, sending temp update instead`);
        delete sessions[key];
        payload = createBubblePayload({
          userId, deviceId, deviceName,
          hvacStatus, mode, currentTemp, coolSetpoint, heatSetpoint,
          timestampIso, eventId: eventData.eventId, eventTimeMs,
          runtimeSeconds: 0, isRuntimeEvent: false
        });
      }
    } else {
      payload = createBubblePayload({
        userId, deviceId, deviceName,
        hvacStatus, mode, currentTemp, coolSetpoint, heatSetpoint,
        timestampIso, eventId: eventData.eventId, eventTimeMs,
        runtimeSeconds: 0, isRuntimeEvent: false
      });
    }
  } else if (isActive && !sessions[key]) {
    // Active but we lost session (restart)
    sessions[key] = {
      startTime: eventTimeMs,
      startStatus: hvacStatus,
      startTemp: currentTemp
    };
    console.log(`🔄 Restarting ${hvacStatus} session for ${key}`);

    payload = createBubblePayload({
      userId, deviceId, deviceName,
      hvacStatus, mode, currentTemp, coolSetpoint, heatSetpoint,
      timestampIso, eventId: eventData.eventId, eventTimeMs,
      runtimeSeconds: 0, isRuntimeEvent: false
    });
  } else {
    // No state change — temp/setpoint update
    const lastPostedTempC = deviceStates[key]?.lastPostedTempC;
    const tempDelta = (currentTemp != null && lastPostedTempC != null)
      ? Math.abs(currentTemp - lastPostedTempC)
      : Infinity; // if unknown, go ahead and post

    // Post always on event, but this flag can be used to short-circuit if you ever want throttling
    const shouldPost = true /* always */ || tempDelta >= TEMP_CHANGE_C_THRESHOLD;

    if (!shouldPost) return;

    payload = createBubblePayload({
      userId, deviceId, deviceName,
      hvacStatus, mode, currentTemp, coolSetpoint, heatSetpoint,
      timestampIso, eventId: eventData.eventId, eventTimeMs,
      runtimeSeconds: 0, isRuntimeEvent: false
    });
  }

  // Send
  const ok = await sendToBubble(payload);

  // Track state for next time
  const now = Date.now();
  deviceStates[key] = {
    ...deviceStates[key],
    userId,
    deviceId,
    deviceName,
    isActive,
    status: hvacStatus,
    mode,
    currentTemp,
    coolSetpoint,
    heatSetpoint,
    lastUpdate: eventTimeMs,
    lastPostTime: ok ? now : (deviceStates[key]?.lastPostTime ?? 0),
    lastPostedTempC: ok ? currentTemp : (deviceStates[key]?.lastPostedTempC ?? null)
  };
}

// ---------------- Heartbeat: ensure at-least-every-N-seconds posts ----------------
setInterval(async () => {
  const now = Date.now();
  for (const [key, state] of Object.entries(deviceStates)) {
    // Only heartbeat if we have enough info to build a payload
    if (!state?.userId || !state?.deviceId || !state?.status) continue;

    const tooLongSincePost = !state.lastPostTime || (now - state.lastPostTime >= MIN_POST_INTERVAL_MS);

    // Heartbeat even if OFF to keep Bubble fresh, but this is easy to switch to "only when active"
    if (tooLongSincePost) {
      const timestampIso = new Date(now).toISOString();
      const eventTimeMs = now;
      const payload = createBubblePayload({
        userId: state.userId,
        deviceId: state.deviceId,
        deviceName: state.deviceName,
        hvacStatus: state.status,
        mode: state.mode,
        currentTemp: state.currentTemp,
        coolSetpoint: state.coolSetpoint,
        heatSetpoint: state.heatSetpoint,
        timestampIso,
        eventId: `heartbeat-${state.deviceId}-${now}`,
        eventTimeMs,
        runtimeSeconds: 0,
        isRuntimeEvent: false,
        sessionData: sessions[key] || null
      });

      const ok = await sendToBubble(payload);
      if (ok) {
        deviceStates[key].lastPostTime = now;
        deviceStates[key].lastPostedTempC = state.currentTemp;
      }
    }
  }
}, HEARTBEAT_INTERVAL_MS);

// ---------------- Cleanup (same as your Enode version) ----------------
setInterval(() => {
  const sixHoursAgo = Date.now() - (6 * 60 * 60 * 1000);
  let cleaned = 0;

  for (const [key, session] of Object.entries(sessions)) {
    const sessionTime = session.startTime || session;
    if (sessionTime < sixHoursAgo) {
      delete sessions[key];
      delete deviceStates[key];
      cleaned++;
    }
  }

  if (cleaned > 0) {
    console.log(`🧹 Cleaned up ${cleaned} old Nest sessions`);
  }
}, 6 * 60 * 60 * 1000); // Every 6 hours

module.exports = { handleEvent };
