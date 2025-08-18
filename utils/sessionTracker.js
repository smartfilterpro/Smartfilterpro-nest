const axios = require(‘axios’);

// —————– Config knobs —————–
const MIN_POST_INTERVAL_MS = 60_000;         // ensure at least one post per device per minute
const TEMP_CHANGE_C_THRESHOLD = 0.1;         // post if ambient temp changes by ≥ 0.1°C
const SETPOINT_CHANGE_C_THRESHOLD = 0.1;     // post if setpoint changes by ≥ 0.1°C
const HEARTBEAT_INTERVAL_MS = 10_000;        // how often to scan for stale devices to post
const MAX_RUNTIME_HOURS = 24;               // maximum reasonable runtime
const MIN_RUNTIME_SECONDS = 5;              // minimum runtime to consider valid
// ————————————————

// Session storage
const sessions = {};
const deviceStates = {}; // Track previous HVAC state + last post info

// Add configuration validation
function validateConfiguration() {
const required = [‘BUBBLE_WEBHOOK_URL’];
const missing = required.filter(key => !process.env[key]);

if (missing.length > 0) {
throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
}

console.log(‘✅ Nest configuration validated:’, {
bubbleUrl: process.env.BUBBLE_WEBHOOK_URL,
tempThreshold: `${TEMP_CHANGE_C_THRESHOLD}°C`,
setpointThreshold: `${SETPOINT_CHANGE_C_THRESHOLD}°C`,
minPostInterval: `${MIN_POST_INTERVAL_MS/1000}s`,
heartbeatInterval: `${HEARTBEAT_INTERVAL_MS/1000}s`,
debugMode: process.env.DEBUG_NEST_EVENTS === “1”
});
}

// Call on module load
validateConfiguration();

function toTimestamp(dateStr) {
if (!dateStr || typeof dateStr !== ‘string’) {
console.warn(‘⚠️ Invalid timestamp string:’, dateStr);
return Date.now();
}

const timestamp = new Date(dateStr).getTime();
if (isNaN(timestamp)) {
console.warn(‘⚠️ Could not parse timestamp:’, dateStr);
return Date.now();
}

return timestamp;
}

function celsiusToFahrenheit(celsius) {
if (celsius == null || !Number.isFinite(celsius)) {
return null;
}
return Math.round((celsius * 9/5) + 32);
}

function shouldRetry(err) {
const networkErrors = [‘ECONNABORTED’, ‘ENOTFOUND’, ‘ECONNRESET’, ‘EAI_AGAIN’, ‘ETIMEDOUT’];
const retryableStatus = err.response?.status >= 500 || err.response?.status === 429;

return networkErrors.includes(err.code) || retryableStatus;
}

async function sendToBubble(payload, retryCount = 0) {
const maxRetries = 3;
const retryDelay = Math.min(1000 * Math.pow(2, retryCount), 10000);

try {
if (!payload || typeof payload !== ‘object’) {
console.error(‘❌ Invalid payload for Bubble:’, payload);
return false;
}

```
const response = await axios.post(process.env.BUBBLE_WEBHOOK_URL, payload, {
  timeout: 15000,
  headers: {
    'Content-Type': 'application/json',
    ...(process.env.BUBBLE_API_KEY ? { 'Authorization': `Bearer ${process.env.BUBBLE_API_KEY}` } : {})
  }
});

console.log('✅ Sent to Bubble:', {
  deviceId: payload.thermostatId,
  isRuntimeEvent: payload.isRuntimeEvent,
  currentTempF: payload.currentTempF,
  hvacMode: payload.hvacMode,
  runtimeSeconds: payload.runtimeSeconds
});
return true;
```

} catch (err) {
const isRetryable = shouldRetry(err);
const canRetry = retryCount < maxRetries && isRetryable;

```
console.error('❌ Failed to send to Bubble:', {
  deviceId: payload.thermostatId,
  error: err.response?.data || err.message,
  status: err.response?.status,
  code: err.code,
  retryCount,
  canRetry,
  retryable: isRetryable
});

if (canRetry) {
  console.log(`🔄 Retrying in ${retryDelay}ms... (attempt ${retryCount + 1}/${maxRetries})`);
  await new Promise(r => setTimeout(r, retryDelay));
  return sendToBubble(payload, retryCount + 1);
}

return false;
```

}
}

