'use strict';
const { v4: uuidv4 } = require('uuid');
const { postToBubble } = require('./bubble');

function now() { return new Date(); }
function secondsBetween(a, b) { return Math.floor((b - a) / 1000); }

const TAIL_SECONDS = parseInt(process.env.LAST_FAN_TAIL_SECONDS || '30', 10);

/**
 * Determine active status based on equipment + fan timer.
 * Returns { active: boolean, mode: 'COOL'|'HEAT'|'FAN'|null }
 */
function resolveActive(equipmentStatus, fanTimerMode) {
  const eq = (equipmentStatus || '').toLowerCase();
  const fan = (fanTimerMode || '').toUpperCase();
  const cooling = eq === 'cool';
  const heating = eq === 'heat';
  const fanOn = fan === 'ON';

  if (cooling) return { active: true, mode: 'COOL' };
  if (heating) return { active: true, mode: 'HEAT' };
  if (fanOn) return { active: true, mode: 'FAN' };
  return { active: false, mode: null };
}

async function ensureDeviceRow(pool, device) {
  const { device_key, device_name, units, location_id, workspace_id, room_display_name } = device;
  const res = await pool.query(
    `INSERT INTO device_status (device_key, device_name, units, location_id, workspace_id, room_display_name, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,now(),now())
     ON CONFLICT (device_key) DO UPDATE SET updated_at = now()
     RETURNING *`,
    [device_key, device_name, units || 'F', location_id || null, workspace_id || null, room_display_name || null]
  );
  return res.rows[0];
}

async function getOpenSession(pool, device_key) {
  const q = await pool.query(
    `SELECT * FROM runtime_session WHERE device_key=$1 AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1`,
    [device_key]
  );
  return q.rows[0] || null;
}

async function startSession(pool, device_key, mode, equipment_status, temperature, heat_sp, cool_sp) {
  const id = uuidv4();
  const started_at = now();
  const q = await pool.query(
    `INSERT INTO runtime_session (id, device_key, mode, equipment_status, started_at, start_temperature, heat_setpoint, cool_setpoint, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now(),now()) RETURNING *`,
    [id, device_key, mode, equipment_status, started_at, temperature, heat_sp, cool_sp]
  );
  await pool.query(
    `UPDATE device_status SET is_running=true, session_started_at=$2, current_mode=$3, current_equipment_status=$4, last_activity_at=now(), updated_at=now()
     WHERE device_key=$1`,
    [device_key, started_at, mode, equipment_status]
  );
  return q.rows[0];
}

async function closeSessionWithTail(pool, deviceStatusRow, sessionRow, latestTemperature, bubbleBasePayload) {
  const device_key = deviceStatusRow.device_key;
  const endTime = now();
  // Delay post by TAIL_SECONDS and add it to runtime duration
  const ended_at = new Date(endTime.getTime() + TAIL_SECONDS * 1000);
  const duration_seconds = secondsBetween(new Date(sessionRow.started_at), ended_at);

  const updated = await pool.query(
    `UPDATE runtime_session
       SET ended_at=$3, duration_seconds=$4, end_temperature=$5, updated_at=now()
     WHERE id=$1 AND device_key=$2
     RETURNING *`,
    [sessionRow.id, device_key, ended_at, duration_seconds, latestTemperature]
  );

  await pool.query(
    `UPDATE device_status
       SET is_running=false, last_post_at=now(),
           last_mode=$2,
           last_was_cooling=($2='COOL'), last_was_heating=($2='HEAT'), last_was_fan_only=($2='FAN'),
           updated_at=now()
     WHERE device_key=$1`,
    [device_key, sessionRow.mode]
  );

  const payload = {
    ...bubbleBasePayload,
    runtimeSeconds: duration_seconds,
    runtimeMinutes: Math.floor(duration_seconds / 60),
    isRuntimeEvent: true,
    hvacMode: sessionRow.mode.toLowerCase(),
    isHvacActive: false,
    lastIsCooling: sessionRow.mode === 'COOL',
    lastIsHeating: sessionRow.mode === 'HEAT',
    lastIsFanOnly: sessionRow.mode === 'FAN',
    lastEquipmentStatus: sessionRow.equipment_status || 'unknown',
    equipmentStatus: 'unknown'
  };

  // Delay the POST by TAIL_SECONDS
  await new Promise((resolve) => setTimeout(resolve, TAIL_SECONDS * 1000));
  await postToBubble(payload);
}

async function recordTemp(pool, device_key, temp, units, session_id) {
  await pool.query(
    `INSERT INTO temp_readings (device_key, temperature, units, event_type, session_id, recorded_at)
     VALUES ($1,$2,$3,'temperature_update',$4,now())`,
    [device_key, temp, units || 'F', session_id || null]
  );
}

