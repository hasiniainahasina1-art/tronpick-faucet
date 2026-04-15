// api/login.js
const puppeteer = require('puppeteer-core');

const BROWSERLESS_TOKEN = process.env.BROWSERLESS_TOKEN;
const PROXY_USERNAME = process.env.PROXY_USERNAME || '';
const PROXY_PASSWORD = process.env.PROXY_PASSWORD || '';

// Coordonnées exactes du Turnstile (validées)
const TURNSTILE_COORDS = { x: 640, y: 615 };

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function humanScroll(page) {
    console.log('📜 Scroll progressif humain...');
    await page.evaluate(() => {
        const currentY = window.scrollY;
        const targetY = currentY + 300;
        const steps = 15;
        for (let i = 1; i <= steps; i++) {
            const y = currentY + (targetY - currentY) * (i / steps);
            window.scrollTo(0, y);
        }
    });
    await delay(5000); // 5 secondes après le scroll
}

export default async function handler(req, res) {
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

    const screenshots = [];
    let browser;

    try {
        browser = await puppeteer.connect({ browserWSEndpoint: `wss://chrome.browserless.io?token=${BROWSERLESS_TOKEN}` });
        const page = await browser.newPage();
        if (proxyAuth) await page.authenticate(proxyAuth);
        await page.setViewport({ width: 1280, height: 720 });

        console.log(`🌐 Navigation vers ${loginUrl}`);
        await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });

        // Remplissage (rapide)
        console.log('⌨️ Remplissage');
        await page.waitForSelector('input[type="email"], input[name="email"]', { timeout: 5000 });
        await page.click('input[type="email"], input[name="email"]', { clickCount: 3 });
        await page.keyboard.press('Backspace');
        await page.type('input[type="email"], input[name="email"]', email, { delay: 10 });

        await page.waitForSelector('input[type="password"]', { timeout: 5000 });
        await page.click('input[type="password"]', { clickCount: 3 });
        await page.keyboard.press('Backspace');
        await page.type('input[type="password"]', password, { delay: 10 });

        // Attente de 15 secondes avant le scroll
        console.log('⏳ Attente de 15 secondes avant scroll...');
        await delay(15000);
        screenshots.push({ label: '01_apres_remplissage_15s', base64: await page.screenshot({ encoding: 'base64', fullPage: true }) });

        // Scroll humain + 5 secondes d'attente
        await humanScroll(page);
        screenshots.push({ label: '02_apres_scroll', base64: await page.screenshot({ encoding: 'base64', fullPage: true }) });

        // --- PREMIER CLIC TURNSTILE (avec capture) ---
        console.log('🖱️ Premier clic Turnstile');
        await page.mouse.click(TURNSTILE_COORDS.x, TURNSTILE_COORDS.y);
        screenshots.push({ label: '03_apres_premier_clic', base64: await page.screenshot({ encoding: 'base64', fullPage: true }) });

        // Attendre 10 secondes
        console.log('⏳ Attente de 10 secondes...');
        await delay(10000);
        screenshots.push({ label: '04_apres_10s_attente', base64: await page.screenshot({ encoding: 'base64', fullPage: true }) });

        // --- DEUXIÈME CLIC TURNSTILE ---
        console.log('🖱️ Deuxième clic Turnstile');
        await page.mouse.click(TURNSTILE_COORDS.x, TURNSTILE_COORDS.y);
        screenshots.push({ label: '05_apres_deuxieme_clic', base64: await page.screenshot({ encoding: 'base64', fullPage: true }) });

        // Attendre encore 10 secondes
        console.log('⏳ Attente de 10 secondes...');
        await delay(10000);
        screenshots.push({ label: '06_apres_10s_attente_finale', base64: await page.screenshot({ encoding: 'base64', fullPage: true }) });

        // --- CLIQUER SUR "LOG IN" ---
        console.log('🔐 Clic sur "Log in"');
        const loginBtn = await page.waitForXPath("//button[contains(text(), 'Log in')]", { timeout: 5000 });
        await loginBtn.click();

        await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 10000 }).catch(() => {});
        await delay(2000);

        const currentUrl = page.url();
        console.log(`📍 URL finale: ${currentUrl}`);

        if (currentUrl.includes('login.php')) {
            screenshots.push({ label: '07_echec_connexion', base64: await page.screenshot({ encoding: 'base64', fullPage: true }) });
            const errorMsg = await page.evaluate(() => {
                const el = document.querySelector('.alert-danger, .error');
                return el ? el.textContent.trim() : null;
            });
            const err = new Error(errorMsg || 'Échec de connexion');
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
                const pages = await browser.pages();
                if (pages.length > 0) {
                    screenshots.push({ label: '99_crash', base64: await pages[0].screenshot({ encoding: 'base64', fullPage: true }) });
                }
            } catch (e) {}
            await browser.close();
        }
        res.status(500).json({ error: error.message, screenshots });
    }
}
