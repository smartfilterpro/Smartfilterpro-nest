'use strict';

const { v4: uuidv4 } = require('uuid');

/**
 * Build standardized Core Ingest payload for Nest thermostats
 * Supports 8-state system: Cooling_Fan, Cooling, Heating_Fan, Heating, AuxHeat_Fan, AuxHeat, Fan_only, Fan_off
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
  timezone = null,
  zipPrefix = null,

  // Event classification
  eventType,
  equipmentStatus,
  previousStatus,
  isActive,
  isReachable = true,
  mode,
  runtimeSeconds,
  runtimeType = 'UPDATE',

  // Telemetry - indoor
  temperatureF,
  humidity = null,
  heatSetpoint,
  coolSetpoint,
  thermostatMode = null,

  // Telemetry - outdoor (Nest doesn't provide, but keep for consistency)
  outdoorTemperatureF = null,
  outdoorHumidity = null,
  pressureHpa = null,

  // Metadata
  observedAt,
  sourceEventId,
  payloadRaw
}) {
  const temperatureC =
    typeof temperatureF === 'number'
      ? Math.round(((temperatureF - 32) * 5) / 9 * 100) / 100
      : null;

  const isoNow = (observedAt || new Date()).toISOString();

  // Map event types to standardized equipment status
  // eventType comes from classifyEquipmentState(): 
  // Cooling_Fan, Cooling, Heating_Fan, Heating, AuxHeat_Fan, AuxHeat, Fan_only, Fan_off
  let standardizedEquipmentStatus = equipmentStatus || 'OFF';
  
  // Determine boolean flags for backward compatibility
  const isCooling = eventType === 'Cooling_Fan' || eventType === 'Cooling';
  const isHeating = eventType === 'Heating_Fan' || eventType === 'Heating' || 
                    eventType === 'AuxHeat_Fan' || eventType === 'AuxHeat';
  const isFanOnly = eventType === 'Fan_only';

  return {
    device_key: deviceKey,
    device_id: deviceKey,
    user_id: userId || null,
    workspace_id: workspaceId || userId || null,
    device_name: deviceName || 'Nest Thermostat',
    manufacturer,
    model,
    device_type: deviceType,
    source,
    source_vendor: sourceVendor,
    connection_source: connectionSource,
    firmware_version: firmwareVersion,
    serial_number: serialNumber,
    timezone,
    zip_prefix: zipPrefix,
    zip_code_prefix: zipPrefix,

    last_mode: mode || null,
    last_is_cooling: isCooling,
    last_is_heating: isHeating,
    last_is_fan_only: isFanOnly,
    last_equipment_status: eventType || null,  // Use eventType (8-state) not raw equipmentStatus
    is_reachable: isReachable,

    // Indoor telemetry
    last_temperature: temperatureF ?? null,
    temperature_f: temperatureF ?? null,
    temperature_c: temperatureC,
    last_humidity: humidity,
    humidity,
    last_heat_setpoint: heatSetpoint ?? null,
    heat_setpoint_f: heatSetpoint ?? null,
    last_cool_setpoint: coolSetpoint ?? null,
    cool_setpoint_f: coolSetpoint ?? null,
    thermostat_mode: thermostatMode,

    // Outdoor telemetry (not available from Nest, but included for schema consistency)
    outdoor_temperature_f: outdoorTemperatureF,
    outdoor_humidity: outdoorHumidity,
    pressure_hpa: pressureHpa,

    // Event data
    event_type: eventType,
    equipment_status: eventType || 'Fan_off',  // Use 8-state classification
    previous_status: previousStatus || 'UNKNOWN',
    is_active: !!isActive,
    runtime_seconds: typeof runtimeSeconds === 'number' ? runtimeSeconds : null,
    runtime_type: runtimeType,
    timestamp: isoNow,
    recorded_at: isoNow,
    observed_at: isoNow,

    source_event_id: sourceEventId || uuidv4(),
    payload_raw: payloadRaw || null
  };
}

module.exports = { buildCorePayload };
