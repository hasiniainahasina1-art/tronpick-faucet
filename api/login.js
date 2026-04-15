// api/login.js
const puppeteer = require('puppeteer-core');

const BROWSERLESS_TOKEN = process.env.BROWSERLESS_TOKEN;
const PROXY_USERNAME = process.env.PROXY_USERNAME || '';
const PROXY_PASSWORD = process.env.PROXY_PASSWORD || '';

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

export default async function handler(req, res) {
    // CORS
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

    let browser;
    try {
        // Connexion à Browserless
        browser = await puppeteer.connect({ browserWSEndpoint: `wss://chrome.browserless.io?token=${BROWSERLESS_TOKEN}` });
        const page = await browser.newPage();
        if (proxyAuth) await page.authenticate(proxyAuth);
        await page.setViewport({ width: 1280, height: 720 });

        console.log(`🌐 Navigation vers ${loginUrl}`);
        await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });

        // Remplissage formulaire (identique à script.js)
        console.log('⌨️ Remplissage');
        await page.waitForSelector('input[type="email"], input[name="email"]', { timeout: 5000 });
        await page.click('input[type="email"], input[name="email"]', { clickCount: 3 });
        await page.keyboard.press('Backspace');
        await page.type('input[type="email"], input[name="email"]', email, { delay: 10 });

        await page.waitForSelector('input[type="password"]', { timeout: 5000 });
        await page.click('input[type="password"]', { clickCount: 3 });
        await page.keyboard.press('Backspace');
        await page.type('input[type="password"]', password, { delay: 10 });

        // --- GESTION TURNSTILE (exactement comme dans script.js) ---
        console.log('🛡️ Recherche iframe Turnstile...');
        const frame = await page.waitForFrame(
            f => f.url().includes('challenges.cloudflare.com/turnstile'),
            { timeout: 8000 }
        ).catch(() => null);

        if (frame) {
            console.log('✅ Iframe trouvée, clic checkbox');
            await frame.click('input[type="checkbox"]');
            await delay(5000); // Attente validation (comme script.js)
        } else {
            console.log('⚠️ Iframe non trouvée, fallback coordonné (640,615)');
            await page.mouse.click(640, 615);
            await delay(5000);
        }

        // Clic sur "Log in"
        console.log('🔐 Clic sur "Log in"');
        const loginBtn = await page.waitForXPath("//button[contains(text(), 'Log in')]", { timeout: 5000 });
        await loginBtn.click();

        await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 10000 }).catch(() => {});
        await delay(2000);

        const currentUrl = page.url();
        console.log(`📍 URL finale: ${currentUrl}`);

        if (currentUrl.includes('login.php')) {
            // ÉCHEC : capture d'écran garantie
            const screenshot = await page.screenshot({ encoding: 'base64', fullPage: true });
            const errorMsg = await page.evaluate(() => {
                const el = document.querySelector('.alert-danger, .error, .message-error');
                return el ? el.textContent.trim() : null;
            });
            const err = new Error(errorMsg || 'Échec de connexion');
            err.screenshot = screenshot; // Attacher la capture
            console.log('📸 Capture attachée à l\'erreur');
            throw err;
        }

        // SUCCÈS
        const cookies = await page.cookies();
        await browser.close();
        res.status(200).json({ success: true, cookies });

    } catch (error) {
        console.error('❌ Erreur:', error);
        // Si l'erreur n'a pas encore de capture, essayer d'en prendre une
        if (browser && !error.screenshot) {
            try {
                const pages = await browser.pages();
                if (pages.length > 0) {
                    error.screenshot = await pages[0].screenshot({ encoding: 'base64', fullPage: true });
                    console.log('📸 Capture de secours ajoutée');
                }
            } catch (e) {
                console.error('Impossible de prendre une capture de secours:', e);
            }
        }
        if (browser) await browser.close().catch(() => {});
        // Renvoyer TOUJOURS la capture si elle existe
        const response = { error: error.message };
        if (error.screenshot) response.screenshot = error.screenshot;
        res.status(500).json(response);
    }
}
