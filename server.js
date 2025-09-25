console.log('Sent connectivity update to Bubble:', sanitizeForLogging({ isReachable: payload.isReachable }));
      } catch (err) {
        console.error('Failed to send connectivity update to Bubble:', err.response?.status || err.code || err.message);
      }
    }

    // Update device state in database
    await updateDeviceState(key, {
      ...prev,
      isReachable,
      lastSeenAt: eventTime,
      lastActivityAt: eventTime
    });

    console.log('DEBUG: Connectivity-only event processing complete');
    return;
  }

  console.log('DEBUG: Validation passed, proceeding with full HVAC event processing');

  // Derive current booleans & equipment status using fan + hvac status (effective)
  const { isHeating, isCooling, isFanOnly, equipmentStatus } = deriveCurrentFlags(hvacStatusEff, fanTimerOn);

  // Runtime only for heat/cool (not fan-only)
  const isActive = isHeating || isCooling;
  const wasActive = !!prev.isRunning;

  // Log equipment status change if different
  if (equipmentStatus !== prev.lastEquipmentStatus) {
    await logEquipmentEvent(
      key,
      'EquipmentStateChanged',
      equipmentStatus,
      prev.lastEquipmentStatus,
      isActive,
      {
        temperature: currentTemp,
        fanTimerOn: fanTimerOn,
        timestamp: eventTime
      }
    );
  }

  function createBubblePayload(runtimeSeconds = 0, isRuntimeEvent = false, sessionData = null) {
    const payload = {
      userId,
      thermostatId: deviceId,
      deviceName: deviceName,
      runtimeSeconds,
      runtimeMinutes: Math.round(runtimeSeconds / 60),
      isRuntimeEvent,
      hvacMode: hvacStatusEff,
      isHvacActive: isActive,
      thermostatMode: mode,
      isReachable,

      currentTempF: celsiusToFahrenheit(currentTemp),
      coolSetpointF: celsiusToFahrenheit(coolSetpoint),
      heatSetpointF: celsiusToFahrenheit(heatSetpoint),
      startTempF: sessionData?.startTemperature ? celsiusToFahrenheit(sessionData.startTemperature) : null,
      endTempF: celsiusToFahrenheit(currentTemp),
      currentTempC: currentTemp ?? null,
      coolSetpointC: coolSetpoint ?? null,
      heatSetpointC: heatSetpoint ?? null,
      startTempC: sessionData?.startTemperature ?? null,
      endTempC: currentTemp ?? null,

      lastIsCooling,
      lastIsHeating,
      lastIsFanOnly,
      lastEquipmentStatus,

      equipmentStatus,
      isFanOnly,

      timestamp,
      eventId: eventData.eventId,
      eventTimestamp: eventTime
    };

    console.log('DEBUG - Created payload:');
    console.log(JSON.stringify(payload, null, 2));
    return payload;
  }

  let payload;
  let sessionChanged = false;

  // Improved runtime calculation logic
  if (isActive && !wasActive) {
    // Just turned on - ensure we're starting a clean session
    console.log(`🟢 HVAC turning ON: ${equipmentStatus} for ${key.substring(0, 16)}`);
    
    // Close any existing session first (safety measure)
    if (sessions[key] || prev.isRunning) {
      console.warn('Warning: Starting new session while previous session still active - closing previous session');
      if (sessions[key]?.startTime) {
        const prevRuntimeSeconds = Math.floor((eventTime - sessions[key].startTime) / 1000);
        if (prevRuntimeSeconds > 0 && prevRuntimeSeconds < 24 * 3600) {
          await logRuntimeSession(key, {
            mode: sessions[key].startStatus || 'unknown',
            equipmentStatus: 'interrupted',
            startedAt: sessions[key].startTime,
            endedAt: eventTime,
            durationSeconds: prevRuntimeSeconds,
            startTemperature: sessions[key].startTemperature,
            endTemperature: currentTemp,
            heatSetpoint: heatSetpoint,
            coolSetpoint: coolSetpoint
          });
        }
      }
    }
    
    // Start new session
    const sessionData = {
      startTime: eventTime,
      startStatus: equipmentStatus, // Use equipment status, not hvac status
      startTemperature: currentTemp
    };
    sessions[key] = sessionData;
    sessionChanged = true;
    
    payload = createBubblePayload(0, false);
    console.log(`✅ Started ${equipmentStatus} session at ${new Date(eventTime).toLocaleTimeString()}`);

  } else if (!isActive && wasActive) {
    // Just turned off - calculate runtime accurately
    console.log(`🔴 HVAC turning OFF for ${key.substring(0, 16)}`);
    
    // Get session data from memory first, then fallback to database
    let session = sessions[key];
    if (!session && prev.sessionStartedAt) {
      session = {
        startTime: prev.sessionStartedAt,
        startStatus: prev.currentMode || 'unknown',
        startTemperature: prev.lastTemperature
      };
      console.log('Using database session data for runtime calculation');
    }
    
    if (session?.startTime) {
      const runtimeSeconds = Math.floor((eventTime - session.startTime) / 1000);
      const runtimeMinutes = Math.round(runtimeSeconds / 60);
      
      console.log(`⏱️  Runtime calculation: ${runtimeSeconds}s (${runtimeMinutes}m) from ${new Date(session.startTime).toLocaleTimeString()} to ${new Date(eventTime).toLocaleTimeString()}`);
      
      if (runtimeSeconds > 0 && runtimeSeconds < 24 * 3600) {
        // Valid runtime - log to database
        await logRuntimeSession(key, {
          mode: session.startStatus,
          equipmentStatus: equipmentStatus,
          startedAt: session.startTime,
          endedAt: eventTime,
          durationSeconds: runtimeSeconds,
          startTemperature: session.startTemperature,
          endTemperature: currentTemp,
          heatSetpoint: heatSetpoint,
          coolSetpoint: coolSetpoint
        });

        payload = createBubblePayload(runtimeSeconds, true, session);
        console.log(`✅ Ended session: ${runtimeSeconds}s runtime (${session.startStatus})`);
      } else {
        console.warn(`❌ Invalid runtime ${runtimeSeconds}s (${runtimeMinutes}m), sending zero runtime`);
        payload = createBubblePayload(0, false);
      }
    } else {
      console.warn('❌ No session data found for runtime calculation');
      payload = createBubblePayload(0, false);
    }
    
    // Clean up session
    delete sessions[key];
    sessionChanged = true;

  } else if (isActive && !sessions[key] && !prev.isRunning) {
    // Active but no session tracked - possible restart scenario or missed start event
    console.log(`🟡 HVAC is active but no session tracked for ${key.substring(0, 16)} - starting recovery session`);
    
    const sessionData = {
      startTime: eventTime,
      startStatus: equipmentStatus,
      startTemperature: currentTemp
    };
    sessions[key] = sessionData;
    sessionChanged = true;
    
    payload = createBubblePayload(0, false);
    console.log(`✅ Recovery session started for ${equipmentStatus}`);

  } else if (isActive && sessions[key]) {
    // Currently running - send periodic update
    const session = sessions[key];
    const currentRuntimeSeconds = Math.floor((eventTime - session.startTime) / 1000);
    const runtimeMinutes = Math.round(currentRuntimeSeconds / 60);
    
    // Send runtime updates every 10 minutes during long sessions
    const lastUpdate = prev.lastActivityAt || 0;
    const timeSinceLastUpdate = eventTime - lastUpdate;
    const shouldSendRuntimeUpdate = timeSinceLastUpdate > (10 * 60 * 1000); // 10 minutes
    
    if (shouldSendRuntimeUpdate && currentRuntimeSeconds > 60) { // Only if running > 1 minute
      console.log(`🔄 Runtime update: ${currentRuntimeSeconds}s (${runtimeMinutes}m) - ${equipmentStatus}`);
      payload = createBubblePayload(currentRuntimeSeconds, false, session);
    } else {
      // Regular temperature/status update without runtime focus
      payload = createBubblePayload(0, false);
    }

  } else {
    // No state change or inactive system
    payload = createBubblePayload(0, false);
    if (currentTemp && !IS_PRODUCTION) {
      console.log(`🌡️  Temperature update: ${currentTemp}°C (${celsiusToFahrenheit(currentTemp)}°F)`);
    }
  }

  // Update device state in database with more accurate tracking
  const newState = {
    ...prev,
    isRunning: isActive,
    sessionStartedAt: isActive ? (sessions[key]?.startTime || prev.sessionStartedAt) : null,
    currentMode: equipmentStatus,
    lastTemperature: currentTemp || prev.lastTemperature,
    lastHeatSetpoint: heatSetpoint !== undefined ? heatSetpoint : prev.lastHeatSetpoint,
    lastCoolSetpoint: coolSetpoint !== undefined ? coolSetpoint : prev.lastCoolSetpoint,
    lastEquipmentStatus: equipmentStatus,
    isReachable,
    lastSeenAt: eventTime,
    lastActivityAt: eventTime
  };

  await updateDeviceState(key, newState);

  if (process.env.BUBBLE_WEBHOOK_URL) {
    try {
      console.log('DEBUG - Sending to Bubble…');
      await axios.post(process.env.BUBBLE_WEBHOOK_URL, payload, {
        timeout: 10000,
        headers: {
          'User-Agent': 'Nest-Runtime-Tracker/1.2',
          'Content-Type': 'application/json'
        }
      });

      const logData = sanitizeForLogging({
        runtimeSeconds: payload.runtimeSeconds,
        isRuntimeEvent: payload.isRuntimeEvent,
        hvacMode: payload.hvacMode,
        isHvacActive: payload.isHvacActive,
        currentTempF: payload.currentTempF,
        isReachable: payload.isReachable
      });
      console.log('Sent to Bubble:', logData);
    } catch (err) {
      console.error('Failed to send to Bubble:', err.response?.status || err.code || err.message);
      const retryDelay = 5000;
      setTimeout(async () => {
        try {
          await axios.post(process.env.BUBBLE_WEBHOOK_URL, payload, {
            timeout: 10000,
            headers: {
              'User-Agent': 'Nest-Runtime-Tracker/1.2',
              'Content-Type': 'application/json'
            }
          });
          console.log('Retry successful');
        } catch (retryErr) {
          console.error('Retry failed:', retryErr.response?.status || retryErr.code || retryErr.message);
        }
      }, retryDelay);
    }
  } else if (!IS_PRODUCTION) {
    const logData = sanitizeForLogging({
      runtimeSeconds: payload.runtimeSeconds,
      isRuntimeEvent: payload.isRuntimeEvent,
      hvacMode: payload.hvacMode,
      isHvacActive: payload.isHvacActive,
      currentTempF: payload.currentTempF,
      isReachable: payload.isReachable
    });
    console.log('Would send to Bubble (no URL configured):', logData);
  }

  console.log('DEBUG: Event processing complete');
}

