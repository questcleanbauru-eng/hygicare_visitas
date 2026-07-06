import { test, expect } from '@playwright/test';
import { mockBackend, login } from './mock-backend.js';

test.beforeEach(async ({ page }) => {
    const errors = [];
    page.on('pageerror', (err) => errors.push(err.message));
    page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });
    page.__errors = errors;
    await mockBackend(page);
});

test.afterEach(async ({ page }) => {
    expect(page.__errors, 'no console/page errors during the test').toEqual([]);
});

test('login page renders', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#login-form')).toBeVisible();
});

test('login succeeds and shows the dashboard', async ({ page }) => {
    await login(page);
    await expect(page.locator('h2:has-text("Dashboard")')).toBeVisible();
});

test('can navigate to Visitas, Propostas, Funil and Admin', async ({ page }) => {
    await login(page);

    await page.click('#nav-visits');
    await expect(page.locator('h2:has-text("Visitas")')).toBeVisible();

    await page.click('#nav-proposals');
    await expect(page.locator('h2:has-text("Propostas")')).toBeVisible();

    await page.click('#nav-funil');
    await expect(page.locator('h2:has-text("Funil")')).toBeVisible();

    await page.click('#nav-admin');
    await expect(page.locator('.admin-hero-title')).toBeVisible();
});

test('forgot-password link navigates away from login', async ({ page }) => {
    await page.goto('/');
    await page.click('#forgot-password');
    await expect(page.locator('#forgot-form')).toBeVisible();
});
