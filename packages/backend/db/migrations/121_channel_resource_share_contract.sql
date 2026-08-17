-- Simplify channel authority: linking a resource is the explicit share grant.
-- The linker must already be authorized and be a channel owner/admin; recipients
-- do not also need duplicate Project membership. Revocation stops future access.
COMMENT ON TABLE channel_resource_links IS
  'Explicit resource shares for a people-centered channel. Active links grant current and future channel participants and invited Agents the declared discover/read/write capability; link creation remains restricted to an authorized channel manager.';
