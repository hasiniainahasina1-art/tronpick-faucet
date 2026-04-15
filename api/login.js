// api/login.js
const puppeteer = require('puppeteer-core');

const BROWSERLESS_TOKEN = process.env.BROWSERLESS_TOKEN;
const PROXY_USERNAME = process.env.PROXY_USERNAME || '';
const PROXY_PASSWORD = process.env.PROXY_PASSWORD || '';

// Coordonnées du Turnstile sur la page de login (1280x720)
const TURNSTILE_COORDS = { x: 640, y: 450 };

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Ajoute un point rouge aux coordonnées données
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

// Supprime le point rouge
async function removeRedDot(page) {
    await page.evaluate(() => {
        const dot = document.getElementById('puppeteer-red-dot');
        if (dot) dot.remove();
    });
}

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Méthode non autorisée' });

    if (!BROWSERLESS_TOKEN) {
        return res.status(500).json({ error: 'BROWSERLESS_TOKEN manquant' });
    }

    const { email, password, platform, proxy } = req.body;
    if (!email || !password || !platform) {
        return res.status(400).json({ error: 'Champs manquants' });
    }

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

    let browser;
    const screenshots = {};

    try {
        browser = await puppeteer.connect({
            browserWSEndpoint: `wss://chrome.browserless.io?token=${BROWSERLESS_TOKEN}`
        });
        const page = await browser.newPage();
        if (proxyAuth) await page.authenticate(proxyAuth);
        await page.setViewport({ width: 1280, height: 720 });

        console.log(`🌐 Navigation vers ${loginUrl}`);
        await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });

        // Remplissage
        console.log('⌨️ Remplissage formulaire');
        await page.waitForSelector('input[type="email"], input[name="email"]', { timeout: 5000 });
        await page.click('input[type="email"], input[name="email"]', { clickCount: 3 });
        await page.keyboard.press('Backspace');
        await page.type('input[type="email"], input[name="email"]', email, { delay: 20 });

        await page.waitForSelector('input[type="password"]', { timeout: 5000 });
        await page.click('input[type="password"]', { clickCount: 3 });
        await page.keyboard.press('Backspace');
        await page.type('input[type="password"]', password, { delay: 20 });

        await delay(500);

        // === DESSINER POINT ROUGE ET CAPTURE ===
        await drawRedDot(page, TURNSTILE_COORDS.x, TURNSTILE_COORDS.y);
        screenshots.withRedDot = await page.screenshot({ encoding: 'base64', fullPage: true });
        console.log('📸 Capture avec point rouge sur Turnstile');
        await removeRedDot(page);

        // === CLIQUER SUR LE TURNSTILE ===
        console.log('🖱️ Clic sur Turnstile');
        await page.mouse.click(TURNSTILE_COORDS.x, TURNSTILE_COORDS.y);
        screenshots.afterTurnstileClick = await page.screenshot({ encoding: 'base64', fullPage: true });
        console.log('📸 Capture après clic Turnstile');

        // === ATTENDRE 10 SECONDES ===
        console.log('⏳ Attente de 10 secondes...');
        await delay(10000);
        screenshots.afterWait = await page.screenshot({ encoding: 'base64', fullPage: true });
        console.log('📸 Capture après 10s d\'attente');

        // === CLIQUER SUR "LOG IN" ===
        console.log('🔐 Clic sur "Log in"');
        const loginBtn = await page.waitForXPath("//button[contains(text(), 'Log in')]", { timeout: 5000 });
        await loginBtn.click();

        await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
        await delay(2000);

        const currentUrl = page.url();
        console.log(`📍 URL finale: ${currentUrl}`);

        if (currentUrl.includes('login.php')) {
            screenshots.final = await page.screenshot({ encoding: 'base64', fullPage: true });
            const errorMsg = await page.evaluate(() => {
                const el = document.querySelector('.alert-danger, .error');
                return el ? el.textContent.trim() : null;
            });
            const err = new Error(errorMsg || 'Identifiants invalides ou captcha');
            err.screenshots = screenshots;
            throw err;
        }

        const cookies = await page.cookies();
        console.log(`✅ ${cookies.length} cookies capturés`);
        await browser.close();
        res.status(200).json({ success: true, cookies });

    } catch (error) {
        console.error('❌ Erreur:', error);
        if (browser) {
            try {
                if (!error.screenshots) {
                    const pages = await browser.pages();
                    if (pages.length > 0) {
                        error.screenshots = { ...screenshots, final: await pages[0].screenshot({ encoding: 'base64', fullPage: true }) };
                    }
                }
            } catch (e) {}
            await browser.close();
        }
        res.status(500).json({ error: error.message, screenshots: error.screenshots || screenshots });
    }
        }
