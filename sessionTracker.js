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

console.log(‘✅ Nest configuration validated’);
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
console.error(‘❌ Failed to send to Bubble:’, {
deviceId: payload.thermostatId,
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

// DEEP OBJECT EXPLORER
function exploreObject(obj, path = ‘’, maxDepth = 5, currentDepth = 0) {
if (currentDepth >= maxDepth || obj === null || obj === undefined) {
return;
}

if (typeof obj === ‘object’ && !Array.isArray(obj)) {
for (const [key, value] of Object.entries(obj)) {
const newPath = path ? `${path}.${key}` : key;
console.log(`  ${' '.repeat(currentDepth * 2)}${newPath}: ${typeof value} = ${JSON.stringify(value)}`);

```
  if (typeof value === 'object' && value !== null) {
    exploreObject(value, newPath, maxDepth, currentDepth + 1);
  }
}
```

} else if (Array.isArray(obj)) {
console.log(`  ${' '.repeat(currentDepth * 2)}${path}: Array[${obj.length}]`);
obj.forEach((item, index) => {
const newPath = `${path}[${index}]`;
console.log(`  ${' '.repeat((currentDepth + 1) * 2)}${newPath}: ${typeof item} = ${JSON.stringify(item)}`);
if (typeof item === ‘object’ && item !== null) {
exploreObject(item, newPath, maxDepth, currentDepth + 2);
}
});
}
}

// FIND ALL TEMPERATURE-RELATED FIELDS
function findTemperatureFields(obj, path = ‘’) {
const tempFields = [];

function search(current, currentPath) {
if (current === null || current === undefined) return;

```
if (typeof current === 'object') {
  for (const [key, value] of Object.entries(current)) {
    const newPath = currentPath ? `${currentPath}.${key}` : key;
    
    // Check if this could be a temperature field
    if (key.toLowerCase().includes('temp') || 
        key.toLowerCase().includes('celsius') || 
        key.toLowerCase().includes('fahrenheit') ||
        (typeof value === 'number' && value > -50 && value < 50)) {
      tempFields.push({
        path: newPath,
        key: key,
        value: value,
        type: typeof value
      });
    }
    
    if (typeof value === 'object' && value !== null) {
      search(value, newPath);
    }
  }
}
```

}

search(obj, path);
return tempFields;
}

// MAIN EVENT HANDLER WITH COMPREHENSIVE LOGGING
async function handleEvent(eventData) {
console.log(’\n’ + ‘═’.repeat(100));
console.log(`🔵 Processing Nest event: ${eventData.eventId || 'no-event-id'}`);
console.log(‘═’.repeat(100));

// STEP 1: LOG THE COMPLETE RAW EVENT
console.log(‘📥 COMPLETE RAW EVENT DATA:’);
console.log(‘─’.repeat(80));
try {
console.log(JSON.stringify(eventData, null, 2));
} catch (e) {
console.log(‘❌ Could not stringify event data:’, e.message);
console.log(‘Direct log:’);
console.log(eventData);
}

// STEP 2: EXPLORE THE OBJECT STRUCTURE
console.log(’\n🔍 OBJECT STRUCTURE EXPLORATION:’);
console.log(‘─’.repeat(80));
exploreObject(eventData);

// STEP 3: FIND ALL TEMPERATURE-LIKE FIELDS
console.log(’\n🌡️ TEMPERATURE FIELD SEARCH:’);
console.log(‘─’.repeat(80));
const tempFields = findTemperatureFields(eventData);
if (tempFields.length > 0) {
console.log(‘Found potential temperature fields:’);
tempFields.forEach(field => {
console.log(`  - ${field.path}: ${field.value} (${field.type})`);
});
} else {
console.log(‘❌ No temperature-like fields found!’);
}

// STEP 4: CHECK ALL POSSIBLE TRAIT LOCATIONS
console.log(’\n🔍 TRAIT LOCATION CHECK:’);
console.log(‘─’.repeat(80));

const traitPaths = [
‘resourceUpdate.traits’,
‘traits’,
‘data.traits’,
‘resourceUpdate.data.traits’,
‘device.traits’,
‘update.traits’
];

let foundTraits = null;
let traitsPath = null;

for (const path of traitPaths) {
const parts = path.split(’.’);
let current = eventData;

```
for (const part of parts) {
  if (current && typeof current === 'object' && part in current) {
    current = current[part];
  } else {
    current = null;
    break;
  }
}

if (current && typeof current === 'object') {
  console.log(`✅ Found traits at: ${path}`);
  console.log('Available trait keys:', Object.keys(current));
  foundTraits = current;
  traitsPath = path;
  break;
} else {
  console.log(`❌ No traits found at: ${path}`);
}
```

}

// STEP 5: EXAMINE TRAITS IN DETAIL
if (foundTraits) {
console.log(`\n🔍 DETAILED TRAITS ANALYSIS (from ${traitsPath}):`);
console.log(‘─’.repeat(80));

```
for (const [traitName, traitData] of Object.entries(foundTraits)) {
  console.log(`\nTrait: ${traitName}`);
  console.log(`Data:`, JSON.stringify(traitData, null, 2));
  
  // Look for temperature data in this trait
  if (traitData && typeof traitData === 'object') {
    const traitTempFields = findTemperatureFields(traitData, traitName);
    if (traitTempFields.length > 0) {
      console.log('🌡️ Temperature fields in this trait:');
      traitTempFields.forEach(field => {
        console.log(`  - ${field.path}: ${field.value}`);
      });
    }
  }
}
```

}

// STEP 6: TRY STANDARD EXTRACTION (ORIGINAL CODE)
console.log(’\n🔍 STANDARD EXTRACTION ATTEMPT:’);
console.log(‘─’.repeat(80));

const userId = eventData.userId;
const resourceUpdate = eventData.resourceUpdate;
const deviceName = resourceUpdate?.name;
const traits = resourceUpdate?.traits;
const timestampIso = eventData.timestamp;

console.log(‘Basic fields:’);
console.log(`- userId: ${userId}`);
console.log(`- deviceName: ${deviceName}`);
console.log(`- timestamp: ${timestampIso}`);
console.log(`- has resourceUpdate: ${!!resourceUpdate}`);
console.log(`- has traits: ${!!traits}`);

if (traits) {
const hvacTrait = traits[‘sdm.devices.traits.ThermostatHvac’];
const tempTrait = traits[‘sdm.devices.traits.Temperature’];
const setpointTrait = traits[‘sdm.devices.traits.ThermostatTemperatureSetpoint’];
const modeTrait = traits[‘sdm.devices.traits.ThermostatMode’];

```
console.log('\nTrait extraction:');
console.log(`- ThermostatHvac: ${JSON.stringify(hvacTrait)}`);
console.log(`- Temperature: ${JSON.stringify(tempTrait)}`);
console.log(`- ThermostatTemperatureSetpoint: ${JSON.stringify(setpointTrait)}`);
console.log(`- ThermostatMode: ${JSON.stringify(modeTrait)}`);

const hvacStatus = hvacTrait?.status;
const currentTemp = tempTrait?.ambientTemperatureCelsius;
const coolSetpoint = setpointTrait?.coolCelsius;
const heatSetpoint = setpointTrait?.heatCelsius;
const mode = modeTrait?.mode;

console.log('\nExtracted values:');
console.log(`- hvacStatus: ${hvacStatus}`);
console.log(`- currentTemp: ${currentTemp}`);
console.log(`- coolSetpoint: ${coolSetpoint}`);
console.log(`- heatSetpoint: ${heatSetpoint}`);
console.log(`- mode: ${mode}`);

// CONTINUE WITH THE REST OF YOUR LOGIC HERE...
// For now, let's just focus on getting the raw data
```

}

console.log(‘═’.repeat(100));
console.log(‘🔵 END OF RAW EVENT ANALYSIS’);
console.log(‘═’.repeat(100) + ‘\n’);

// Don’t actually process the event yet - just log everything
console.log(‘⏸️ Event processing paused for analysis’);
}

module.exports = {
handleEvent
};
