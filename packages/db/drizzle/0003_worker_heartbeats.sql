-- Worker liveness.
--
-- The web app had no way to distinguish a campaign that is pacing itself from
-- one whose sender is not running. Both look the same from the database:
-- status 'running', targets queued, nothing moving. So the campaign page
-- explained that messages go out every 25-55 seconds while no worker process
-- existed at all, which is worse than saying nothing.
--
-- One row per worker process, upserted on a short interval. No user_id: this
-- is infrastructure rather than tenant data, so it carries no row-level
-- security and every account reads the same rows.

CREATE TABLE "worker_heartbeats" (
	"worker_id" text PRIMARY KEY NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"open_sessions" integer DEFAULT 0 NOT NULL
);

