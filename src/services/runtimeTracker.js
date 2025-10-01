async function handleTemperatureChange(deviceKey, tempF, tempC, userId) {
  const pool = getPool();
  
  try {
    // Update device status
    await pool.query(`
      UPDATE device_status SET
        last_temperature = $2,
        last_seen_at = NOW(),
        updated_at = NOW()
      WHERE device_key = $1
    `, [deviceKey, tempF]);
    
    // Log temperature reading
    const deviceState = activeDevices.get(deviceKey);
    const sessionId = deviceState?.sessionId || null;
    
    await pool.query(`
      INSERT INTO temp_readings (
        device_key, temperature, units, event_type, session_id
      ) VALUES ($1, $2, 'F', 'temperature_update', $3)
    `, [deviceKey, tempF, sessionId]);
    
    // Get device info for Bubble post
    const deviceResult = await pool.query(`
      SELECT device_name, is_reachable, current_mode, current_equipment_status,
             last_was_cooling, last_was_heating, last_was_fan_only
      FROM device_status
      WHERE device_key = $1
    `, [deviceKey]);
    
    if (deviceResult.rows.length === 0) return;
    
    const device = deviceResult.rows[0];
    const currentMode = device.current_mode || 'off';
    
    // Post temperature update to Bubble
    await postToBubble({
      userId: userId,
      thermostatId: deviceKey,  // <-- CHANGED: use deviceKey instead of userId
      deviceName: device.device_name,
      runtimeSeconds: 0,
      runtimeMinutes: 0,
      isRuntimeEvent: false,
      hvacMode: currentMode,  // <-- CHANGED: already lowercase from database
      isHvacActive: !!deviceState,
      thermostatMode: currentMode.toUpperCase(),
      isReachable: device.is_reachable ?? true,
      currentTempF: tempF,
      currentTempC: tempC,
      lastIsCooling: device.last_was_cooling || false,
      lastIsHeating: device.last_was_heating || false,
      lastIsFanOnly: device.last_was_fan_only || false,
      lastEquipmentStatus: device.current_equipment_status?.toLowerCase() || 'off',
      equipmentStatus: device.current_equipment_status?.toLowerCase() || 'off',
      isFanOnly: deviceState?.isFanOnly || false,
      timestamp: new Date().toISOString(),
      eventId: uuidv4(),
      eventTimestamp: Date.now()
    });
    
  } catch (error) {
    console.error('Error handling temperature change:', error);
  }
}
