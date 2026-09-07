import type { NextConfig } from "next";

/**
 * Next.js reports anonymous usage statistics by default.
 *
 * `README.md` and `SECURITY.md` both promise an Instance runs with no outbound network,
 * so that it can be hosted where the data must not leave. A framework phoning home would
 * make that false — quietly, and in a way an operator could not see without watching
 * their own egress.
 *
 * Set here as well as in the npm scripts because the two fail differently: the scripts
 * cover `npm run build` and `npm start`, and this covers anything that loads the config
 * by another route. `??=` so an operator who has set it themselves is not overridden.
 */
process.env["NEXT_TELEMETRY_DISABLED"] ??= "1";

const nextConfig: NextConfig = {
  // The service layer is Node-only — it opens database connections — so nothing here
  // may be bundled for the edge runtime.
  serverExternalPackages: ["@electric-sql/pglite", "postgres", "drizzle-orm"],
  poweredByHeader: false,
};

export default nextConfig;
