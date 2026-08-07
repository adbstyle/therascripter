-- Migration 016: Boot-Recovery-Zähler für Poison-Task-Erkennung
-- Purpose: recoverStuckTasks() inkrementiert attempts bei jedem Boot-Reset
--   eines 'running'-Tasks. Nach MAX_BOOT_RECOVERY_ATTEMPTS (2) wird der Task
--   als failed markiert statt erneut auf pending gesetzt — ein hart
--   crashender Task (z. B. nativer OOM) erzeugte vorher eine endlose
--   Crash-Schleife bei jedem App-Start.
-- Ein sauberer Shutdown (TaskQueueService.shutdown) setzt selbst auf pending
--   zurück OHNE attempts zu erhöhen — nur echte Crashes zählen.

ALTER TABLE task_queue ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
