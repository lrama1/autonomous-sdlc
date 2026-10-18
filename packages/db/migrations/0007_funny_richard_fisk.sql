CREATE TABLE "doc_snapshot" (
	"id" uuid PRIMARY KEY NOT NULL,
	"integration_id" uuid NOT NULL,
	"url" text NOT NULL,
	"sha256" text NOT NULL,
	"content" text,
	"error" text,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "integration_entry" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"kind" text DEFAULT 'third_party' NOT NULL,
	"owner" text,
	"initiative_id" uuid,
	"docs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"hosts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"auth_type" text DEFAULT 'none' NOT NULL,
	"credential_ref" text,
	"data_sent" text,
	"data_received" text,
	"test_strategy" text DEFAULT 'none' NOT NULL,
	"limits_and_cost" text,
	"terms" text,
	"failure_behavior" text,
	"status" text DEFAULT 'proposed' NOT NULL,
	"proposed_by" text,
	"confirmed_by" uuid,
	"confirmed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "integration_entry_name_unique" UNIQUE("name")
);
--> statement-breakpoint
ALTER TABLE "doc_snapshot" ADD CONSTRAINT "doc_snapshot_integration_id_integration_entry_id_fk" FOREIGN KEY ("integration_id") REFERENCES "public"."integration_entry"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_entry" ADD CONSTRAINT "integration_entry_initiative_id_initiative_id_fk" FOREIGN KEY ("initiative_id") REFERENCES "public"."initiative"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_entry" ADD CONSTRAINT "integration_entry_confirmed_by_person_id_fk" FOREIGN KEY ("confirmed_by") REFERENCES "public"."person"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "doc_snapshot_integration_idx" ON "doc_snapshot" USING btree ("integration_id","url","fetched_at");