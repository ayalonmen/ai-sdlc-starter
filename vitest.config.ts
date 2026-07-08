import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The test agent writes files here, named <thing>.test.ts.
    include: ["test/**/*.test.ts"],
    environment: "node",
  },
});
