-- Read-only challenges are separate from mission/effect identities. A new
-- observation never replaces an uncertain Council effect or its command.
CREATE TABLE plugin_private_paperclip_council_270061461e.linear_intake_challenges (
  challenge_id uuid PRIMARY KEY,
  company_id uuid NOT NULL,
  mission_id uuid NOT NULL,
  stage text NOT NULL CHECK (stage IN ('preparation', 'admission')),
  generation integer NOT NULL CHECK (generation BETWEEN 1 AND 128),
  subject_hash text NOT NULL,
  request_hash text NOT NULL,
  request jsonb NOT NULL,
  response jsonb,
  response_hash text,
  observed_at timestamptz,
  last_emitted_at timestamptz,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, mission_id, stage, generation),
  FOREIGN KEY (company_id, mission_id) REFERENCES
    plugin_private_paperclip_council_270061461e.project_task_intakes(company_id, mission_id) ON DELETE RESTRICT
);
