CREATE TABLE "github_app" (
	"id" uuid PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"app_id" bigint NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"owner_login" text NOT NULL,
	"html_url" text NOT NULL,
	"installation_id" bigint,
	"installed_on" text[] DEFAULT '{}' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "github_app_kind_unique" UNIQUE("kind")
);