async function handleEvent(pool, evt) {
  const {
    userId, thermostatId, deviceName, temperatureC, temperatureF,
    thermostatMode, equipmentStatus, fanTimerMode,
    isReachable, roomDisplayName, eventId, eventTimestamp
  } = evt;

  const units = Number.isFinite(temperatureF) ? 'F' : 'C';
  const currentTemp = Number.isFinite(temperatureF) ? temperatureF : (Number.isFinite(temperatureC) ? temperatureC : null);

  const device_key = thermostatId;
  const deviceRow = await ensureDeviceRow(pool, {
    device_key, device_name: deviceName, units, room_display_name: roomDisplayName
  });

  // Reachability handling: if offline, close any open session and mark unreachable
  if (isReachable === false) {
    const open = await getOpenSession(pool, device_key);
    if (open) {
      await closeSessionWithTail(pool, deviceRow, open, currentTemp, {
        userId, thermostatId, deviceName,
        thermostatMode: thermostatMode || 'UNKNOWN',
        isReachable: false,
        currentTempF: Number.isFinite(temperatureF) ? temperatureF : null,
        currentTempC: Number.isFinite(temperatureC) ? temperatureC : null,
        timestamp: new Date().toISOString(),
        eventId: eventId || null,
        eventTimestamp: eventTimestamp || Date.now()
      });
    }
    await pool.query(
      `UPDATE device_status SET is_reachable=false, last_seen_at=now(), updated_at=now() WHERE device_key=$1`,
      [device_key]
    );
    // Also log connectivity event
    await pool.query(
      `INSERT INTO equipment_events (device_key, event_type, is_active, event_data)
       VALUES ($1,'connectivity',false,$2)`,
      [device_key, { isReachable: false }]
    );
    return;
  } else if (isReachable === true) {
    await pool.query(
      `UPDATE device_status SET is_reachable=true, last_seen_at=now(), updated_at=now() WHERE device_key=$1`,
      [device_key]
    );
  }

  // Resolve active state
  const activeInfo = resolveActive(equipmentStatus, fanTimerMode);
  const open = await getOpenSession(pool, device_key);

  // Always record temperature (every single reading)
  await recordTemp(pool, device_key, currentTemp, units, open ? open.id : null);

  // Prepare base payload used for any Bubble posts
  const basePayload = {
    userId,
    thermostatId,
    deviceName,
    runtimeSeconds: 0,
    runtimeMinutes: 0,
    isRuntimeEvent: false,
    hvacMode: (activeInfo.mode || 'UNKNOWN').toLowerCase(),
    isHvacActive: !!activeInfo.active,
    thermostatMode: thermostatMode || 'UNKNOWN',
    isReachable: true,
    currentTempF: Number.isFinite(temperatureF) ? temperatureF : null,
    currentTempC: Number.isFinite(temperatureC) ? temperatureC : null,
    lastIsCooling: false,
    lastIsHeating: false,
    lastIsFanOnly: false,
    lastEquipmentStatus: equipmentStatus || 'unknown',
    equipmentStatus: (equipmentStatus || 'unknown').toLowerCase(),
    isFanOnly: activeInfo.mode === 'FAN',
    timestamp: new Date().toISOString(),
    eventId: eventId || null,
    eventTimestamp: eventTimestamp || Date.now()
  };

  // Update device_status snapshot
  await pool.query(
    `UPDATE device_status
       SET current_mode=$2, current_equipment_status=$3,
           last_temperature=$4, last_fan_status=$5, last_equipment_status=$3,
           last_seen_at=now(), last_activity_at=now(), updated_at=now()
     WHERE device_key=$1`,
    [device_key, activeInfo.mode || 'OFF', equipmentStatus || 'unknown', currentTemp, (fanTimerMode || 'UNKNOWN')]
  );

  if (activeInfo.active) {
    if (!open) {
      // Start a new session based on priority COOL > HEAT > FAN
      const mode = activeInfo.mode;
      await startSession(pool, device_key, mode, (equipmentStatus || 'unknown'), currentTemp, null, null);
      await pool.query(
        `INSERT INTO equipment_events (device_key, event_type, equipment_status, previous_status, is_active, session_id, event_data)
         VALUES ($1,'equipment_status_change',$2,null,true,$3,$4)`,
        [device_key, equipmentStatus || 'unknown', null, { fanTimerMode, thermostatMode }]
      );
    } else if (open && open.mode !== activeInfo.mode) {
      // Mode switch while still active: close previous, start new (Q8)
      await closeSessionWithTail(pool, deviceRow, open, currentTemp, basePayload);
      await startSession(pool, device_key, activeInfo.mode, (equipmentStatus || 'unknown'), currentTemp, null, null);
    }
  } else {
    // Not active now
    if (open) {
      // End the session only when *both* equipment off and fan off
      await closeSessionWithTail(pool, deviceRow, open, currentTemp, basePayload);
      await pool.query(
        `INSERT INTO equipment_events (device_key, event_type, equipment_status, previous_status, is_active, session_id, event_data)
         VALUES ($1,'equipment_status_change',$2,$3,false,$4,$5)`,
        [device_key, equipmentStatus || 'unknown', open.equipment_status || null, false, open.id, { fanTimerMode, thermostatMode }]
      );
    }
  }

  // For temperature updates (every event carries temp), also post the current temperature to Bubble
  await postToBubble({
    ...basePayload,
    // isRuntimeEvent remains false for temp-only posts
  });
}

module.exports = {
  handleEvent,
  resolveActive
};
