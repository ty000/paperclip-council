CREATE TABLE plugin_private_paperclip_council_270061461e.missions (
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  mission_id uuid NOT NULL,
  root_issue_id uuid NOT NULL REFERENCES public.issues(id) ON DELETE RESTRICT,
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE RESTRICT,
  owner_user_id text NOT NULL,
  team_roster_id uuid NOT NULL,
  team_revision uuid NOT NULL,
  council_roster_id uuid NOT NULL,
  council_revision uuid NOT NULL,
  version bigint NOT NULL DEFAULT 1 CHECK (version >= 1),
  aggregate jsonb NOT NULL CHECK (jsonb_typeof(aggregate) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, mission_id),
  UNIQUE (company_id, root_issue_id),
  FOREIGN KEY (company_id, team_roster_id, team_revision)
    REFERENCES plugin_private_paperclip_council_270061461e.roster_revisions(company_id, roster_id, revision)
    ON DELETE RESTRICT,
  FOREIGN KEY (company_id, council_roster_id, council_revision)
    REFERENCES plugin_private_paperclip_council_270061461e.roster_revisions(company_id, roster_id, revision)
    ON DELETE RESTRICT
);

CREATE INDEX mission_project_idx
  ON plugin_private_paperclip_council_270061461e.missions(company_id, project_id, updated_at DESC);

CREATE INDEX mission_roster_revision_idx
  ON plugin_private_paperclip_council_270061461e.missions(
    company_id, team_roster_id, team_revision, council_roster_id, council_revision
  );
