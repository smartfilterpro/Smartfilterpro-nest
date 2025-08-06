const axios = require('axios');

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
  const deviceId = deviceName?.split('/').pop();
  
  // Get HVAC status and temperature data
  const hvacStatus = traits?.['sdm.devices.traits.ThermostatHvac']?.status; // "HEATING", "COOLING", "OFF"
  const currentTemp = traits?.['sdm.devices.traits.Temperature']?.ambientTemperatureCelsius;
  const coolSetpoint = traits?.['sdm.devices.traits.ThermostatTemperatureSetpoint']?.coolCelsius;
  const heatSetpoint = traits?.['sdm.devices.traits.ThermostatTemperatureSetpoint']?.heatCelsius;
  const mode = traits?.['sdm.devices.traits.ThermostatMode']?.mode;

  // Validation (similar to your Enode validation)
  if (!userId || !deviceId || !hvacStatus || !timestamp) {
    console.warn('⚠️ Skipping incomplete Nest event');
    return;
  }

  const key = `${userId}-${deviceId}`;
  const eventTime = toTimestamp(timestamp);
  
  // Determine if HVAC is active (heating or cooling)
  const isActive = hvacStatus === 'HEATING' || hvacStatus === 'COOLING';
  const wasActive = deviceStates[key]?.isActive || false;
  
  // Standard payload structure - SAME for all events sent to Bubble
  function createBubblePayload(runtimeSeconds = 0, isRuntimeEvent = false, sessionData = null) {
    return {
      // User and device info
      userId,
      thermostatId: deviceId,
      deviceName: deviceName,
      
      // Runtime data (0 for temperature updates, actual for runtime events)
      runtimeSeconds,
      runtimeMinutes: Math.round(runtimeSeconds / 60),
      isRuntimeEvent,
      
      // Current status
      hvacMode: hvacStatus, // "HEATING", "COOLING", "OFF"
      thermostatMode: mode, // "HEAT", "COOL", "HEAT_COOL", "OFF"
      
      // Temperature data (converted to Fahrenheit) - always present
      currentTempF: currentTemp ? celsiusToFahrenheit(currentTemp) : null,
      coolSetpointF: coolSetpoint ? celsiusToFahrenheit(coolSetpoint) : null,
      heatSetpointF: heatSetpoint ? celsiusToFahrenheit(heatSetpoint) : null,
      
      // Session start temperatures (only for runtime events)
      startTempF: sessionData?.startTemp ? celsiusToFahrenheit(sessionData.startTemp) : null,
      endTempF: currentTemp ? celsiusToFahrenheit(currentTemp) : null,
      
      // Raw celsius values - always present
      currentTempC: currentTemp,
      coolSetpointC: coolSetpoint,
      heatSetpointC: heatSetpoint,
      startTempC: sessionData?.startTemp || null,
      endTempC: currentTemp,
      
      // Timestamps - always present
      timestamp,
      eventId: eventData.eventId,
      eventTimestamp: eventTime
    };
  }

  // ALWAYS send to Bubble (with appropriate runtime values)
  let payload;
  
  if (isActive && !wasActive) {
    // Just turned on - start new session, send temp update
    sessions[key] = {
      startTime: eventTime,
      startStatus: hvacStatus,
      startTemp: currentTemp
    };
    console.log(`🟢 Starting ${hvacStatus} session for ${key}`);
    
    payload = createBubblePayload(0, false); // 0 runtime, not a runtime event
    
  } else if (!isActive && wasActive) {
    // Just turned off - calculate runtime
    const session = sessions[key];
    if (session) {
      const runtimeSeconds = Math.floor((eventTime - session.startTime) / 1000);
      
      // Basic validation (same as your Enode logic)
      if (runtimeSeconds > 0 && runtimeSeconds < 86400) { // 0 to 24 hours
        delete sessions[key];
        payload = createBubblePayload(runtimeSeconds, true, session); // Actual runtime event
      } else {
        console.warn(`⚠️ Invalid runtime ${runtimeSeconds}s for ${key}, skipping`);
        delete sessions[key];
        payload = createBubblePayload(0, false); // Send temp update with 0 runtime
      }
    } else {
      payload = createBubblePayload(0, false); // No session found, send temp update
    }
    
  } else if (isActive && !sessions[key]) {
    // System is active but no session start (after restart)
    sessions[key] = {
      startTime: eventTime,
      startStatus: hvacStatus,
      startTemp: currentTemp
    };
    console.log(`🔄 Restarting ${hvacStatus} session for ${key}`);
    
    payload = createBubblePayload(0, false); // Send temp update
    
  } else {
    // No state change, just temperature/setpoint update
    payload = createBubblePayload(0, false); // Send temp update
  }

  // Send to Bubble (every event gets sent)
  try {
    await axios.post(process.env.BUBBLE_WEBHOOK_URL, payload);
    console.log('✅ Sent to Bubble:', payload);
  } catch (err) {
    console.error('❌ Failed to send to Bubble:', err.response?.data || err.message);
    
    // Retry logic
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

  // Track current state for next event
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