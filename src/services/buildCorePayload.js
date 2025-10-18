'use strict';
const { v4: uuidv4 } = require('uuid');

/**
 * Builds a unified Core Ingest payload for all thermostat integrations (Nest, Ecobee, Resideo, etc.)
 */
function buildCorePayload({
  deviceKey,
  userId,
  deviceName,
  manufacturer = 'Google Nest',
  model = 'Nest Thermostat',
  connectionSource = 'nest',
  source = 'nest',
  sourceVendor = 'nest',
  workspaceId = userId,
  deviceType = 'thermostat',
  firmwareVersion = null,
  serialNumber = null,
  timezone,
  zipPrefix,
  
  eventType,
  equipmentStatus,
  previousStatus,
  isActive,
  isReachable,  // ✅ ADD THIS PARAMETER
  mode,
  runtimeSeconds,
  
  temperatureF,
  humidity,
  heatSetpoint,
  coolSetpoint,
  outdoorTemperatureF,  // ✅ ADD THIS
  outdoorHumidity,      // ✅ ADD THIS
  pressureHpa,          // ✅ ADD THIS
  thermostatMode,       // ✅ ADD THIS (separate from mode)
  
  observedAt,
  sourceEventId,
  runtimeType,          // ✅ ADD THIS (START/END/UPDATE)
  payloadRaw
}) {
  const temperatureC =
    typeof temperatureF === 'number'
      ? Math.round(((temperatureF - 32) * 5 / 9) * 100) / 100
      : null;

  const iso = (observedAt || new Date()).toISOString();

  const payload = {
    // Device identifiers
    device_key: deviceKey,
    device_id: deviceKey,  // ✅ CHANGED: Remove 'nest:' prefix for consistency
    user_id: userId || null,
    workspace_id: workspaceId || userId || null,  // ✅ IMPROVED: fallback
    
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
    last_mode: mode || null,
    thermostat_mode: thermostatMode || mode || null,  // ✅ ADD THIS
    last_is_cooling: equipmentStatus === 'COOLING',
    last_is_heating: equipmentStatus === 'HEATING',
    last_is_fan_only: equipmentStatus === 'FAN',
    last_equipment_status: equipmentStatus || null,
    is_reachable: isReachable !== undefined ? !!isReachable : true,  // ✅ CHANGED: Dynamic
    
    // Telemetry (indoor)
    last_temperature: temperatureF ?? null,
    temperature_f: temperatureF ?? null,  // ✅ ADD THIS (alias)
    temperature_c: temperatureC,          // ✅ ADD THIS
    last_temperature_c: temperatureC,     // ✅ ADD THIS
    last_humidity: humidity ?? null,
    humidity: humidity ?? null,           // ✅ ADD THIS (alias)
    last_heat_setpoint: heatSetpoint ?? null,
    heat_setpoint_f: heatSetpoint ?? null,  // ✅ ADD THIS (alias)
    last_cool_setpoint: coolSetpoint ?? null,
    cool_setpoint_f: coolSetpoint ?? null,  // ✅ ADD THIS (alias)
    
    // Telemetry (outdoor) - ✅ ADD THESE
    outdoor_temperature_f: outdoorTemperatureF ?? null,
    outdoor_humidity: outdoorHumidity ?? null,
    pressure_hpa: pressureHpa ?? null,
    
    // Event details
    event_type: eventType,
    is_active: !!isActive,
    equipment_status: equipmentStatus || 'OFF',
    previous_status: previousStatus || 'UNKNOWN',
    runtime_seconds: typeof runtimeSeconds === 'number' ? runtimeSeconds : null,
    runtime_type: runtimeType || 'UPDATE',  // ✅ ADD THIS
    
    // Timestamps
    timestamp: iso,
    recorded_at: iso,
    observed_at: iso,  // ✅ ADD THIS (consistency with other services)
    
    // Trace
    source_event_id: sourceEventId || uuidv4(),
    payload_raw: payloadRaw || null
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
