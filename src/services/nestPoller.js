Received webhook: {
  "message": {
    "data": "ewogICJldmVudElkIjogImQ1YTM1ZDkzLTAzYTgtNDMwZi1iYzAxLWRlZTM4NTdlOTc3MiIsCiAgInRpbWVzdGFtcCI6ICIyMDI1LTEwLTAzVDE5OjM4OjQ5LjA0NDM4NloiLAogICJyZXNvdXJjZVVwZGF0ZSI6IHsKICAgICJuYW1lIjogImVudGVycHJpc2VzLzc2OGQ3MDQ4LWE5MzQtNDI3Mi1hODEzLTU1N2Y5NDlmYWE3MC9kZXZpY2VzL0FWUEh3RXZSZXdlZlR4NkV5cjRFOUowcEhFYkZBNEpIQXFDUkI5b0JGcENBMmU0NHFHeGZrcmhIcUpjdEw0UGMtZ0xjUlA0bnRCNFNzNng0UnA3VG1yNExzeXVuUFEiLAogICAgInRyYWl0cyI6IHsKICAgICAgInNkbS5kZXZpY2VzLnRyYWl0cy5GYW4iOiB7CiAgICAgICAgInRpbWVyTW9kZSI6ICJPRkYiCiAgICAgIH0KICAgIH0KICB9LAogICJ1c2VySWQiOiAiQVZQSHdFdUdCRjJzQzFwM01zQ3h3M0ZpNnNJTnRqU2MxU1dESEVDdDJGT2kiLAogICJyZXNvdXJjZUdyb3VwIjogWyJlbnRlcnByaXNlcy83NjhkNzA0OC1hOTM0LTQyNzItYTgxMy01NTdmOTQ5ZmFhNzAvZGV2aWNlcy9BVlBId0V2UmV3ZWZUeDZFeXI0RTlKMHBIRWJGQTRKSEFxQ1JCOW9CRnBDQTJlNDRxR3hma3JoSHFKY3RMNFBjLWdMY1JQNG50QjRTczZ4NFJwN1RtcjRMc3l1blBRIl0KfQ==",
    "messageId": "16475275603937410",
    "message_id": "16475275603937410",
    "publishTime": "2025-10-03T19:49:48.309Z",
    "publish_time": "2025-10-03T19:49:48.309Z"
  },
  "subscription": "projects/smartfilterpronest/subscriptions/SmartfilterProNestPush"
}
Decoded Pub/Sub data: {
  "eventId": "d5a35d93-03a8-430f-bc01-dee3857e9772",
  "timestamp": "2025-10-03T19:38:49.044386Z",
  "resourceUpdate": {
    "name": "enterprises/768d7048-a934-4272-a813-557f949faa70/devices/AVPHwEvRewefTx6Eyr4E9J0pHEbFA4JHAqCRB9oBFpCA2e44qGxfkrhHqJctL4Pc-gLcRP4ntB4Ss6x4Rp7Tmr4LsyunPQ",
    "traits": {
      "sdm.devices.traits.Fan": {
        "timerMode": "OFF"
      }
    }
  },
  "userId": "AVPHwEuGBF2sC1p3MsCxw3Fi6sINtjSc1SWDHECt2FOi",
  "resourceGroup": ["enterprises/768d7048-a934-4272-a813-557f949faa70/devices/AVPHwEvRewefTx6Eyr4E9J0pHEbFA4JHAqCRB9oBFpCA2e44qGxfkrhHqJctL4Pc-gLcRP4ntB4Ss6x4Rp7Tmr4LsyunPQ"]
}
Parsed event data: {
  "eventId": "d5a35d93-03a8-430f-bc01-dee3857e9772",
  "timestamp": "2025-10-03T19:38:49.044386Z",
  "resourceUpdate": {
    "name": "enterprises/768d7048-a934-4272-a813-557f949faa70/devices/AVPHwEvRewefTx6Eyr4E9J0pHEbFA4JHAqCRB9oBFpCA2e44qGxfkrhHqJctL4Pc-gLcRP4ntB4Ss6x4Rp7Tmr4LsyunPQ",
    "traits": {
      "sdm.devices.traits.Fan": {
        "timerMode": "OFF"
      }
    }
  },
  "userId": "AVPHwEuGBF2sC1p3MsCxw3Fi6sINtjSc1SWDHECt2FOi",
  "resourceGroup": [
    "enterprises/768d7048-a934-4272-a813-557f949faa70/devices/AVPHwEvRewefTx6Eyr4E9J0pHEbFA4JHAqCRB9oBFpCA2e44qGxfkrhHqJctL4Pc-gLcRP4ntB4Ss6x4Rp7Tmr4LsyunPQ"
  ]
}
========== PROCESSING DEVICE EVENT ==========
Device Key: AVPHwEvRewefTx6Eyr4E9J0pHEbFA4JHAqCRB9oBFpCA2e44qGxfkrhHqJctL4Pc-gLcRP4ntB4Ss6x4Rp7Tmr4LsyunPQ
User ID: AVPHwEuGBF2sC1p3MsCxw3Fi6sINtjSc1SWDHECt2FOi
ALL TRAITS RECEIVED: {
  "sdm.devices.traits.Fan": {
    "timerMode": "OFF"
  }
}
Fan trait received: {
  "timerMode": "OFF"
}
Fan Timer Status: OFF
Fetching missing data from database...
Equipment Status from DB: COOLING
--- RUNTIME LOGIC EVALUATION ---
Equipment Status: COOLING
  - Heating: false
  - Cooling: true
  - Off: false
Fan Timer: OFF
ACTIVITY DETERMINATION:
Should be active: true
  Reason: Cooling
Was active: true
Current in-memory state: EXISTS
ACTION: UPDATE EXISTING SESSION (still active)
  Session has been running for 873 seconds
