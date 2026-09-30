CREATE TABLE plugin_private_paperclip_council_270061461e.mission_governance (
  company_id uuid NOT NULL,
  mission_id uuid NOT NULL,
  mission_version bigint NOT NULL CHECK (mission_version >= 1),
  mandate_revision bigint NOT NULL CHECK (mandate_revision >= 1),
  version bigint NOT NULL DEFAULT 1 CHECK (version >= 1),
  approach_admitted integer NOT NULL DEFAULT 0 CHECK (approach_admitted >= 0),
  result_admitted integer NOT NULL DEFAULT 0 CHECK (result_admitted >= 0),
  consultation_admitted integer NOT NULL DEFAULT 0 CHECK (consultation_admitted >= 0),
  active_consultation_reservations integer NOT NULL DEFAULT 0 CHECK (active_consultation_reservations >= 0),
  unknown_cost_exposure_refs jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(unknown_cost_exposure_refs) = 'array'),
  aggregate jsonb NOT NULL CHECK (jsonb_typeof(aggregate) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, mission_id),
  FOREIGN KEY (company_id, mission_id)
    REFERENCES plugin_private_paperclip_council_270061461e.missions(company_id, mission_id)
    ON DELETE RESTRICT,
  CHECK ((aggregate->>'schemaVersion')::integer = 1),
  CHECK ((aggregate->>'version')::bigint = version),
  CHECK ((aggregate->>'missionVersion')::bigint = mission_version),
  CHECK ((aggregate->>'mandateRevision')::bigint = mandate_revision),
  CHECK ((aggregate#>>'{counters,approach,admitted}')::integer = approach_admitted),
  CHECK ((aggregate#>>'{counters,result,admitted}')::integer = result_admitted),
  CHECK ((aggregate#>>'{counters,consultation,admitted}')::integer = consultation_admitted),
  CHECK ((aggregate#>>'{counters,consultation,activeReservations}')::integer = active_consultation_reservations),
  CHECK (aggregate#>'{counters,unknownCostExposureRefs}' = unknown_cost_exposure_refs)
);

CREATE INDEX mission_governance_phase_idx
  ON plugin_private_paperclip_council_270061461e.mission_governance(
    company_id,
    (aggregate->>'phase'),
    updated_at DESC
  );

