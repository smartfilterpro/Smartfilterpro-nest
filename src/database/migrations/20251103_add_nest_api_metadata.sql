-- Migration: Add Nest API metadata columns to device_status
-- Purpose: Store additional metadata from Nest API traits (ThermostatEco, Settings, Info, parentRelations)
-- Author: SmartFilterPro
-- Date: 2025-11-03

-- Ensure the table exists
CREATE TABLE IF NOT EXISTS device_status (
  device_key TEXT PRIMARY KEY
);

-- Add missing columns for Nest API metadata if they do not already exist
ALTER TABLE device_status
  ADD COLUMN IF NOT EXISTS custom_name TEXT,
  ADD COLUMN IF NOT EXISTS parent_resource TEXT,
  ADD COLUMN IF NOT EXISTS temperature_scale TEXT,
  ADD COLUMN IF NOT EXISTS eco_mode TEXT DEFAULT 'OFF',
  ADD COLUMN IF NOT EXISTS eco_heat_celsius DECIMAL(5,2),
  ADD COLUMN IF NOT EXISTS eco_cool_celsius DECIMAL(5,2),
  ADD COLUMN IF NOT EXISTS last_humidity DECIMAL(5,2),
  ADD COLUMN IF NOT EXISTS firmware_version TEXT,
  ADD COLUMN IF NOT EXISTS serial_number TEXT;

-- Add comments for documentation
COMMENT ON COLUMN device_status.custom_name IS 'Custom device name from sdm.devices.traits.Info';
COMMENT ON COLUMN device_status.parent_resource IS 'Parent room/structure resource path from parentRelations';
COMMENT ON COLUMN device_status.temperature_scale IS 'Temperature display preference (CELSIUS or FAHRENHEIT) from sdm.devices.traits.Settings';
COMMENT ON COLUMN device_status.eco_mode IS 'Eco mode status (MANUAL_ECO or OFF) from sdm.devices.traits.ThermostatEco';
COMMENT ON COLUMN device_status.eco_heat_celsius IS 'Eco mode heat setpoint in Celsius from sdm.devices.traits.ThermostatEco';
COMMENT ON COLUMN device_status.eco_cool_celsius IS 'Eco mode cool setpoint in Celsius from sdm.devices.traits.ThermostatEco';
COMMENT ON COLUMN device_status.last_humidity IS 'Last ambient humidity percentage from sdm.devices.traits.Humidity';
COMMENT ON COLUMN device_status.firmware_version IS 'Device firmware version';
COMMENT ON COLUMN device_status.serial_number IS 'Device serial number';
