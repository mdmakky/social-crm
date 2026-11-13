DROP TRIGGER audit_log_no_update ON audit_log;
--> statement-breakpoint
-- statement-level so the guard also fires when RLS hides every row from the caller
CREATE TRIGGER audit_log_append_only_guard BEFORE UPDATE OR DELETE OR TRUNCATE ON audit_log FOR EACH STATEMENT EXECUTE FUNCTION audit_log_append_only();
