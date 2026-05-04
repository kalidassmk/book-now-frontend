const { test, expect } = require('@playwright/test');

/**
 * Portfolio Page & Navigation Test Suite
 */
test.describe('Portfolio & Navigation', () => {
    
    test.beforeEach(async ({ page }) => {
        // Go to the dashboard
        await page.goto('http://localhost:3000');
        // Wait for the page to load (checking for title)
        await expect(page).toHaveTitle(/BookNow/i);
    });

    test('should switch to Portfolio page and show live data', async ({ page }) => {
        // 1. Click Portfolio navigation button
        await page.click('button:has-text("Portfolio")');
        
        // 2. Verify URL has portfolio hash
        await expect(page).toHaveURL('http://localhost:3000/#/portfolio');

        // 3. Verify Portfolio container is visible
        const portfolio = page.locator('#view-portfolio');
        const display = await portfolio.evaluate(el => getComputedStyle(el).display);
        expect(display).toBe('flex');

        // 3.5. Verify home is hidden
        const home = page.locator('#view-home');
        const homeDisplay = await home.evaluate(el => getComputedStyle(el).display);
        expect(homeDisplay).toBe('none');

        // 4. Verify opacity is 1 (checking the fix for the previous bug)
        const opacity = await portfolio.evaluate(el => getComputedStyle(el).opacity);
        expect(parseFloat(opacity)).toBeGreaterThan(0.9);

        // 5. Check for 'Live Balances' card
        await expect(page.locator('text=Live Balances')).toBeVisible();
        
        // 6. Check for 'Open Orders' card
        await expect(page.locator('text=Portfolio Open Orders')).toBeVisible();
    });

    test('should switch back to Scanner page', async ({ page }) => {
        // Go to portfolio first
        await page.click('button:has-text("Portfolio")');
        
        // Go back to scanner
        await page.click('button:has-text("Scanner")');
        
        // Verify Scanner container is visible
        await expect(page.locator('#view-home')).toBeVisible();
        
        // Verify Portfolio container is hidden
        await expect(page.locator('#view-portfolio')).toBeHidden();
    });

    test('should show connection status correctly', async ({ page }) => {
        const liveLabel = page.locator('#live-label');
        // It might be 'Connecting' initially, so we wait for 'Live'
        await expect(liveLabel).toHaveText(/Live|Connecting/);
    });
});
