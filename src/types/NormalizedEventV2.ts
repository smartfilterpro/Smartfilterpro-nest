export interface NormalizedEventV2 {
  // ───────────── Device identity ─────────────
  device_key: string;                 // unique per thermostat (nest:xyz, ecobee:123)
  frontend_id?: string;               // optional bubble/frontend link
  user_id?: string;                   // optional user reference

  // Connection & manufacturer info
  connection_source: 'nest' | 'ecobee' | 'resideo' | 'smartthings' | 'hubitat' | 'home_assistant' | 'matter';
  manufacturer?: string;              // 'Google Nest', 'Ecobee', 'Honeywell'
  model?: string;                     // 'T9', 'EB-STATE5', etc.
  device_name?: string;
  device_type?: 'thermostat' | 'controller' | 'gateway' | 'relay' | string;

  // ───────────── Runtime & HVAC state ─────────────
  equipment_status?: 'HEATING' | 'COOLING' | 'FAN' | 'OFF' | 'UNKNOWN' | string;
  hvac_mode?: 'HEAT' | 'COOL' | 'AUTO' | 'OFF' | 'ECO' | null;
  fan_on?: boolean;
  is_active: boolean;                 // true when heating/cooling/fan is running
  runtime_seconds?: number | null;    // only populated when a session ends
  observed_at: string;                // ISO timestamp from vendor

  // ───────────── Environmental telemetry ─────────────
  temperature_f?: number | null;
  temperature_c?: number | null;
  humidity?: number | null;
  outdoor_temperature_f?: number | null;
  outdoor_humidity?: number | null;
  pressure_hpa?: number | null;

  // ───────────── Setpoints & targets ─────────────
  heat_setpoint_f?: number | null;
  cool_setpoint_f?: number | null;
  target_humidity?: number | null;

  // ───────────── Optional metadata ─────────────
  occupancy?: boolean;
  eco_mode?: boolean;
  away_mode?: boolean;
  firmware_version?: string;
  serial_number?: string;
  ip_address?: string;

  // ───────────── Raw payload ─────────────
  payload_raw?: any; // full vendor payload for auditing / AI enrichment
}
