// Builds "begin; <migration body>; <rollback test>" for `supabase db query`.
// The test always raises, so nothing (migration or rows) is committed.
// Usage: node supabase/tests/run-hdfc-sql-test.mjs > out.sql
//        supabase db query --linked --project-ref <ref> -f out.sql   -> expect "HDFC_SQL_TESTS_PASSED"
import fs from "node:fs";
const here = new URL(".", import.meta.url);
const migration = fs.readFileSync(new URL("../migrations/20261118010000_hdfc_persistence.sql", here), "utf8")
  .replace(/^\s*begin;\s*$/m, "").replace(/^\s*commit;\s*$/m, "");
if (/^\s*commit\b/im.test(migration)) throw new Error("migration body must not commit");
const test = fs.readFileSync(new URL("hdfc_persistence_rollback_test.sql", here), "utf8");
process.stdout.write(`begin;\n${migration}\n${test}\nrollback;\n`);
