ALTER TABLE "build_task" ADD COLUMN "history" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "build_task" ADD COLUMN "guidance" text;--> statement-breakpoint
ALTER TABLE "build_task" ADD COLUMN "ask_id" uuid;