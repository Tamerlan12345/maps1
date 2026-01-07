
import asyncio
from playwright.async_api import async_playwright, expect

async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        page = await browser.new_page()

        # First, go to the page to establish a context for localStorage
        await page.goto("http://localhost:8080")

        # Bypass login by setting auth state directly in localStorage
        await page.evaluate("""() => {
            localStorage.setItem('authState', '1');
            localStorage.setItem('userRole', 'admin');
        }""")

        # Reload the page so the application can recognize the new auth state
        await page.reload()

        # Wait for the map container and the first map tile to be visible
        await expect(page.locator("#map")).to_be_visible()
        await expect(page.locator(".leaflet-tile-loaded").first).to_be_visible()

        # Take a screenshot for verification
        await page.screenshot(path="verification.png")
        await browser.close()

if __name__ == '__main__':
    asyncio.run(main())
