CREATE TABLE plugin_private_paperclip_council_270061461e.foundation_probes (
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  issue_id uuid NOT NULL REFERENCES public.issues(id) ON DELETE CASCADE,
  probe_id text NOT NULL,
  version bigint NOT NULL DEFAULT 0 CHECK (version >= 0),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, issue_id, probe_id)
);
