const puppeteer = require('puppeteer-core');

const BROWSERLESS_TOKEN = process.env.BROWSERLESS_TOKEN;

const delay = (min, max) =>
    new Promise(res => setTimeout(res, Math.random() * (max - min) + min));

// mouvement souris simple (compatible browserless)
async function moveMouseHuman(page, x, y) {
    const steps = 10 + Math.floor(Math.random() * 10);

    for (let i = 0; i < steps; i++) {
        await page.mouse.move(
            x + (Math.random() * 5),
            y + (Math.random() * 5)
        );
        await delay(10, 40);
    }
}

export default async function handler(req, res) {
    let browser;

    try {
        console.log("🚀 START");

        if (!BROWSERLESS_TOKEN) {
            throw new Error("Token manquant");
        }

        browser = await puppeteer.connect({
            browserWSEndpoint: `wss://chrome.browserless.io?token=${BROWSERLESS_TOKEN}`
        });

        const page = await browser.newPage();

        // User-Agent réel
        await page.setUserAgent(
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36'
        );

        await page.setViewport({ width: 1280, height: 720 });

        console.log("🌐 GOTO");
        await page.goto('https://tronpick.io/login.php', {
            waitUntil: 'domcontentloaded',
            timeout: 20000
        });

        // petit scroll humain
        await page.evaluate(() => window.scrollBy(0, Math.random() * 200));

        await delay(3000, 7000);

        console.log("🖱 MOVE");
        await moveMouseHuman(page, 640, 615);

        await delay(500, 1500);

        console.log("🖱 CLICK");
        await page.mouse.click(
            640 + Math.random() * 3,
            615 + Math.random() * 3
        );

        await delay(4000, 8000);

        const screenshot = await page.screenshot({
            encoding: 'base64',
            fullPage: true
        });

        await browser.close();

        res.status(200).json({
            success: true,
            screenshot
        });

    } catch (error) {
        console.error("❌ ERROR:", error.message);
        console.error(error.stack);

        if (browser) {
            await browser.close().catch(() => {});
        }

        res.status(500).json({
            success: false,
            error: error.message
        });
    }
}
