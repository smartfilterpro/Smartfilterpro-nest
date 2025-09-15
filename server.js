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

// Map current hvac/fan to canonical equipmentStatus
function mapEquipmentStatus(hvacStatus, isFanOnly) {
  if (hvacStatus === 'HEATING') return 'heat';
  if (hvacStatus === 'COOLING') return 'cool';
  if (isFanOnly) return 'fan';
  if (hvacStatus === 'OFF' || !hvacStatus) return 'off';
  return 'unknown';
}

function deriveCurrentFlags(hvacStatus, fanTimerOn) {
  const isHeating = hvacStatus === 'HEATING';
  const isCooling = hvacStatus === 'COOLING';
  const isFanOnly = !!fanTimerOn && !isHeating && !isCooling;
  const equipmentStatus = mapEquipmentStatus(hvacStatus, isFanOnly);
  return { isHeating, isCooling, isFanOnly, equipmentStatus };
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

  // Get HVAC status, temperature, mode, and fan
  const hvacStatus = traits?.['sdm.devices.traits.ThermostatHvac']?.status;
  const currentTemp = traits?.['sdm.devices.traits.Temperature']?.ambientTemperatureCelsius;
  const coolSetpoint = traits?.['sdm.devices.traits.ThermostatTemperatureSetpoint']?.coolCelsius;
  const heatSetpoint = traits?.['sdm.devices.traits.ThermostatTemperatureSetpoint']?.heatCelsius;
  const mode = traits?.['sdm.devices.traits.ThermostatMode']?.mode;

  // Fan trait (used to infer fan-only)
  const fanTimerMode = traits?.['sdm.devices.traits.Fan']?.timerMode; // "ON" | "OFF" | undefined
  const fanTimerOn = fanTimerMode === 'ON';

  // DEBUG: Log extracted trait values
  console.log('DEBUG - Extracted trait values:');
  console.log(`- hvacStatus: ${hvacStatus}`);
  console.log(`- currentTemp: ${currentTemp}`);
  console.log(`- coolSetpoint: ${coolSetpoint}`);
  console.log(`- heatSetpoint: ${heatSetpoint}`);
  console.log(`- mode: ${mode}`);
  console.log(`- fanTimerMode: ${fanTimerMode}`);

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

    const fanTrait = traits['sdm.devices.traits.Fan'];
    console.log(`- Fan trait: ${JSON.stringify(fanTrait)}`);
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
  console.log(`- timestamp present: ${!!timestamp}`);

  if (!userId || !deviceId || !timestamp) {
    console.warn('Skipping incomplete Nest event');
    if (!userId) console.log('  - Missing userId');
    if (!deviceId) console.log('  - Missing deviceId');
    if (!timestamp) console.log('  - Missing timestamp');
    return;
  }

  const key = `${userId}-${deviceId}`;
  const eventTime = toTimestamp(timestamp);

  // Pull previous (to populate "last*")
  const prev = deviceStates[key] || {};
  const lastIsCooling = !!prev.isCooling;
  const lastIsHeating = !!prev.isHeating;
  const lastIsFanOnly = !!prev.isFanOnly;
  const lastEquipmentStatus = prev.equipmentStatus || 'unknown';

  // If we got only a temp change, still send with "last*" from prev and current derived state from prev
  const isTemperatureOnlyEvent = !hvacStatus && currentTemp != null;

  if (isTemperatureOnlyEvent) {
    console.log('Temperature-only event detected');

    // Fall back to last known state for current snapshot
    const effectiveStatus = prev.status || 'OFF';
    const effectiveMode = prev.mode || mode || 'OFF';
    const effectiveFanOnly = prev.isFanOnly || false;

    const payload = {
      userId,
      thermostatId: deviceId,
      deviceName: deviceName,
      runtimeSeconds: 0,
      runtimeMinutes: 0,
      isRuntimeEvent: false,
      hvacMode: effectiveStatus,               // string from previous known state
      isHvacActive: effectiveStatus === 'HEATING' || effectiveStatus === 'COOLING',
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

      // NEW "last*" fields
      lastIsCooling,
      lastIsHeating,
      lastIsFanOnly,
      lastEquipmentStatus,

      // Optional convenience: also include current equipmentStatus snapshot based on last-known
      equipmentStatus: mapEquipmentStatus(effectiveStatus, effectiveFanOnly),

      timestamp,
      eventId: eventData.eventId,
      eventTimestamp: eventTime
    };

    console.log('DEBUG - Created temperature-only payload:');
    console.log(JSON.stringify(payload, null, 2));

    if (process.env.BUBBLE_WEBHOOK_URL) {
      try {
        console.log('DEBUG - Sending temperature update to Bubble...');
        await axios.post(process.env.BUBBLE_WEBHOOK_URL, payload, {
          timeout: 10000,
          headers: {
            'User-Agent': 'Nest-Runtime-Tracker/1.1',
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

    // Keep last known temps/timestamps fresh
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

  // Derive current booleans & equipment status using fan + hvac status
  const { isHeating, isCooling, isFanOnly, equipmentStatus } = deriveCurrentFlags(hvacStatus, fanTimerOn);

  // Determine activity transitions for runtime sessions
  const isActive = isHeating || isCooling; // runtime only for heat/cool (not fan-only)
  const wasActive = !!prev.isActive;

  // Create standard payload for Bubble (includes "last*" and current equipmentStatus)
  function createBubblePayload(runtimeSeconds = 0, isRuntimeEvent = false, sessionData = null) {
    const payload = {
      userId,
      thermostatId: deviceId,
      deviceName: deviceName,
      runtimeSeconds,
      runtimeMinutes: Math.round(runtimeSeconds / 60),
      isRuntimeEvent,
      hvacMode: hvacStatus,                 // "HEATING" | "COOLING" | "OFF"
      isHvacActive: isActive,               // heat/cool only (fan-only excluded from runtime)
      thermostatMode: mode,

      // temps
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

      // NEW "last*" fields (from previous snapshot)
      lastIsCooling,
      lastIsHeating,
      lastIsFanOnly,
      lastEquipmentStatus,

      // Also include current equipment status snapshot
      equipmentStatus,                      // "cool" | "heat" | "fan" | "off" | "unknown"

      // (optional) expose current fan-only flag for debugging/analytics
      isFanOnly,                            // boolean

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
    // Just turned on (heat/cool) - start new runtime session
    sessions[key] = {
      startTime: eventTime,
      startStatus: hvacStatus,
      startTemp: currentTemp
    };
    console.log(`Starting ${hvacStatus} session for ${key.substring(0, 16)}...`);
    payload = createBubblePayload(0, false);
  } else if (!isActive && wasActive) {
    // Just turned off from heat/cool - end runtime session
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
    // Active but no session (restart scenario)
    sessions[key] = {
      startTime: eventTime,
      startStatus: hvacStatus,
      startTemp: currentTemp
    };
    console.log(`Restarting ${hvacStatus} session for ${key.substring(0, 16)}...`);
    payload = createBubblePayload(0, false);
  } else {
    // No state change (or fan-only) → regular update only (no runtime increment)
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
          'User-Agent': 'Nest-Runtime-Tracker/1.1',
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
              'User-Agent': 'Nest-Runtime-Tracker/1.1',
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

  // Track current state for next event ("last*")
  deviceStates[key] = {
    isActive,                 // heat/cool only
    status: hvacStatus,       // raw HEATING/COOLING/OFF
    mode: mode,
    temp: currentTemp,
    isHeating,
    isCooling,
    isFanOnly,
    equipmentStatus,          // mapped "heat"/"cool"/"fan"/"off"/"unknown"
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