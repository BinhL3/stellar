import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Null means the viewer's own theme.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE projection_projects ADD COLUMN theme_id TEXT`;
});
