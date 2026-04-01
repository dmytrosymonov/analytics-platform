DELETE FROM "delivery_attempts"
WHERE "sent_message_id" IN (
    SELECT sm.id
    FROM "sent_messages" sm
    JOIN "report_results" rr ON rr.id = sm."result_id"
    JOIN "data_sources" ds ON ds.id = rr."source_id"
    WHERE ds."type" = 'fireflies'
);

DELETE FROM "sent_messages"
WHERE "result_id" IN (
    SELECT rr.id
    FROM "report_results" rr
    JOIN "data_sources" ds ON ds.id = rr."source_id"
    WHERE ds."type" = 'fireflies'
);

DELETE FROM "report_results"
WHERE "source_id" IN (
    SELECT id
    FROM "data_sources"
    WHERE "type" = 'fireflies'
);

DELETE FROM "report_jobs"
WHERE "source_id" IN (
    SELECT id
    FROM "data_sources"
    WHERE "type" = 'fireflies'
);

DELETE FROM "user_schedule_preferences"
WHERE "schedule_id" IN (
    SELECT rs.id
    FROM "report_schedules" rs
    JOIN "data_sources" ds ON ds.id = rs."source_id"
    WHERE ds."type" = 'fireflies'
);

DELETE FROM "report_schedules"
WHERE "source_id" IN (
    SELECT id
    FROM "data_sources"
    WHERE "type" = 'fireflies'
);

DELETE FROM "user_report_preferences"
WHERE "source_id" IN (
    SELECT id
    FROM "data_sources"
    WHERE "type" = 'fireflies'
);

DELETE FROM "prompt_versions"
WHERE "template_id" IN (
    SELECT pt.id
    FROM "prompt_templates" pt
    JOIN "data_sources" ds ON ds.id = pt."source_id"
    WHERE ds."type" = 'fireflies'
);

DELETE FROM "prompt_templates"
WHERE "source_id" IN (
    SELECT id
    FROM "data_sources"
    WHERE "type" = 'fireflies'
);

DELETE FROM "source_credentials"
WHERE "source_id" IN (
    SELECT id
    FROM "data_sources"
    WHERE "type" = 'fireflies'
);

DELETE FROM "source_settings"
WHERE "source_id" IN (
    SELECT id
    FROM "data_sources"
    WHERE "type" = 'fireflies'
);

DELETE FROM "data_sources"
WHERE "type" = 'fireflies';

DELETE FROM "system_settings"
WHERE "key" = 'scheduler.fireflies_cron';

ALTER TYPE "SourceType" RENAME TO "SourceType_old";

CREATE TYPE "SourceType" AS ENUM ('gto', 'ga4', 'redmine', 'youtrack', 'gto_comments');

ALTER TABLE "data_sources"
ALTER COLUMN "type" TYPE "SourceType"
USING ("type"::text::"SourceType");

DROP TYPE "SourceType_old";
