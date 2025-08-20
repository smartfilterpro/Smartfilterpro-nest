'use strict';

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
  if (celsius == null || !Number.isFinite(celsius)) return null;
  return Math.round((celsius * 9) / 5 + 32);
}

// Sanitize sensitive data for logging
function sanitizeForLogging(data) {
  if (!data) return data;
  const sanitized = { ...data };
  if (sanitized.userId) sanitized.userId = sanitized.userId.substring(0, 8) + '…';
  if (sanitized.deviceName) {
    const tail = sanitized.deviceName.split('/').pop() || '';
    sanitized.deviceName = 'device-' + tail.substring(0, 8) + '…';
  }
  if (sanitized.thermostatId) sanitized.thermostatId = sanitized.thermostatId.substring(0, 8) + '…';
  return sanitized;
}

async function handleNestEvent(eventData) {
  console.log('DEBUG: Starting event processing');
  if (!IS_PRODUCTION) console.log('Processing Nest event…');

  // DEBUG: Log the complete event structure
  console.log('DEBUG - Complete event data:');
  console.log(JSON.stringify(eventData, null, 2));

  // Extract data from Nest event structure
  const userId = eventData.userId;
  const deviceName = eventData.resourceUpdate?.name;
  const traits = eventData.resourceUpdate?.traits;
  const timestamp = eventData.timestamp;

  // DEBUG: Log extraction results
  console.log('DEBUG - Basic field extraction:');
  console.log(`- userId: ${userId}`);
  console.log(`- deviceName: ${deviceName}`);
  console.log(`- timestamp: ${timestamp}`);
  console.log(`- resourceUpdate exists: ${!!eventData.resourceUpdate}`);
  console.log(`- traits exists: ${!!traits}`);

  if (eventData.resourceUpdate) {
    console.log('DEBUG - resourceUpdate keys:', Object.keys(eventData.resourceUpdate));
  }

  // DEBUG: Log the complete traits object
  console.log('DEBUG - Raw traits object:');
  if (traits) {
    console.log(JSON.stringify(traits, null, 2));
    console.log('DEBUG - Available trait keys:', Object.keys(traits));
  } else {
    console.log('No traits found!');
  }

  // Extract device ID from the long device name
  const deviceId = deviceName?.split('/').pop();

  // Get HVAC status and temperature data
  const hvacStatus = traits?.['sdm.devices.traits.ThermostatHvac']?.status;
  const currentTemp = traits?.['sdm.devices.traits.Temperature']?.ambientTemperatureCelsius;
  const coolSetpoint = traits?.['sdm.devices.traits.ThermostatTemperatureSetpoint']?.coolCelsius;
  const heatSetpoint = traits?.['sdm.devices.traits.ThermostatTemperatureSetpoint']?.heatCelsius;
  const mode = traits?.['sdm.devices.traits.ThermostatMode']?.mode;

  // DEBUG: Log extracted trait values
  console.log('DEBUG - Extracted trait values:');
  console.log(`- hvacStatus: ${hvacStatus}`);
  console.log(`- currentTemp: ${currentTemp}`);
  console.log(`- coolSetpoint: ${coolSetpoint}`);
  console.log(`- heatSetpoint: ${heatSetpoint}`);
  console.log(`- mode: ${mode}`);

  // DEBUG: Check each trait individually
  if (traits) {
    const hvacTrait = traits['sdm.devices.traits.ThermostatHvac'];
    console.log(`- ThermostatHvac trait: ${JSON.stringify(hvacTrait)}`);

    const tempTrait = traits['sdm.devices.traits.Temperature'];
    console.log(`- Temperature trait: ${JSON.stringify(tempTrait)}`);

    const setpointTrait = traits['sdm.devices.traits.ThermostatTemperatureSetpoint'];
    console.log(`- ThermostatTemperatureSetpoint trait: ${JSON.stringify(setpointTrait)}`);

    const modeTrait = traits['sdm.devices.traits.ThermostatMode'];
    console.log(`- ThermostatMode trait: ${JSON.stringify(modeTrait)}`);
  }

  // Safe logging (sanitized data)
  if (!IS_PRODUCTION) {
    console.log(
      `Event data: userId=${userId?.substring(0, 8)}..., deviceId=${deviceId?.substring(0, 8)}..., hvacStatus=${hvacStatus}, temp=${currentTemp}°C`
    );
  }

  // DEBUG: Validation check
  console.log('DEBUG - Validation check:');
  console.log(`- userId present: ${!!userId}`);
  console.log(`- deviceId present: ${!!deviceId}`);
  console.log(`- hvacStatus present: ${!!hvacStatus}`);
  console.log(`- timestamp present: ${!!timestamp}`);
  console.log(`- currentTemp present: ${currentTemp != null}`);

  // Only require userId, deviceId, and timestamp
  if (!userId || !deviceId || !timestamp) {
    console.warn('Skipping incomplete Nest event');
    if (!userId) console.log('  - Missing userId');
    if (!deviceId) console.log('  - Missing deviceId');
    if (!timestamp) console.log('  - Missing timestamp');
    return;
  }

  const key = `${userId}-${deviceId}`;
  const eventTime = toTimestamp(timestamp);

  // Check if this is a temperature-only event
  const isTemperatureOnlyEvent = !hvacStatus && currentTemp != null;

  if (isTemperatureOnlyEvent) {
    console.log('Temperature-only event detected');

    // Use last known HVAC status or default to 'OFF'
    const lastState = deviceStates[key];
    const effectiveHvacStatus = lastState?.status || 'OFF';
    const effectiveMode = lastState?.mode || mode || 'OFF';

    console.log(`Using last known HVAC status: ${effectiveHvacStatus}`);

    // Create payload for temperature update
    const payload = {
      userId,
      thermostatId: deviceId,
      deviceName: deviceName,
      runtimeSeconds: 0,
      runtimeMinutes: 0,
      isRuntimeEvent: false,
      hvacMode: effectiveHvacStatus,
      isHvacActive: effectiveHvacStatus === 'HEATING' || effectiveHvacStatus === 'COOLING',
      thermostatMode: effectiveMode,
      currentTempF: celsiusToFahrenheit(currentTemp),
      coolSetpointF: celsiusToFahrenheit(coolSetpoint),
      heatSetpointF: celsiusToFahrenheit(heatSetpoint),
      startTempF: null,
      endTempF: celsiusToFahrenheit(currentTemp),
      currentTempC: currentTemp ?? null,
      coolSetpointC: coolSetpoint ?? null,
      heatSetpointC: heatSetpoint ?? null,
      startTempC: null,
      endTempC: currentTemp ?? null,
      timestamp,
      eventId: eventData.eventId,
      eventTimestamp: eventTime
    };

    console.log('DEBUG - Created temperature-only payload:');
    console.log(JSON.stringify(payload, null, 2));

    // Send to Bubble
    if (process.env.BUBBLE_WEBHOOK_URL) {
      try {
        console.log('DEBUG - Sending temperature update to Bubble...');
        await axios.post(process.env.BUBBLE_WEBHOOK_URL, payload, {
          timeout: 10000,
          headers: {
            'User-Agent': 'Nest-Runtime-Tracker/1.0',
            'Content-Type': 'application/json'
          }
        });

        const logData = sanitizeForLogging({
          runtimeSeconds: payload.runtimeSeconds,
          isRuntimeEvent: payload.isRuntimeEvent,
          hvacMode: payload.hvacMode,
          isHvacActive: payload.isHvacActive,
          currentTempF: payload.currentTempF
        });
        console.log('Sent temperature update to Bubble:', logData);
      } catch (err) {
        console.error(
          'Failed to send temperature update to Bubble:',
          err.response?.status || err.code || err.message
        );
      }
    }

    // Update device state to track temperature
    deviceStates[key] = {
      ...deviceStates[key],
      temp: currentTemp,
      lastUpdate: eventTime,
      lastTempUpdate: eventTime
    };

    console.log('DEBUG: Temperature-only event processing complete');
    return;
  }

  console.log('DEBUG: Validation passed, proceeding with full HVAC event processing');

  // Determine if HVAC is active
  const isActive = hvacStatus === 'HEATING' || hvacStatus === 'COOLING';
  const wasActive = deviceStates[key]?.isActive || false;

  // Create standard payload for Bubble
  function createBubblePayload(runtimeSeconds = 0, isRuntimeEvent = false, sessionData = null) {
    const payload = {
      userId,
      thermostatId: deviceId,
      deviceName: deviceName,
      runtimeSeconds,
      runtimeMinutes: Math.round(runtimeSeconds / 60),
      isRuntimeEvent,
      hvacMode: hvacStatus,
      isHvacActive: isActive,
      thermostatMode: mode,
      currentTempF: celsiusToFahrenheit(currentTemp),
      coolSetpointF: celsiusToFahrenheit(coolSetpoint),
      heatSetpointF: celsiusToFahrenheit(heatSetpoint),
      startTempF: sessionData?.startTemp ? celsiusToFahrenheit(sessionData.startTemp) : null,
      endTempF: celsiusToFahrenheit(currentTemp),
      currentTempC: currentTemp ?? null,
      coolSetpointC: coolSetpoint ?? null,
      heatSetpointC: heatSetpoint ?? null,
      startTempC: sessionData?.startTemp ?? null,
      endTempC: currentTemp ?? null,
      timestamp,
      eventId: eventData.eventId,
      eventTimestamp: eventTime
    };

    console.log('DEBUG - Created payload:');
    console.log(JSON.stringify(payload, null, 2));
    return payload;
  }

  let payload;

  if (isActive && !wasActive) {
    // Just turned on - start new session
    sessions[key] = {
      startTime: eventTime,
      startStatus: hvacStatus,
      startTemp: currentTemp
    };
    console.log(`Starting ${hvacStatus} session for ${key.substring(0, 16)}...`);
    payload = createBubblePayload(0, false);
  } else if (!isActive && wasActive) {
    // Just turned off - calculate runtime
    const session = sessions[key];
    if (session) {
      const runtimeSeconds = Math.floor((eventTime - session.startTime) / 1000);
      if (runtimeSeconds > 0 && runtimeSeconds < 86400) {
        delete sessions[key];
        payload = createBubblePayload(runtimeSeconds, true, session);
        console.log(`Ending session: ${runtimeSeconds} seconds runtime`);
      } else {
        console.warn(`Invalid runtime ${runtimeSeconds}s, skipping`);
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
    console.log(`Restarting ${hvacStatus} session for ${key.substring(0, 16)}...`);
    payload = createBubblePayload(0, false);
  } else {
    // No state change, just temperature update
    payload = createBubblePayload(0, false);
    if (!IS_PRODUCTION) console.log(`Temperature update: ${currentTemp}°C`);
  }

  // Send to Bubble if URL is configured
  if (process.env.BUBBLE_WEBHOOK_URL) {
    try {
      console.log('DEBUG - Sending to Bubble…');
      await axios.post(process.env.BUBBLE_WEBHOOK_URL, payload, {
        timeout: 10000,
        headers: {
          'User-Agent': 'Nest-Runtime-Tracker/1.0',
          'Content-Type': 'application/json'
        }
      });

      const logData = sanitizeForLogging({
        runtimeSeconds: payload.runtimeSeconds,
        isRuntimeEvent: payload.isRuntimeEvent,
        hvacMode: payload.hvacMode,
        isHvacActive: payload.isHvacActive,
        currentTempF: payload.currentTempF
      });
      console.log('Sent to Bubble:', logData);
    } catch (err) {
      console.error('Failed to send to Bubble:', err.response?.status || err.code || err.message);

      // Retry logic with simple delay
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
          console.log('Retry successful');
        } catch (retryErr) {
          console.error('Retry failed:', retryErr.response?.status || retryErr.code || retryErr.message);
        }
      }, retryDelay);
    }
  } else {
    if (!IS_PRODUCTION) {
      const logData = sanitizeForLogging({
        runtimeSeconds: payload.runtimeSeconds,
        isRuntimeEvent: payload.isRuntimeEvent,
        hvacMode: payload.hvacMode,
        isHvacActive: payload.isHvacActive,
        currentTempF: payload.currentTempF
      });
      console.log('Would send to Bubble (no URL configured):', logData);
    }
  }

  // Track current state
  deviceStates[key] = {
    isActive,
    status: hvacStatus,
    mode: mode,
    temp: currentTemp,
    lastUpdate: eventTime
  };

  console.log('DEBUG: Event processing complete');
}

