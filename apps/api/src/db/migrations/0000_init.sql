CREATE TYPE "public"."booking_state" AS ENUM('draft', 'pending_accept', 'confirmed', 'in_progress', 'completed', 'reviewed', 'cancelled_devotee', 'cancelled_pandit', 'expired');--> statement-breakpoint
CREATE TYPE "public"."dispute_state" AS ENUM('open', 'awaiting_evidence', 'resolved', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."dispute_type" AS ENUM('cash_mismatch', 'no_show', 'quality', 'refund', 'other');--> statement-breakpoint
CREATE TYPE "public"."kyc_status" AS ENUM('pending', 'submitted', 'verified', 'rejected', 'expired');--> statement-breakpoint
CREATE TYPE "public"."kyc_type" AS ENUM('identity', 'bank', 'credential', 'demo');--> statement-breakpoint
CREATE TYPE "public"."ledger_account_type" AS ENUM('platform', 'pandit', 'devotee_credit', 'escrow', 'tax');--> statement-breakpoint
CREATE TYPE "public"."ledger_direction" AS ENUM('debit', 'credit');--> statement-breakpoint
CREATE TYPE "public"."ledger_entry_type" AS ENUM('token', 'balance', 'commission', 'payout', 'refund', 'credit_grant', 'credit_redeem', 'cash_due', 'cash_recovery', 'cash_settled_direct', 'tds', 'tds_carry', 'instant_payout_fee', 'adjustment');--> statement-breakpoint
CREATE TYPE "public"."locale" AS ENUM('bn', 'hi', 'en');--> statement-breakpoint
CREATE TYPE "public"."panchang_kind" AS ENUM('tithi', 'nakshatra', 'yoga', 'karana');--> statement-breakpoint
CREATE TYPE "public"."panchang_source" AS ENUM('api', 'manual_panjika', 'pandit_override');--> statement-breakpoint
CREATE TYPE "public"."panjika_school" AS ENUM('bisuddha_siddhanta', 'gupta_press');--> statement-breakpoint
CREATE TYPE "public"."payment_intent_kind" AS ENUM('token', 'balance', 'self_settle');--> statement-breakpoint
CREATE TYPE "public"."payment_intent_status" AS ENUM('created', 'attempted', 'captured', 'failed', 'refunded');--> statement-breakpoint
CREATE TYPE "public"."payment_mode" AS ENUM('digital_full', 'digital_token_balance', 'cash');--> statement-breakpoint
CREATE TYPE "public"."payout_status" AS ENUM('pending', 'processing', 'paid', 'failed', 'reversed');--> statement-breakpoint
CREATE TYPE "public"."samagri_option" AS ENUM('none', 'pandit_brings');--> statement-breakpoint
CREATE TYPE "public"."slot_source" AS ENUM('default', 'manual', 'recurring', 'travel_buffer', 'booking');--> statement-breakpoint
CREATE TYPE "public"."slot_status" AS ENUM('open', 'closed', 'booked', 'buffer');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('devotee', 'pandit', 'admin', 'ops');--> statement-breakpoint
CREATE TABLE "addresses" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"label" text,
	"line1" text NOT NULL,
	"line2" text,
	"city_id" text NOT NULL,
	"pincode" text NOT NULL,
	"lat" double precision NOT NULL,
	"lng" double precision NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cities" (
	"id" text PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"tz" text DEFAULT 'Asia/Kolkata' NOT NULL,
	"default_panjika_school" "panjika_school" DEFAULT 'gupta_press' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cities_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "kyc_records" (
	"id" text PRIMARY KEY NOT NULL,
	"pandit_id" text NOT NULL,
	"type" "kyc_type" NOT NULL,
	"status" "kyc_status" DEFAULT 'pending' NOT NULL,
	"provider" text DEFAULT 'manual' NOT NULL,
	"provider_ref" text,
	"identifier_last4" text,
	"doc_key" text,
	"doc_purge_after" timestamp with time zone,
	"reviewed_by" text,
	"review_notes" text,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pandit_profiles" (
	"user_id" text PRIMARY KEY NOT NULL,
	"bio" text,
	"experience_years" integer DEFAULT 0 NOT NULL,
	"traditions" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"languages" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"service_radius_km" integer DEFAULT 15 NOT NULL,
	"base_lat" double precision,
	"base_lng" double precision,
	"kyc_status" "kyc_status" DEFAULT 'pending' NOT NULL,
	"kyc_verified_at" timestamp with time zone,
	"kyc_expires_at" timestamp with time zone,
	"badges" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"rating_sum" integer DEFAULT 0 NOT NULL,
	"rating_count" integer DEFAULT 0 NOT NULL,
	"acceptance_rate" numeric(5, 4),
	"cash_credit_limit_paise" bigint DEFAULT 500000 NOT NULL,
	"cash_jobs_enabled" boolean DEFAULT true NOT NULL,
	"auto_accept" boolean DEFAULT false NOT NULL,
	"linked_account_id" text,
	"new_supply_boost_remaining" integer DEFAULT 20 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"phone" text NOT NULL,
	"name" text,
	"email" text,
	"role" "user_role" DEFAULT 'devotee' NOT NULL,
	"locale" "locale" DEFAULT 'bn' NOT NULL,
	"panjika_school" "panjika_school",
	"city_id" text,
	"referral_code" text,
	"referred_by" text,
	"status" text DEFAULT 'active' NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_phone_unique" UNIQUE("phone"),
	CONSTRAINT "users_referral_code_unique" UNIQUE("referral_code")
);
--> statement-breakpoint
CREATE TABLE "bom_item_translations" (
	"bom_item_id" text NOT NULL,
	"locale" "locale" NOT NULL,
	"name" text NOT NULL,
	CONSTRAINT "bom_item_translations_bom_item_id_locale_pk" PRIMARY KEY("bom_item_id","locale")
);
--> statement-breakpoint
CREATE TABLE "bom_items" (
	"id" text PRIMARY KEY NOT NULL,
	"bom_id" text NOT NULL,
	"qty" numeric(10, 3) NOT NULL,
	"unit" text NOT NULL,
	"grade" text,
	"catalog_price_paise" bigint NOT NULL,
	"perishable" boolean DEFAULT false NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "boms" (
	"id" text PRIMARY KEY NOT NULL,
	"ritual_id" text NOT NULL,
	"city_id" text,
	"tradition" text,
	"version" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pandit_rituals" (
	"pandit_id" text NOT NULL,
	"ritual_id" text NOT NULL,
	"price_paise" bigint NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	CONSTRAINT "pandit_rituals_pandit_id_ritual_id_pk" PRIMARY KEY("pandit_id","ritual_id")
);
--> statement-breakpoint
CREATE TABLE "ritual_city_prices" (
	"ritual_id" text NOT NULL,
	"city_id" text NOT NULL,
	"band_min_paise" bigint NOT NULL,
	"band_max_paise" bigint NOT NULL,
	"default_paise" bigint NOT NULL,
	CONSTRAINT "ritual_city_prices_ritual_id_city_id_pk" PRIMARY KEY("ritual_id","city_id")
);
--> statement-breakpoint
CREATE TABLE "ritual_translations" (
	"ritual_id" text NOT NULL,
	"locale" "locale" NOT NULL,
	"name" text NOT NULL,
	"short_description" text NOT NULL,
	"description" text NOT NULL,
	CONSTRAINT "ritual_translations_ritual_id_locale_pk" PRIMARY KEY("ritual_id","locale")
);
--> statement-breakpoint
CREATE TABLE "rituals" (
	"id" text PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"duration_min" integer NOT NULL,
	"default_slot_span" integer DEFAULT 1 NOT NULL,
	"is_muhurat_sensitive" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 100 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rituals_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "muhurat_flags" (
	"id" text PRIMARY KEY NOT NULL,
	"city_id" text NOT NULL,
	"school" "panjika_school" NOT NULL,
	"date" date NOT NULL,
	"ritual_id" text NOT NULL,
	"is_auspicious" boolean NOT NULL,
	"window_start" timestamp with time zone,
	"window_end" timestamp with time zone,
	"note" text,
	"source" "panchang_source" DEFAULT 'api' NOT NULL,
	"entered_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "panchang_days" (
	"id" text PRIMARY KEY NOT NULL,
	"city_id" text NOT NULL,
	"school" "panjika_school" NOT NULL,
	"date" date NOT NULL,
	"bengali_date" text,
	"sunrise" timestamp with time zone NOT NULL,
	"sunset" timestamp with time zone NOT NULL,
	"tithi_at_sunrise" text NOT NULL,
	"nakshatra_at_sunrise" text NOT NULL,
	"abhijit_start" timestamp with time zone,
	"abhijit_end" timestamp with time zone,
	"rahu_start" timestamp with time zone,
	"rahu_end" timestamp with time zone,
	"schools_disagree" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "panchang_intervals" (
	"id" text PRIMARY KEY NOT NULL,
	"city_id" text NOT NULL,
	"school" "panjika_school" NOT NULL,
	"kind" "panchang_kind" NOT NULL,
	"value_key" text NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"source" "panchang_source" DEFAULT 'api' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "panchang_terms" (
	"value_key" text NOT NULL,
	"locale" "locale" NOT NULL,
	"label" text NOT NULL,
	CONSTRAINT "panchang_terms_value_key_locale_pk" PRIMARY KEY("value_key","locale")
);
--> statement-breakpoint
CREATE TABLE "surge_rules" (
	"id" text PRIMARY KEY NOT NULL,
	"city_id" text NOT NULL,
	"date" date NOT NULL,
	"ritual_id" text,
	"multiplier_bps" integer DEFAULT 10000 NOT NULL,
	"source" text DEFAULT 'auto' NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "availability" (
	"id" text PRIMARY KEY NOT NULL,
	"pandit_id" text NOT NULL,
	"date" date NOT NULL,
	"slot_idx" integer NOT NULL,
	"status" "slot_status" DEFAULT 'open' NOT NULL,
	"source" "slot_source" DEFAULT 'default' NOT NULL,
	"booking_id" text,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "slot_defs" (
	"id" text PRIMARY KEY NOT NULL,
	"city_id" text NOT NULL,
	"idx" integer NOT NULL,
	"start_time" time NOT NULL,
	"end_time" time NOT NULL,
	"active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "booking_events" (
	"id" text PRIMARY KEY NOT NULL,
	"booking_id" text NOT NULL,
	"from_state" "booking_state",
	"to_state" "booking_state" NOT NULL,
	"trigger" text NOT NULL,
	"actor_id" text,
	"actor_role" text,
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bookings" (
	"id" text PRIMARY KEY NOT NULL,
	"devotee_id" text NOT NULL,
	"pandit_id" text NOT NULL,
	"ritual_id" text NOT NULL,
	"city_id" text NOT NULL,
	"address_id" text,
	"date" date NOT NULL,
	"slot_idx" integer NOT NULL,
	"slot_span" integer DEFAULT 1 NOT NULL,
	"slot_start_at" timestamp with time zone NOT NULL,
	"slot_end_at" timestamp with time zone NOT NULL,
	"parent_booking_id" text,
	"state" "booking_state" DEFAULT 'draft' NOT NULL,
	"panjika_school" "panjika_school" NOT NULL,
	"language" text DEFAULT 'bn' NOT NULL,
	"tradition" text,
	"attendee_count" integer DEFAULT 10 NOT NULL,
	"sankalp" jsonb,
	"samagri_option" "samagri_option" DEFAULT 'pandit_brings' NOT NULL,
	"bom_snapshot" jsonb,
	"price" jsonb NOT NULL,
	"payment_mode" "payment_mode" NOT NULL,
	"start_otp_hash" text,
	"complete_otp_hash" text,
	"otp_attempts" integer DEFAULT 0 NOT NULL,
	"accepted_at" timestamp with time zone,
	"accept_deadline_at" timestamp with time zone,
	"confirmed_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"cancel_reason" text,
	"cash_collected_paise" bigint,
	"offline_capture_at" timestamp with time zone,
	"completion_lat" text,
	"completion_lng" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reviews" (
	"id" text PRIMARY KEY NOT NULL,
	"booking_id" text NOT NULL,
	"author" text NOT NULL,
	"pandit_stars" integer,
	"punctuality_stars" integer,
	"samagri_stars" integer,
	"devotee_stars" integer,
	"text" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "ledger_accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_type" "ledger_account_type" NOT NULL,
	"owner_id" text,
	"currency" text DEFAULT 'INR' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ledger_entries" (
	"id" text PRIMARY KEY NOT NULL,
	"txn_id" text NOT NULL,
	"account_id" text NOT NULL,
	"booking_id" text,
	"direction" "ledger_direction" NOT NULL,
	"amount_paise" bigint NOT NULL,
	"type" "ledger_entry_type" NOT NULL,
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ledger_transactions" (
	"id" text PRIMARY KEY NOT NULL,
	"booking_id" text,
	"kind" text NOT NULL,
	"description" text,
	"idempotency_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ledger_transactions_idempotency_key_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "payment_intents" (
	"id" text PRIMARY KEY NOT NULL,
	"booking_id" text,
	"user_id" text NOT NULL,
	"kind" "payment_intent_kind" NOT NULL,
	"aggregator" text DEFAULT 'razorpay' NOT NULL,
	"aggregator_order_id" text,
	"aggregator_payment_id" text,
	"amount_paise" bigint NOT NULL,
	"status" "payment_intent_status" DEFAULT 'created' NOT NULL,
	"method" text,
	"idempotency_key" text NOT NULL,
	"captured_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_intents_idempotency_key_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "payouts" (
	"id" text PRIMARY KEY NOT NULL,
	"pandit_id" text NOT NULL,
	"period_start" date NOT NULL,
	"period_end" date NOT NULL,
	"gross_paise" bigint NOT NULL,
	"dues_recovered_paise" bigint DEFAULT 0 NOT NULL,
	"tds_paise" bigint DEFAULT 0 NOT NULL,
	"fee_paise" bigint DEFAULT 0 NOT NULL,
	"net_paise" bigint NOT NULL,
	"aggregator_ref" text,
	"status" "payout_status" DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhook_events" (
	"id" text PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"provider_event_id" text NOT NULL,
	"payload" jsonb NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"processed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" text PRIMARY KEY NOT NULL,
	"actor_id" text,
	"actor_role" text,
	"action" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"before" jsonb,
	"after" jsonb,
	"ip" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "disputes" (
	"id" text PRIMARY KEY NOT NULL,
	"booking_id" text NOT NULL,
	"type" "dispute_type" NOT NULL,
	"state" "dispute_state" DEFAULT 'open' NOT NULL,
	"raised_by" text,
	"evidence" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"resolution" text,
	"resolved_by" text,
	"first_response_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "idempotency_keys" (
	"key" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"endpoint" text NOT NULL,
	"request_hash" text NOT NULL,
	"response_status" integer,
	"response_body" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification_templates" (
	"id" text PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"locale" "locale" NOT NULL,
	"channel" text NOT NULL,
	"provider_template_name" text,
	"body" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"template_key" text NOT NULL,
	"channel" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"provider_ref" text,
	"sent_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"failed_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "outbox" (
	"id" text PRIMARY KEY NOT NULL,
	"aggregate_type" text NOT NULL,
	"aggregate_id" text NOT NULL,
	"event_type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"published_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "processed_events" (
	"consumer" text NOT NULL,
	"event_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "promo_codes" (
	"id" text PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"discount_bps" integer,
	"discount_flat_paise" bigint,
	"max_redemptions" integer,
	"per_user_limit" integer DEFAULT 1 NOT NULL,
	"valid_from" timestamp with time zone NOT NULL,
	"valid_until" timestamp with time zone NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "promo_codes_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "promo_redemptions" (
	"id" text PRIMARY KEY NOT NULL,
	"promo_id" text NOT NULL,
	"user_id" text NOT NULL,
	"booking_id" text NOT NULL,
	"discount_paise" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "addresses" ADD CONSTRAINT "addresses_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "addresses" ADD CONSTRAINT "addresses_city_id_cities_id_fk" FOREIGN KEY ("city_id") REFERENCES "public"."cities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kyc_records" ADD CONSTRAINT "kyc_records_pandit_id_pandit_profiles_user_id_fk" FOREIGN KEY ("pandit_id") REFERENCES "public"."pandit_profiles"("user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kyc_records" ADD CONSTRAINT "kyc_records_reviewed_by_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pandit_profiles" ADD CONSTRAINT "pandit_profiles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_city_id_cities_id_fk" FOREIGN KEY ("city_id") REFERENCES "public"."cities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bom_item_translations" ADD CONSTRAINT "bom_item_translations_bom_item_id_bom_items_id_fk" FOREIGN KEY ("bom_item_id") REFERENCES "public"."bom_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bom_items" ADD CONSTRAINT "bom_items_bom_id_boms_id_fk" FOREIGN KEY ("bom_id") REFERENCES "public"."boms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "boms" ADD CONSTRAINT "boms_ritual_id_rituals_id_fk" FOREIGN KEY ("ritual_id") REFERENCES "public"."rituals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "boms" ADD CONSTRAINT "boms_city_id_cities_id_fk" FOREIGN KEY ("city_id") REFERENCES "public"."cities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pandit_rituals" ADD CONSTRAINT "pandit_rituals_pandit_id_pandit_profiles_user_id_fk" FOREIGN KEY ("pandit_id") REFERENCES "public"."pandit_profiles"("user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pandit_rituals" ADD CONSTRAINT "pandit_rituals_ritual_id_rituals_id_fk" FOREIGN KEY ("ritual_id") REFERENCES "public"."rituals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ritual_city_prices" ADD CONSTRAINT "ritual_city_prices_ritual_id_rituals_id_fk" FOREIGN KEY ("ritual_id") REFERENCES "public"."rituals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ritual_city_prices" ADD CONSTRAINT "ritual_city_prices_city_id_cities_id_fk" FOREIGN KEY ("city_id") REFERENCES "public"."cities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ritual_translations" ADD CONSTRAINT "ritual_translations_ritual_id_rituals_id_fk" FOREIGN KEY ("ritual_id") REFERENCES "public"."rituals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "muhurat_flags" ADD CONSTRAINT "muhurat_flags_city_id_cities_id_fk" FOREIGN KEY ("city_id") REFERENCES "public"."cities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "muhurat_flags" ADD CONSTRAINT "muhurat_flags_ritual_id_rituals_id_fk" FOREIGN KEY ("ritual_id") REFERENCES "public"."rituals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "muhurat_flags" ADD CONSTRAINT "muhurat_flags_entered_by_users_id_fk" FOREIGN KEY ("entered_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "panchang_days" ADD CONSTRAINT "panchang_days_city_id_cities_id_fk" FOREIGN KEY ("city_id") REFERENCES "public"."cities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "panchang_intervals" ADD CONSTRAINT "panchang_intervals_city_id_cities_id_fk" FOREIGN KEY ("city_id") REFERENCES "public"."cities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "surge_rules" ADD CONSTRAINT "surge_rules_city_id_cities_id_fk" FOREIGN KEY ("city_id") REFERENCES "public"."cities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "surge_rules" ADD CONSTRAINT "surge_rules_ritual_id_rituals_id_fk" FOREIGN KEY ("ritual_id") REFERENCES "public"."rituals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "surge_rules" ADD CONSTRAINT "surge_rules_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "availability" ADD CONSTRAINT "availability_pandit_id_pandit_profiles_user_id_fk" FOREIGN KEY ("pandit_id") REFERENCES "public"."pandit_profiles"("user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slot_defs" ADD CONSTRAINT "slot_defs_city_id_cities_id_fk" FOREIGN KEY ("city_id") REFERENCES "public"."cities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_events" ADD CONSTRAINT "booking_events_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_events" ADD CONSTRAINT "booking_events_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_devotee_id_users_id_fk" FOREIGN KEY ("devotee_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_pandit_id_users_id_fk" FOREIGN KEY ("pandit_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_ritual_id_rituals_id_fk" FOREIGN KEY ("ritual_id") REFERENCES "public"."rituals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_city_id_cities_id_fk" FOREIGN KEY ("city_id") REFERENCES "public"."cities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_address_id_addresses_id_fk" FOREIGN KEY ("address_id") REFERENCES "public"."addresses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_txn_id_ledger_transactions_id_fk" FOREIGN KEY ("txn_id") REFERENCES "public"."ledger_transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_account_id_ledger_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."ledger_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_transactions" ADD CONSTRAINT "ledger_transactions_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_intents" ADD CONSTRAINT "payment_intents_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_intents" ADD CONSTRAINT "payment_intents_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_pandit_id_users_id_fk" FOREIGN KEY ("pandit_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_raised_by_users_id_fk" FOREIGN KEY ("raised_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_resolved_by_users_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promo_redemptions" ADD CONSTRAINT "promo_redemptions_promo_id_promo_codes_id_fk" FOREIGN KEY ("promo_id") REFERENCES "public"."promo_codes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promo_redemptions" ADD CONSTRAINT "promo_redemptions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promo_redemptions" ADD CONSTRAINT "promo_redemptions_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "addresses_user_idx" ON "addresses" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "kyc_pandit_idx" ON "kyc_records" USING btree ("pandit_id","type");--> statement-breakpoint
CREATE INDEX "pandit_kyc_idx" ON "pandit_profiles" USING btree ("kyc_status");--> statement-breakpoint
CREATE INDEX "pandit_geo_idx" ON "pandit_profiles" USING btree ("base_lat","base_lng");--> statement-breakpoint
CREATE INDEX "users_role_idx" ON "users" USING btree ("role");--> statement-breakpoint
CREATE INDEX "bom_items_bom_idx" ON "bom_items" USING btree ("bom_id");--> statement-breakpoint
CREATE INDEX "boms_ritual_idx" ON "boms" USING btree ("ritual_id","status");--> statement-breakpoint
CREATE INDEX "pandit_rituals_ritual_idx" ON "pandit_rituals" USING btree ("ritual_id","active");--> statement-breakpoint
CREATE UNIQUE INDEX "muhurat_flags_uniq" ON "muhurat_flags" USING btree ("city_id","school","date","ritual_id");--> statement-breakpoint
CREATE INDEX "muhurat_flags_lookup" ON "muhurat_flags" USING btree ("city_id","school","ritual_id","date");--> statement-breakpoint
CREATE UNIQUE INDEX "panchang_days_uniq" ON "panchang_days" USING btree ("city_id","school","date");--> statement-breakpoint
CREATE INDEX "panchang_intervals_lookup" ON "panchang_intervals" USING btree ("city_id","school","kind","starts_at","ends_at");--> statement-breakpoint
CREATE UNIQUE INDEX "surge_rules_uniq" ON "surge_rules" USING btree ("city_id","date","ritual_id");--> statement-breakpoint
CREATE UNIQUE INDEX "availability_uniq" ON "availability" USING btree ("pandit_id","date","slot_idx");--> statement-breakpoint
CREATE INDEX "availability_search" ON "availability" USING btree ("date","slot_idx","status");--> statement-breakpoint
CREATE INDEX "availability_starts_idx" ON "availability" USING btree ("starts_at");--> statement-breakpoint
CREATE UNIQUE INDEX "slot_defs_uniq" ON "slot_defs" USING btree ("city_id","idx");--> statement-breakpoint
CREATE INDEX "booking_events_booking_idx" ON "booking_events" USING btree ("booking_id","created_at");--> statement-breakpoint
CREATE INDEX "bookings_devotee_idx" ON "bookings" USING btree ("devotee_id","state");--> statement-breakpoint
CREATE INDEX "bookings_pandit_idx" ON "bookings" USING btree ("pandit_id","state");--> statement-breakpoint
CREATE INDEX "bookings_slot_start_idx" ON "bookings" USING btree ("slot_start_at");--> statement-breakpoint
CREATE INDEX "bookings_state_idx" ON "bookings" USING btree ("state","slot_start_at");--> statement-breakpoint
CREATE UNIQUE INDEX "reviews_uniq" ON "reviews" USING btree ("booking_id","author");--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_accounts_uniq" ON "ledger_accounts" USING btree ("owner_type","owner_id");--> statement-breakpoint
CREATE INDEX "ledger_entries_txn_idx" ON "ledger_entries" USING btree ("txn_id");--> statement-breakpoint
CREATE INDEX "ledger_entries_acct_idx" ON "ledger_entries" USING btree ("account_id","created_at");--> statement-breakpoint
CREATE INDEX "ledger_entries_type_idx" ON "ledger_entries" USING btree ("type","created_at");--> statement-breakpoint
CREATE INDEX "ledger_txn_booking_idx" ON "ledger_transactions" USING btree ("booking_id");--> statement-breakpoint
CREATE INDEX "payment_intents_booking_idx" ON "payment_intents" USING btree ("booking_id");--> statement-breakpoint
CREATE INDEX "payouts_pandit_idx" ON "payouts" USING btree ("pandit_id","period_end");--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_events_uniq" ON "webhook_events" USING btree ("provider","provider_event_id");--> statement-breakpoint
CREATE INDEX "webhook_events_pending" ON "webhook_events" USING btree ("processed_at");--> statement-breakpoint
CREATE INDEX "audit_log_entity_idx" ON "audit_log" USING btree ("entity_type","entity_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_log_actor_idx" ON "audit_log" USING btree ("actor_id","created_at");--> statement-breakpoint
CREATE INDEX "disputes_open_idx" ON "disputes" USING btree ("state","created_at");--> statement-breakpoint
CREATE INDEX "disputes_booking_idx" ON "disputes" USING btree ("booking_id");--> statement-breakpoint
CREATE INDEX "idempotency_expiry_idx" ON "idempotency_keys" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "notification_templates_uniq" ON "notification_templates" USING btree ("key","locale","channel");--> statement-breakpoint
CREATE INDEX "notifications_user_idx" ON "notifications" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "outbox_unpublished" ON "outbox" USING btree ("published_at","id");--> statement-breakpoint
CREATE INDEX "outbox_aggregate" ON "outbox" USING btree ("aggregate_type","aggregate_id");--> statement-breakpoint
CREATE UNIQUE INDEX "processed_events_uniq" ON "processed_events" USING btree ("consumer","event_id");--> statement-breakpoint
CREATE UNIQUE INDEX "promo_redemptions_uniq" ON "promo_redemptions" USING btree ("promo_id","booking_id");--> statement-breakpoint
CREATE INDEX "promo_redemptions_user_idx" ON "promo_redemptions" USING btree ("user_id","promo_id");