// Staleness monitoring - check for devices that haven't sent updates in 12 hours
setInterval(async () => {
  const now = Date.now();
  const staleThreshold = now - STALENESS_THRESHOLD;
  
  console.log('Checking for stale devices...');
  
  // Check memory-based devices
  for (const [key, state] of Object.entries(deviceStates)) {
    const lastActivity = state.lastActivityAt || 0;
    const lastStalenessNotification = state.lastStalenessNotification || 0;
    
    // Send notification if:
    // 1. Device is stale (last activity > 12 hours ago)
    // 2. Either never sent staleness notification OR last notification was > 12 hours ago
    if (lastActivity > 0 && lastActivity < staleThreshold) {
      const timeSinceLastNotification = now - lastStalenessNotification;
      
      if (lastStalenessNotification === 0 || timeSinceLastNotification >= STALENESS_THRESHOLD) {
        const hoursSinceLastActivity = Math.floor((now - lastActivity) / (60 * 60 * 1000));
        console.log(`Device ${key} is stale (${hoursSinceLastActivity} hours since last activity), sending staleness notification`);
        
        await sendStalenessNotification(key, state, now);
        
        // Update the last staleness notification time
        state.lastStalenessNotification = now;
        deviceStates[key] = state;
      }
    } else if (lastActivity >= staleThreshold && state.lastStalenessNotification) {
      // Device came back online - reset staleness notification tracking
      delete state.lastStalenessNotification;
      deviceStates[key] = state;
    }
  }
  
  // Check database-based devices if enabled
  if (pool) {
    try {
      const staleDevices = await pool.query(`
        SELECT device_key, last_activity_at, last_temperature, last_equipment_status, 
               is_reachable, last_staleness_notification
        FROM device_states 
        WHERE last_activity_at < $1 
          AND last_activity_at > $2
      `, [new Date(staleThreshold), new Date(now - (7 * 24 * 60 * 60 * 1000))]); // Don't check devices older than 7 days
      
      for (const device of staleDevices.rows) {
        const lastStalenessNotification = device.last_staleness_notification ? 
          new Date(device.last_staleness_notification).getTime() : 0;
        const timeSinceLastNotification = now - lastStalenessNotification;
        
        if (lastStalenessNotification === 0 || timeSinceLastNotification >= STALENESS_THRESHOLD) {
          const hoursSinceLastActivity = Math.floor((now - new Date(device.last_activity_at).getTime()) / (60 * 60 * 1000));
          console.log(`Database device ${device.device_key} is stale (${hoursSinceLastActivity} hours), sending staleness notification`);
          
          await sendStalenessNotification(device.device_key, {
            lastTemperature: device.last_temperature,
            lastEquipmentStatus: device.last_equipment_status,
            lastActivityAt: new Date(device.last_activity_at).getTime()
          }, now);
          
          // Update database with last staleness notification time
          try {
            await pool.query(`
              UPDATE device_states 
              SET last_staleness_notification = NOW() 
              WHERE device_key = $1
            `, [device.device_key]);
          } catch (updateError) {
            console.error('Failed to update staleness notification time:', updateError.message);
          }
        }
      }
    } catch (error) {
      console.error('Error checking database for stale devices:', error.message);
    }
  }
}, STALENESS_CHECK_INTERVAL);

