import { defineConfig, devices } from "@playwright/test";

const port = 4193;

export default defineConfig({
  testDir: "./e2e",
  testMatch: /r33-onboarding\.spec\.ts/u,
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  workers: 1,
  reporter: "line",
  use: {
    ...devices["Desktop Chrome"],
    baseURL: `http://127.0.0.1:${port}`,
    locale: "en-US",
    timezoneId: "UTC",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    launchOptions: {
      args: ["--host-resolver-rules=MAP saltanat-r33.test 127.0.0.1"]
    }
  },
  projects: [{ name: "r33-chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `npm run build && RUNTIME_PROFILE=public-http-paper AUTH_MODE=legacy DEMO_MODE=1 AUTH_TOKEN=r33-isolated-token PORT=${port} HOST=127.0.0.1 npm start`,
    url: `http://127.0.0.1:${port}/api/health`,
    reuseExistingServer: false,
    timeout: 180_000,
    stdout: "pipe",
    stderr: "pipe"
  }
});
