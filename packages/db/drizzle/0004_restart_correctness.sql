-- Restart correctness.
--
-- Three things a restart used to get wrong, and one host that restarts a lot:
-- a free instance spins down after fifteen idle minutes, is woken by the next
-- request, and may be recycled at any time. Overlapping deployments make the
-- old and new instances briefly concurrent.
--
-- 1. wa_session_leases — which worker owns a WhatsApp session.
--
-- WhatsApp allows one connection per linked device. Two workers holding the
-- same session fight, and WhatsApp settles it by logging the number out, which
-- costs the user a re-pair. A lease rather than an advisory lock because
-- advisory locks are session-scoped and a pooler in transaction mode hands a
-- different backend to every transaction; the transaction-scoped variant
-- releases at commit, which cannot express ownership held for hours. A row
-- with an expiry needs no session state and survives any pooler.
--
-- 2. campaign_targets.dispatch_started_at — written immediately before the
-- message is handed to WhatsApp.
--
-- This separates "never tried" from "tried, outcome unknown". A worker killed
-- between the socket write and the database write leaves this set with no
-- message id, and the message may well have arrived. Retrying would send a
-- second copy, so the reaper refuses and records why.
--
-- 3. campaigns.next_send_at / batch_sent_count — durable pacing.
--
-- The pacer lived in memory, so every restart reset it: the inter-message
-- delay was skipped and, worse, so was the 45-90 minute pause between
-- batches. Pacing exists to look human. A limit a restart bypasses is not one.

CREATE TABLE "wa_session_leases" (
	"session_id" uuid PRIMARY KEY NOT NULL,
	"worker_id" text NOT NULL,
	"acquired_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "campaign_targets" ADD COLUMN "dispatch_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "campaigns" ADD COLUMN "next_send_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "campaigns" ADD COLUMN "batch_sent_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "wa_session_leases" ADD CONSTRAINT "wa_session_leases_session_id_wa_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."wa_sessions"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint

-- Granted explicitly rather than relying on the default privileges set in
-- 0001. Those only apply to tables created afterwards BY THE SAME ROLE, and a
-- managed provider may not run every migration as the role that owns the
-- schema. Being wrong about that shows up as the worker silently unable to
-- claim any session, which is a bad way to find out.
GRANT SELECT, INSERT, UPDATE, DELETE ON "wa_session_leases" TO wa_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "worker_heartbeats" TO wa_app;
--> statement-breakpoint

-- Finding the sessions whose lease has lapsed is the worker's most frequent
-- query, and it runs on every reconciliation pass.
CREATE INDEX IF NOT EXISTS "wa_session_leases_expires_idx" ON "wa_session_leases" ("expires_at");
--> statement-breakpoint

-- The sender asks "which running campaign is due?" every few seconds. Without
-- this it is a sequential scan of every campaign on the instance.
CREATE INDEX IF NOT EXISTS "campaigns_due_idx" ON "campaigns" ("status", "next_send_at");