// Runtime timeout monitoring - close sessions that have been running too long
setInterval(async () => {
  const now = Date.now();
  const timeoutThreshold = now - RUNTIME_TIMEOUT;
  
  console.log('Checking for timed-out runtime sessions...');
  
  // Check memory sessions
  for (const [key, session] of Object.entries(sessions)) {
    if (session.startTime && session.startTime < timeoutThreshold) {
      console.log(`Force-closing runtime session for ${key} (running for ${Math.round((now - session.startTime) / 60000)} minutes)`);
      
      const runtimeSeconds = Math.floor((now - session.startTime) / 1000);
      
      // Log the session end
      if (pool) {
        await logRuntimeSession(key, {
          mode: session.startStatus,
          equipmentStatus: 'timeout',
          startedAt: session.startTime,
          endedAt: now,
          durationSeconds: runtimeSeconds,
          startTemperature: session.startTemperature,
          endTemperature: null,
          heatSetpoint: null,
          coolSetpoint: null
        });
      }
      
      // Send timeout notification to Bubble
      const payload = {
        thermostatId: key.split('-').pop(),
        deviceName: `Device ${key}`,
        runtimeSeconds: runtimeSeconds,
        runtimeMinutes: Math.round(runtimeSeconds / 60),
        isRuntimeEvent: true,
        hvacMode: 'OFF',
        isHvacActive: false,
        thermostatMode: 'OFF',
        isReachable: false, // Mark as unreachable due to timeout
        
        currentTempF: null,
        coolSetpointF: null,
        heatSetpointF: null,
        startTempF: session.startTemperature ? celsiusToFahrenheit(session.startTemperature) : null,
        endTempF: null,
        currentTempC: null,
        coolSetpointC: null,
        heatSetpointC: null,
        startTempC: session.startTemperature || null,
        endTempC: null,
        
        lastIsCooling: false,
        lastIsHeating: false,
        lastIsFanOnly: false,
        lastEquipmentStatus: 'timeout',
        equipmentStatus: 'timeout',
        
        timestamp: new Date(now).toISOString(),
        eventId: `timeout-${Date.now()}`,
        eventTimestamp: now
      };
      
      if (process.env.BUBBLE_WEBHOOK_URL) {
        try {
          await axios.post(process.env.BUBBLE_WEBHOOK_URL, payload, {
            timeout: 10000,
            headers: {
              'User-Agent': 'Nest-Runtime-Tracker/1.2',
              'Content-Type': 'application/json'
            }
          });
          console.log('Sent runtime timeout notification to Bubble');
        } catch (err) {
          console.error('Failed to send timeout notification:', err.message);
        }
      }
      
      // Update device state
      const deviceState = deviceStates[key] || {};
      deviceState.isRunning = false;
      deviceState.sessionStartedAt = null;
      deviceState.isReachable = false;
      deviceState.lastActivityAt = now;
      
      await updateDeviceState(key, deviceState);
      delete sessions[key];
    }
  }
  
  // Check database sessions
  if (pool) {
    try {
      const result = await pool.query(`
        UPDATE runtime_sessions 
        SET ended_at = NOW(),
            duration_seconds = EXTRACT(EPOCH FROM (NOW() - started_at))::INTEGER,
            equipment_status = 'timeout'
        WHERE ended_at IS NULL 
          AND started_at < $1
        RETURNING device_key, duration_seconds
      `, [new Date(timeoutThreshold)]);
      
      for (const row of result.rows) {
        console.log(`Force-closed database runtime session for ${row.device_key} (${row.duration_seconds}s)`);
      }
      
      // Update device states for timed-out sessions
      await pool.query(`
        UPDATE device_states 
        SET is_running = false,
            session_started_at = NULL,
            is_reachable = false,
            last_activity_at = NOW()
        WHERE is_running = true 
          AND session_started_at < $1
      `, [new Date(timeoutThreshold)]);
      
    } catch (error) {
      console.error('Error checking database for timed-out sessions:', error.message);
    }
  }
}, STALENESS_CHECK_INTERVAL);

// Regular cleanup - runs every 6 hours
setInterval(async () => {
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

  // Database cleanup
  if (pool) {
    try {
      const results = await Promise.all([
        pool.query(`DELETE FROM runtime_sessions WHERE ended_at < NOW() - INTERVAL '90 days'`),
        pool.query(`DELETE FROM temperature_readings WHERE recorded_at < NOW() - INTERVAL '90 days'`),
        pool.query(`DELETE FROM equipment_events WHERE recorded_at < NOW() - INTERVAL '90 days'`)
      ]);
      
      console.log(`Database cleanup: ${results[0].rowCount} sessions, ${results[1].rowCount} temp readings, ${results[2].rowCount} equipment events deleted`);
    } catch (error) {
      console.error('Database cleanup error:', error.message);
    }
  }

  if (cleaned > 0) {
    console.log(`Cleaned up ${cleaned} old Nest sessions`);
  }
}, CLEANUP_INTERVAL);

// Database initialization on startup
async function initializeDatabase() {
  if (!ENABLE_DATABASE || !pool) {
    console.log('Database disabled - using memory-only state');
    return;
  }

  try {
    const result = await pool.query('SELECT NOW() as now');
    console.log('Database connection established:', result.rows[0].now);
    
    // Run migration
    await runDatabaseMigration();
    
    // Load existing device states into memory for faster access
    const stateResult = await pool.query('SELECT device_key FROM device_states');
    console.log(`Loaded ${stateResult.rows.length} existing device states from database`);
    
  } catch (error) {
    console.error('Database initialization failed:', error.message);
    console.warn('Falling back to memory-only state management');
  }
}

// Health check with detailed system information
app.get('/admin/health', requireAuth, async (req, res) => {
  let dbStatus = 'disabled';
  let dbInfo = {};
  
  if (pool) {
    try {
      const dbResult = await pool.query(`
        SELECT 
          COUNT(*) as device_count,
          COUNT(CASE WHEN is_running = true THEN 1 END) as running_sessions,
          COUNT(CASE WHEN is_reachable = false THEN 1 END) as unreachable_devices
        FROM device_states
      `);
      
      const sessionResult = await pool.query(`
        SELECT COUNT(*) as total_sessions
        FROM runtime_sessions 
        WHERE started_at > NOW() - INTERVAL '24 hours'
      `);
      
      dbStatus = 'connected';
      dbInfo = {
        devices: parseInt(dbResult.rows[0].device_count),
        runningSessions: parseInt(dbResult.rows[0].running_sessions),
        unreachableDevices: parseInt(dbResult.rows[0].unreachable_devices),
        sessionsLast24h: parseInt(sessionResult.rows[0].total_sessions)
      };
    } catch (error) {
      dbStatus = 'error';
      dbInfo = { error: error.message };
    }
  }

  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    memorySessions: Object.keys(sessions).length,
    memoryStates: Object.keys(deviceStates).length,
    database: {
      status: dbStatus,
      ...dbInfo
    },
    config: {
      stalenessThresholdHours: STALENESS_THRESHOLD / (60 * 60 * 1000),
      runtimeTimeoutHours: RUNTIME_TIMEOUT / (60 * 60 * 1000),
      databaseEnabled: ENABLE_DATABASE,
      bubbleConfigured: !!process.env.BUBBLE_WEBHOOK_URL
    },
    memoryUsage: process.memoryUsage()
  });
});

