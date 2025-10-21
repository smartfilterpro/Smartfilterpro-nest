'use strict';

const { v4: uuidv4 } = require('uuid');

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
  thermostatMode,
  observedAt,
  sourceEventId,
  runtimeType,
  payloadRaw
}) {
  const temperatureC = typeof temperatureF === 'number' ? Math.round(((temperatureF - 32) * 5 / 9) * 100) / 100 : null;
  const iso = (observedAt || new Date()).toISOString();
  const isCooling = equipmentStatus === 'Ccooling' || equipmentStatus === 'Cooling_Fan';
  const isHeating = equipmentStatus === 'Heating' || equipmentStatus === 'Heating_Fan' || equipmentStatus === 'Aux_Heating' || equipmentStatus === 'Auc_Heating_Fam';
  const isFanOnly = equipmentStatus === 'Fan_only';

  const payload = {
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
    last_mode: thermostatMode || mode || null,
    thermostat_mode: thermostatMode || mode || null,
    last_is_cooling: isCooling,
    last_is_heating: isHeating,
    last_is_fan_only: isFanOnly,
    last_equipment_status: equipmentStatus || 'Idle',
    is_reachable: isReachable !== undefined ? !!isReachable : true,
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
    outdoor_temperature_f: outdoorTemperatureF ?? null,
    outdoor_humidity: outdoorHumidity ?? null,
    pressure_hpa: pressureHpa ?? null,
    event_type: eventType || 'Unknown',
    is_active: !!isActive,
    equipment_status: equipmentStatus || 'Idle',
    previous_status: previousStatus || 'UNKNOWN',
    runtime_seconds: typeof runtimeSeconds === 'number' ? runtimeSeconds : null,
    runtime_type: runtimeType || 'UPDATE',
    timestamp: iso,
    recorded_at: iso,
    observed_at: iso,
    source_event_id: sourceEventId || uuidv4(),
    payload_raw: payloadRaw || null
  };

  if (timezone) payload.timezone = timezone;
  if (zipPrefix) {
    payload.zip_prefix = zipPrefix;
    payload.zip_code_prefix = zipPrefix;
  }

  return payload;
}

module.exports = { buildCorePayload };
