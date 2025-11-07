# Logging Configuration

## Railway Logging

Railway **automatically captures all stdout and stderr** output from your Node.js application. There are no traditional log levels (DEBUG, INFO, WARN, ERROR) to configure in Railway itself - all console.log and console.error statements are captured and displayed in the Railway dashboard.

### Current Logging in This Application

The application includes extensive logging for debugging:

#### 🔑 **Token & Authentication Logs**
- `✅ Tokens stored successfully` - When Bubble sends OAuth tokens
- `🔄 Token refresh triggered` - When access token is auto-refreshed
- `⚠️  User has no refresh_token` - Warning when refresh token is missing
- `❌ Error polling devices: Invalid Credentials` - Token expiry/auth failures

#### 📡 **Polling Logs**
- `=== CHECKING FOR STALE DEVICES ===` - Every 5 minutes
- `📡 Polling stale device: {deviceId}` - When polling a specific device
- `Custom name: "backyard"` - Shows custom device name from API
- `Room: "Patio"` - Shows room name from API

#### 🏷️ **Metadata Extraction Logs**
- `[METADATA] {deviceId} custom name updated: "none" -> "backyard"` - Custom name changes
- `[METADATA] {deviceId} room name updated: "none" -> "Patio"` - Room name changes
- `[METADATA] {deviceId} firmware version: 1.2.3` - Firmware info
- `[METADATA] {deviceId} serial number: ABC123` - Serial number
- `[METADATA] {deviceId} saving 3 metadata field(s) to database` - Database writes

#### 📤 **Core Ingest Logs**
- `[CORE POST] Using custom name: "backyard" (instead of device path)` - Shows which name is used
- `[CORE POST] {deviceId} -> Telemetry_Update (UPDATE)` - Events sent to Core
- `✅ [CoreIngest] Posted update (nest) → {deviceId}` - Successful posts

#### 🌡️ **Device State Logs**
- `[TEMP] {deviceId} temperature: 72°F` - Temperature readings
- `[HVAC] {deviceId} equipment status: IDLE -> HEATING` - HVAC state changes
- `[FAN] {deviceId} fan timer: false -> true` - Fan changes
- `[MODE] {deviceId} mode: HEAT -> COOL` - Thermostat mode changes

### Viewing Logs in Railway

1. Go to your Railway dashboard
2. Click on your service/deployment
3. Click the **"Logs"** tab
4. Use the search box to filter logs (e.g., search "METADATA" to see only metadata logs)
5. Logs are shown in real-time with timestamps

### Filtering Logs

Use Railway's search feature with these keywords:

| Search Term | What You'll See |
|-------------|----------------|
| `[METADATA]` | Device name, room, firmware, serial changes |
| `[CORE POST]` | Events being sent to Core Ingest |
| `Polling` | Polling activity and stale device checks |
| `Token` | Token storage and refresh events |
| `Invalid Credentials` | Authentication failures |
| `custom name` | When custom device names are detected |
| `❌` | All errors |
| `✅` | All successes |

### Adding More Verbose Logging

If you need even more detailed logging, you can add a `LOG_LEVEL` environment variable:

**In Railway Dashboard:**
1. Go to Variables tab
2. Add: `LOG_LEVEL=debug`
3. Redeploy

Then modify the code to check this variable:
```javascript
const isDebug = process.env.LOG_LEVEL === 'debug';
if (isDebug) {
  console.log('[DEBUG] Raw device object:', JSON.stringify(device, null, 2));
}
```

### Log Retention

- **Railway Free Plan:** Logs retained for ~3 days
- **Railway Pro Plan:** Logs retained for ~7 days
- For longer retention, consider:
  - Datadog integration
  - Logtail/Better Stack integration
  - Custom log shipping to S3/CloudWatch

### Performance Considerations

Current logging is **verbose but optimized**:
- ✅ Only logs when values change (not every event)
- ✅ Uses short device IDs for readability
- ✅ Structured format for easy searching
- ✅ Emoji prefixes for quick visual scanning

If logs become overwhelming, you can reduce verbosity by:
1. Removing `[METADATA]` logs for unchanged values
2. Throttling `[CORE POST]` logs to only show errors
3. Removing polling logs when no devices are stale

### Debugging Token Issues

If you see `Invalid Credentials` errors:

1. Search logs for: `Token refresh triggered`
   - Should see automatic refresh attempts

2. Check token storage: `Tokens stored successfully`
   - Verify `Has refresh token: true`
   - Check expiry timestamp

3. Look for: `User has no refresh_token`
   - User needs to re-authenticate via Bubble

4. Check database directly (via Railway's Postgres tab):
   ```sql
   SELECT user_id,
          refresh_token IS NOT NULL as has_refresh,
          expires_at,
          expires_at > NOW() as is_valid
   FROM oauth_tokens;
   ```

### Debugging Custom Name Issues

If custom names aren't showing:

1. Search logs for: `custom name updated` or `room name updated`
   - Should see when names are first detected

2. Search for: `Custom name: "backyard"`
   - Appears during polling if API returns custom name

3. Search for: `Using custom name:` or `Using room name:`
   - Shows which name is sent to Core Ingest

4. Check if traits are present:
   ```
   📡 Polling stale device: AVPHwEv...
      Custom name: "backyard"    ← Should see this
      Room: "Patio"               ← Or this
   ```

5. If missing, the Google Nest API may not be returning these traits
   - User may not have set a custom name
   - Room assignment may be missing in Google Home app
