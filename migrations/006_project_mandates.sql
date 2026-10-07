CREATE TABLE plugin_private_paperclip_council_270061461e.project_mandates (
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE RESTRICT,
  version bigint NOT NULL CHECK (version >= 1),
  revision_id uuid NOT NULL UNIQUE,
  command_id uuid NOT NULL,
  payload_hash text NOT NULL,
  authorized_by text NOT NULL,
  content jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, project_id, version),
  UNIQUE (company_id, project_id, command_id)
);

CREATE TABLE plugin_private_paperclip_council_270061461e.project_task_intakes (
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  root_issue_id uuid NOT NULL REFERENCES public.issues(id) ON DELETE RESTRICT,
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE RESTRICT,
  policy_revision_id uuid NOT NULL REFERENCES plugin_private_paperclip_council_270061461e.project_mandates(revision_id) ON DELETE RESTRICT,
  mission_id uuid NOT NULL,
  version bigint NOT NULL DEFAULT 1 CHECK (version >= 1),
  state jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, root_issue_id),
  UNIQUE (company_id, mission_id)
);
