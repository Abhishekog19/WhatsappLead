CREATE TYPE "public"."account_type" AS ENUM('personal', 'business');--> statement-breakpoint
CREATE TYPE "public"."campaign_status" AS ENUM('draft', 'scheduled', 'running', 'paused', 'completed', 'cancelled', 'failed');--> statement-breakpoint
CREATE TYPE "public"."dedupe_mode" AS ENUM('never_repeat', 'cooldown', 'off');--> statement-breakpoint
CREATE TYPE "public"."message_direction" AS ENUM('out', 'in');--> statement-breakpoint
CREATE TYPE "public"."message_event_type" AS ENUM('sent', 'delivered', 'read', 'failed', 'reply');--> statement-breakpoint
CREATE TYPE "public"."skip_reason" AS ENUM('duplicate', 'suppressed', 'invalid_number', 'not_on_whatsapp', 'cooldown', 'cap_reached', 'outside_window');--> statement-breakpoint
CREATE TYPE "public"."suppression_reason" AS ENUM('manual', 'opt_out', 'invalid_number', 'not_on_whatsapp', 'reported');--> statement-breakpoint
CREATE TYPE "public"."target_status" AS ENUM('pending', 'sending', 'sent', 'failed', 'skipped');--> statement-breakpoint
CREATE TYPE "public"."throttle_signal" AS ENUM('first_warning', 'second_warning', 'capped_475', 'shadow_463');--> statement-breakpoint
CREATE TYPE "public"."wa_engine" AS ENUM('baileys', 'wwebjs');--> statement-breakpoint
CREATE TYPE "public"."wa_session_status" AS ENUM('pending', 'pairing', 'connected', 'disconnected', 'logged_out', 'throttled', 'banned');--> statement-breakpoint
CREATE TABLE "auth_accounts" (
	"user_id" text NOT NULL,
	"type" text NOT NULL,
	"provider" text NOT NULL,
	"provider_account_id" text NOT NULL,
	"refresh_token" text,
	"access_token" text,
	"expires_at" integer,
	"token_type" text,
	"scope" text,
	"id_token" text,
	"session_state" text,
	CONSTRAINT "auth_accounts_provider_provider_account_id_pk" PRIMARY KEY("provider","provider_account_id")
);
--> statement-breakpoint
CREATE TABLE "auth_sessions" (
	"session_token" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"expires" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "authenticators" (
	"credential_id" text NOT NULL,
	"user_id" text NOT NULL,
	"provider_account_id" text NOT NULL,
	"credential_public_key" text NOT NULL,
	"counter" integer NOT NULL,
	"credential_device_type" text NOT NULL,
	"credential_backed_up" boolean NOT NULL,
	"transports" text,
	CONSTRAINT "authenticators_user_id_credential_id_pk" PRIMARY KEY("user_id","credential_id"),
	CONSTRAINT "authenticators_credential_id_unique" UNIQUE("credential_id")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text,
	"email" text,
	"email_verified" timestamp with time zone,
	"image" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"suspended_at" timestamp with time zone,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "verification_tokens" (
	"identifier" text NOT NULL,
	"token" text NOT NULL,
	"expires" timestamp with time zone NOT NULL,
	CONSTRAINT "verification_tokens_identifier_token_pk" PRIMARY KEY("identifier","token")
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"user_id" text PRIMARY KEY NOT NULL,
	"dedupe_mode" "dedupe_mode" DEFAULT 'never_repeat' NOT NULL,
	"cooldown_days" integer DEFAULT 90 NOT NULL,
	"new_contact_cap_24h" integer,
	"warmup_enabled" boolean DEFAULT true NOT NULL,
	"min_delay_ms" integer DEFAULT 25000 NOT NULL,
	"max_delay_ms" integer DEFAULT 55000 NOT NULL,
	"batch_size" integer DEFAULT 15 NOT NULL,
	"min_batch_pause_ms" integer DEFAULT 2700000 NOT NULL,
	"max_batch_pause_ms" integer DEFAULT 5400000 NOT NULL,
	"simulate_typing" boolean DEFAULT true NOT NULL,
	"send_window_start_hour" smallint DEFAULT 10 NOT NULL,
	"send_window_end_hour" smallint DEFAULT 19 NOT NULL,
	"timezone" text DEFAULT 'Asia/Kolkata' NOT NULL,
	"skip_weekends" boolean DEFAULT false NOT NULL,
	"default_country" text DEFAULT 'IN' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wa_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"label" text DEFAULT 'My WhatsApp' NOT NULL,
	"phone_e164" text,
	"account_type" "account_type" DEFAULT 'personal' NOT NULL,
	"engine" "wa_engine" DEFAULT 'baileys' NOT NULL,
	"status" "wa_session_status" DEFAULT 'pending' NOT NULL,
	"creds_encrypted" text,
	"pairing_code" text,
	"pairing_code_expires_at" timestamp with time zone,
	"qr_payload" text,
	"qr_expires_at" timestamp with time zone,
	"linked_at" timestamp with time zone,
	"tier" smallint DEFAULT 1 NOT NULL,
	"tier_updated_at" timestamp with time zone,
	"clean_days" integer DEFAULT 0 NOT NULL,
	"delay_multiplier" real DEFAULT 1 NOT NULL,
	"throttled_until" timestamp with time zone,
	"last_connected_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "contact_lists" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"source_filename" text,
	"columns" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"rows_total" integer DEFAULT 0 NOT NULL,
	"rows_imported" integer DEFAULT 0 NOT NULL,
	"rows_invalid" integer DEFAULT 0 NOT NULL,
	"rows_duplicate" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "contacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"list_id" uuid,
	"phone_e164" text NOT NULL,
	"name" text,
	"fields" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"on_whatsapp" text,
	"on_whatsapp_checked_at" timestamp with time zone,
	"last_messaged_at" timestamp with time zone,
	"message_count" integer DEFAULT 0 NOT NULL,
	"last_replied_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "suppressions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"phone_e164" text NOT NULL,
	"reason" "suppression_reason" DEFAULT 'manual' NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "template_variants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"template_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"label" text,
	"body" text NOT NULL,
	"weight" smallint DEFAULT 1 NOT NULL,
	"position" smallint DEFAULT 0 NOT NULL,
	"sent_count" integer DEFAULT 0 NOT NULL,
	"reply_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "campaign_targets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"campaign_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"contact_id" uuid NOT NULL,
	"status" "target_status" DEFAULT 'pending' NOT NULL,
	"skip_reason" "skip_reason",
	"variant_id" uuid,
	"rendered_body" text,
	"attempts" smallint DEFAULT 0 NOT NULL,
	"last_error" text,
	"claimed_at" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"wa_message_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "campaigns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"status" "campaign_status" DEFAULT 'draft' NOT NULL,
	"session_id" uuid NOT NULL,
	"list_id" uuid NOT NULL,
	"template_id" uuid NOT NULL,
	"daily_cap_override" integer,
	"scheduled_for" timestamp with time zone,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"paused_at" timestamp with time zone,
	"pause_reason" text,
	"total_targets" integer DEFAULT 0 NOT NULL,
	"sent_count" integer DEFAULT 0 NOT NULL,
	"failed_count" integer DEFAULT 0 NOT NULL,
	"skipped_count" integer DEFAULT 0 NOT NULL,
	"reply_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text,
	"action" text NOT NULL,
	"entity_type" text,
	"entity_id" text,
	"metadata" jsonb,
	"ip_address" text,
	"user_agent" text,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "message_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"session_id" uuid NOT NULL,
	"contact_id" uuid,
	"campaign_id" uuid,
	"direction" "message_direction" NOT NULL,
	"type" "message_event_type" NOT NULL,
	"wa_message_id" text,
	"body" text,
	"error" text,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "new_contact_sends" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"session_id" uuid NOT NULL,
	"contact_id" uuid,
	"campaign_id" uuid,
	"phone_e164" text NOT NULL,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "throttle_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"session_id" uuid NOT NULL,
	"signal" "throttle_signal" NOT NULL,
	"raw" jsonb,
	"tier_before" smallint,
	"tier_after" smallint,
	"paused_until" timestamp with time zone,
	"acknowledged_at" timestamp with time zone,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "auth_accounts" ADD CONSTRAINT "auth_accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_sessions" ADD CONSTRAINT "auth_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "authenticators" ADD CONSTRAINT "authenticators_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settings" ADD CONSTRAINT "settings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wa_sessions" ADD CONSTRAINT "wa_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_lists" ADD CONSTRAINT "contact_lists_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_list_id_contact_lists_id_fk" FOREIGN KEY ("list_id") REFERENCES "public"."contact_lists"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suppressions" ADD CONSTRAINT "suppressions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "template_variants" ADD CONSTRAINT "template_variants_template_id_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."templates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "template_variants" ADD CONSTRAINT "template_variants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "templates" ADD CONSTRAINT "templates_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_targets" ADD CONSTRAINT "campaign_targets_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_targets" ADD CONSTRAINT "campaign_targets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_targets" ADD CONSTRAINT "campaign_targets_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_targets" ADD CONSTRAINT "campaign_targets_variant_id_template_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."template_variants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_session_id_wa_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."wa_sessions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_list_id_contact_lists_id_fk" FOREIGN KEY ("list_id") REFERENCES "public"."contact_lists"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_template_id_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."templates"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_events" ADD CONSTRAINT "message_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_events" ADD CONSTRAINT "message_events_session_id_wa_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."wa_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_events" ADD CONSTRAINT "message_events_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_events" ADD CONSTRAINT "message_events_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "new_contact_sends" ADD CONSTRAINT "new_contact_sends_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "new_contact_sends" ADD CONSTRAINT "new_contact_sends_session_id_wa_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."wa_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "new_contact_sends" ADD CONSTRAINT "new_contact_sends_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "new_contact_sends" ADD CONSTRAINT "new_contact_sends_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "throttle_events" ADD CONSTRAINT "throttle_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "throttle_events" ADD CONSTRAINT "throttle_events_session_id_wa_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."wa_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "wa_sessions_user_idx" ON "wa_sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "wa_sessions_status_idx" ON "wa_sessions" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "wa_sessions_user_phone_idx" ON "wa_sessions" USING btree ("user_id","phone_e164") WHERE phone_e164 is not null and deleted_at is null;--> statement-breakpoint
CREATE INDEX "contact_lists_user_idx" ON "contact_lists" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "contacts_user_phone_idx" ON "contacts" USING btree ("user_id","phone_e164");--> statement-breakpoint
CREATE INDEX "contacts_list_idx" ON "contacts" USING btree ("list_id");--> statement-breakpoint
CREATE INDEX "contacts_user_last_messaged_idx" ON "contacts" USING btree ("user_id","last_messaged_at");--> statement-breakpoint
CREATE UNIQUE INDEX "suppressions_user_phone_idx" ON "suppressions" USING btree ("user_id","phone_e164");--> statement-breakpoint
CREATE INDEX "template_variants_template_idx" ON "template_variants" USING btree ("template_id");--> statement-breakpoint
CREATE INDEX "template_variants_user_idx" ON "template_variants" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "templates_user_idx" ON "templates" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "campaign_targets_campaign_contact_idx" ON "campaign_targets" USING btree ("campaign_id","contact_id");--> statement-breakpoint
CREATE INDEX "campaign_targets_claim_idx" ON "campaign_targets" USING btree ("campaign_id","status","created_at");--> statement-breakpoint
CREATE INDEX "campaign_targets_user_idx" ON "campaign_targets" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "campaigns_user_idx" ON "campaigns" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "campaigns_status_idx" ON "campaigns" USING btree ("status");--> statement-breakpoint
CREATE INDEX "audit_log_user_idx" ON "audit_log" USING btree ("user_id","occurred_at");--> statement-breakpoint
CREATE INDEX "message_events_session_idx" ON "message_events" USING btree ("session_id","occurred_at");--> statement-breakpoint
CREATE INDEX "message_events_campaign_idx" ON "message_events" USING btree ("campaign_id");--> statement-breakpoint
CREATE INDEX "message_events_wa_message_idx" ON "message_events" USING btree ("wa_message_id");--> statement-breakpoint
CREATE INDEX "message_events_user_idx" ON "message_events" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "new_contact_sends_session_sent_idx" ON "new_contact_sends" USING btree ("session_id","sent_at");--> statement-breakpoint
CREATE INDEX "new_contact_sends_user_idx" ON "new_contact_sends" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "throttle_events_session_idx" ON "throttle_events" USING btree ("session_id","occurred_at");--> statement-breakpoint
CREATE INDEX "throttle_events_user_idx" ON "throttle_events" USING btree ("user_id");