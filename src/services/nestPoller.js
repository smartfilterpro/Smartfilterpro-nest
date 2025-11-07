'use strict';

const { google } = require('googleapis');
const { getPool } = require('../database/db');
const { handleDeviceEvent } = require('./runtimeTracker');

const POLL_INTERVAL_MS = 5 * 60 * 1000; // Check every 5 minutes
const STALE_THRESHOLD_MS = 20 * 60 * 1000; // Poll if no update in 20 minutes
const smartdevicemanagement = google.smartdevicemanagement('v1');

let pollInterval;

/**
 * Returns a Google OAuth2 client for a given user.
 */
async function getOAuthClientForUser(userId) {
  const pool = getPool();

  const result = await pool.query(
    'SELECT access_token, refresh_token, expires_at FROM oauth_tokens WHERE user_id = $1',
    [userId]
  );

  if (result.rows.length === 0) {
    throw new Error(`No OAuth tokens found for user: ${userId}`);
  }

  const { access_token, refresh_token, expires_at } = result.rows[0];

  // Validate that we have a refresh token for automatic token refresh
  if (!refresh_token) {
    console.warn(`⚠️  User ${userId} has no refresh_token - cannot auto-refresh when expired`);
  }

  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );

  oauth2Client.setCredentials({
    access_token,
    refresh_token,
    expiry_date: expires_at ? new Date(expires_at).getTime() : null
  });

  // Listen for automatic token refresh events
  oauth2Client.on('tokens', async (tokens) => {
    try {
      console.log(`🔄 Token refresh triggered for user: ${userId}`);

      if (tokens.access_token) {
        // FIX: tokens.expiry_date is ALREADY an absolute timestamp, not a duration
        const expiresAt = tokens.expiry_date
          ? new Date(tokens.expiry_date)
          : new Date(Date.now() + 3600 * 1000); // Default to 1 hour

        console.log(`✅ Updating access_token for user ${userId}, expires at ${expiresAt.toISOString()}`);

        await pool.query(
          'UPDATE oauth_tokens SET access_token = $1, expires_at = $2, updated_at = NOW() WHERE user_id = $3',
          [tokens.access_token, expiresAt, userId]
        );
      }

      if (tokens.refresh_token) {
        console.log(`✅ Updating refresh_token for user ${userId}`);
        await pool.query(
          'UPDATE oauth_tokens SET refresh_token = $1, updated_at = NOW() WHERE user_id = $2',
          [tokens.refresh_token, userId]
        );
      }
    } catch (error) {
      console.error(`❌ Error updating tokens for user ${userId}:`, error.message);
    }
  });

  return oauth2Client;
}

/**
 * Finds devices that have not reported recently, and triggers polling.
 */
async function pollStaleDevices() {
  const pool = getPool();

  try {
    console.log('\n=== CHECKING FOR STALE DEVICES ===');

    const now = new Date();
    const staleThreshold = new Date(now.getTime() - STALE_THRESHOLD_MS);

    // Find devices that haven't reported in 20+ minutes
    const staleDevicesResult = await pool.query(
      `
      SELECT 
        ds.device_key,
        ds.device_name,
        ds.frontend_id AS user_id,
        ds.last_seen_at,
        ds.last_activity_at,
        GREATEST(ds.last_seen_at, ds.last_activity_at) AS last_update,
        EXTRACT(EPOCH FROM (NOW() - GREATEST(ds.last_seen_at, ds.last_activity_at))) / 60 AS minutes_since_update
      FROM device_status ds
      WHERE GREATEST(ds.last_seen_at, ds.last_activity_at) < $1
         OR (ds.last_seen_at IS NULL AND ds.last_activity_at IS NULL)
      ORDER BY GREATEST(ds.last_seen_at, ds.last_activity_at) ASC NULLS FIRST
      `,
      [staleThreshold]
    );

    if (staleDevicesResult.rows.length === 0) {
      console.log('✓ All devices are up-to-date (no polling needed)');
      console.log('=== CHECK COMPLETE ===\n');
      return;
    }

    console.log(`Found ${staleDevicesResult.rows.length} stale device(s) to poll:`);

    for (const device of staleDevicesResult.rows) {
      const minutesStaleRaw = device.minutes_since_update;
      const minutesStale =
        typeof minutesStaleRaw === 'number' && !isNaN(minutesStaleRaw)
          ? minutesStaleRaw
          : 0;
      const staleMsg =
        minutesStale > 0
          ? `${minutesStale.toFixed(1)} min ago`
          : 'never updated';
      console.log(`  - ${device.device_key}: ${staleMsg}`);
    }

    // Group by user to minimize API calls
    const devicesByUser = staleDevicesResult.rows.reduce((acc, device) => {
      if (!acc[device.user_id]) acc[device.user_id] = [];
      acc[device.user_id].push(device);
      return acc;
    }, {});

    console.log(`Polling ${Object.keys(devicesByUser).length} user(s)`);

    for (const [userId, devices] of Object.entries(devicesByUser)) {
      await pollUserDevices(userId, devices.map((d) => d.device_key));
    }

    console.log('=== STALE DEVICE CHECK COMPLETE ===\n');
  } catch (error) {
    console.error('Error checking stale devices:', error.message);
  }
}

