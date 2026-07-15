import { defineConfig, devices } from "@playwright/test";

const port = 4192;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  // The suite shares one backend and intentionally exercises persistent state.
  // Unbounded local parallelism (57 workers on a large host) overloads public
  // market data and makes otherwise unrelated browser scenarios interfere.
  workers: process.env.CI ? 1 : 4,
  reporter: process.env.CI ? [["html", { open: "never" }], ["line"]] : "line",
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure"
  },
  projects: [
    { name: "chromium", testIgnore: /visual\.spec\.ts/, use: { ...devices["Desktop Chrome"] } },
    { name: "firefox-smoke", testIgnore: /visual\.spec\.ts/, grep: /@smoke/, use: { ...devices["Desktop Firefox"] } },
    { name: "firefox", testIgnore: /visual\.spec\.ts/, use: { ...devices["Desktop Firefox"] } },
    { name: "webkit", testIgnore: /visual\.spec\.ts/, use: { ...devices["Desktop Safari"] } },
    {
      name: "visual",
      testMatch: /visual\.spec\.ts/,
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1440, height: 900 },
        colorScheme: "dark",
        locale: "en-US",
        timezoneId: "UTC",
        reducedMotion: "reduce"
      }
    }
  ],
  snapshotPathTemplate: "{testDir}/__screenshots__/{projectName}/{arg}{ext}",
  webServer: {
    command: `npm run build && PORT=${port} HOST=127.0.0.1 DEMO_MODE=1 AUTH_TOKEN=e2e-local-admin-token npm start`,
    url: `http://127.0.0.1:${port}/api/health`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    stdout: "pipe",
    stderr: "pipe"
  }
});
