const { google } = require('googleapis');
const { getPool } = require('../database/db');
const { handleDeviceEvent } = require('./runtimeTracker');

const POLL_INTERVAL_MS = 20 * 60 * 1000; // 20 minutes
const smartdevicemanagement = google.smartdevicemanagement('v1');

let pollInterval;

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
  
  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
  
  oauth2Client.setCredentials({
    access_token,
    refresh_token,
    expiry_date: new Date(expires_at).getTime()
  });
  
  // Auto-refresh tokens and save to database
  oauth2Client.on('tokens', async (tokens) => {
    console.log(`Refreshing tokens for user: ${userId}`);
    
    if (tokens.access_token) {
      const expiresAt = new Date(Date.now() + (tokens.expiry_date || 3600000));
      await pool.query(
        'UPDATE oauth_tokens SET access_token = $1, expires_at = $2, updated_at = NOW() WHERE user_id = $3',
        [tokens.access_token, expiresAt, userId]
      );
    }
    
    if (tokens.refresh_token) {
      await pool.query(
        'UPDATE oauth_tokens SET refresh_token = $1, updated_at = NOW() WHERE user_id = $2',
        [tokens.refresh_token, userId]
      );
    }
  });
  
  return oauth2Client;
}

async function pollAllUsers() {
  const pool = getPool();
  
  try {
    console.log('\n=== POLLING NEST DEVICES FOR ALL USERS ===');
    
    // Get all users with tokens
    const usersResult = await pool.query(
      'SELECT DISTINCT user_id FROM oauth_tokens'
    );
    
    console.log(`Found ${usersResult.rows.length} user(s) with tokens`);
    
    for (const row of usersResult.rows) {
      await pollUserDevices(row.user_id);
    }
    
    console.log('=== POLLING COMPLETE ===\n');
  } catch (error) {
    console.error('Polling error:', error.message);
  }
}

async function pollUserDevices(userId) {
  try {
    console.log(`Polling devices for user: ${userId}`);
    
    const auth = await getOAuthClientForUser(userId);
    
    // Get project ID from environment or extract from device names in database
    let projectId = process.env.GOOGLE_PROJECT_ID;
    
    if (!projectId) {
      // Try to get it from existing device data
      const pool = getPool();
      const deviceResult = await pool.query(
        'SELECT device_name FROM device_status WHERE frontend_id = $1 LIMIT 1',
        [userId]
      );
      
      if (deviceResult.rows.length > 0) {
        // Extract from device name: enterprises/{project}/devices/{deviceId}
        const parts = deviceResult.rows[0].device_name.split('/');
        projectId = parts[1];
      } else {
        console.error('Cannot determine project ID for user:', userId);
        return;
      }
    }
    
    // List all devices for this user
    const response = await smartdevicemanagement.enterprises.devices.list({
      auth,
      parent: `enterprises/${projectId}`
    });
    
    const devices = response.data.devices || [];
    console.log(`Found ${devices.length} device(s) for user ${userId}`);
    
    for (const device of devices) {
      console.log(`Processing device: ${device.name}`);
      
      // Convert device data to event format
      const syntheticEvent = {
        eventId: `poll-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        timestamp: new Date().toISOString(),
        resourceUpdate: {
          name: device.name,
          traits: device.traits || {}
        },
        userId: userId,
        resourceGroup: [device.name]
      };
      
      await handleDeviceEvent(syntheticEvent);
    }
  } catch (error) {
    console.error(`Error polling devices for user ${userId}:`, error.message);
  }
}



function stopPoller() {
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
    console.log('Poller stopped');
  }
}

module.exports = { startPoller, stopPoller, pollUserDevices, pollAllUsers };
