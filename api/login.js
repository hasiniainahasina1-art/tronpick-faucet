// api/login.js
const puppeteer = require('puppeteer-core');

const BROWSERLESS_TOKEN = process.env.BROWSERLESS_TOKEN;
const PROXY_USERNAME = process.env.PROXY_USERNAME || '';
const PROXY_PASSWORD = process.env.PROXY_PASSWORD || '';

// Coordonnées de secours (si l'iframe n'est pas trouvée)
const TURNSTILE_COORDS = { x: 640, y: 615 };

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

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

        // Capture après remplissage
        screenshots.push({ label: 'after_fill', base64: await page.screenshot({ encoding: 'base64', fullPage: true }) });

        // --- GESTION TURNSTILE ---
        console.log('🛡️ Recherche de l\'iframe Turnstile...');
        const turnstileFrame = page.frames().find(f => f.url().includes('challenges.cloudflare.com/turnstile'));
        
        if (turnstileFrame) {
            console.log('✅ Iframe Turnstile trouvée, double clic dans l\'iframe');
            
            // Premier clic
            await turnstileFrame.click('input[type="checkbox"]');
            console.log('   Premier clic effectué');
            await delay(8000);
            screenshots.push({ label: 'after_first_iframe_click', base64: await page.screenshot({ encoding: 'base64', fullPage: true }) });
            
            // Deuxième clic
            await turnstileFrame.click('input[type="checkbox"]');
            console.log('   Second clic effectué');
            await delay(8000);
            screenshots.push({ label: 'after_second_iframe_click', base64: await page.screenshot({ encoding: 'base64', fullPage: true }) });
        } else {
            console.log('⚠️ Iframe non trouvée, fallback coordonnées');
            
            // Fallback coordonné
            await page.mouse.click(TURNSTILE_COORDS.x, TURNSTILE_COORDS.y);
            await delay(8000);
            screenshots.push({ label: 'after_first_coord_click', base64: await page.screenshot({ encoding: 'base64', fullPage: true }) });
            
            await page.mouse.click(TURNSTILE_COORDS.x, TURNSTILE_COORDS.y);
            await delay(8000);
            screenshots.push({ label: 'after_second_coord_click', base64: await page.screenshot({ encoding: 'base64', fullPage: true }) });
        }

        // Attendre token
        console.log('⏳ Attente token Turnstile...');
        await page.waitForFunction(
            () => {
                const inp = document.querySelector('[name="cf-turnstile-response"]');
                return inp && inp.value.length > 10;
            },
            { timeout: 8000 }
        ).catch(() => console.log('⚠️ Token non généré'));

        // Clic "Log in"
        console.log('🔐 Clic sur "Log in"');
        const loginBtn = await page.waitForXPath("//button[contains(text(), 'Log in')]", { timeout: 5000 });
        await loginBtn.click();

        await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
        await delay(2000);

        const currentUrl = page.url();
        console.log(`📍 URL finale: ${currentUrl}`);

        if (currentUrl.includes('login.php')) {
            screenshots.push({ label: 'login_failed', base64: await page.screenshot({ encoding: 'base64', fullPage: true }) });
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
                const pages = await browser.pages();
                if (pages.length > 0) {
                    screenshots.push({ label: 'crash', base64: await pages[0].screenshot({ encoding: 'base64', fullPage: true }) });
                }
            } catch (e) {}
            await browser.close();
        }
        // S'assurer que screenshots est toujours présent
        const response = { error: error.message };
        if (error.screenshots) response.screenshots = error.screenshots;
        else if (screenshots.length) response.screenshots = screenshots;
        res.status(500).json(response);
    }
}
