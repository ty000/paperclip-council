CREATE TABLE plugin_private_paperclip_council_270061461e.admission_envelopes (
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  period_key text NOT NULL CHECK (length(btrim(period_key)) BETWEEN 1 AND 200),
  version bigint NOT NULL DEFAULT 1 CHECK (version >= 1),
  document jsonb NOT NULL CHECK (jsonb_typeof(document) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, period_key)
);

CREATE INDEX admission_envelope_updated_idx
  ON plugin_private_paperclip_council_270061461e.admission_envelopes(company_id, updated_at DESC);