function makeKey(userId, deviceId) {
return `${userId}-${deviceId}`;
}

function shouldPostTemperatureUpdate(currentTemp, lastPostedTemp) {
if (currentTemp == null) return false;
if (lastPostedTemp == null) return true; // First reading

const delta = Math.abs(currentTemp - lastPostedTemp);
return delta >= TEMP_CHANGE_C_THRESHOLD;
}

function shouldPostSetpointUpdate(coolSetpoint, heatSetpoint, lastState) {
if (!lastState) return !!(coolSetpoint != null || heatSetpoint != null); // First reading

const coolChanged = coolSetpoint != null && lastState.lastPostedCoolSetpoint != null &&
Math.abs(coolSetpoint - lastState.lastPostedCoolSetpoint) >= SETPOINT_CHANGE_C_THRESHOLD;

const heatChanged = heatSetpoint != null && lastState.lastPostedHeatSetpoint != null &&
Math.abs(heatSetpoint - lastState.lastPostedHeatSetpoint) >= SETPOINT_CHANGE_C_THRESHOLD;

const newCoolSetpoint = coolSetpoint != null && lastState.lastPostedCoolSetpoint == null;
const newHeatSetpoint = heatSetpoint != null && lastState.lastPostedHeatSetpoint == null;

return coolChanged || heatChanged || newCoolSetpoint || newHeatSetpoint;
}

function getTempDelta(currentTemp, lastTemp) {
if (currentTemp == null || lastTemp == null) return null;
return Math.abs(currentTemp - lastTemp);
}

function validateTemperature(temp, context = ‘’) {
if (temp == null) return null;

if (!Number.isFinite(temp)) {
console.warn(`⚠️ Invalid temperature value ${context}: ${temp}`);
return null;
}

// Validate reasonable temperature ranges (in Celsius)
if (temp < -50 || temp > 80) {
console.warn(`⚠️ Temperature outside reasonable range ${context}: ${temp}°C`);
}

return temp;
}

