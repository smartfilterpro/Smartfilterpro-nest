const axios = require(‘axios’);

// —————– Config knobs —————–
const MIN_POST_INTERVAL_MS = 60_000;  
const TEMP_CHANGE_C_THRESHOLD = 0.1;  
const SETPOINT_CHANGE_C_THRESHOLD = 0.1;  
const HEARTBEAT_INTERVAL_MS = 10_000;  
const MAX_RUNTIME_HOURS = 24;  
const MIN_RUNTIME_SECONDS = 5;

// Session storage
const sessions = {};
const deviceStates = {};

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
// LOG THE PAYLOAD WE'RE SENDING
console.log('🚀 SENDING TO BUBBLE:', JSON.stringify(payload, null, 2));

const response = await axios.post(process.env.BUBBLE_WEBHOOK_URL, payload, {
  timeout: 15000,
  headers: {
    'Content-Type': 'application/json',
    ...(process.env.BUBBLE_API_KEY ? { 'Authorization': `Bearer ${process.env.BUBBLE_API_KEY}` } : {})
  }
});

console.log('✅ BUBBLE RESPONSE:', response.status, response.data);
console.log('✅ Sent to Bubble SUCCESS:', {
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
console.error('❌ BUBBLE ERROR:', {
  deviceId: payload.thermostatId,
  error: err.response?.data || err.message,
  status: err.response?.status,
  code: err.code,
  retryCount,
  canRetry,
  retryable: isRetryable,
  fullError: err.toJSON ? err.toJSON() : err
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
if (lastPostedTemp == null) return true;

const delta = Math.abs(currentTemp - lastPostedTemp);
return delta >= TEMP_CHANGE_C_THRESHOLD;
}

function shouldPostSetpointUpdate(coolSetpoint, heatSetpoint, lastState) {
if (!lastState) return !!(coolSetpoint != null || heatSetpoint != null);

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

if (temp < -50 || temp > 80) {
console.warn(`⚠️ Temperature outside reasonable range ${context}: ${temp}°C`);
}

return temp;
}

function createBubblePayload({
userId,
deviceId,
deviceName,
hvacStatus,
mode,
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
const validCurrentTemp = validateTemperature(currentTemp, ‘currentTemp’);
const validCoolSetpoint = validateTemperature(coolSetpoint, ‘coolSetpoint’);
const validHeatSetpoint = validateTemperature(heatSetpoint, ‘heatSetpoint’);
const validStartTemp = validateTemperature(sessionData?.startTemp, ‘startTemp’);

const payload = {
userId,
thermostatId: deviceId,
deviceName,
runtimeSeconds,
runtimeMinutes: Math.round(runtimeSeconds / 60),
isRuntimeEvent,
hvacMode: hvacStatus,
thermostatMode: mode,
isHvacActive: hvacStatus === ‘HEATING’ || hvacStatus === ‘COOLING’,
currentTempF: celsiusToFahrenheit(validCurrentTemp),
coolSetpointF: celsiusToFahrenheit(validCoolSetpoint),
heatSetpointF: celsiusToFahrenheit(validHeatSetpoint),
startTempF: celsiusToFahrenheit(validStartTemp),
endTempF: celsiusToFahrenheit(validCurrentTemp),
currentTempC: validCurrentTemp,
coolSetpointC: validCoolSetpoint,
heatSetpointC: validHeatSetpoint,
startTempC: validStartTemp,
endTempC: validCurrentTemp,
timestamp: timestampIso,
eventId,
eventTimestamp: eventTimeMs
};

console.log(‘🔧 CREATED PAYLOAD:’, JSON.stringify(payload, null, 2));
return payload;
}

// MAIN EVENT HANDLER WITH EXTREME DEBUGGING
async function handleEvent(eventData) {
console.log(’\n’ + ‘=’.repeat(80));
console.log(`🔵 PROCESSING NEST EVENT: ${eventData.eventId || 'no-event-id'}`);
console.log(’=’.repeat(80));

// LOG EVERYTHING ABOUT THE INCOMING EVENT
console.log(‘📥 RAW EVENT DATA:’);
console.log(JSON.stringify(eventData, null, 2));
console.log(‘📊 EVENT DATA ANALYSIS:’);
console.log(’- Type:’, typeof eventData);
console.log(’- Keys:’, Object.keys(eventData || {}));
console.log(’- Has resourceUpdate:’, !!eventData.resourceUpdate);
console.log(’- Has traits:’, !!eventData.resourceUpdate?.traits);
console.log(’- Has userId:’, !!eventData.userId);
console.log(’- Has timestamp:’, !!eventData.timestamp);

if (!eventData || typeof eventData !== ‘object’) {
console.error(‘❌ INVALID EVENT DATA’);
return;
}

// EXTRACT BASIC INFO
const userId = eventData.userId;
const timestampIso = eventData.timestamp;

console.log(‘🔍 BASIC EXTRACTION:’);
console.log(’- userId:’, userId);
console.log(’- timestamp:’, timestampIso);

// EXTRACT DEVICE INFO - TRY EVERY POSSIBLE LOCATION
let deviceName, deviceId;

console.log(‘🔍 DEVICE INFO EXTRACTION:’);

// Try resourceUpdate.name first
if (eventData.resourceUpdate?.name) {
deviceName = eventData.resourceUpdate.name;
console.log(’- Found deviceName in resourceUpdate.name:’, deviceName);
}

// Try other locations
if (!deviceName) {
deviceName = eventData.name || eventData.device?.name || eventData.deviceName;
console.log(’- Found deviceName in fallback location:’, deviceName);
}

if (deviceName && typeof deviceName === ‘string’) {
const parts = deviceName.split(’/’);
deviceId = parts[parts.length - 1];
console.log(’- Extracted deviceId from deviceName:’, deviceId);
} else {
deviceId = eventData.deviceId || eventData.device?.id || eventData.resourceUpdate?.id;
console.log(’- Found deviceId in direct field:’, deviceId);
}

console.log(’- Final deviceName:’, deviceName);
console.log(’- Final deviceId:’, deviceId);

// EXTRACT TRAITS - TRY EVERY POSSIBLE LOCATION
let traits;

console.log(‘🔍 TRAITS EXTRACTION:’);

if (eventData.resourceUpdate?.traits) {
traits = eventData.resourceUpdate.traits;
console.log(’- Found traits in resourceUpdate.traits’);
} else if (eventData.traits) {
traits = eventData.traits;
console.log(’- Found traits in direct traits field’);
} else if (eventData.data?.traits) {
traits = eventData.data.traits;
console.log(’- Found traits in data.traits’);
} else if (eventData.resourceUpdate?.data?.traits) {
traits = eventData.resourceUpdate.data.traits;
console.log(’- Found traits in resourceUpdate.data.traits’);
}

console.log(’- Traits found:’, !!traits);
console.log(’- Traits type:’, typeof traits);
console.log(’- Traits keys:’, traits ? Object.keys(traits) : ‘none’);

if (traits) {
console.log(’- Full traits object:’);
console.log(JSON.stringify(traits, null, 2));
}

// EXTRACT INDIVIDUAL TRAIT VALUES
let hvacStatus, currentTemp, coolSetpoint, heatSetpoint, mode;

console.log(‘🔍 INDIVIDUAL TRAIT EXTRACTION:’);

if (traits) {
const hvacTrait = traits[‘sdm.devices.traits.ThermostatHvac’];
const tempTrait = traits[‘sdm.devices.traits.Temperature’];
const setpointTrait = traits[‘sdm.devices.traits.ThermostatTemperatureSetpoint’];
const modeTrait = traits[‘sdm.devices.traits.ThermostatMode’];

```
console.log('- hvacTrait:', JSON.stringify(hvacTrait, null, 2));
console.log('- tempTrait:', JSON.stringify(tempTrait, null, 2));
console.log('- setpointTrait:', JSON.stringify(setpointTrait, null, 2));
console.log('- modeTrait:', JSON.stringify(modeTrait, null, 2));

hvacStatus = hvacTrait?.status;
currentTemp = tempTrait?.ambientTemperatureCelsius;
coolSetpoint = setpointTrait?.coolCelsius;
heatSetpoint = setpointTrait?.heatCelsius;
mode = modeTrait?.mode;
```

}

console.log(‘🔍 FINAL EXTRACTED VALUES:’);
console.log(’- hvacStatus:’, hvacStatus);
console.log(’- currentTemp:’, currentTemp);
console.log(’- coolSetpoint:’, coolSetpoint);
console.log(’- heatSetpoint:’, heatSetpoint);
console.log(’- mode:’, mode);

// VALIDATION
console.log(‘🔍 VALIDATION:’);
console.log(’- Has userId:’, !!userId);
console.log(’- Has deviceId:’, !!deviceId);
console.log(’- Has timestampIso:’, !!timestampIso);
console.log(’- Has traits:’, !!traits);

if (!userId) {
console.error(‘❌ VALIDATION FAILED: Missing userId’);
return;
}

if (!deviceId) {
console.error(‘❌ VALIDATION FAILED: Missing deviceId’);
return;
}

if (!timestampIso) {
console.error(‘❌ VALIDATION FAILED: Missing timestamp’);
return;
}

if (!traits) {
console.error(‘❌ VALIDATION FAILED: Missing traits’);
return;
}

// CHECK WHAT DATA WE HAVE
const hasTemperature = currentTemp != null && Number.isFinite(currentTemp);
const hasSetpoints = (coolSetpoint != null && Number.isFinite(coolSetpoint)) ||
(heatSetpoint != null && Number.isFinite(heatSetpoint));
const hasHvacStatus = hvacStatus != null && hvacStatus !== ‘’;
const hasMode = mode != null && mode !== ‘’;

console.log(‘🔍 DATA AVAILABILITY:’);
console.log(’- hasTemperature:’, hasTemperature);
console.log(’- hasSetpoints:’, hasSetpoints);
console.log(’- hasHvacStatus:’, hasHvacStatus);
console.log(’- hasMode:’, hasMode);

// ALWAYS TRY TO SEND SOMETHING - EVEN IF INCOMPLETE
console.log(‘🚀 ATTEMPTING TO SEND DATA REGARDLESS…’);

const key = makeKey(userId, deviceId);
const eventTimeMs = toTimestamp(timestampIso);
const safeHvacStatus = hvacStatus || ‘UNKNOWN’;
const safeMode = mode || ‘UNKNOWN’;

// CREATE AND SEND PAYLOAD
const payload = createBubblePayload({
userId,
deviceId,
deviceName: deviceName || `device-${deviceId}`,
hvacStatus: safeHvacStatus,
mode: safeMode,
currentTemp,
coolSetpoint,
heatSetpoint,
timestampIso,
eventId: eventData.eventId || `event-${Date.now()}`,
eventTimeMs,
runtimeSeconds: 0,
isRuntimeEvent: false
});

console.log(‘🚀 ATTEMPTING SEND TO BUBBLE…’);
const ok = await sendToBubble(payload);

if (ok) {
console.log(‘✅ SUCCESSFULLY SENT TO BUBBLE!’);

```
// Update state
const now = Date.now();
deviceStates[key] = {
  ...deviceStates[key],
  userId,
  deviceId,
  deviceName: deviceName || `device-${deviceId}`,
  isActive: safeHvacStatus === 'HEATING' || safeHvacStatus === 'COOLING',
  status: safeHvacStatus,
  mode: safeMode,
  currentTemp,
  coolSetpoint,
  heatSetpoint,
  lastUpdate: eventTimeMs,
  lastPostTime: now,
  lastPostedTempC: currentTemp,
  lastPostedCoolSetpoint: coolSetpoint,
  lastPostedHeatSetpoint: heatSetpoint,
  eventCount: (deviceStates[key]?.eventCount || 0) + 1
};

console.log('✅ UPDATED DEVICE STATE:', JSON.stringify(deviceStates[key], null, 2));
```

} else {
console.error(‘❌ FAILED TO SEND TO BUBBLE’);
}

console.log(’=’.repeat(80));
console.log(‘🔵 END OF EVENT PROCESSING’);
console.log(’=’.repeat(80) + ‘\n’);
}

// Heartbeat and cleanup (simplified for debugging)
setInterval(async () => {
console.log(‘💓 Heartbeat check…’);
const now = Date.now();
for (const [key, state] of Object.entries(deviceStates)) {
if (!state?.userId || !state?.deviceId) continue;

```
const tooLongSincePost = !state.lastPostTime || (now - state.lastPostTime >= MIN_POST_INTERVAL_MS);

if (tooLongSincePost) {
  console.log(`💓 Sending heartbeat for ${key}`);
  const timestampIso = new Date(now).toISOString();
  const eventTimeMs = now;
  const payload = createBubblePayload({
    userId: state.userId,
    deviceId: state.deviceId,
    deviceName: state.deviceName || `device-${state.deviceId}`,
    hvacStatus: state.status || 'OFF',
    mode: state.mode || 'OFF',
    currentTemp: state.currentTemp,
    coolSetpoint: state.coolSetpoint,
    heatSetpoint: state.heatSetpoint,
    timestampIso,
    eventId: `heartbeat-${state.deviceId}-${now}`,
    eventTimeMs,
    runtimeSeconds: 0,
    isRuntimeEvent: false
  });

  const ok = await sendToBubble(payload);
  if (ok) {
    deviceStates[key].lastPostTime = now;
  }
}
```

}
}, HEARTBEAT_INTERVAL_MS);

module.exports = {
handleEvent,
shouldPostTemperatureUpdate,
shouldPostSetpointUpdate,
validateTemperature,
celsiusToFahrenheit
};