CREATE TYPE "public"."action_category" AS ENUM('llm_call', 'tool_call', 'spend', 'publish', 'other');--> statement-breakpoint
CREATE TYPE "public"."agent_mode" AS ENUM('watch', 'budgeted', 'paused');--> statement-breakpoint
CREATE TYPE "public"."block_source" AS ENUM('plane', 'runtime');--> statement-breakpoint
CREATE TYPE "public"."event_type" AS ENUM('agent.action', 'spend.recorded', 'action.blocked', 'heartbeat');--> statement-breakpoint
CREATE TYPE "public"."membership_role" AS ENUM('operator', 'member');--> statement-breakpoint
CREATE TYPE "public"."precheck_decision" AS ENUM('allow', 'deny');--> statement-breakpoint
CREATE TYPE "public"."session_status" AS ENUM('open', 'closed');--> statement-breakpoint
CREATE TYPE "public"."task_status" AS ENUM('pending', 'running', 'succeeded', 'failed', 'cancelled');--> statement-breakpoint
CREATE TABLE "agent_policies" (
	"workspace_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"mode" "agent_mode" DEFAULT 'watch' NOT NULL,
	"daily_spend_cap_usd" numeric(14, 6),
	"daily_publish_cap" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_policies_pkey" PRIMARY KEY("workspace_id","agent_id"),
	CONSTRAINT "agent_policies_daily_spend_cap_nonnegative_check" CHECK ("agent_policies"."daily_spend_cap_usd" is null or "agent_policies"."daily_spend_cap_usd" >= 0),
	CONSTRAINT "agent_policies_daily_publish_cap_nonnegative_check" CHECK ("agent_policies"."daily_publish_cap" is null or "agent_policies"."daily_publish_cap" >= 0)
);
--> statement-breakpoint
CREATE TABLE "agents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"external_id" text NOT NULL,
	"display_name" text,
	"runtime_profile_id" uuid,
	"last_seen_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agents_workspace_external_id_key" UNIQUE("workspace_id","external_id"),
	CONSTRAINT "agents_workspace_id_id_key" UNIQUE("workspace_id","id"),
	CONSTRAINT "agents_external_id_nonempty_check" CHECK (length("agents"."external_id") > 0)
);
--> statement-breakpoint
CREATE TABLE "api_credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"key_prefix" text NOT NULL,
	"secret_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	CONSTRAINT "api_credentials_key_prefix_key" UNIQUE("key_prefix"),
	CONSTRAINT "api_credentials_secret_hash_key" UNIQUE("secret_hash"),
	CONSTRAINT "api_credentials_name_nonempty_check" CHECK (length("api_credentials"."name") > 0),
	CONSTRAINT "api_credentials_key_prefix_nonempty_check" CHECK (length("api_credentials"."key_prefix") > 0)
);
--> statement-breakpoint
CREATE TABLE "blocks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"external_block_id" text,
	"source" "block_source" NOT NULL,
	"category" "action_category" NOT NULL,
	"rule" text NOT NULL,
	"reason" text NOT NULL,
	"amount_usd" numeric(14, 6),
	"count" integer,
	"precheck_receipt_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "blocks_workspace_id_id_key" UNIQUE("workspace_id","id"),
	CONSTRAINT "blocks_workspace_external_block_id_key" UNIQUE("workspace_id","external_block_id"),
	CONSTRAINT "blocks_rule_nonempty_check" CHECK (length("blocks"."rule") > 0),
	CONSTRAINT "blocks_reason_nonempty_check" CHECK (length("blocks"."reason") > 0),
	CONSTRAINT "blocks_amount_nonnegative_check" CHECK ("blocks"."amount_usd" is null or "blocks"."amount_usd" >= 0),
	CONSTRAINT "blocks_count_nonnegative_check" CHECK ("blocks"."count" is null or "blocks"."count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"event_id" text NOT NULL,
	"agent_id" uuid NOT NULL,
	"type" "event_type" NOT NULL,
	"category" "action_category",
	"payload" jsonb NOT NULL,
	"precheck_receipt_id" uuid,
	"block_id" uuid,
	"occurred_at" timestamp with time zone,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "events_workspace_event_id_key" UNIQUE("workspace_id","event_id"),
	CONSTRAINT "events_event_id_nonempty_check" CHECK (length("events"."event_id") > 0)
);
--> statement-breakpoint
CREATE TABLE "ledger_daily" (
	"workspace_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"day" date NOT NULL,
	"spend_committed_usd" numeric(14, 6) DEFAULT '0' NOT NULL,
	"publish_count_committed" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ledger_daily_pkey" PRIMARY KEY("workspace_id","agent_id","day"),
	CONSTRAINT "ledger_daily_spend_nonnegative_check" CHECK ("ledger_daily"."spend_committed_usd" >= 0),
	CONSTRAINT "ledger_daily_publish_nonnegative_check" CHECK ("ledger_daily"."publish_count_committed" >= 0)
);
--> statement-breakpoint
CREATE TABLE "precheck_receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"category" "action_category" NOT NULL,
	"requested_amount_usd" numeric(14, 6),
	"requested_publish_count" integer,
	"decision" "precheck_decision" NOT NULL,
	"policy_version" bigint NOT NULL,
	"applied_mode" "agent_mode" NOT NULL,
	"applied_spend_cap_usd" numeric(14, 6),
	"applied_publish_cap" integer,
	"accounting_day" date,
	"ledger_spend_before_usd" numeric(14, 6),
	"ledger_publish_before" integer,
	"remaining_spend_usd" numeric(14, 6),
	"remaining_publish_count" integer,
	"deny_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "precheck_receipts_workspace_id_id_key" UNIQUE("workspace_id","id"),
	CONSTRAINT "precheck_receipts_deny_requires_reason_check" CHECK ("precheck_receipts"."decision" <> 'deny' or "precheck_receipts"."deny_reason" is not null),
	CONSTRAINT "precheck_receipts_requested_amount_nonnegative_check" CHECK ("precheck_receipts"."requested_amount_usd" is null or "precheck_receipts"."requested_amount_usd" >= 0),
	CONSTRAINT "precheck_receipts_requested_publish_nonnegative_check" CHECK ("precheck_receipts"."requested_publish_count" is null or "precheck_receipts"."requested_publish_count" >= 0),
	CONSTRAINT "precheck_receipts_ledger_spend_nonnegative_check" CHECK ("precheck_receipts"."ledger_spend_before_usd" is null or "precheck_receipts"."ledger_spend_before_usd" >= 0),
	CONSTRAINT "precheck_receipts_ledger_publish_nonnegative_check" CHECK ("precheck_receipts"."ledger_publish_before" is null or "precheck_receipts"."ledger_publish_before" >= 0),
	CONSTRAINT "precheck_receipts_policy_version_check" CHECK ("precheck_receipts"."policy_version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "runtime_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"adapter_key" text NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "runtime_profiles_workspace_name_key" UNIQUE("workspace_id","name"),
	CONSTRAINT "runtime_profiles_workspace_id_id_key" UNIQUE("workspace_id","id"),
	CONSTRAINT "runtime_profiles_name_nonempty_check" CHECK (length("runtime_profiles"."name") > 0),
	CONSTRAINT "runtime_profiles_adapter_key_nonempty_check" CHECK (length("runtime_profiles"."adapter_key") > 0)
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"runtime_profile_id" uuid,
	"status" "session_status" DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sessions_workspace_id_id_key" UNIQUE("workspace_id","id")
);
--> statement-breakpoint
CREATE TABLE "share_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"token_prefix" text NOT NULL,
	"token_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "share_tokens_token_prefix_key" UNIQUE("token_prefix"),
	CONSTRAINT "share_tokens_token_hash_key" UNIQUE("token_hash"),
	CONSTRAINT "share_tokens_token_prefix_nonempty_check" CHECK (length("share_tokens"."token_prefix") > 0)
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"status" "task_status" DEFAULT 'pending' NOT NULL,
	"instruction" text NOT NULL,
	"input" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_key" UNIQUE("email"),
	CONSTRAINT "users_email_lowercase_check" CHECK ("users"."email" = lower("users"."email")),
	CONSTRAINT "users_email_nonempty_check" CHECK (length("users"."email") > 0)
);
--> statement-breakpoint
CREATE TABLE "workspace_memberships" (
	"workspace_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" "membership_role" DEFAULT 'member' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_memberships_pkey" PRIMARY KEY("workspace_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "workspace_policy_state" (
	"workspace_id" uuid PRIMARY KEY NOT NULL,
	"version" bigint DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_policy_state_version_check" CHECK ("workspace_policy_state"."version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "workspaces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"demo_enabled" boolean DEFAULT false NOT NULL,
	"demo_slug" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspaces_demo_slug_key" UNIQUE("demo_slug"),
	CONSTRAINT "workspaces_name_nonempty_check" CHECK (length("workspaces"."name") > 0),
	CONSTRAINT "workspaces_demo_slug_requires_demo_check" CHECK ("workspaces"."demo_slug" is null or "workspaces"."demo_enabled")
);
--> statement-breakpoint
ALTER TABLE "agent_policies" ADD CONSTRAINT "agent_policies_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_policies" ADD CONSTRAINT "agent_policies_workspace_agent_fkey" FOREIGN KEY ("workspace_id","agent_id") REFERENCES "public"."agents"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_workspace_runtime_profile_fkey" FOREIGN KEY ("workspace_id","runtime_profile_id") REFERENCES "public"."runtime_profiles"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_credentials" ADD CONSTRAINT "api_credentials_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "blocks" ADD CONSTRAINT "blocks_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "blocks" ADD CONSTRAINT "blocks_workspace_agent_fkey" FOREIGN KEY ("workspace_id","agent_id") REFERENCES "public"."agents"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "blocks" ADD CONSTRAINT "blocks_workspace_precheck_receipt_fkey" FOREIGN KEY ("workspace_id","precheck_receipt_id") REFERENCES "public"."precheck_receipts"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_workspace_agent_fkey" FOREIGN KEY ("workspace_id","agent_id") REFERENCES "public"."agents"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_workspace_precheck_receipt_fkey" FOREIGN KEY ("workspace_id","precheck_receipt_id") REFERENCES "public"."precheck_receipts"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_workspace_block_fkey" FOREIGN KEY ("workspace_id","block_id") REFERENCES "public"."blocks"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_daily" ADD CONSTRAINT "ledger_daily_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_daily" ADD CONSTRAINT "ledger_daily_workspace_agent_fkey" FOREIGN KEY ("workspace_id","agent_id") REFERENCES "public"."agents"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "precheck_receipts" ADD CONSTRAINT "precheck_receipts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "precheck_receipts" ADD CONSTRAINT "precheck_receipts_workspace_agent_fkey" FOREIGN KEY ("workspace_id","agent_id") REFERENCES "public"."agents"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runtime_profiles" ADD CONSTRAINT "runtime_profiles_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_workspace_agent_fkey" FOREIGN KEY ("workspace_id","agent_id") REFERENCES "public"."agents"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_workspace_runtime_profile_fkey" FOREIGN KEY ("workspace_id","runtime_profile_id") REFERENCES "public"."runtime_profiles"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "share_tokens" ADD CONSTRAINT "share_tokens_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_workspace_session_fkey" FOREIGN KEY ("workspace_id","session_id") REFERENCES "public"."sessions"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_workspace_agent_fkey" FOREIGN KEY ("workspace_id","agent_id") REFERENCES "public"."agents"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_memberships" ADD CONSTRAINT "workspace_memberships_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_memberships" ADD CONSTRAINT "workspace_memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_policy_state" ADD CONSTRAINT "workspace_policy_state_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agents_workspace_last_seen_idx" ON "agents" USING btree ("workspace_id","last_seen_at");--> statement-breakpoint
CREATE INDEX "api_credentials_workspace_idx" ON "api_credentials" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "blocks_workspace_created_idx" ON "blocks" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "blocks_workspace_precheck_receipt_idx" ON "blocks" USING btree ("workspace_id","precheck_receipt_id") WHERE precheck_receipt_id is not null;--> statement-breakpoint
CREATE INDEX "events_workspace_received_idx" ON "events" USING btree ("workspace_id","received_at");--> statement-breakpoint
CREATE INDEX "events_workspace_agent_received_idx" ON "events" USING btree ("workspace_id","agent_id","received_at");--> statement-breakpoint
CREATE INDEX "precheck_receipts_workspace_agent_created_idx" ON "precheck_receipts" USING btree ("workspace_id","agent_id","created_at");--> statement-breakpoint
CREATE INDEX "sessions_workspace_agent_idx" ON "sessions" USING btree ("workspace_id","agent_id");--> statement-breakpoint
CREATE INDEX "share_tokens_workspace_active_idx" ON "share_tokens" USING btree ("workspace_id") WHERE revoked_at is null;--> statement-breakpoint
CREATE INDEX "tasks_workspace_session_idx" ON "tasks" USING btree ("workspace_id","session_id");--> statement-breakpoint
CREATE INDEX "workspace_memberships_user_idx" ON "workspace_memberships" USING btree ("user_id");