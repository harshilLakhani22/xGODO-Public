import { chromium, request } from 'playwright';

async function run() {
    console.log('--- Starting Automation Script ---');

    // 1. Launch Browser
    const browser = await chromium.launch({ headless: false }); // Headless: false to see the browser
    const context = await browser.newContext();
    const page = await context.newPage();

    try {
        // 2. Visit Public Page
        console.log('Navigating to example.com...');
        await page.goto('https://example.com'); // Evgenii Rofe : your public page

        // 3. Extract Data Points
        const title = await page.title();
        const h1Text = await page.textContent('h1');
        console.log(`Page Title: ${title}`);
        console.log(`H1 Text: ${h1Text}`);

        // 4. Interact with App (Click Link)
        console.log('Clicking "More information..." link...');
        // The link on example.com is "More information..."
        await Promise.all([
            page.waitForLoadState('load'), // Wait for navigation to complete
            page.click('a')
        ]);

        console.log(`New URL: ${page.url()}`);

        // 5. Use API Endpoints
        console.log('\n--- API Interaction ---');
        const apiContext = await request.newContext({
            baseURL: 'https://jsonplaceholder.typicode.com'
        });

        const response = await apiContext.get('/todos/1');
        if (response.ok()) {
            const data = await response.json();
            console.log('API Response:', data);
        } else {
            console.error(`API Error: ${response.status()} ${response.statusText()}`);
        }

    } catch (error) {
        console.error('An error occurred:', error);
    } finally {
        // 6. Cleanup
        await browser.close();
        console.log('\n--- Script Finished ---');
    }
}

run();
