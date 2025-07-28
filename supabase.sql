-- WARNING: This schema is for context only and is not meant to be run.
-- Table order and constraints may not be valid for execution.

CREATE TABLE IF NOT EXISTS public.emasDB (
  id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  buying_rate numeric,
  date timestamp without time zone,
  sent_to text,
  sent_at timestamp with time zone DEFAULT now(),
  gold_id bigint UNIQUE,
  CONSTRAINT emasDB_pkey PRIMARY KEY (id)
);
