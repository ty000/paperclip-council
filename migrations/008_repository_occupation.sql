CREATE TABLE plugin_private_paperclip_council_270061461e.repository_occupation (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  version bigint NOT NULL DEFAULT 1 CHECK (version >= 1),
  document jsonb NOT NULL CHECK (jsonb_typeof(document) = 'object')
);

INSERT INTO plugin_private_paperclip_council_270061461e.repository_occupation (document)
VALUES ('{"initialized":false,"holders":{}}'::jsonb);
