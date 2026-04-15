// api/login.js
const puppeteer = require('puppeteer-core');

const BROWSERLESS_TOKEN = process.env.BROWSERLESS_TOKEN;
const PROXY_USERNAME = process.env.PROXY_USERNAME || '';
const PROXY_PASSWORD = process.env.PROXY_PASSWORD || '';

const TURNSTILE_COORDS = { x: 640, y: 650 };
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function drawRedDot(page, x, y) {
    await page.evaluate((x, y) => {
        const dot = document.createElement('div');
        dot.id = 'puppeteer-red-dot';
        dot.style.position = 'fixed';
        dot.style.left = (x - 6) + 'px';
        dot.style.top = (y - 6) + 'px';
        dot.style.width = '12px';
        dot.style.height = '12px';
        dot.style.backgroundColor = 'red';
        dot.style.border = '2px solid darkred';
        dot.style.borderRadius = '50%';
        dot.style.zIndex = '999999';
        document.body.appendChild(dot);
    }, x, y);
}

async function removeRedDot(page) {
    await page.evaluate(() => {
        const dot = document.getElementById('puppeteer-red-dot');
        if (dot) dot.remove();
    });
}

export default async function handler(req, res) {
    // CORS + méthode
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Méthode non autorisée' });

    if (!BROWSERLESS_TOKEN) return res.status(500).json({ error: 'BROWSERLESS_TOKEN manquant' });

    const { email, password, platform, proxy } = req.body;
    if (!email || !password || !platform) return res.status(400).json({ error: 'Champs manquants' });

    const siteUrls = {
        tronpick: 'https://tronpick.io/login.php',
        litepick: 'https://litepick.io/login.php',
        dogepick: 'https://dogepick.io/login.php',
        solpick: 'https://solpick.io/login.php',
        binpick: 'https://binpick.io/login.php'
    };
    const loginUrl = siteUrls[platform];
    if (!loginUrl) return res.status(400).json({ error: 'Plateforme inconnue' });

    let proxyAuth = null;
    if (proxy) {
        const parts = proxy.split(':');
        if (parts.length === 4) proxyAuth = { username: parts[2], password: parts[3] };
    } else if (PROXY_USERNAME) {
        proxyAuth = { username: PROXY_USERNAME, password: PROXY_PASSWORD };
    }

    const screenshots = []; // tableau d'objets { label, base64 }

    let browser;
    try {
        browser = await puppeteer.connect({ browserWSEndpoint: `wss://chrome.browserless.io?token=${BROWSERLESS_TOKEN}` });
        const page = await browser.newPage();
        if (proxyAuth) await page.authenticate(proxyAuth);
        await page.setViewport({ width: 1280, height: 720 });

        await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });

        // Remplissage
        await page.waitForSelector('input[type="email"], input[name="email"]', { timeout: 5000 });
        await page.click('input[type="email"], input[name="email"]', { clickCount: 3 });
        await page.keyboard.press('Backspace');
        await page.type('input[type="email"], input[name="email"]', email, { delay: 20 });

        await page.waitForSelector('input[type="password"]', { timeout: 5000 });
        await page.click('input[type="password"]', { clickCount: 3 });
        await page.keyboard.press('Backspace');
        await page.type('input[type="password"]', password, { delay: 20 });

        await delay(500);

        // 1. Dessiner point rouge et capture
        await drawRedDot(page, TURNSTILE_COORDS.x, TURNSTILE_COORDS.y);
        screenshots.push({
            label: 'withRedDot',
            base64: await page.screenshot({ encoding: 'base64', fullPage: true })
        });

        // 2. Clic Turnstile et capture (point encore présent)
        await page.mouse.click(TURNSTILE_COORDS.x, TURNSTILE_COORDS.y);
        await delay(500);
        screenshots.push({
            label: 'afterTurnstileClick',
            base64: await page.screenshot({ encoding: 'base64', fullPage: true })
        });

        // 3. Supprimer le point
        await removeRedDot(page);

        // 4. Attendre 10s et capture
        await delay(10000);
        screenshots.push({
            label: 'afterWait',
            base64: await page.screenshot({ encoding: 'base64', fullPage: true })
        });

        // 5. Clic "Log in"
        const loginBtn = await page.waitForXPath("//button[contains(text(), 'Log in')]", { timeout: 5000 });
        await loginBtn.click();
        await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
        await delay(2000);

        const currentUrl = page.url();
        if (currentUrl.includes('login.php')) {
            screenshots.push({
                label: 'final',
                base64: await page.screenshot({ encoding: 'base64', fullPage: true })
            });
            const errorMsg = await page.evaluate(() => {
                const el = document.querySelector('.alert-danger, .error');
                return el ? el.textContent.trim() : null;
            });
            const err = new Error(errorMsg || 'Identifiants invalides ou captcha');
            err.screenshots = screenshots;
            throw err;
        }

        const cookies = await page.cookies();
        await browser.close();
        res.status(200).json({ success: true, cookies });

    } catch (error) {
        console.error('❌ Erreur:', error);
        if (browser) {
            try {
                const pages = await browser.pages();
                if (pages.length > 0 && !error.screenshots) {
                    screenshots.push({
                        label: 'final_error',
                        base64: await pages[0].screenshot({ encoding: 'base64', fullPage: true })
                    });
                }
            } catch (e) {}
            await browser.close();
        }
        res.status(500).json({ error: error.message, screenshots });
    }
}
