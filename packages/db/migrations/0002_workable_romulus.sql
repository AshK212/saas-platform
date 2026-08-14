ALTER TABLE "precheck_receipts" ADD COLUMN "action_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "precheck_receipts" ADD CONSTRAINT "precheck_receipts_workspace_action_id_key" UNIQUE("workspace_id","action_id");--> statement-breakpoint
ALTER TABLE "precheck_receipts" ADD CONSTRAINT "precheck_receipts_action_id_nonempty_check" CHECK (length("precheck_receipts"."action_id") > 0);