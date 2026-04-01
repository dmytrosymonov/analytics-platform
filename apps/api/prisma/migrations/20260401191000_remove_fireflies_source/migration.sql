WITH fireflies_source AS (
    SELECT id
    FROM "data_sources"
    WHERE "type" = 'fireflies'
),
fireflies_results AS (
    SELECT rr.id
    FROM "report_results" rr
    JOIN fireflies_source fs ON fs.id = rr."source_id"
),
fireflies_messages AS (
    SELECT sm.id
    FROM "sent_messages" sm
    JOIN fireflies_results fr ON fr.id = sm."result_id"
),
fireflies_schedules AS (
    SELECT rs.id
    FROM "report_schedules" rs
    JOIN fireflies_source fs ON fs.id = rs."source_id"
),
fireflies_templates AS (
    SELECT pt.id
    FROM "prompt_templates" pt
    JOIN fireflies_source fs ON fs.id = pt."source_id"
)
DELETE FROM "delivery_attempts"
WHERE "sent_message_id" IN (SELECT id FROM fireflies_messages);

DELETE FROM "sent_messages"
WHERE "id" IN (SELECT id FROM fireflies_messages);

DELETE FROM "report_results"
WHERE "id" IN (SELECT id FROM fireflies_results);

DELETE FROM "report_jobs"
WHERE "source_id" IN (SELECT id FROM fireflies_source);

DELETE FROM "user_schedule_preferences"
WHERE "schedule_id" IN (SELECT id FROM fireflies_schedules);

DELETE FROM "report_schedules"
WHERE "id" IN (SELECT id FROM fireflies_schedules);

DELETE FROM "user_report_preferences"
WHERE "source_id" IN (SELECT id FROM fireflies_source);

DELETE FROM "prompt_versions"
WHERE "template_id" IN (SELECT id FROM fireflies_templates);

DELETE FROM "prompt_templates"
WHERE "id" IN (SELECT id FROM fireflies_templates);

DELETE FROM "source_credentials"
WHERE "source_id" IN (SELECT id FROM fireflies_source);

DELETE FROM "source_settings"
WHERE "source_id" IN (SELECT id FROM fireflies_source);

DELETE FROM "data_sources"
WHERE "id" IN (SELECT id FROM fireflies_source);

DELETE FROM "system_settings"
WHERE "key" = 'scheduler.fireflies_cron';

ALTER TYPE "SourceType" RENAME TO "SourceType_old";

CREATE TYPE "SourceType" AS ENUM ('gto', 'ga4', 'redmine', 'youtrack', 'gto_comments');

ALTER TABLE "data_sources"
ALTER COLUMN "type" TYPE "SourceType"
USING ("type"::text::"SourceType");

DROP TYPE "SourceType_old";
