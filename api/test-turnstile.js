const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');

puppeteer.use(StealthPlugin());

const delay = (min, max) => 
  new Promise(res => setTimeout(res, Math.random() * (max - min) + min));

// Mouvement souris humain
async function moveMouseHuman(page, x, y) {
    const steps = 20 + Math.floor(Math.random() * 15);
    const start = await page.mouse._client.send('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: Math.random() * 300,
        y: Math.random() * 300
    });

    for (let i = 0; i < steps; i++) {
        await page.mouse.move(
            x + (Math.random() * 5),
            y + (Math.random() * 5)
        );
        await delay(10, 50);
    }
}

module.exports = async (req, res) => {
    let browser;

    try {
        browser = await puppeteer.connect({
            browserWSEndpoint: `wss://chrome.browserless.io?token=${process.env.BROWSERLESS_TOKEN}`
        });

        const page = await browser.newPage();

        // 🎭 User-Agent réaliste
        await page.setUserAgent(
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36'
        );

        await page.setViewport({ width: 1280, height: 720 });

        console.log('🌐 Chargement...');
        await page.goto('https://tronpick.io/login.php', { waitUntil: 'networkidle2' });

        // Scroll humain
        await page.evaluate(() => {
            window.scrollBy(0, Math.random() * 300);
        });

        await delay(3000, 7000);

        console.log('🖱️ Mouvement vers Turnstile...');
        await moveMouseHuman(page, 640, 615);

        await delay(500, 1500);

        console.log('🖱️ Clic humain...');
        await page.mouse.click(
            640 + (Math.random() * 3),
            615 + (Math.random() * 3)
        );

        await delay(4000, 9000);

        console.log('🔁 Deuxième interaction...');
        await moveMouseHuman(page, 640, 615);

        await delay(500, 1500);

        await page.mouse.click(
            640 + (Math.random() * 3),
            615 + (Math.random() * 3)
        );

        const screenshot = await page.screenshot({ encoding: 'base64' });

        await browser.close();

        res.json({ success: true, screenshot });

    } catch (e) {
        if (browser) await browser.close();
        res.status(500).json({ error: e.message });
    }
};
