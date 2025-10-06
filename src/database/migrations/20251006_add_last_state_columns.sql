-- Migration: Add last_* state tracking columns to device_status
-- Purpose: Track last known heating, cooling, fan-only, and equipment status
-- Author: Eric Hanfman (SmartFilterPro)
-- Date: 2025-10-06

-- Ensure the table exists
CREATE TABLE IF NOT EXISTS device_status (
  device_key TEXT PRIMARY KEY
);

-- Rename any legacy “last_was_*” columns to the new standard naming
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'device_status' AND column_name = 'last_was_cooling'
  ) THEN
    ALTER TABLE device_status RENAME COLUMN last_was_cooling TO last_is_cooling;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'device_status' AND column_name = 'last_was_heating'
  ) THEN
    ALTER TABLE device_status RENAME COLUMN last_was_heating TO last_is_heating;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'device_status' AND column_name = 'last_was_fan_only'
  ) THEN
    ALTER TABLE device_status RENAME COLUMN last_was_fan_only TO last_is_fan_only;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'device_status' AND column_name = 'last_was_equipment_status'
  ) THEN
    ALTER TABLE device_status RENAME COLUMN last_was_equipment_status TO last_equipment_status;
  END IF;
END $$;

-- Add missing columns if they do not already exist
ALTER TABLE device_status
  ADD COLUMN IF NOT EXISTS last_mode TEXT,
  ADD COLUMN IF NOT EXISTS last_is_cooling BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS last_is_heating BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS last_is_fan_only BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS last_equipment_status TEXT;