/**
 * Polls the Nest API for a user’s devices and sends synthetic events to runtimeTracker.
 */
async function pollUserDevices(userId, staleDeviceIds = null) {
  try {
    console.log(`Polling devices for user: ${userId}`);

    const auth = await getOAuthClientForUser(userId);
    let projectId = process.env.GOOGLE_PROJECT_ID;

    // Derive projectId dynamically if missing
    if (!projectId) {
      const pool = getPool();
      const deviceResult = await pool.query(
        'SELECT device_name FROM device_status WHERE frontend_id = $1 LIMIT 1',
        [userId]
      );

      if (deviceResult.rows.length > 0) {
        const parts = deviceResult.rows[0].device_name.split('/');
        projectId = parts[1];
      } else {
        console.error('Cannot determine project ID for user:', userId);
        return;
      }
    }

    const response = await smartdevicemanagement.enterprises.devices.list({
      auth,
      parent: `enterprises/${projectId}`
    });

    const devices = response.data.devices || [];
    console.log(`Found ${devices.length} total device(s) for user ${userId}`);

    // Filter to only stale devices if specified
    const devicesToProcess = staleDeviceIds
      ? devices.filter((d) => {
          const deviceId = d.name.split('/').pop();
          return staleDeviceIds.includes(deviceId);
        })
      : devices;

    console.log(`Processing ${devicesToProcess.length} device(s)`);

    for (const device of devicesToProcess) {
      const deviceId = device.name.split('/').pop();
      console.log(`📡 Polling stale device: ${deviceId}`);

      // Log device metadata if available
      const customName = device.traits?.['sdm.devices.traits.Info']?.customName;
      const roomName = device.parentRelations?.[0]?.displayName;
      if (customName) console.log(`   Custom name: "${customName}"`);
      if (roomName) console.log(`   Room: "${roomName}"`);

      const syntheticEvent = {
        eventId: `poll-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        timestamp: new Date().toISOString(),
        resourceUpdate: {
          name: device.name,
          traits: device.traits || {},
          parentRelations: device.parentRelations || [] // FIX: Include parent relations for room name
        },
        userId: userId,
        resourceGroup: [device.name]
      };

      await handleDeviceEvent(syntheticEvent);
    }
  } catch (error) {
    console.error(`❌ Error polling devices for user ${userId}:`, error.message);

    // Provide specific guidance for common errors
    if (error.message.includes('Invalid Credentials') || error.message.includes('invalid_grant')) {
      console.error(`   ⚠️  Token issue detected for user ${userId}:`);
      console.error(`   - Access token may be expired`);
      console.error(`   - Refresh token may be missing or invalid`);
      console.error(`   - User may need to re-authenticate via Bubble`);
      console.error(`   → Check oauth_tokens table: SELECT user_id, refresh_token IS NOT NULL as has_refresh, expires_at FROM oauth_tokens WHERE user_id = '${userId}';`);
    } else if (error.code === 'ENOTFOUND' || error.code === 'ECONNREFUSED') {
      console.error(`   ⚠️  Network error - Google API may be unreachable`);
    } else {
      console.error(`   Error details:`, error);
    }
  }
}

/**
 * Manual full poll of all users (startup or manual trigger)
 */
async function pollAllUsers() {
  const pool = getPool();

  try {
    console.log('\n=== POLLING ALL DEVICES (MANUAL) ===');

    const usersResult = await pool.query('SELECT DISTINCT user_id FROM oauth_tokens');
    console.log(`Found ${usersResult.rows.length} user(s) with tokens`);

    for (const row of usersResult.rows) {
      await pollUserDevices(row.user_id);
    }

    console.log('=== MANUAL POLLING COMPLETE ===\n');
  } catch (error) {
    console.error('Manual polling error:', error.message);
  }
}

/**
 * Starts the periodic stale device poller
 */
function startPoller() {
  console.log(
    `Starting stale device checker (every ${POLL_INTERVAL_MS / 60000} minutes)`
  );
  console.log(
    `Will poll devices with no update in ${STALE_THRESHOLD_MS / 60000} minutes`
  );

  // Run immediately on startup
  pollStaleDevices().catch((err) =>
    console.error('Initial stale check failed (non-fatal):', err.message)
  );

  // Then run on interval
  pollInterval = setInterval(pollStaleDevices, POLL_INTERVAL_MS);
}

/**
 * Stops the poller
 */
function stopPoller() {
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
    console.log('Poller stopped');
  }
}

module.exports = { startPoller, stopPoller, pollUserDevices, pollAllUsers };
