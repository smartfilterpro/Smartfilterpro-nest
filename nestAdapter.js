'use strict';

/**
 * This file documents the expected event shape for /nest/event.
 * In production you would connect to Google's SDM Pub/Sub push or your relay
 * and normalize into this shape.
 *
 * Example JSON body for POST /nest/event:
 * {
 *   "userId": "USER123",
 *   "thermostatId": "DEVICE123",
 *   "deviceName": "enterprises/.../devices/DEVICE123",
 *   "temperatureC": 22.2,
 *   "temperatureF": 72.0,
 *   "thermostatMode": "COOL" | "HEAT" | "OFF" | "AUTO",
 *   "equipmentStatus": "cool" | "heat" | "idle" | "unknown",
 *   "fanTimerMode": "ON" | "OFF" | "UNKNOWN",
 *   "isReachable": true,
 *   "roomDisplayName": "Living Room",
 *   "eventId": "uuid-or-similar",
 *   "eventTimestamp": 1758896073087
 * }
 */
module.exports = {};