// Cleanup old sessions every 6 hours
setInterval(() => {
  const sixHoursAgo = Date.now() - 6 * 60 * 60 * 1000;
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
    console.log(`Cleaned up ${cleaned} old Nest sessions`);
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
  res.send('Nest Runtime Webhook server is running!');
});

app.post('/webhook', async (req, res) => {
  try {
    // Basic webhook verification (check if request has expected structure)
    const pubsubMessage = req.body.message;
    if (!pubsubMessage || !pubsubMessage.data) {
      console.error('Invalid Pub/Sub message structure');
      return res.status(400).send('Invalid Pub/Sub message');
    }

    // Decode and validate base64 data
    let eventData;
    try {
      eventData = JSON.parse(Buffer.from(pubsubMessage.data, 'base64').toString());
    } catch (decodeError) {
      console.error('Failed to decode Pub/Sub message:', decodeError.message);
      return res.status(400).send('Invalid message format');
    }

    // Safe logging (event ID only)
    console.log('Processing Nest event:', eventData.eventId || 'unknown-event');

    await handleNestEvent(eventData);

    res.status(200).send('OK');
  } catch (error) {
    console.error('Webhook error:', error.message);
    res.status(500).send('Internal Server Error');
  }
});

// Error handling for unhandled routes
app.use('*', (req, res) => {
  res.status(404).send('Not Found');
});

// Global error handler
app.use((error, req, res, next) => {
  console.error('Unhandled error:', error.message);
  res.status(500).send('Internal Server Error');
});

app.listen(PORT, () => {
  console.log(`Nest server is running on port ${PORT}`);
  console.log(`Ready to receive events at /webhook`);
  console.log(`Bubble integration: ${process.env.BUBBLE_WEBHOOK_URL ? 'Configured' : 'Not configured'}`);
  console.log(`Environment: ${IS_PRODUCTION ? 'Production' : 'Development'}`);
});