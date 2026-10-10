-- Linking method.
--
-- Both ways of linking a device are first-class, not a primary and a
-- fallback. A pairing code is the only option for someone with a single
-- phone; a QR is faster when there is already a second screen in front of
-- them. Which one was chosen decides whether the worker asks WhatsApp for a
-- code or waits for a QR to be scanned, so it has to be recorded rather than
-- inferred.
--
-- Default is pairing_code, which is also what every existing row becomes:
-- that is the flow the product was built around.

CREATE TYPE "public"."link_method" AS ENUM('pairing_code', 'qr');--> statement-breakpoint
ALTER TABLE "wa_sessions" ADD COLUMN "link_method" "link_method" DEFAULT 'pairing_code' NOT NULL;
