console.log('Starting Nest server...');

const express = require('express');
const axios = require('axios');
require('dotenv').config();

console.log('All modules loaded successfully');

const app = express();
const PORT = process.env.PORT || 8080;

// Security headers middleware
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

app.use(express.json());

// Session storage (same pattern as Enode)
const sessions = {};
const deviceStates = {};

// Environment check
const IS_PRODUCTION = process.env.NODE_ENV === 'production';

function toTimestamp(dateStr) {
  return new Date(dateStr).getTime();
}

function celsiusToFahrenheit(celsius) {
  return Math.round((celsius * 9/5) + 32);
}

// Sanitize sensitive data for logging
function sanitizeForLogging(data) {
  if (!data) return data;
  
  const sanitized = { ...data };
  
  // Remove or truncate sensitive fields
  if (sanitized.userId) {
    sanitized.userId = sanitized.userId.substring(0, 8) + '...';
  }
  if (sanitized.deviceName) {
    sanitized.deviceName = 'device-' + sanitized.deviceName.split('/').pop().substring(0, 8) + '...';
  }
  if (sanitized.thermostatId) {
    sanitized.thermostatId = sanitized.thermostatId.substring(0, 8) + '...';
  }
  
  return sanitized;
}

async function handleNestEvent(eventData) {
  if (!IS_PRODUCTION) {
    console.log('🔄 Processing Nest event...');
  }
  
  // Extract data from Nest event structure
  const userId = eventData.userId;
  const deviceName = eventData.resourceUpdate?.name;
  const traits = eventData.resourceUpdate?.traits;
  const timestamp = eventData.timestamp;

  // Extract device ID from the long device name
  const deviceId = deviceName?.split('/').pop();
  
  // Get HVAC status and temperature data
  const hvacStatus = traits?.['sdm.devices.traits.ThermostatHvac']?.status;
  const currentTemp = traits?.['sdm.devices.traits.Temperature']?.ambientTemperatureCelsius;
  const coolSetpoint = traits?.['sdm.devices.traits.ThermostatTemperatureSetpoint']?.coolCelsius;
  const heatSetpoint = traits?.['sdm.devices.traits.ThermostatTemperatureSetpoint']?.heatCelsius;
  const mode = traits?.['sdm.devices.traits.ThermostatMode']?.mode;

  // Safe logging (sanitized data)
  if (!IS_PRODUCTION) {
    console.log(`📊 Event data: userId=${userId?.substring(0, 8)}..., deviceId=${deviceId?.substring(0, 8)}..., hvacStatus=${hvacStatus}, temp=${currentTemp}°C`);
  }

  // Validation
  if (!userId || !deviceId || !hvacStatus || !timestamp) {
    console.warn('⚠️ Skipping incomplete Nest event');
    return;
  }

  const key = `${userId}-${deviceId}`;
  const eventTime = toTimestamp(timestamp);
  
  // Determine if HVAC is active
  const isActive = hvacStatus === 'HEATING' || hvacStatus === 'COOLING';
  const wasActive = deviceStates[key]?.isActive || false;
  
  // Create standard payload for Bubble
  function createBubblePayload(runtimeSeconds = 0, isRuntimeEvent = false, sessionData = null) {
    return {
      userId,
      thermostatId: deviceId,
      deviceName: deviceName,
      runtimeSeconds,
      runtimeMinutes: Math.round(runtimeSeconds / 60),
      isRuntimeEvent,
      hvacMode: hvacStatus,
      thermostatMode: mode,
      currentTempF: currentTemp ? celsiusToFahrenheit(currentTemp) : null,
      coolSetpointF: coolSetpoint ? celsiusToFahrenheit(coolSetpoint) : null,
      heatSetpointF: heatSetpoint ? celsiusToFahrenheit(heatSetpoint) : null,
      startTempF: sessionData?.startTemp ? celsiusToFahrenheit(sessionData.startTemp) : null,
      endTempF: currentTemp ? celsiusToFahrenheit(currentTemp) : null,
      currentTempC: currentTemp,
      coolSetpointC: coolSetpoint,
      heatSetpointC: heatSetpoint,
      startTempC: sessionData?.startTemp || null,
      endTempC: currentTemp,
      timestamp,
      eventId: eventData.eventId,
      eventTimestamp: eventTime
    };
  }

  let payload;
  
  if (isActive && !wasActive) {
    // Just turned on - start new session
    sessions[key] = {
      startTime: eventTime,
      startStatus: hvacStatus,
      startTemp: currentTemp
    };
    console.log(`🟢 Starting ${hvacStatus} session for ${key.substring(0, 16)}...`);
    payload = createBubblePayload(0, false);
    
  } else if (!isActive && wasActive) {
    // Just turned off - calculate runtime
    const session = sessions[key];
    if (session) {
      const runtimeSeconds = Math.floor((eventTime - session.startTime) / 1000);
      
      if (runtimeSeconds > 0 && runtimeSeconds < 86400) {
        delete sessions[key];
        payload = createBubblePayload(runtimeSeconds, true, session);
        console.log(`🔴 Ending session: ${runtimeSeconds} seconds runtime`);
      } else {
        console.warn(`⚠️ Invalid runtime ${runtimeSeconds}s, skipping`);
        delete sessions[key];
        payload = createBubblePayload(0, false);
      }
    } else {
      payload = createBubblePayload(0, false);
    }
    
  } else if (isActive && !sessions[key]) {
    // System active but no session (restart scenario)
    sessions[key] = {
      startTime: eventTime,
      startStatus: hvacStatus,
      startTemp: currentTemp
    };
    console.log(`🔄 Restarting ${hvacStatus} session for ${key.substring(0, 16)}...`);
    payload = createBubblePayload(0, false);
    
  } else {
    // No state change, just temperature update
    payload = createBubblePayload(0, false);
    if (!IS_PRODUCTION) {
      console.log(`📈 Temperature update: ${currentTemp}°C`);
    }
  }

  // Send to Bubble if URL is configured
  if (process.env.BUBBLE_WEBHOOK_URL) {
    try {
      await axios.post(process.env.BUBBLE_WEBHOOK_URL, payload, {
        timeout: 10000, // 10 second timeout
        headers: {
          'User-Agent': 'Nest-Runtime-Tracker/1.0',
          'Content-Type': 'application/json'
        }
      });
      
      // Safe logging (no sensitive data)
      const logData = sanitizeForLogging({
        runtimeSeconds: payload.runtimeSeconds,
        isRuntimeEvent: payload.isRuntimeEvent,
        hvacMode: payload.hvacMode,
        currentTempF: payload.currentTempF
      });
      console.log('✅ Sent to Bubble:', logData);
      
    } catch (err) {
      console.error('❌ Failed to send to Bubble:', err.response?.status || err.code || err.message);
      
      // Retry logic with exponential backoff
      const retryDelay = 5000;
      setTimeout(async () => {
        try {
          await axios.post(process.env.BUBBLE_WEBHOOK_URL, payload, {
            timeout: 10000,
            headers: {
              'User-Agent': 'Nest-Runtime-Tracker/1.0',
              'Content-Type': 'application/json'
            }
          });
          console.log('✅ Retry successful');
        } catch (retryErr) {
          console.error('❌ Retry failed:', retryErr.response?.status || retryErr.code || retryErr.message);
        }
      }, retryDelay);
    }
  } else {
    if (!IS_PRODUCTION) {
      const logData = sanitizeForLogging({
        runtimeSeconds: payload.runtimeSeconds,
        isRuntimeEvent: payload.isRuntimeEvent,
        hvacMode: payload.hvacMode,
        currentTempF: payload.currentTempF
      });
      console.log('📝 Would send to Bubble (no URL configured):', logData);
    }
  }

  // Track current state
  deviceStates[key] = {
    isActive,
    status: hvacStatus,
    temp: currentTemp,
    lastUpdate: eventTime
  };
}