// Post system metrics to Railway (or any webhook endpoint)
app.post('/admin/post-to-railway', requireAuth, async (req, res) => {
  const railwayWebhookUrl = process.env.RAILWAY_WEBHOOK_URL;
  
  if (!railwayWebhookUrl) {
    return res.status(400).json({ error: 'RAILWAY_WEBHOOK_URL not configured' });
  }

  try {
    // Collect system metrics
    let systemMetrics = {
      timestamp: new Date().toISOString(),
      service: 'nest-runtime-tracker',
      uptime: process.uptime(),
      memorySessions: Object.keys(sessions).length,
      memoryStates: Object.keys(deviceStates).length,
      memoryUsage: process.memoryUsage()
    };

    // Add database metrics if available
    if (pool) {
      try {
        const dbMetrics = await pool.query(`
          SELECT 
            COUNT(*) as total_devices,
            COUNT(CASE WHEN is_running = true THEN 1 END) as running_sessions,
            COUNT(CASE WHEN is_reachable = false THEN 1 END) as unreachable_devices,
            COUNT(CASE WHEN last_activity_at > NOW() - INTERVAL '1 hour' THEN 1 END) as active_last_hour,
            AVG(last_temperature) as avg_temperature
          FROM device_states
        `);

        const sessionMetrics = await pool.query(`
          SELECT 
            COUNT(*) as sessions_today,
            AVG(duration_seconds) as avg_duration_seconds,
            SUM(duration_seconds) as total_runtime_seconds
          FROM runtime_sessions 
          WHERE started_at > NOW() - INTERVAL '24 hours'
        `);

        systemMetrics.database = {
          totalDevices: parseInt(dbMetrics.rows[0].total_devices),
          runningSessions: parseInt(dbMetrics.rows[0].running_sessions),
          unreachableDevices: parseInt(dbMetrics.rows[0].unreachable_devices),
          activeLastHour: parseInt(dbMetrics.rows[0].active_last_hour),
          avgTemperature: dbMetrics.rows[0].avg_temperature ? parseFloat(dbMetrics.rows[0].avg_temperature) : null,
          sessionsToday: parseInt(sessionMetrics.rows[0].sessions_today),
          avgDurationSeconds: sessionMetrics.rows[0].avg_duration_seconds ? parseFloat(sessionMetrics.rows[0].avg_duration_seconds) : null,
          totalRuntimeSecondsToday: sessionMetrics.rows[0].total_runtime_seconds ? parseInt(sessionMetrics.rows[0].total_runtime_seconds) : 0
        };
      } catch (dbError) {
        systemMetrics.database = { error: dbError.message };
      }
    }

    // Include any custom data from request body
    if (req.body && typeof req.body === 'object') {
      systemMetrics.customData = req.body;
    }

    // Send to Railway webhook
    const response = await axios.post(railwayWebhookUrl, systemMetrics, {
      timeout: 10000,
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Nest-Runtime-Tracker/1.2'
      }
    });

    console.log('Posted metrics to Railway:', sanitizeForLogging(systemMetrics));

    res.json({
      success: true,
      timestamp: new Date().toISOString(),
      metricsPosted: systemMetrics,
      railwayResponse: {
        status: response.status,
        statusText: response.statusText
      }
    });

  } catch (error) {
    console.error('Failed to post to Railway:', error.message);
    res.status(500).json({
      error: 'Failed to post to Railway',
      message: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// Get user data summary (for verification before deletion)
app.get('/admin/user/:userId', requireAuth, async (req, res) => {
  const userId = req.params.userId;
  
  if (!userId) {
    return res.status(400).json({ error: 'User ID is required' });
  }

  const sanitizedUserId = userId.substring(0, 8) + '...';

  try {
    let userSummary = {
      userId: sanitizedUserId,
      timestamp: new Date().toISOString(),
      memoryData: {
        activeSessions: 0,
        deviceStates: 0,
        deviceList: []
      },
      databaseData: {}
    };

    // Check memory data
    for (const [key, session] of Object.entries(sessions)) {
      if (key.startsWith(userId + '-')) {
        userSummary.memoryData.activeSessions++;
        userSummary.memoryData.deviceList.push({
          deviceKey: key,
          startTime: new Date(session.startTime).toISOString(),
          status: session.startStatus,
          startTemp: session.startTemperature
        });
      }
    }

    for (const [key] of Object.entries(deviceStates)) {
      if (key.startsWith(userId + '-')) {
        userSummary.memoryData.deviceStates++;
      }
    }

    // Check database data if enabled
    if (pool) {
      try {
        const deviceStatesResult = await pool.query(
          `SELECT device_key, is_running, last_temperature, last_activity_at 
           FROM device_states WHERE device_key LIKE $1`,
          [userId + '-%']
        );

        const sessionCountResult = await pool.query(
          `SELECT COUNT(*) as count FROM runtime_sessions rs
           JOIN device_states ds ON rs.device_key = ds.device_key
           WHERE ds.device_key LIKE $1`,
          [userId + '-%']
        );

        const tempReadingsResult = await pool.query(
          `SELECT COUNT(*) as count FROM temperature_readings tr
           JOIN device_states ds ON tr.device_key = ds.device_key
           WHERE ds.device_key LIKE $1`,
          [userId + '-%']
        );

        userSummary.databaseData = {
          devices: deviceStatesResult.rows.map(row => ({
            deviceKey: row.device_key,
            isRunning: row.is_running,
            lastTemperature: row.last_temperature,
            lastActivity: row.last_activity_at
          })),
          totalRuntimeSessions: parseInt(sessionCountResult.rows[0].count),
          totalTemperatureReadings: parseInt(tempReadingsResult.rows[0].count)
        };

      } catch (dbError) {
        userSummary.databaseData = { error: dbError.message };
      }
    } else {
      userSummary.databaseData = { message: 'Database not enabled' };
    }

    res.json(userSummary);

  } catch (error) {
    console.error(`Failed to get user summary for ${sanitizedUserId}:`, error.message);
    res.status(500).json({
      error: 'Failed to get user data',
      userId: sanitizedUserId,
      message: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// Delete user account and all associated data
app.delete('/admin/user/:userId', requireAuth, async (req, res) => {
  const userId = req.params.userId;
  
  if (!userId) {
    return res.status(400).json({ error: 'User ID is required' });
  }

  // Sanitize userId for logging
  const sanitizedUserId = userId.substring(0, 8) + '...';

  try {
    let deletionReport = {
      userId: sanitizedUserId,
      timestamp: new Date().toISOString(),
      memoryCleanup: {
        sessionsDeleted: 0,
        statesDeleted: 0
      },
      databaseCleanup: {}
    };

    // Clean up memory-based data
    let memorySessionsDeleted = 0;
    let memoryStatesDeleted = 0;

    for (const [key, session] of Object.entries(sessions)) {
      if (key.startsWith(userId + '-')) {
        delete sessions[key];
        memorySessionsDeleted++;
      }
    }

    for (const [key, state] of Object.entries(deviceStates)) {
      if (key.startsWith(userId + '-')) {
        delete deviceStates[key];
        memoryStatesDeleted++;
      }
    }

    deletionReport.memoryCleanup = {
      sessionsDeleted: memorySessionsDeleted,
      statesDeleted: memoryStatesDeleted
    };

    // Clean up database if enabled
    if (pool) {
      try {
        const client = await pool.connect();
        
        try {
          await client.query('BEGIN');

          // Find all device_keys for this user
          const deviceKeysResult = await client.query(
            `SELECT device_key FROM device_states WHERE device_key LIKE $1`,
            [userId + '-%']
          );
          
          const deviceKeys = deviceKeysResult.rows.map(row => row.device_key);
          
          if (deviceKeys.length > 0) {
            // Delete from all related tables
            const tempReadingsResult = await client.query(
              `DELETE FROM temperature_readings WHERE device_key = ANY($1)`,
              [deviceKeys]
            );
            
            const equipmentEventsResult = await client.query(
              `DELETE FROM equipment_events WHERE device_key = ANY($1)`,
              [deviceKeys]
            );
            
            const runtimeSessionsResult = await client.query(
              `DELETE FROM runtime_sessions WHERE device_key = ANY($1)`,
              [deviceKeys]
            );
            
            const deviceStatesResult = await client.query(
              `DELETE FROM device_states WHERE device_key = ANY($1)`,
              [deviceKeys]
            );

            deletionReport.databaseCleanup = {
              devicesDeleted: deviceStatesResult.rowCount,
              runtimeSessionsDeleted: runtimeSessionsResult.rowCount,
              equipmentEventsDeleted: equipmentEventsResult.rowCount,
              temperatureReadingsDeleted: tempReadingsResult.rowCount,
              deviceKeysAffected: deviceKeys.length
            };
          } else {
            deletionReport.databaseCleanup = {
              message: 'No database records found for this user'
            };
          }

          await client.query('COMMIT');
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        } finally {
          client.release();
        }

      } catch (dbError) {
        deletionReport.databaseCleanup = {
          error: dbError.message
        };
      }
    } else {
      deletionReport.databaseCleanup = {
        message: 'Database not enabled'
      };
    }

    // Optionally notify Bubble about account deletion
    if (process.env.BUBBLE_WEBHOOK_URL && req.body?.notifyBubble) {
      try {
        const bubblePayload = {
          eventType: 'AccountDeleted',
          userId: userId,
          timestamp: new Date().toISOString(),
          deletionReport: deletionReport
        };

        await axios.post(process.env.BUBBLE_WEBHOOK_URL, bubblePayload, {
          timeout: 10000,
          headers: {
            'User-Agent': 'Nest-Runtime-Tracker/1.2',
            'Content-Type': 'application/json'
          }
        });

        deletionReport.bubbleNotification = 'sent';
      } catch (bubbleError) {
        deletionReport.bubbleNotification = { error: bubbleError.message };
      }
    }

    console.log(`User account deletion completed for ${sanitizedUserId}:`, deletionReport);

    res.json({
      success: true,
      message: `User account ${sanitizedUserId} has been deleted`,
      deletionReport: deletionReport
    });

  } catch (error) {
    console.error(`Failed to delete user account ${sanitizedUserId}:`, error.message);
    res.status(500).json({
      error: 'Failed to delete user account',
      userId: sanitizedUserId,
      message: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// Force cleanup of stale data
app.post('/admin/cleanup', requireAuth, async (req, res) => {
  try {
    const now = Date.now();
    const cleanupReport = {
      timestamp: new Date().toISOString(),
      memoryCleanup: { sessionsDeleted: 0, statesDeleted: 0 },
      databaseCleanup: {}
    };

    // Memory cleanup
    const staleThreshold = now - STALENESS_THRESHOLD;
    let memorySessionsDeleted = 0;
    let memoryStatesDeleted = 0;

    for (const [key, session] of Object.entries(sessions)) {
      if (session.startTime < staleThreshold) {
        delete sessions[key];
        memorySessionsDeleted++;
      }
    }

    for (const [key, state] of Object.entries(deviceStates)) {
      const lastActivity = state.lastActivityAt || 0;
      if (lastActivity < staleThreshold) {
        delete deviceStates[key];
        memoryStatesDeleted++;
      }
    }

    cleanupReport.memoryCleanup = {
      sessionsDeleted: memorySessionsDeleted,
      statesDeleted: memoryStatesDeleted
    };

    // Database cleanup
    if (pool) {
      try {
        const results = await Promise.all([
          pool.query(`DELETE FROM runtime_sessions WHERE ended_at < NOW() - INTERVAL '90 days'`),
          pool.query(`DELETE FROM temperature_readings WHERE recorded_at < NOW() - INTERVAL '90 days'`),
          pool.query(`DELETE FROM equipment_events WHERE recorded_at < NOW() - INTERVAL '90 days'`),
          pool.query(`UPDATE device_states SET is_reachable = false WHERE last_activity_at < NOW() - INTERVAL '${STALENESS_THRESHOLD / 1000} seconds'`)
        ]);

        cleanupReport.databaseCleanup = {
          sessionsDeleted: results[0].rowCount,
          temperatureReadingsDeleted: results[1].rowCount,
          equipmentEventsDeleted: results[2].rowCount,
          devicesMarkedUnreachable: results[3].rowCount
        };
      } catch (dbError) {
        cleanupReport.databaseCleanup = { error: dbError.message };
      }
    }

    console.log('Manual cleanup completed:', cleanupReport);

    res.json({
      success: true,
      message: 'Cleanup completed',
      report: cleanupReport
    });

  } catch (error) {
    console.error('Cleanup failed:', error.message);
    res.status(500).json({
      error: 'Cleanup failed',
      message: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// Health check endpoint
app.get('/health', async (req, res) => {
  let dbStatus = 'disabled';
  
  if (pool) {
    try {
      await pool.query('SELECT 1');
      dbStatus = 'connected';
    } catch (error) {
      dbStatus = 'error';
    }
  }

  res.status(200).json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    sessions: Object.keys(sessions).length,
    uptime: process.uptime(),
    database: dbStatus,
    memoryUsage: process.memoryUsage()
  });
});

app.get('/', (req, res) => {
  res.send('Nest Runtime Webhook server is running!');
});

app.post('/webhook', async (req, res) => {
  try {
    const pubsubMessage = req.body.message;
    if (!pubsubMessage || !pubsubMessage.data) {
      console.error('Invalid Pub/Sub message structure');
      return res.status(400).send('Invalid Pub/Sub message');
    }

    let eventData;
    try {
      eventData = JSON.parse(Buffer.from(pubsubMessage.data, 'base64').toString());
    } catch (decodeError) {
      console.error('Failed to decode Pub/Sub message:', decodeError.message);
      return res.status(400).send('Invalid message format');
    }

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

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('Received SIGINT, shutting down gracefully...');
  if (pool) {
    await pool.end();
  }
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('Received SIGTERM, shutting down gracefully...');
  if (pool) {
    await pool.end();
  }
  process.exit(0);
});

// Start the server
async function startServer() {
  await initializeDatabase();
  
  app.listen(PORT, () => {
    console.log(`Server started successfully`);
    console.log(`Configuration:`);
    console.log(`- Port: ${PORT}`);
    console.log(`- Environment: ${IS_PRODUCTION ? 'Production' : 'Development'}`);
    console.log(`- Bubble webhook: ${process.env.BUBBLE_WEBHOOK_URL ? 'Configured' : 'Not configured'}`);
    console.log(`- Database: ${ENABLE_DATABASE && DATABASE_URL ? 'Enabled' : 'Disabled (memory-only)'}`);
    console.log(`- Staleness threshold: ${STALENESS_THRESHOLD / (60 * 60 * 1000)} hours`);
    console.log(`- Runtime timeout: ${RUNTIME_TIMEOUT / (60 * 60 * 1000)} hours`);
    console.log(`Ready to receive Nest events at /webhook`);
  });
}

startServer().catch(error => {
  console.error('Failed to start server:', error.message);
  process.exit(1);
});'use strict';

console.log('Starting Nest server...');

const express = require('express');
const axios = require('axios');
const { Pool } = require('pg');
require('dotenv').config();

console.log('All modules loaded successfully');

const app = express();
const PORT = process.env.PORT || 8080;

// Database configuration
const DATABASE_URL = process.env.DATABASE_URL;
const ENABLE_DATABASE = process.env.ENABLE_DATABASE !== "0"; // Enabled by default
let pool = null;

if (ENABLE_DATABASE && DATABASE_URL) {
  pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false },
    max: parseInt(process.env.DB_MAX_CONNECTIONS || '10'),
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
  });

  pool.on('error', (err) => {
    console.error('Database pool error:', err.message);
  });
}

// Security headers middleware
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

app.use(express.json());

// Session storage (keep for fallback when DB is disabled)
const sessions = {};
const deviceStates = {};

// Environment check
const IS_PRODUCTION = process.env.NODE_ENV === 'production';

// Enhanced monitoring and cleanup system
const STALENESS_CHECK_INTERVAL = 60 * 60 * 1000; // Check every hour
const STALENESS_THRESHOLD = (parseInt(process.env.STALENESS_THRESHOLD_HOURS) || 12) * 60 * 60 * 1000; // Default 12 hours
const CLEANUP_INTERVAL = 6 * 60 * 60 * 1000; // 6 hours
const RUNTIME_TIMEOUT = (parseInt(process.env.RUNTIME_TIMEOUT_HOURS) || 4) * 60 * 60 * 1000; // Default 4 hours

// Database functions
async function ensureDeviceExists(deviceKey) {
  if (!pool) return;
  try {
    await pool.query(
      `INSERT INTO device_states (device_key) VALUES ($1) ON CONFLICT (device_key) DO NOTHING`,
      [deviceKey]
    );
  } catch (error) {
    console.error(`Failed to ensure device ${deviceKey} exists:`, error.message);
  }
}

async function getDeviceState(deviceKey) {
  if (!pool) {
    return deviceStates[deviceKey] || null;
  }
  
  try {
    const result = await pool.query(
      `SELECT * FROM device_states WHERE device_key = $1`,
      [deviceKey]
    );
    
    if (result.rows.length === 0) {
      return null;
    }
    
    const row = result.rows[0];
    return {
      isRunning: row.is_running || false,
      sessionStartedAt: row.session_started_at ? new Date(row.session_started_at).getTime() : null,
      currentMode: row.current_mode || 'idle',
      lastTemperature: row.last_temperature ? Number(row.last_temperature) : null,
      lastHeatSetpoint: row.last_heat_setpoint ? Number(row.last_heat_setpoint) : null,
      lastCoolSetpoint: row.last_cool_setpoint ? Number(row.last_cool_setpoint) : null,
      lastEquipmentStatus: row.last_equipment_status,
      isReachable: row.is_reachable !== false,
      lastSeenAt: row.last_seen_at ? new Date(row.last_seen_at).getTime() : Date.now(),
      lastActivityAt: row.last_activity_at ? new Date(row.last_activity_at).getTime() : Date.now()
    };
  } catch (error) {
    console.error('Failed to get device state:', error.message);
    return deviceStates[deviceKey] || null; // Fallback to memory
  }
}

async function updateDeviceState(deviceKey, state) {
  // Always update memory for immediate access
  deviceStates[deviceKey] = state;
  
  if (!pool) return;
  
  try {
    await ensureDeviceExists(deviceKey);
    await pool.query(
      `
      UPDATE device_states SET
        is_running = $2,
        session_started_at = $3,
        current_mode = $4,
        last_temperature = $5,
        last_heat_setpoint = $6,
        last_cool_setpoint = $7,
        last_equipment_status = $8,
        is_reachable = $9,
        last_seen_at = $10,
        last_activity_at = $11,
        updated_at = NOW()
      WHERE device_key = $1
      `,
      [
        deviceKey,
        !!state.isRunning,
        state.sessionStartedAt ? new Date(state.sessionStartedAt) : null,
        state.currentMode || 'idle',
        state.lastTemperature,
        state.lastHeatSetpoint,
        state.lastCoolSetpoint,
        state.lastEquipmentStatus,
        state.isReachable !== false,
        state.lastSeenAt ? new Date(state.lastSeenAt) : new Date(),
        state.lastActivityAt ? new Date(state.lastActivityAt) : new Date()
      ]
    );
  } catch (error) {
    console.error('Failed to update device state:', error.message);
  }
}

async function logRuntimeSession(deviceKey, sessionData) {
  if (!pool) return null;
  
  try {
    await ensureDeviceExists(deviceKey);
    const result = await pool.query(
      `
      INSERT INTO runtime_sessions 
        (device_key, mode, equipment_status, started_at, ended_at, duration_seconds, 
         start_temperature, end_temperature, heat_setpoint, cool_setpoint)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      RETURNING id, session_id
      `,
      [
        deviceKey,
        sessionData.mode,
        sessionData.equipmentStatus,
        sessionData.startedAt ? new Date(sessionData.startedAt) : null,
        sessionData.endedAt ? new Date(sessionData.endedAt) : null,
        sessionData.durationSeconds,
        sessionData.startTemperature,
        sessionData.endTemperature,
        sessionData.heatSetpoint,
        sessionData.coolSetpoint
      ]
    );
    return result.rows[0];
  } catch (error) {
    console.error('Failed to log runtime session:', error.message);
    return null;
  }
}

async function logTemperatureReading(deviceKey, temperature, units = 'F', eventType = 'reading') {
  if (!pool) return;
  
  try {
    await ensureDeviceExists(deviceKey);
    await pool.query(
      `INSERT INTO temperature_readings (device_key, temperature, units, event_type) VALUES ($1, $2, $3, $4)`,
      [deviceKey, Number(temperature), String(units), String(eventType)]
    );
  } catch (error) {
    console.error('Failed to log temperature reading:', error.message);
  }
}

async function logEquipmentEvent(deviceKey, eventType, equipmentStatus, previousStatus, isActive, eventData = {}) {
  if (!pool) return;
  
  try {
    await ensureDeviceExists(deviceKey);
    await pool.query(
      `
      INSERT INTO equipment_events 
        (device_key, event_type, equipment_status, previous_status, is_active, event_data)
      VALUES ($1, $2, $3, $4, $5, $6)
      `,
      [deviceKey, eventType, equipmentStatus, previousStatus, !!isActive, JSON.stringify(eventData)]
    );
  } catch (error) {
    console.error('Failed to log equipment event:', error.message);
  }
}

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

// Authentication middleware for admin endpoints
function requireAuth(req, res, next) {
  const authToken = req.headers.authorization?.replace('Bearer ', '');
  const expectedToken = process.env.ADMIN_API_KEY;
  
  if (!expectedToken) {
    return res.status(500).json({ error: 'Admin API key not configured' });
  }
  
  if (!authToken || authToken !== expectedToken) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  next();
}

// Database migration function with proper field sizes
async function runDatabaseMigration() {
  if (!ENABLE_DATABASE || !pool) {
    console.log('Database disabled - skipping migration');
    return;
  }

  try {
    console.log('Checking database schema...');

    // Check if schema already exists
    const schemaExists = await pool.query(`
      SELECT COUNT(*) as count 
      FROM information_schema.tables 
      WHERE table_name = 'device_states' AND table_schema = 'public'
    `);
    
    if (parseInt(schemaExists.rows[0].count) > 0) {
      console.log('Database schema already exists - skipping migration');
      return;
    }

    console.log('Creating database schema with proper field sizes...');
    console.log('- device_key: VARCHAR(300) for long Nest device IDs');
    console.log('- device_name: VARCHAR(600) for full device paths');
    console.log('- other ID fields: VARCHAR(300)');
    
    const migrationSQL = `
      -- Device state tracking table for Nest devices
      CREATE TABLE IF NOT EXISTS device_states (
          device_key VARCHAR(300) PRIMARY KEY,
          frontend_id VARCHAR(300),
          mac_id VARCHAR(300),
          device_name VARCHAR(600),
          units CHAR(1) DEFAULT 'F' CHECK (units IN ('F', 'C')),
          location_id VARCHAR(300),
          workspace_id VARCHAR(300),
          
          -- Current runtime session
          is_running BOOLEAN DEFAULT FALSE,
          session_started_at TIMESTAMPTZ,
          current_mode VARCHAR(20) DEFAULT 'idle',
          current_equipment_status VARCHAR(50),
          
          -- Last known values
          last_temperature DECIMAL(5,2),
          last_heat_setpoint DECIMAL(5,2),
          last_cool_setpoint DECIMAL(5,2),
          last_fan_status VARCHAR(10),
          last_equipment_status VARCHAR(50),
          
          -- Session tracking
          last_mode VARCHAR(20),
          last_was_cooling BOOLEAN DEFAULT FALSE,
          last_was_heating BOOLEAN DEFAULT FALSE,
          last_was_fan_only BOOLEAN DEFAULT FALSE,
          
          -- Connectivity
          is_reachable BOOLEAN DEFAULT TRUE,
          last_seen_at TIMESTAMPTZ DEFAULT NOW(),
          last_activity_at TIMESTAMPTZ DEFAULT NOW(),
          last_post_at TIMESTAMPTZ DEFAULT NOW(),
          last_staleness_notification TIMESTAMPTZ,
          
          -- Metadata
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW()
      );

      -- Runtime sessions history
      CREATE TABLE IF NOT EXISTS runtime_sessions (
          id BIGSERIAL PRIMARY KEY,
          device_key VARCHAR(300) NOT NULL REFERENCES device_states(device_key) ON DELETE CASCADE,
          session_id UUID DEFAULT gen_random_uuid(),
          
          -- Session details
          mode VARCHAR(20) NOT NULL,
          equipment_status VARCHAR(50),
          started_at TIMESTAMPTZ NOT NULL,
          ended_at TIMESTAMPTZ,
          duration_seconds INTEGER,
          
          -- Environmental data
          start_temperature DECIMAL(5,2),
          end_temperature DECIMAL(5,2),
          heat_setpoint DECIMAL(5,2),
          cool_setpoint DECIMAL(5,2),
          
          -- Session stats
          tick_count INTEGER DEFAULT 0,
          last_tick_at TIMESTAMPTZ,
          
          -- Metadata
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW()
      );

      -- Equipment status changes log
      CREATE TABLE IF NOT EXISTS equipment_events (
          id BIGSERIAL PRIMARY KEY,
          device_key VARCHAR(300) NOT NULL REFERENCES device_states(device_key) ON DELETE CASCADE,
          event_type VARCHAR(50) NOT NULL,
          equipment_status VARCHAR(50),
          previous_status VARCHAR(50),
          is_active BOOLEAN,
          session_id UUID,
          event_data JSONB,
          recorded_at TIMESTAMPTZ DEFAULT NOW()
      );

      -- Temperature readings log
      CREATE TABLE IF NOT EXISTS temperature_readings (
          id BIGSERIAL PRIMARY KEY,
          device_key VARCHAR(300) NOT NULL REFERENCES device_states(device_key) ON DELETE CASCADE,
          temperature DECIMAL(5,2) NOT NULL,
          units CHAR(1) NOT NULL,
          event_type VARCHAR(50),
          session_id UUID,
          recorded_at TIMESTAMPTZ DEFAULT NOW()
      );

      -- Indexes for performance
      CREATE INDEX IF NOT EXISTS idx_device_states_last_seen ON device_states(last_seen_at);
      CREATE INDEX IF NOT EXISTS idx_device_states_running ON device_states(is_running) WHERE is_running = TRUE;
      CREATE INDEX IF NOT EXISTS idx_runtime_sessions_device_time ON runtime_sessions(device_key, started_at DESC);
      CREATE INDEX IF NOT EXISTS idx_runtime_sessions_active ON runtime_sessions(device_key, ended_at) WHERE ended_at IS NULL;
      CREATE INDEX IF NOT EXISTS idx_temperature_readings_device_time ON temperature_readings(device_key, recorded_at DESC);
      CREATE INDEX IF NOT EXISTS idx_equipment_events_device_time ON equipment_events(device_key, recorded_at DESC);

      -- Create trigger function if it doesn't exist
      CREATE OR REPLACE FUNCTION update_updated_at_column()
      RETURNS TRIGGER AS $$
      BEGIN
          NEW.updated_at = NOW();
          RETURN NEW;
      END;
      $$ language 'plpgsql';

      -- Create triggers only if they don't exist
      DO $$
      BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'update_device_states_updated_at') THEN
              CREATE TRIGGER update_device_states_updated_at 
                  BEFORE UPDATE ON device_states 
                  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
          END IF;
          
          IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'update_runtime_sessions_updated_at') THEN
              CREATE TRIGGER update_runtime_sessions_updated_at 
                  BEFORE UPDATE ON runtime_sessions 
                  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
          END IF;
      END
      $$;
    `;

    await pool.query(migrationSQL);
    console.log('Database schema created successfully');
    
    // Verify the schema was created with correct field sizes
    const checkSchema = await pool.query(`
      SELECT column_name, character_maximum_length 
      FROM information_schema.columns 
      WHERE table_name = 'device_states' 
        AND column_name IN ('device_key', 'device_name')
    `);
    
    for (const row of checkSchema.rows) {
      console.log(`Verified: ${row.column_name} = VARCHAR(${row.character_maximum_length})`);
    }
    
  } catch (error) {
    console.error('Database migration failed:', error.message);
    console.warn('Continuing with memory-only operation...');
  }
}

// Send staleness notification to Bubble
async function sendStalenessNotification(deviceKey, deviceState, currentTime) {
  const deviceId = deviceKey.split('-').pop();
  const lastActivityTime = deviceState.lastActivityAt || 0;
  const hoursSinceLastActivity = lastActivityTime > 0 ? 
    Math.floor((currentTime - lastActivityTime) / (60 * 60 * 1000)) : 0;
  
  const payload = {
    thermostatId: deviceId,
    deviceName: `Device ${deviceId}`,
    runtimeSeconds: 0,
    runtimeMinutes: 0,
    isRuntimeEvent: false,
    hvacMode: 'UNKNOWN',
    isHvacActive: false,
    thermostatMode: 'UNKNOWN',
    isReachable: false, // Mark as unreachable due to staleness
    
    currentTempF: deviceState.lastTemperature ? celsiusToFahrenheit(deviceState.lastTemperature) : null,
    coolSetpointF: null,
    heatSetpointF: null,
    startTempF: null,
    endTempF: deviceState.lastTemperature ? celsiusToFahrenheit(deviceState.lastTemperature) : null,
    currentTempC: deviceState.lastTemperature || null,
    coolSetpointC: null,
    heatSetpointC: null,
    startTempC: null,
    endTempC: deviceState.lastTemperature || null,
    
    lastIsCooling: false,
    lastIsHeating: false,
    lastIsFanOnly: false,
    lastEquipmentStatus: deviceState.lastEquipmentStatus || 'unknown',
    equipmentStatus: 'stale',
    
    // Add staleness timing information
    hoursSinceLastActivity: hoursSinceLastActivity,
    lastActivityTime: lastActivityTime > 0 ? new Date(lastActivityTime).toISOString() : null,
    stalenessReason: hoursSinceLastActivity >= 24 ? 'extended_offline' : 'device_offline',
    
    timestamp: new Date(currentTime).toISOString(),
    eventId: `stale-${Date.now()}`,
    eventTimestamp: currentTime
  };
  
  if (process.env.BUBBLE_WEBHOOK_URL) {
    try {
      await axios.post(process.env.BUBBLE_WEBHOOK_URL, payload, {
        timeout: 10000,
        headers: {
          'User-Agent': 'Nest-Runtime-Tracker/1.2',
          'Content-Type': 'application/json'
        }
      });
      
      console.log('Sent staleness notification to Bubble:', sanitizeForLogging({
        deviceId: payload.thermostatId,
        currentTempF: payload.currentTempF,
        isReachable: payload.isReachable,
        hoursSinceLastActivity: payload.hoursSinceLastActivity,
        lastActivity: payload.lastActivityTime
      }));
    } catch (err) {
      console.error('Failed to send staleness notification to Bubble:', err.response?.status || err.code || err.message);
    }
  }
}

async function handleNestEvent(eventData) {
  console.log('DEBUG: Starting event processing');
  if (!IS_PRODUCTION) console.log('Processing Nest event…');

  console.log('DEBUG - Complete event data:');
  console.log(JSON.stringify(eventData, null, 2));

  const userId = eventData.userId;
  const deviceName = eventData.resourceUpdate?.name;
  const traits = eventData.resourceUpdate?.traits;
  const timestamp = eventData.timestamp;

  console.log('DEBUG - Basic field extraction:');
  console.log(`- userId: ${userId}`);
  console.log(`- deviceName: ${deviceName}`);
  console.log(`- timestamp: ${timestamp}`);
  console.log(`- resourceUpdate exists: ${!!eventData.resourceUpdate}`);
  console.log(`- traits exists: ${!!traits}`);

  if (eventData.resourceUpdate) {
    console.log('DEBUG - resourceUpdate keys:', Object.keys(eventData.resourceUpdate));
  }

  console.log('DEBUG - Raw traits object:');
  if (traits) {
    console.log(JSON.stringify(traits, null, 2));
    console.log('DEBUG - Available trait keys:', Object.keys(traits));
  } else {
    console.log('No traits found!');
  }

  const deviceId = deviceName?.split('/').pop();

  // Primary traits
  const hvacStatusRaw = traits?.['sdm.devices.traits.ThermostatHvac']?.status; // "HEATING" | "COOLING" | "OFF"
  const currentTemp = traits?.['sdm.devices.traits.Temperature']?.ambientTemperatureCelsius;
  const coolSetpoint = traits?.['sdm.devices.traits.ThermostatTemperatureSetpoint']?.coolCelsius;
  const heatSetpoint = traits?.['sdm.devices.traits.ThermostatTemperatureSetpoint']?.heatCelsius;
  const mode = traits?.['sdm.devices.traits.ThermostatMode']?.mode;

  // Fan trait (to infer fan-only)
  const fanTimerMode = traits?.['sdm.devices.traits.Fan']?.timerMode; // "ON" | "OFF"
  const fanTimerOn = fanTimerMode === 'ON';

  // Connectivity trait
  const connectivityStatus = traits?.['sdm.devices.traits.Connectivity']?.status; // "ONLINE" | "OFFLINE"
  const key = `${userId}-${deviceId}`;
  
  // Get previous state from database
  const prev = await getDeviceState(key) || {};
  
  const isReachable = (connectivityStatus === 'OFFLINE')
    ? false
    : (connectivityStatus === 'ONLINE')
      ? true
      : (prev.isReachable ?? true); // default to true if unknown

  // Log extracted values
  console.log('DEBUG - Extracted trait values:');
  console.log(`- hvacStatusRaw: ${hvacStatusRaw}`);
  console.log(`- currentTemp: ${currentTemp}`);
  console.log(`- coolSetpoint: ${coolSetpoint}`);
  console.log(`- heatSetpoint: ${heatSetpoint}`);
  console.log(`- mode: ${mode}`);
  console.log(`- fanTimerMode: ${fanTimerMode}`);
  console.log(`- connectivityStatus: ${connectivityStatus} -> isReachable=${isReachable}`);

  if (!IS_PRODUCTION) {
    console.log(
      `Event data: userId=${userId?.substring(0, 8)}..., deviceId=${deviceId?.substring(0, 8)}..., hvac=${hvacStatusRaw}, temp=${currentTemp}°C`
    );
  }

  // Basic validation
  if (!userId || !deviceId || !timestamp) {
    console.warn('Skipping incomplete Nest event');
    if (!userId) console.log('  - Missing userId');
    if (!deviceId) console.log('  - Missing deviceId');
    if (!timestamp) console.log('  - Missing timestamp');
    return;
  }

  const eventTime = toTimestamp(timestamp);

  // previous ("last*") fields
  const lastIsCooling = !!prev.lastEquipmentStatus?.includes('cool');
  const lastIsHeating = !!prev.lastEquipmentStatus?.includes('heat');
  const lastIsFanOnly = !!prev.lastEquipmentStatus?.includes('fan');
  const lastEquipmentStatus = prev.lastEquipmentStatus || 'unknown';

  // Determine effective HVAC status when not present (e.g., connectivity-only or temp-only)
  const hvacStatusEff = hvacStatusRaw ?? prev.currentMode ?? 'OFF';

  // Connectivity-only?
  const isConnectivityOnly = !!connectivityStatus && !hvacStatusRaw && currentTemp == null;

  // Temperature-only?
  const isTemperatureOnlyEvent = !hvacStatusRaw && currentTemp != null;

  // ---- Temperature-only branch ----
  if (isTemperatureOnlyEvent) {
    console.log('Temperature-only event detected');

    // Log temperature reading to database
    await logTemperatureReading(key, celsiusToFahrenheit(currentTemp), 'F', 'ThermostatIndoorTemperatureEvent');

    const effectiveMode = prev.currentMode || mode || 'OFF';
    const effectiveFanOnly = prev.lastEquipmentStatus === 'fan';

    const payload = {
      userId,
      thermostatId: deviceId,
      deviceName: deviceName,
      runtimeSeconds: 0,
      runtimeMinutes: 0,
      isRuntimeEvent: false,
      hvacMode: hvacStatusEff,
      isHvacActive: hvacStatusEff === 'HEATING' || hvacStatusEff === 'COOLING',
      thermostatMode: effectiveMode,
      isReachable,

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

      lastIsCooling,
      lastIsHeating,
      lastIsFanOnly,
      lastEquipmentStatus,
      equipmentStatus: mapEquipmentStatus(hvacStatusEff, effectiveFanOnly),

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
            'User-Agent': 'Nest-Runtime-Tracker/1.2',
            'Content-Type': 'application/json'
          }
        });
        const logData = sanitizeForLogging({
          runtimeSeconds: payload.runtimeSeconds,
          isRuntimeEvent: payload.isRuntimeEvent,
          hvacMode: payload.hvacMode,
          isHvacActive: payload.isHvacActive,
          currentTempF: payload.currentTempF,
          isReachable: payload.isReachable
        });
        console.log('Sent temperature update to Bubble:', logData);
      } catch (err) {
        console.error('Failed to send temperature update to Bubble:', err.response?.status || err.code || err.message);
      }
    }

    // Update device state in database
    await updateDeviceState(key, {
      ...prev,
      lastTemperature: currentTemp,
      lastSeenAt: eventTime,
      lastActivityAt: eventTime,
      isReachable
    });

    console.log('DEBUG: Temperature-only event processing complete');
    return;
  }

  // ---- Connectivity-only branch ----
  if (isConnectivityOnly) {
    console.log('Connectivity-only event detected');

    const payload = {
      userId,
      thermostatId: deviceId,
      deviceName: deviceName,
      runtimeSeconds: 0,
      runtimeMinutes: 0,
      isRuntimeEvent: false,
      hvacMode: hvacStatusEff,
      isHvacActive: hvacStatusEff === 'HEATING' || hvacStatusEff === 'COOLING',
      thermostatMode: prev.currentMode || mode || 'OFF',
      isReachable,

      currentTempF: celsiusToFahrenheit(prev.lastTemperature),
      coolSetpointF: celsiusToFahrenheit(coolSetpoint),
      heatSetpointF: celsiusToFahrenheit(heatSetpoint),
      startTempF: null,
      endTempF: celsiusToFahrenheit(prev.lastTemperature),
      currentTempC: prev.lastTemperature ?? null,
      coolSetpointC: coolSetpoint ?? null,
      heatSetpointC: heatSetpoint ?? null,
      startTempC: null,
      endTempC: prev.lastTemperature ?? null,

      lastIsCooling,
      lastIsHeating,
      lastIsFanOnly,
      lastEquipmentStatus,
      equipmentStatus: prev.lastEquipmentStatus || mapEquipmentStatus(hvacStatusEff, prev.lastEquipmentStatus === 'fan'),

      timestamp,
      eventId: eventData.eventId,
      eventTimestamp: eventTime
    };

    console.log('DEBUG - Created connectivity-only payload:');
    console.log(JSON.stringify(payload, null, 2));

    if (process.env.BUBBLE_WEBHOOK_URL) {
      try {
        console.log('DEBUG - Sending connectivity update to Bubble…');
        await axios.post(process.env.BUBBLE_WEBHOOK_URL, payload, {
          timeout: 10000,
          headers: {
            'User-Agent': 'Nest-Runtime-Tracker/1.2',
            'Content-Type': 'application/json'
          }
        });
        console.log
