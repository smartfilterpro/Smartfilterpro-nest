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
  timezone,     // optional, only include if defined
  zipPrefix,    // optional, only include if defined

  eventType,
  equipmentStatus,
  previousStatus,
  isActive,
  mode,
  runtimeSeconds,
  temperatureF,
  humidity,
  heatSetpoint,
  coolSetpoint,
  observedAt,
  sourceEventId,
  payloadRaw
}) {
  const temperatureC =
    typeof temperatureF === 'number'
      ? Math.round(((temperatureF - 32) * 5 / 9) * 100) / 100
      : null;

  const iso = (observedAt || new Date()).toISOString();

  // Base payload — only includes values we know from the Nest API
  const payload = {
    device_key: deviceKey,
    device_id: `nest:${deviceKey}`,
    user_id: userId || null,
    workspace_id: workspaceId || null,
    device_name: deviceName || 'Nest Thermostat',
    manufacturer,
    model,
    device_type: deviceType,
    source,
    source_vendor: sourceVendor,
    connection_source: connectionSource,
    firmware_version: firmwareVersion,
    serial_number: serialNumber,

    // State snapshot
    last_mode: mode || null,
    last_is_cooling: equipmentStatus === 'COOLING',
    last_is_heating: equipmentStatus === 'HEATING',
    last_is_fan_only: equipmentStatus === 'FAN',
    last_equipment_status: equipmentStatus || null,
    is_reachable: true,

    // Telemetry snapshot
    last_temperature: temperatureF ?? null,
    last_humidity: humidity ?? null,
    last_heat_setpoint: heatSetpoint ?? null,
    last_cool_setpoint: coolSetpoint ?? null,

    // Event metadata
    event_type: eventType,
    is_active: !!isActive,
    equipment_status: equipmentStatus || 'OFF',
    previous_status: previousStatus || 'UNKNOWN',
    runtime_seconds: typeof runtimeSeconds === 'number' ? runtimeSeconds : null,
    timestamp: iso,
    recorded_at: iso,
    source_event_id: sourceEventId || uuidv4(),
    payload_raw: payloadRaw || null
  };

  // ✅ Only include optional fields if they are defined
  if (timezone) payload.timezone = timezone;
  if (zipPrefix) {
    payload.zip_prefix = zipPrefix;
    payload.zip_code_prefix = zipPrefix;
  }

  return payload;
}
