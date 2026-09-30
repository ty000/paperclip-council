CREATE TABLE plugin_private_paperclip_council_270061461e.roster_revisions (
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  roster_id uuid NOT NULL,
  revision uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('team', 'council')),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  project_id uuid REFERENCES public.projects(id) ON DELETE RESTRICT,
  content jsonb NOT NULL,
  created_by_user_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, roster_id, revision)
);

CREATE TABLE plugin_private_paperclip_council_270061461e.roster_heads (
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  roster_id uuid NOT NULL,
  published_revision uuid NOT NULL,
  lifecycle text NOT NULL DEFAULT 'draft' CHECK (lifecycle IN ('draft', 'active', 'suspended', 'retired')),
  version bigint NOT NULL DEFAULT 1 CHECK (version >= 1),
  audit_entries jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(audit_entries) = 'array'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, roster_id),
  FOREIGN KEY (company_id, roster_id, published_revision)
    REFERENCES plugin_private_paperclip_council_270061461e.roster_revisions(company_id, roster_id, revision)
    ON DELETE RESTRICT
);

CREATE INDEX plugin_private_paperclip_council_270061461e.roster_history_idx
  ON plugin_private_paperclip_council_270061461e.roster_revisions(company_id, roster_id, revision DESC);

CREATE INDEX plugin_private_paperclip_council_270061461e.roster_lifecycle_idx
  ON plugin_private_paperclip_council_270061461e.roster_heads(company_id, lifecycle, updated_at DESC);
