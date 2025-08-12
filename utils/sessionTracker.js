// sessiontracker.js
// Drop-in SDM session tracker for SmartFilterPro
// - Fixes currentTempF being null by using last-known temp and on-demand snapshot
// - Tracks runtime when HEATING/COOLING or Fan timer is ON
// - Posts to Bubble on every event with your original field names

const axios = require("axios");

// ---- In-memory state ----
const sessions = {};      // key = `${userId}-${deviceId}` -> session start (ms)
const deviceStates = {};  // key -> { ambientTempC, tempUpdatedAt, lastHvacStatus, lastFanTimerOn }

// ---- Config ----
const STALE_MS = 5 * 60 * 1000; // 5 minutes
const BUBBLE_POST_URL = process.env.BUBBLE_POST_URL || "https://your-bubble-endpoint.example.com";

// ---- Helpers ----
function toMillis(dateStr) {
  const t = Date.parse(dateStr);
  return Number.isFinite(t) ? t : Date.now();
}

function cToF(c) {
  return typeof c === "number" ? Math.round((c * 9) / 5 + 32) : null;
}

async function getSnapshotTempC(resourceName, accessToken) {
  if (!accessToken || !resourceName) return null;
  try {
    const { data } = await axios.get(
      `https://smartdevicemanagement.googleapis.com/v1/${resourceName}`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    return data?.traits?.["sdm.devices.traits.Temperature"]?.ambientTemperatureCelsius ?? null;
  } catch (err) {
    console.warn("⚠️ Temp snapshot fetch failed:", err.response?.data || err.message);
    return null;
  }
}

function evaluateActivity(traits) {
  const hvacStatus = traits?.["sdm.devices.traits.ThermostatHvac"]?.status || "OFF"; // HEATING | COOLING | OFF
  const isHvacActive = hvacStatus === "HEATING" || hvacStatus === "COOLING";

  const fanTrait = traits?.["sdm.devices.traits.Fan"] || {};
  const isFanTimerOn = (fanTrait.timerMode || "OFF") === "ON";

  // Treat either condition as "active" for filter wear
  const isActive = isHvacActive || isFanTimerOn;

  return { hvacStatus, isHvacActive, isFanTimerOn, isActive };
}

async function postToBubble(payload) {
  try {
    await axios.post(BUBBLE_POST_URL, payload, {
      timeout: 10000,
      headers: { "Content-Type": "application/json" },
    });
    console.log("✅ Posted to Bubble:", payload);
  } catch (err) {
    console.error("❌ Bubble post failed:", err.response?.data || err.message);
  }
}

/**
 * Handle a single SDM event.
 * @param {object} eventData  SDM event with shape { userId, timestamp, resourceUpdate: { name, traits } }
 * @param {string} accessToken Google access token (used only if a temp snapshot is needed)
 */
async function handleEvent(eventData, accessToken) {
  const userId = eventData.userId;
  const resourceName = eventData.resourceUpdate?.name; // "enterprises/.../devices/DEVICE_ID"
  const traits = eventData.resourceUpdate?.traits || {};
  const deviceId = resourceName?.split("/")?.pop();
  const timestampMillis = toMillis(eventData.timestamp);

  if (!userId || !deviceId) {
    console.warn("⚠️ Skipping event: missing userId or deviceId");
    return;
  }

  const key = `${userId}-${deviceId}`;

  // ---- Active state (HVAC + Fan timer) ----
  const { hvacStatus, isHvacActive, isFanTimerOn, isActive } = evaluateActivity(traits);

  // ---- Resolve temperature: event -> cache -> snapshot ----
  let tempC = traits?.["sdm.devices.traits.Temperature"]?.ambientTemperatureCelsius;

  if (typeof tempC !== "number") {
    tempC = deviceStates[key]?.ambientTempC ?? null;
  }

  const lastAt = deviceStates[key]?.tempUpdatedAt || 0;
  const stale = Date.now() - lastAt > STALE_MS;

  if ((typeof tempC !== "number" || stale)) {
    const snapC = await getSnapshotTempC(resourceName, accessToken);
    if (typeof snapC === "number") tempC = snapC;
  }

  if (typeof tempC === "number") {
    deviceStates[key] = {
      ...(deviceStates[key] || {}),
      ambientTempC: tempC,
      tempUpdatedAt: Date.now(),
      lastHvacStatus: hvacStatus,
      lastFanTimerOn: isFanTimerOn,
    };
  } else {
    deviceStates[key] = {
      ...(deviceStates[key] || {}),
      lastHvacStatus: hvacStatus,
      lastFanTimerOn: isFanTimerOn,
    };
  }

  const currentTempF = cToF(tempC);

  // ---- Session tracking ----
  let runtimeSeconds = null;
  let isRuntimeEvent = false;

  const hasSession = sessions[key] != null;

  if (isActive && !hasSession) {
    sessions[key] = timestampMillis;
    console.log(`⏱️ Session started for ${key} at ${timestampMillis}`);
  } else if (!isActive && hasSession) {
    const start = sessions[key];
    runtimeSeconds = Math.max(0, Math.round((timestampMillis - start) / 1000));
    delete sessions[key];
    isRuntimeEvent = true;
    console.log(`⏱️ Session ended for ${key}. Runtime: ${runtimeSeconds}s`);
  }

  // ---- Build payload using your field names ----
  const payload = {
    userId,
    thermostatId: deviceId,
    runtimeSeconds,          // null unless a session just ended
    isRuntimeEvent,          // true only when a session ends
    hvacMode: hvacStatus,    // "HEATING" | "COOLING" | "OFF"
    isHvacActive,            // boolean (heat/cool only, not fan)
    currentTempF,            // Fahrenheit (null until first resolved)
    timestampMillis,
  };

  await postToBubble(payload);
}

module.exports = { handleEvent, _internals: { sessions, deviceStates } };
