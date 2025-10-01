// README.md
# Nest Thermostat Runtime Tracker

A Node.js application that monitors Google Nest thermostats, tracks runtime by mode, and posts data to Bubble.

## Features

- Real-time thermostat monitoring via Google Pub/Sub
- Runtime tracking for heating, cooling, and fan-only modes
- PostgreSQL database for persistent storage
- Automatic session recovery on restart
- Retry logic for Bubble API posts
- Temperature change tracking
- Device reachability monitoring
- User and device deletion endpoints

## Setup

### Prerequisites

- Node.js 18+
- PostgreSQL database
- Google Cloud Platform account with SDM API access
- Google Pub/Sub subscription

### Environment Variables

Create a `.env` file with:

```env
PORT=3000
DATABASE_URL=postgresql://user:password@host:5432/database
GOOGLE_PROJECT_ID=your-project-id
GOOGLE_PUBSUB_SUBSCRIPTION=your-subscription-name
GOOGLE_CLIENT_ID=your-client-id
GOOGLE_CLIENT_SECRET=your-client-secret
GOOGLE_REDIRECT_URI=https://your-app.railway.app/auth/callback
BUBBLE_WEBHOOK_URL=https://smartfilterpro-scaling.bubbleapps.io/version-test/api/1.1/wf/nest_callback
LAST_FAN_TAIL_SECONDS=30
MAX_RETRY_ATTEMPTS=3
RETRY_DELAY_MS=2000
```

### Installation

```bash
npm install
npm run migrate
npm start
```

### Railway Deployment

1. Connect your GitHub repo to Railway
2. Add environment variables in Railway dashboard
3. Deploy!

## API Endpoints

### OAuth
- `GET /auth/google` - Initiate Google OAuth flow
- `GET /auth/callback` - OAuth callback handler

### Deletion
- `DELETE /api/user/:userId` - Delete user and all devices
- `DELETE /api/device/:deviceKey` - Delete specific device

### Health Check
- `GET /health` - Service health status

## Database Schema

### Tables
- `device_status` - Current device state
- `equipment_events` - Equipment status changes
- `runtime_sessions` - HVAC runtime sessions
- `temp_readings` - Temperature history
- `oauth_tokens` - User authentication tokens

## Runtime Logic

The system tracks runtime when:
- Thermostat is heating (`equipmentStatus = "HEATING"`)
- Thermostat is cooling (`equipmentStatus = "COOLING"`)
- Fan timer is on (`isFanTimerOn = true`)

Runtime stops when ALL of the following are OFF:
- Equipment status is "OFF"
- Fan timer is off

The `LAST_FAN_TAIL_SECONDS` setting adds extra runtime to account for fan tail-off periods.

## License

MIT
