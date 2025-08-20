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

async function sendToBubble(payload, retryCount = 0) {
const maxRetries = 3;
const retryDelay = Math.min(1000 * Math.pow(2, retryCount), 10000);

try {
if (!payload || typeof payload !== ‘object’) {
console.error(‘❌ Invalid payload for Bubble:’, payload);
return false;
}

```
console.log('🚀 SENDING TO BUBBLE:', JSON.stringify(payload, null, 2));

const response = await axios.post(process.env.BUBBLE_WEBHOOK_URL, payload, {
  timeout: 15000,
  headers: {
    'Content-Type': 'application/json',
    ...(process.env.BUBBLE_API_KEY ? { 'Authorization': `Bearer ${process.env.BUBBLE_API_KEY}` } : {})
  }
});

console.log('✅ BUBBLE SUCCESS:', response.status, response.data);
return true;
```

} catch (err) {
console.error(‘❌ BUBBLE ERROR:’, {
error: err.response?.data || err.message,
status: err.response?.status,
code: err.code
});

```
if (retryCount < maxRetries) {
  console.log(`🔄 Retrying in ${retryDelay}ms...`);
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

// MAIN EVENT HANDLER - LOG EVERYTHING FIRST
async function handleEvent(eventData) {
// LOG ABSOLUTELY EVERYTHING FIRST - BEFORE ANY VALIDATION
console.log(’\n’ + ‘🟦’.repeat(50));
console.log(‘🔵 NEST EVENT RECEIVED’);
console.log(‘🟦’.repeat(50));

console.log(‘📥 TYPEOF eventData:’, typeof eventData);
console.log(‘📥 eventData === null:’, eventData === null);
console.log(‘📥 eventData === undefined:’, eventData === undefined);

if (eventData) {
console.log(‘📥 eventData.constructor:’, eventData.constructor?.name);
console.log(‘📥 Object.keys(eventData):’, Object.keys(eventData));
console.log(‘📥 JSON.stringify(eventData):’);
try {
console.log(JSON.stringify(eventData, null, 2));
} catch (e) {
console.log(‘❌ Could not stringify eventData:’, e.message);
console.log(‘📥 eventData (direct log):’);
console.log(eventData);
}
} else {
console.log(‘❌ eventData is null/undefined’);
}

// NOW TRY THE ORIGINAL VALIDATION
console.log(’\n📋 STARTING VALIDATION…’);

if (!eventData || typeof eventData !== ‘object’) {
console.error(‘❌ VALIDATION FAILED: eventData is not an object’);
console.log(’- eventData:’, eventData);
console.log(’- typeof eventData:’, typeof eventData);
return;
}

console.log(‘✅ eventData is an object, continuing…’);

// Check for the eventId that we see in the logs
const eventId = eventData.eventId;
console.log(‘🆔 eventId:’, eventId);

// Extract data
const userId = eventData.userId;
const resourceUpdate = eventData.resourceUpdate;
const deviceName = resourceUpdate?.name;
const traits = resourceUpdate?.traits;
const timestampIso = eventData.timestamp;

console.log(’\n📊 BASIC FIELD EXTRACTION:’);
console.log(’- userId:’, userId);
console.log(’- resourceUpdate exists:’, !!resourceUpdate);
console.log(’- deviceName:’, deviceName);
console.log(’- traits exists:’, !!traits);
console.log(’- timestampIso:’, timestampIso);

if (resourceUpdate) {
console.log(’- resourceUpdate keys:’, Object.keys(resourceUpdate));
console.log(’- resourceUpdate:’, JSON.stringify(resourceUpdate, null, 2));
}

if (traits) {
console.log(’- traits keys:’, Object.keys(traits));
console.log(’- traits:’, JSON.stringify(traits, null, 2));
}

// Extract device ID
let deviceId;
if (deviceName && typeof deviceName === ‘string’) {
const parts = deviceName.split(’/’);
deviceId = parts[parts.length - 1];
}

console.log(’\n🔍 DEVICE INFO:’);
console.log(’- deviceName:’, deviceName);
console.log(’- deviceId:’, deviceId);

// Extract trait values
let hvacStatus, currentTemp, coolSetpoint, heatSetpoint, mode;

if (traits) {
const hvacTrait = traits[‘sdm.devices.traits.ThermostatHvac’];
const tempTrait = traits[‘sdm.devices.traits.Temperature’];
const setpointTrait = traits[‘sdm.devices.traits.ThermostatTemperatureSetpoint’];
const modeTrait = traits[‘sdm.devices.traits.ThermostatMode’];

```
console.log('\n🔍 TRAIT EXTRACTION:');
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

console.log(’\n🎯 EXTRACTED VALUES:’);
console.log(’- hvacStatus:’, hvacStatus);
console.log(’- currentTemp:’, currentTemp);
console.log(’- coolSetpoint:’, coolSetpoint);
console.log(’- heatSetpoint:’, heatSetpoint);
console.log(’- mode:’, mode);

// Validation checks
console.log(’\n✅ VALIDATION CHECKS:’);
console.log(’- userId present:’, !!userId);
console.log(’- deviceId present:’, !!deviceId);
console.log(’- timestampIso present:’, !!timestampIso);

if (!userId) {
console.error(‘❌ Missing userId in Nest event’);
return;
}

if (!deviceId) {
console.error(‘❌ Missing or invalid deviceId in Nest event:’, deviceName);
return;
}

if (!timestampIso) {
console.error(‘❌ Missing timestamp in Nest event’);
return;
}

// Check data availability
const hasTemperature = currentTemp != null && Number.isFinite(currentTemp);
const hasSetpoints = (coolSetpoint != null && Number.isFinite(coolSetpoint)) ||
(heatSetpoint != null && Number.isFinite(heatSetpoint));
const hasHvacStatus = hvacStatus != null && hvacStatus !== ‘’;
const hasMode = mode != null && mode !== ‘’;

console.log(’\n🔍 DATA AVAILABILITY:’);
console.log(’- hasTemperature:’, hasTemperature, ‘(value:’, currentTemp, ‘)’);
console.log(’- hasSetpoints:’, hasSetpoints, ‘(cool:’, coolSetpoint, ‘, heat:’, heatSetpoint, ‘)’);
console.log(’- hasHvacStatus:’, hasHvacStatus, ‘(value:’, hvacStatus, ‘)’);
console.log(’- hasMode:’, hasMode, ‘(value:’, mode, ‘)’);

if (!hasTemperature && !hasSetpoints && !hasHvacStatus && !hasMode) {
console.warn(‘⚠️ SKIPPING: No useful data found in event’);
console.log(’- This is where your events are being rejected’);
console.log(’- Need at least one of: temperature, setpoints, hvac status, or mode’);
return;
}

console.log(‘🚀 PROCEEDING WITH SEND - Found useful data!’);

// Create and send payload
const key = makeKey(userId, deviceId);
const eventTimeMs = toTimestamp(timestampIso);

const payload = {
userId,
thermostatId: deviceId,
deviceName: deviceName || `device-${deviceId}`,
runtimeSeconds: 0,
runtimeMinutes: 0,
isRuntimeEvent: false,
hvacMode: hvacStatus || ‘UNKNOWN’,
thermostatMode: mode || ‘UNKNOWN’,
isHvacActive: hvacStatus === ‘HEATING’ || hvacStatus === ‘COOLING’,
currentTempF: celsiusToFahrenheit(currentTemp),
coolSetpointF: celsiusToFahrenheit(coolSetpoint),
heatSetpointF: celsiusToFahrenheit(heatSetpoint),
currentTempC: currentTemp,
coolSetpointC: coolSetpoint,
heatSetpointC: heatSetpoint,
timestamp: timestampIso,
eventId: eventId || `event-${Date.now()}`,
eventTimestamp: eventTimeMs
};

console.log(’\n🔧 CREATED PAYLOAD:’);
console.log(JSON.stringify(payload, null, 2));

const ok = await sendToBubble(payload);

if (ok) {
console.log(‘✅ SUCCESS: Data sent to Bubble!’);

```
// Update device state
const now = Date.now();
deviceStates[key] = {
  userId,
  deviceId,
  deviceName: deviceName || `device-${deviceId}`,
  isActive: hvacStatus === 'HEATING' || hvacStatus === 'COOLING',
  status: hvacStatus || 'UNKNOWN',
  mode: mode || 'UNKNOWN',
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

console.log('✅ Updated device state for', key);
```

} else {
console.error(‘❌ FAILED: Could not send to Bubble’);
}

console.log(‘🟦’.repeat(50));
console.log(‘🔵 END NEST EVENT’);
console.log(‘🟦’.repeat(50) + ‘\n’);
}

// Simplified heartbeat for debugging
setInterval(async () => {
console.log(‘💓 Heartbeat check - deviceStates count:’, Object.keys(deviceStates).length);
}, HEARTBEAT_INTERVAL_MS);

module.exports = {
handleEvent
};