Updating session - Elapsed: 873s
Session updated - isHvacActive: TRUE
========== EVENT PROCESSING COMPLETE ==========
Received webhook: {
  "message": {
    "data": "ewogICJldmVudElkIjogImQ5ZjMxMjYwLTkyN2ItNDg1Ny1iOTI0LTM1M2U0ZjYwOGJiZSIsCiAgInRpbWVzdGFtcCI6ICIyMDI1LTEwLTAzVDE5OjM4OjQ5LjA0NDM4NloiLAogICJyZXNvdXJjZVVwZGF0ZSI6IHsKICAgICJuYW1lIjogImVudGVycHJpc2VzLzc2OGQ3MDQ4LWE5MzQtNDI3Mi1hODEzLTU1N2Y5NDlmYWE3MC9kZXZpY2VzL0FWUEh3RXZSZXdlZlR4NkV5cjRFOUowcEhFYkZBNEpIQXFDUkI5b0JGcENBMmU0NHFHeGZrcmhIcUpjdEw0UGMtZ0xjUlA0bnRCNFNzNng0UnA3VG1yNExzeXVuUFEiLAogICAgInRyYWl0cyI6IHsKICAgICAgInNkbS5kZXZpY2VzLnRyYWl0cy5UaGVybW9zdGF0SHZhYyI6IHsKICAgICAgICAic3RhdHVzIjogIkNPT0xJTkciCiAgICAgIH0KICAgIH0KICB9LAogICJ1c2VySWQiOiAiQVZQSHdFdUdCRjJzQzFwM01zQ3h3M0ZpNnNJTnRqU2MxU1dESEVDdDJGT2kiLAogICJyZXNvdXJjZUdyb3VwIjogWyJlbnRlcnByaXNlcy83NjhkNzA0OC1hOTM0LTQyNzItYTgxMy01NTdmOTQ5ZmFhNzAvZGV2aWNlcy9BVlBId0V2UmV3ZWZUeDZFeXI0RTlKMHBIRWJGQTRKSEFxQ1JCOW9CRnBDQTJlNDRxR3hma3JoSHFKY3RMNFBjLWdMY1JQNG50QjRTczZ4NFJwN1RtcjRMc3l1blBRIl0KfQ==",
    "messageId": "16585354885000899",
    "message_id": "16585354885000899",
    "publishTime": "2025-10-03T19:49:51.286Z",
    "publish_time": "2025-10-03T19:49:51.286Z"
  },
  "subscription": "projects/smartfilterpronest/subscriptions/SmartfilterProNestPush"
}
Decoded Pub/Sub data: {
  "eventId": "d9f31260-927b-4857-b924-353e4f608bbe",
  "timestamp": "2025-10-03T19:38:49.044386Z",
  "resourceUpdate": {
    "name": "enterprises/768d7048-a934-4272-a813-557f949faa70/devices/AVPHwEvRewefTx6Eyr4E9J0pHEbFA4JHAqCRB9oBFpCA2e44qGxfkrhHqJctL4Pc-gLcRP4ntB4Ss6x4Rp7Tmr4LsyunPQ",
    "traits": {
      "sdm.devices.traits.ThermostatHvac": {
        "status": "COOLING"
      }
    }
  },
  "userId": "AVPHwEuGBF2sC1p3MsCxw3Fi6sINtjSc1SWDHECt2FOi",
  "resourceGroup": ["enterprises/768d7048-a934-4272-a813-557f949faa70/devices/AVPHwEvRewefTx6Eyr4E9J0pHEbFA4JHAqCRB9oBFpCA2e44qGxfkrhHqJctL4Pc-gLcRP4ntB4Ss6x4Rp7Tmr4LsyunPQ"]
}
Parsed event data: {
  "eventId": "d9f31260-927b-4857-b924-353e4f608bbe",
  "timestamp": "2025-10-03T19:38:49.044386Z",
  "resourceUpdate": {
    "name": "enterprises/768d7048-a934-4272-a813-557f949faa70/devices/AVPHwEvRewefTx6Eyr4E9J0pHEbFA4JHAqCRB9oBFpCA2e44qGxfkrhHqJctL4Pc-gLcRP4ntB4Ss6x4Rp7Tmr4LsyunPQ",
    "traits": {
      "sdm.devices.traits.ThermostatHvac": {
        "status": "COOLING"
      }
    }
  },
  "userId": "AVPHwEuGBF2sC1p3MsCxw3Fi6sINtjSc1SWDHECt2FOi",
  "resourceGroup": [
    "enterprises/768d7048-a934-4272-a813-557f949faa70/devices/AVPHwEvRewefTx6Eyr4E9J0pHEbFA4JHAqCRB9oBFpCA2e44qGxfkrhHqJctL4Pc-gLcRP4ntB4Ss6x4Rp7Tmr4LsyunPQ"
  ]
}
========== PROCESSING DEVICE EVENT ==========
Device Key: AVPHwEvRewefTx6Eyr4E9J0pHEbFA4JHAqCRB9oBFpCA2e44qGxfkrhHqJctL4Pc-gLcRP4ntB4Ss6x4Rp7Tmr4LsyunPQ
User ID: AVPHwEuGBF2sC1p3MsCxw3Fi6sINtjSc1SWDHECt2FOi
ALL TRAITS RECEIVED: {
  "sdm.devices.traits.ThermostatHvac": {
    "status": "COOLING"
  }
}
Equipment Status from trait: COOLING
No Fan trait in this event - using last known state from database
Fetching missing data from database...
Fan Timer from DB: OFF
--- RUNTIME LOGIC EVALUATION ---
Equipment Status: COOLING
  - Heating: false
  - Cooling: true
  - Off: false
