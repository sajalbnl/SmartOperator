import { Pool } from "pg";
import { requireEnv } from "../scripts/env.js";

export const db = new Pool({
  connectionString: requireEnv("DATABASE_URL"),
});

