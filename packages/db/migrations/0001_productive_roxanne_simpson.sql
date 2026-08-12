CREATE TABLE "auth_magic_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"email" text NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "auth_magic_links_token_hash_key" UNIQUE("token_hash"),
	CONSTRAINT "auth_magic_links_expiry_after_creation_check" CHECK ("auth_magic_links"."expires_at" > "auth_magic_links"."created_at"),
	CONSTRAINT "auth_magic_links_email_lowercase_check" CHECK ("auth_magic_links"."email" = lower("auth_magic_links"."email"))
);
--> statement-breakpoint
CREATE TABLE "auth_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	CONSTRAINT "auth_sessions_token_hash_key" UNIQUE("token_hash"),
	CONSTRAINT "auth_sessions_expiry_after_creation_check" CHECK ("auth_sessions"."expires_at" > "auth_sessions"."created_at")
);
--> statement-breakpoint
ALTER TABLE "auth_magic_links" ADD CONSTRAINT "auth_magic_links_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_sessions" ADD CONSTRAINT "auth_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "auth_magic_links_email_created_idx" ON "auth_magic_links" USING btree ("email","created_at");--> statement-breakpoint
CREATE INDEX "auth_magic_links_user_idx" ON "auth_magic_links" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "auth_sessions_user_idx" ON "auth_sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "auth_sessions_active_idx" ON "auth_sessions" USING btree ("expires_at") WHERE revoked_at is null;