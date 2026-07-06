import { defineConfig } from '@playwright/test';

export default defineConfig({
    testDir: './tests',
    fullyParallel: true,
    reporter: 'list',
    use: {
        baseURL: 'http://localhost:5173',
        screenshot: 'only-on-failure'
    },
    webServer: {
        command: 'node build.js --serve',
        url: 'http://localhost:5173',
        reuseExistingServer: !process.env.CI,
        timeout: 30000
    }
});
