-- One WhatsApp conversation per person.
--
-- WhatsApp delivers each message as its own HTTP request, so nothing in this process
-- is holding a session between them. The history lives here instead, keyed by the
-- phone number the message arrived from.
CREATE TABLE IF NOT EXISTS assistant_conversations (
  phone         text PRIMARY KEY,
  user_id       text REFERENCES users(id),
  -- Anthropic MessageParam[]. Stored whole because a tool_use block and its
  -- tool_result must travel together — splitting them into rows would let a partial
  -- write produce a history the API rejects.
  history       jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- Rolled over rather than grown forever: a year of chat would eventually cost more
  -- to send than the answer is worth, and nobody needs March in October.
  turns         integer NOT NULL DEFAULT 0,
  last_at       timestamptz NOT NULL DEFAULT now(),
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- Inbound messages, for idempotency and for reading what actually happened.
--
-- BSPs retry, so the same message id can arrive several times. Without this a retry
-- would re-run the agent, and an agent that creates bookings must not run twice on
-- one message.
CREATE TABLE IF NOT EXISTS assistant_inbound (
  provider_message_id text PRIMARY KEY,
  phone               text NOT NULL,
  body                text NOT NULL,
  received_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS assistant_inbound_phone_idx
  ON assistant_inbound (phone, received_at DESC);
