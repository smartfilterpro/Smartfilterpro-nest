const axios = require(‘axios’);

// Session storage (same pattern as Enode)
const sessions = {};
const deviceStates = {}; // Track previous HVAC state

function toTimestamp(dateStr) {
return new Date(dateStr).getTime();
}

function celsiusToFahrenheit(celsius) {
return Math.round((celsius * 9/5) + 32);
}

async function handleEvent(eventData) {
// Extract data from Nest event structure
const userId = eventData.userId;
const deviceName = eventData.resourceUpdate?.name;
const traits = eventData.resourceUpdate?.traits;
const timestamp = eventData.timestamp;

// Extract device ID from the long device name
const deviceId = deviceName?.split(’/’).pop();

// Get HVAC status and temperature data
const hvacStatus = traits?.[‘sdm.devices.traits.ThermostatHvac’]?.status; // “HEATING”, “COOLING”, “OFF”
const currentTemp = traits?.[‘sdm.devices.traits.Temperature’]?.ambientTemperatureCelsius;
const coolSetpoint = traits?.[‘sdm.devices.traits.ThermostatTemperatureSetpoint’]?.coolCelsius;
const heatSetpoint = traits?.[‘sdm.devices.traits.ThermostatTemperatureSetpoint’]?.heatCelsius;
const mode = traits?.[‘sdm.devices.traits.ThermostatMode’]?.mode;

// Validation (similar to your Enode validation)
if (!userId || !deviceId || !hvacStatus || !timestamp) {
console.warn(‘⚠️ Skipping incomplete Nest event’);
return;
}

const key = `${userId}-${deviceId}`;
const eventTime = toTimestamp(timestamp);

// Determine if HVAC is active (heating or cooling)
const isActive = hvacStatus === ‘HEATING’ || hvacStatus === ‘COOLING’;
const wasActive = deviceStates[key]?.isActive || false;
const previousStatus = deviceStates[key]?.status || ‘OFF’;

if (isActive && !wasActive) {
// Just turned on - start new session
sessions[key] = {
startTime: eventTime,
startStatus: hvacStatus,
startTemp: currentTemp
};
console.log(`🟢 Starting ${hvacStatus} session for ${key}`);

} else if (!isActive && wasActive) {
// Just turned off - calculate runtime
const session = sessions[key];
if (session) {
const runtimeSeconds = Math.floor((eventTime - session.startTime) / 1000);

```
  // Basic validation (same as your Enode logic)
  if (runtimeSeconds > 0 && runtimeSeconds < 86400) { // 0 to 24 hours
    delete sessions[key];

    // Payload for Bubble (similar structure to your Enode payload)
    const payload = {
      userId,
      thermostatId: deviceId,
      deviceName: deviceName,
      runtimeSeconds,
      runtimeMinutes: Math.round(runtimeSeconds / 60),
      timestamp,
      
      // HVAC specific data
      hvacMode: session.startStatus, // "HEATING" or "COOLING"
      thermostatMode: mode, // "HEAT", "COOL", "HEAT_COOL", "OFF"
      
      // Temperature data (converted to Fahrenheit)
      startTempF: session.startTemp ? celsiusToFahrenheit(session.startTemp) : null,
      endTempF: currentTemp ? celsiusToFahrenheit(currentTemp) : null,
      coolSetpointF: coolSetpoint ? celsiusToFahrenheit(coolSetpoint) : null,
      heatSetpointF: heatSetpoint ? celsiusToFahrenheit(heatSetpoint) : null,
      
      // Raw celsius values (if needed)
      startTempC: session.startTemp,
      endTempC: currentTemp,
      coolSetpointC: coolSetpoint,
      heatSetpointC: heatSetpoint,
      
      // Event metadata
      eventId: eventData.eventId,
      eventTimestamp: eventTime
    };

    try {
      // Send to Bubble (same pattern as your Enode code)
      await axios.post(process.env.BUBBLE_WEBHOOK_URL, payload);
      console.log('✅ Sent Nest runtime to Bubble:', payload);
    } catch (err) {
      console.error('❌ Failed to send to Bubble:', err.response?.data || err.message);
      
      // Retry logic (same as your Enode code)
      if (err.code === 'ECONNABORTED' || err.code === 'ENOTFOUND') {
        console.log('🔄 Retrying in 5 seconds...');
        setTimeout(async () => {
          try {
            await axios.post(process.env.BUBBLE_WEBHOOK_URL, payload);
            console.log('✅ Retry successful:', payload);
          } catch (retryErr) {
            console.error('❌ Retry failed:', retryErr.message);
          }
        }, 5000);
      }
    }
  } else {
    console.warn(`⚠️ Invalid runtime ${runtimeSeconds}s for ${key}, skipping`);
    delete sessions[key];
  }
}
```

} else if (isActive && !sessions[key]) {
// System is active but no session start (after restart)
sessions[key] = {
startTime: eventTime,
startStatus: hvacStatus,
startTemp: currentTemp
};
console.log(`🔄 Restarting ${hvacStatus} session for ${key}`);
}

// Track current state for next event (enhanced from your Enode version)
deviceStates[key] = {
isActive,
status: hvacStatus,
temp: currentTemp,
lastUpdate: eventTime
};
}

// Cleanup logic (same as your Enode version)
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

module.exports = {
handleEvent
};