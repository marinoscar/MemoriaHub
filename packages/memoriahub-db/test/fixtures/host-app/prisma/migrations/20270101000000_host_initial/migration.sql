-- Fixture host history: the tables the domain migrations reference.
CREATE TABLE "users" ("id" UUID NOT NULL, "email" TEXT NOT NULL, CONSTRAINT "users_pkey" PRIMARY KEY ("id"));
CREATE TABLE "organizations" ("id" UUID NOT NULL, CONSTRAINT "organizations_pkey" PRIMARY KEY ("id"));
CREATE TABLE "groups" ("id" UUID NOT NULL, CONSTRAINT "groups_pkey" PRIMARY KEY ("id"));
CREATE TABLE "storage_objects" ("id" UUID NOT NULL, CONSTRAINT "storage_objects_pkey" PRIMARY KEY ("id"));
CREATE TABLE "worker_nodes" ("id" UUID NOT NULL, CONSTRAINT "worker_nodes_pkey" PRIMARY KEY ("id"));
CREATE TABLE "personal_access_tokens" ("id" UUID NOT NULL, CONSTRAINT "personal_access_tokens_pkey" PRIMARY KEY ("id"));
