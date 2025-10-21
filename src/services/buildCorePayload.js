‘use strict’;

const { v4: uuidv4 } = require(‘uuid’);

/**

- Builds a unified Core Ingest payload for all thermostat integrations (Nest, Ecobee, Resideo, etc.)
- 
- CRITICAL: event_type and equipment_status are DIFFERENT:
- - event_type: Type of event (Mode_Change, Telemetry_Update, etc.)
- - equipment_status: Current equipment state (HEATING, COOLING, HEATING_FAN, COOLING_FAN, AUX_HEATING, AUX_HEATING_FAN, FAN, IDLE)
    */
    function buildCorePayload({
    deviceKey,
    userId,
    deviceName,
    manufacturer = ‘Google Nest’,
    model = ‘Nest Thermostat’,
    connectionSource = ‘nest’,
    source = ‘nest’,
    sourceVendor = ‘nest’,
    workspaceId = userId,
    deviceType = ‘thermostat’,
    firmwareVersion = null,
    serialNumber = null,
    timezone,
    zipPrefix,

eventType,           // ✅ What KIND of event: Mode_Change, Telemetry_Update
equipmentStatus,     // ✅ What equipment is DOING: HEATING, COOLING, OFF, FAN
previousStatus,
isActive,
isReachable,
mode,
runtimeSeconds,

temperatureF,
humidity,
heatSetpoint,
coolSetpoint,
outdoorTemperatureF,
outdoorHumidity,
pressureHpa,
thermostatMode,      // ✅ User-selected mode: heat, cool, auto, off

observedAt,
sourceEventId,
runtimeType,
payloadRaw
}) {
const temperatureC =
typeof temperatureF === ‘number’
? Math.round(((temperatureF - 32) * 5 / 9) * 100) / 100
: null;

const iso = (observedAt || new Date()).toISOString();

// ✅ CRITICAL: Map equipment_status (with _FAN suffix) to boolean flags
const isCooling = equipmentStatus === ‘COOLING’ || equipmentStatus === ‘COOLING_FAN’;
const isHeating = equipmentStatus === ‘HEATING’ ||
equipmentStatus === ‘HEATING_FAN’ ||
equipmentStatus === ‘AUX_HEATING’ ||
equipmentStatus === ‘AUX_HEATING_FAN’;
const isFanOnly = equipmentStatus === ‘FAN’;_HEATING’;
const isFanOnly = equipmentStatus === ‘FAN’;

const payload = {
// Device identifiers
device_key: deviceKey,
device_id: deviceKey,
user_id: userId || null,
workspace_id: workspaceId || userId || null,

```
// Device metadata
device_name: deviceName || 'Nest Thermostat',
manufacturer,
model,
device_type: deviceType,
source,
source_vendor: sourceVendor,
connection_source: connectionSource,
firmware_version: firmwareVersion,
serial_number: serialNumber,

// Device state snapshot
last_mode: thermostatMode || mode || null,
thermostat_mode: thermostatMode || mode || null,
last_is_cooling: isCooling,
last_is_heating: isHeating,
last_is_fan_only: isFanOnly,
last_equipment_status: equipmentStatus || 'IDLE',  // ✅ IDLE when not running
is_reachable: isReachable !== undefined ? !!isReachable : true,

// Telemetry (indoor)
last_temperature: temperatureF ?? null,
temperature_f: temperatureF ?? null,
temperature_c: temperatureC,
last_temperature_c: temperatureC,
last_humidity: humidity ?? null,
humidity: humidity ?? null,
last_heat_setpoint: heatSetpoint ?? null,
heat_setpoint_f: heatSetpoint ?? null,
last_cool_setpoint: coolSetpoint ?? null,
cool_setpoint_f: coolSetpoint ?? null,

// Telemetry (outdoor)
outdoor_temperature_f: outdoorTemperatureF ?? null,
outdoor_humidity: outdoorHumidity ?? null,
pressure_hpa: pressureHpa ?? null,

// Event details - THESE ARE DIFFERENT FIELDS!
event_type: eventType || 'Unknown',              // ✅ Type of event
is_active: !!isActive,
equipment_status: equipmentStatus || 'IDLE',     // ✅ Equipment state (IDLE when not running)
previous_status: previousStatus || 'UNKNOWN',
runtime_seconds: typeof runtimeSeconds === 'number' ? runtimeSeconds : null,
runtime_type: runtimeType || 'UPDATE',

// Timestamps
timestamp: iso,
recorded_at: iso,
observed_at: iso,

// Trace
source_event_id: sourceEventId || uuidv4(),
payload_raw: payloadRaw || null
```

};

// Optional fields
if (timezone) payload.timezone = timezone;
if (zipPrefix) {
payload.zip_prefix = zipPrefix;
payload.zip_code_prefix = zipPrefix;
}

return payload;
}

module.exports = { buildCorePayload };