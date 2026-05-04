
const { test, expect } = require('@playwright/test');

test('Dashboard loads and navigates', async ({ page }) => {
    await page.goto('http://localhost:3000');
    await expect(page).toHaveTitle(/BookNow/);
    
    // Test navigation
    await page.click('text=Portfolio');
    await expect(page.locator('#view-portfolio')).toBeVisible();
    
    await page.click('text=Scanner');
    await expect(page.locator('#view-home')).toBeVisible();
});