// Standard payload creator
function createBubblePayload({
userId,
deviceId,
deviceName,
hvacStatus,          // “HEATING”,“COOLING”,“OFF”
mode,                // “HEAT”,“COOL”,“HEAT_COOL”,“OFF”
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
// Validate temperatures
const validCurrentTemp = validateTemperature(currentTemp, ‘currentTemp’);
const validCoolSetpoint = validateTemperature(coolSetpoint, ‘coolSetpoint’);
const validHeatSetpoint = validateTemperature(heatSetpoint, ‘heatSetpoint’);
const validStartTemp = validateTemperature(sessionData?.startTemp, ‘startTemp’);

return {
// User and device info
userId,
thermostatId: deviceId,
deviceName,

```
// Runtime data (0 for temperature updates, actual for runtime events)
runtimeSeconds,
runtimeMinutes: Math.round(runtimeSeconds / 60),
isRuntimeEvent,

// Current status
hvacMode: hvacStatus,     // "HEATING", "COOLING", "OFF"
thermostatMode: mode,     // "HEAT", "COOL", "HEAT_COOL", "OFF"
isHvacActive: hvacStatus === 'HEATING' || hvacStatus === 'COOLING',

// Temperature data (F)
currentTempF: celsiusToFahrenheit(validCurrentTemp),
coolSetpointF: celsiusToFahrenheit(validCoolSetpoint),
heatSetpointF: celsiusToFahrenheit(validHeatSetpoint),

// Session start temperatures (only meaningful for runtime events)
startTempF: celsiusToFahrenheit(validStartTemp),
endTempF: celsiusToFahrenheit(validCurrentTemp),

// Raw celsius values
currentTempC: validCurrentTemp,
coolSetpointC: validCoolSetpoint,
heatSetpointC: validHeatSetpoint,
startTempC: validStartTemp,
endTempC: validCurrentTemp,

// Timestamps
timestamp: timestampIso,
eventId,
eventTimestamp: eventTimeMs
```

};
}

async function handleTemperatureOnlyUpdate({
userId, deviceId, deviceName, currentTemp, coolSetpoint, heatSetpoint,
mode, timestampIso, eventData
}) {
const key = makeKey(userId, deviceId);
const lastState = deviceStates[key];

// Use last known HVAC status if we don’t have it in this event
const hvacStatus = lastState?.status || ‘OFF’;

const tempChanged = shouldPostTemperatureUpdate(currentTemp, lastState?.lastPostedTempC);
const setpointChanged = shouldPostSetpointUpdate(coolSetpoint, heatSetpoint, lastState);
const timeSinceLastPost = Date.now() - (lastState?.lastPostTime || 0);
const forcePostDueToTime = timeSinceLastPost >= MIN_POST_INTERVAL_MS;

if (!tempChanged && !setpointChanged && !forcePostDueToTime) {
if (process.env.DEBUG_NEST_EVENTS === “1”) {
console.log(`📊 Skipping temperature-only update for ${key}:`, {
tempDelta: getTempDelta(currentTemp, lastState?.lastPostedTempC)?.toFixed(3),
timeSincePost: Math.round(timeSinceLastPost/1000)
});
}
return;
}

console.log(`🌡️ Temperature/setpoint update for ${key}:`, {
tempChanged,
setpointChanged,
forcePostDueToTime,
currentTemp: currentTemp?.toFixed(1),
lastTemp: lastState?.lastPostedTempC?.toFixed(1)
});

const eventTimeMs = toTimestamp(timestampIso);
const payload = createBubblePayload({
userId, deviceId, deviceName,
hvacStatus, mode, currentTemp, coolSetpoint, heatSetpoint,
timestampIso, eventId: eventData.eventId, eventTimeMs,
runtimeSeconds: 0, isRuntimeEvent: false
});

const ok = await sendToBubble(payload);

// Update state
if (ok) {
const now = Date.now();
deviceStates[key] = {
…lastState,
userId, deviceId, deviceName,
currentTemp, coolSetpoint, heatSetpoint, mode,
lastUpdate: eventTimeMs,
lastPostTime: now,
lastPostedTempC: currentTemp,
lastPostedCoolSetpoint: coolSetpoint,
lastPostedHeatSetpoint: heatSetpoint,
eventCount: (lastState?.eventCount || 0) + 1
};
}
}

async function handleEvent(eventData) {
// Log the event we’re processing
console.log(`🔵 Processing Nest event: ${eventData.eventId || 'no-event-id'}`);

// Add comprehensive validation with better debugging
if (!eventData || typeof eventData !== ‘object’) {
console.warn(‘⚠️ Invalid event data received:’, typeof eventData);
return;
}

// Extract data with better error handling
const userId = eventData.userId;
const resourceUpdate = eventData.resourceUpdate;
const deviceName = resourceUpdate?.name;
const traits = resourceUpdate?.traits;
const timestampIso = eventData.timestamp;

// Log raw event for debugging
if (process.env.DEBUG_NEST_EVENTS === “1”) {
console.log(‘🧩 RAW NEST EVENT:’);
console.dir(eventData, { depth: null });
console.log(‘🔍 EXTRACTED DATA:’, {
userId,
deviceName,
hasTraits: !!traits,
timestampIso,
traitKeys: traits ? Object.keys(traits) : []
});
}

// Extract device ID more safely
let deviceId;
if (deviceName && typeof deviceName === ‘string’) {
const parts = deviceName.split(’/’);
deviceId = parts[parts.length - 1];
}

// More flexible validation - don’t require all fields immediately
if (!userId) {
console.warn(‘⚠️ Missing userId in Nest event’);
return;
}

if (!deviceId) {
console.warn(‘⚠️ Missing or invalid deviceId in Nest event:’, deviceName);
return;
}

if (!timestampIso) {
console.warn(‘⚠️ Missing timestamp in Nest event’);
return;
}

// Extract traits with validation - handle missing traits more gracefully
const hvacTrait = traits?.[‘sdm.devices.traits.ThermostatHvac’];
const tempTrait = traits?.[‘sdm.devices.traits.Temperature’];
const setpointTrait = traits?.[‘sdm.devices.traits.ThermostatTemperatureSetpoint’];
const modeTrait = traits?.[‘sdm.devices.traits.ThermostatMode’];

const hvacStatus = hvacTrait?.status;
const currentTemp = tempTrait?.ambientTemperatureCelsius;
const coolSetpoint = setpointTrait?.coolCelsius;
const heatSetpoint = setpointTrait?.heatCelsius;
const mode = modeTrait?.mode;

// Debug extracted values
if (process.env.DEBUG_NEST_EVENTS === “1”) {
console.log(‘🔍 EXTRACTED VALUES:’, {
hvacStatus,
currentTemp,
coolSetpoint,
heatSetpoint,
mode,
hasHvacTrait: !!hvacTrait,
hasTempTrait: !!tempTrait,
hasSetpointTrait: !!setpointTrait,
hasModeTrait: !!modeTrait
});
}

// Check if we have any meaningful data
const hasTemperature = currentTemp != null;
const hasSetpoints = coolSetpoint != null || heatSetpoint != null;
const hasHvacStatus = hvacStatus != null;
const hasMode = mode != null;

if (!hasTemperature && !hasSetpoints && !hasHvacStatus && !hasMode) {
console.warn(‘⚠️ Skipping incomplete Nest event - no temperature, setpoints, HVAC status, or mode’);
return;
}

// Handle cases where we don’t have HVAC status but have other data
if (!hasHvacStatus && (hasTemperature || hasSetpoints)) {
console.log(`🌡️ Temperature/setpoint-only event for ${deviceId}`);
await handleTemperatureOnlyUpdate({
userId, deviceId, deviceName, currentTemp, coolSetpoint, heatSetpoint,
mode, timestampIso, eventData
});
return;
}

// Continue with full event processing if we have HVAC status
if (!hasHvacStatus) {
console.warn(‘⚠️ Skipping event - no HVAC status and no temperature/setpoint data’);
return;
}

const key = makeKey(userId, deviceId);
const eventTimeMs = toTimestamp(timestampIso);

// Determine activity
const isActive = hvacStatus === ‘HEATING’ || hvacStatus === ‘COOLING’;
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
console.log(`🟢 Starting ${hvacStatus} session for ${key.substring(0, 16)}...`);

```
payload = createBubblePayload({
  userId, deviceId, deviceName,
  hvacStatus, mode, currentTemp, coolSetpoint, heatSetpoint,
  timestampIso, eventId: eventData.eventId, eventTimeMs,
  runtimeSeconds: 0, isRuntimeEvent: false
});
```

} else if (!isActive && wasActive) {
// Turned off — end session
const session = sessions[key];
if (session) {
const runtimeMs = eventTimeMs - session.startTime;
const runtimeSeconds = Math.floor(runtimeMs / 1000);

```
  // More robust runtime validation
  const maxRuntimeSeconds = MAX_RUNTIME_HOURS * 3600;
  if (runtimeSeconds >= MIN_RUNTIME_SECONDS && 
      runtimeSeconds <= maxRuntimeSeconds && 
      runtimeMs >= (MIN_RUNTIME_SECONDS * 1000)) {
    
    console.log(`🔴 Ending ${session.startStatus} session for ${key.substring(0, 16)}...: ${runtimeSeconds}s`);
    delete sessions[key];
    
    payload = createBubblePayload({
      userId, deviceId, deviceName,
      hvacStatus, mode, currentTemp, coolSetpoint, heatSetpoint,
      timestampIso, eventId: eventData.eventId, eventTimeMs,
      runtimeSeconds, isRuntimeEvent: true, sessionData: session
    });
  } else {
    console.warn(`⚠️ Invalid runtime ${runtimeSeconds}s (${runtimeMs}ms) for ${key}, sending temp update instead`);
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
```

} else if (isActive && !sessions[key]) {
// Active but we lost session (restart)
sessions[key] = {
startTime: eventTimeMs,
startStatus: hvacStatus,
startTemp: currentTemp
};
console.log(`🔄 Restarting ${hvacStatus} session for ${key.substring(0, 16)}...`);

```
payload = createBubblePayload({
  userId, deviceId, deviceName,
  hvacStatus, mode, currentTemp, coolSetpoint, heatSetpoint,
  timestampIso, eventId: eventData.eventId, eventTimeMs,
  runtimeSeconds: 0, isRuntimeEvent: false
});
```

} else {
// No state change — check if we should post temperature update
const lastState = deviceStates[key];
const tempChanged = shouldPostTemperatureUpdate(currentTemp, lastState?.lastPostedTempC);
const setpointChanged = shouldPostSetpointUpdate(coolSetpoint, heatSetpoint, lastState);
const timeSinceLastPost = Date.now() - (lastState?.lastPostTime || 0);
const forcePostDueToTime = timeSinceLastPost >= MIN_POST_INTERVAL_MS;

```
if (!tempChanged && !setpointChanged && !forcePostDueToTime) {
  if (process.env.DEBUG_NEST_EVENTS === "1") {
    console.log(`📊 Skipping update for ${key}:`, {
      tempDelta: getTempDelta(currentTemp, lastState?.lastPostedTempC)?.toFixed(3),
      timeSincePost: Math.round(timeSinceLastPost/1000)
    });
  }
  return;
}

console.log(`🌡️ Temperature/setpoint update for ${key.substring(0, 16)}...:`, {
  tempChanged,
  setpointChanged, 
  forcePostDueToTime,
  currentTemp: currentTemp?.toFixed(1),
  lastTemp: lastState?.lastPostedTempC?.toFixed(1)
});

payload = createBubblePayload({
  userId, deviceId, deviceName,
  hvacStatus, mode, currentTemp, coolSetpoint, heatSetpoint,
  timestampIso, eventId: eventData.eventId, eventTimeMs,
  runtimeSeconds: 0, isRuntimeEvent: false
});
```

}

// Send
const ok = await sendToBubble(payload);

// Track state for next time
const now = Date.now();
deviceStates[key] = {
…deviceStates[key],
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
lastPostedTempC: ok ? currentTemp : (deviceStates[key]?.lastPostedTempC ?? null),
lastPostedCoolSetpoint: ok ? coolSetpoint : (deviceStates[key]?.lastPostedCoolSetpoint ?? null),
lastPostedHeatSetpoint: ok ? heatSetpoint : (deviceStates[key]?.lastPostedHeatSetpoint ?? null),
eventCount: (deviceStates[key]?.eventCount || 0) + 1
};
}

// –––––––– Heartbeat: ensure at-least-every-N-seconds posts ––––––––
setInterval(async () => {
const now = Date.now();
for (const [key, state] of Object.entries(deviceStates)) {
// Only heartbeat if we have enough info to build a payload
if (!state?.userId || !state?.deviceId || !state?.status) continue;

```
const tooLongSincePost = !state.lastPostTime || (now - state.lastPostTime >= MIN_POST_INTERVAL_MS);

// Heartbeat even if OFF to keep Bubble fresh
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
    deviceStates[key].lastPostedCoolSetpoint = state.coolSetpoint;
    deviceStates[key].lastPostedHeatSetpoint = state.heatSetpoint;
    
    if (process.env.DEBUG_NEST_EVENTS === "1") {
      console.log(`💓 Heartbeat sent for ${key}`);
    }
  }
}
```

}
}, HEARTBEAT_INTERVAL_MS);

// –––––––– Cleanup ––––––––
setInterval(() => {
const sixHoursAgo = Date.now() - (6 * 60 * 60 * 1000);
const oneDayAgo = Date.now() - (24 * 60 * 60 * 1000);
let cleanedSessions = 0;
let cleanedStates = 0;

// Clean up old sessions
for (const [key, session] of Object.entries(sessions)) {
const sessionTime = session.startTime || session;
if (sessionTime < sixHoursAgo) {
delete sessions[key];
cleanedSessions++;
}
}

// Clean up very old device states (but keep recent ones for state tracking)
for (const [key, state] of Object.entries(deviceStates)) {
if (state.lastUpdate && state.lastUpdate < oneDayAgo) {
delete deviceStates[key];
cleanedStates++;
}
}

if (cleanedSessions > 0 || cleanedStates > 0) {
console.log(`🧹 Cleaned up ${cleanedSessions} old sessions and ${cleanedStates} old device states`);
}
}, 6 * 60 * 60 * 1000); // Every 6 hours

// Export for use
module.exports = {
handleEvent,
// Expose for testing
shouldPostTemperatureUpdate,
shouldPostSetpointUpdate,
validateTemperature,
celsiusToFahrenheit
};