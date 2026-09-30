CREATE TABLE plugin_private_paperclip_council_270061461e.decision_receipts (
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE RESTRICT,
  issue_id uuid NOT NULL REFERENCES public.issues(id) ON DELETE RESTRICT,
  operation_id text NOT NULL CHECK (length(operation_id) BETWEEN 1 AND 128),
  content_sha256 text NOT NULL CHECK (content_sha256 ~ '^[a-f0-9]{64}$'),
  verdict text NOT NULL CHECK (verdict IN ('changes_requested', 'approved')),
  target_url text NOT NULL CHECK (length(target_url) BETWEEN 1 AND 2048),
  request_body jsonb NOT NULL CHECK (jsonb_typeof(request_body) = 'object'),
  actor_agent_id text NOT NULL,
  run_id text NOT NULL,
  attempt_id uuid NOT NULL,
  state text NOT NULL DEFAULT 'indeterminate' CHECK (state IN ('indeterminate', 'native_observed')),
  block_reason text,
  native_status integer CHECK (native_status BETWEEN 100 AND 599),
  native_body jsonb,
  native_observed_at timestamptz,
  human_decisions jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(human_decisions) = 'array'),
  claimed_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, issue_id, operation_id)
);

CREATE UNIQUE INDEX decision_receipts_unresolved_issue_idx
  ON plugin_private_paperclip_council_270061461e.decision_receipts(company_id, issue_id)
  WHERE state = 'indeterminate';

CREATE UNIQUE INDEX decision_receipts_company_operation_idx
  ON plugin_private_paperclip_council_270061461e.decision_receipts(company_id, operation_id);

CREATE INDEX decision_receipts_company_history_idx
  ON plugin_private_paperclip_council_270061461e.decision_receipts(company_id, claimed_at DESC, issue_id, operation_id);
