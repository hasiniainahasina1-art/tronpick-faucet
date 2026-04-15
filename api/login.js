// api/login.js
const puppeteer = require('puppeteer-core');

const BROWSERLESS_TOKEN = process.env.BROWSERLESS_TOKEN;
const PROXY_USERNAME = process.env.PROXY_USERNAME || '';
const PROXY_PASSWORD = process.env.PROXY_PASSWORD || '';

// Coordonnées du Turnstile sur la page de login (1280x720)
const LOGIN_TURNSTILE_COORDS = { x: 640, y: 450 };

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

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

        // === CAPTURE AVANT PREMIER CLIC ===
        const screenshotBefore = await page.screenshot({ encoding: 'base64', fullPage: true });
        console.log('📸 Capture AVANT premier clic prise');

        // Premier clic
        console.log('🛡️ Premier clic Turnstile');
        await page.mouse.click(LOGIN_TURNSTILE_COORDS.x, LOGIN_TURNSTILE_COORDS.y);
        await delay(2000); // Laisser le widget réagir

        // === CAPTURE APRÈS PREMIER CLIC ===
        const screenshotAfterFirst = await page.screenshot({ encoding: 'base64', fullPage: true });
        console.log('📸 Capture APRÈS premier clic prise');

        // Attendre 8 secondes au total depuis le premier clic (déjà attendu 2s)
        await delay(6000);

        // Deuxième clic
        console.log('🛡️ Second clic Turnstile');
        await page.mouse.click(LOGIN_TURNSTILE_COORDS.x, LOGIN_TURNSTILE_COORDS.y);

        // Attendre génération token
        console.log('⏳ Attente token Turnstile...');
        await page.waitForFunction(
            () => {
                const inp = document.querySelector('[name="cf-turnstile-response"]');
                return inp && inp.value.length > 10;
            },
            { timeout: 8000 }
        ).catch(() => console.log('⚠️ Token non généré, on continue'));

        await delay(1000);

        // Clic "Log in"
        console.log('🔐 Clic sur Log in');
        const btn = await page.waitForXPath("//button[contains(text(), 'Log in')]", { timeout: 5000 });
        await btn.click();

        await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
        await delay(2000);

        const currentUrl = page.url();
        console.log(`📍 URL finale: ${currentUrl}`);

        if (currentUrl.includes('login.php')) {
            const screenshotFinal = await page.screenshot({ encoding: 'base64', fullPage: true });
            const errorMsg = await page.evaluate(() => {
                const el = document.querySelector('.alert-danger, .error');
                return el ? el.textContent.trim() : null;
            });
            const err = new Error(errorMsg || 'Identifiants invalides ou captcha');
            err.screenshots = {
                beforeFirstClick: screenshotBefore,
                afterFirstClick: screenshotAfterFirst,
                final: screenshotFinal
            };
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
                        error.screenshots = { final: await pages[0].screenshot({ encoding: 'base64', fullPage: true }) };
                    }
                }
            } catch (e) {}
            await browser.close();
        }
        // Envoyer les captures dans la réponse d'erreur
        res.status(500).json({
            error: error.message,
            screenshots: error.screenshots || null
        });
    }
}