// Cleanup old sessions every 6 hours
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
}, 6 * 60 * 60 * 1000);

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    sessions: Object.keys(sessions).length,
    uptime: process.uptime()
  });
});

app.get('/', (req, res) => {
  res.send('✅ Nest Runtime Webhook server is running!');
});

app.post('/webhook', async (req, res) => {
  try {
    // Basic webhook verification (check if request has expected structure)
    const pubsubMessage = req.body.message;
    if (!pubsubMessage || !pubsubMessage.data) {
      console.error('❌ Invalid Pub/Sub message structure');
      return res.status(400).send('Invalid Pub/Sub message');
    }

    // Decode and validate base64 data
    let eventData;
    try {
      eventData = JSON.parse(Buffer.from(pubsubMessage.data, 'base64').toString());
    } catch (decodeError) {
      console.error('❌ Failed to decode Pub/Sub message:', decodeError.message);
      return res.status(400).send('Invalid message format');
    }

    // Safe logging (event ID only)
    console.log("🔵 Processing Nest event:", eventData.eventId || 'unknown-event');

    await handleNestEvent(eventData);

    res.status(200).send('OK');
  } catch (error) {
    console.error('🔥 Webhook error:', error.message);
    res.status(500).send('Internal Server Error');
  }
});

// Error handling for unhandled routes
app.use('*', (req, res) => {
  res.status(404).send('Not Found');
});

// Global error handler
app.use((error, req, res, next) => {
  console.error('🔥 Unhandled error:', error.message);
  res.status(500).send('Internal Server Error');
});

app.listen(PORT, () => {
  console.log(`🚀 Nest server is running on port ${PORT}`);
  console.log(`📡 Ready to receive events at /webhook`);
  console.log(`🔗 Bubble integration: ${process.env.BUBBLE_WEBHOOK_URL ? 'Configured' : 'Not configured'}`);
  console.log(`🛡️ Environment: ${IS_PRODUCTION ? 'Production' : 'Development'}`);
});
