// api/login.js
const puppeteer = require('puppeteer-core');

const DEFAULT_PROXY_HOST = '31.59.20.176';
const DEFAULT_PROXY_PORT = '6754';

const BROWSERLESS_TOKEN = process.env.BROWSERLESS_TOKEN;
const PROXY_USERNAME = process.env.PROXY_USERNAME || '';
const PROXY_PASSWORD = process.env.PROXY_PASSWORD || '';

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function fillField(page, selector, value, fieldName) {
    await page.waitForSelector(selector, { timeout: 10000 });
    await page.click(selector, { clickCount: 3 });
    await page.keyboard.press('Backspace');
    await delay(100);
    await page.evaluate((sel, val) => {
        const el = document.querySelector(sel);
        el.value = val;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        el.dispatchEvent(new Event('blur', { bubbles: true }));
    }, selector, value);
    await delay(300);
    let actual = await page.$eval(selector, el => el.value);
    if (actual !== value) {
        await page.click(selector, { clickCount: 3 });
        await page.keyboard.press('Backspace');
        for (const char of value) await page.keyboard.type(char, { delay: 30 });
        actual = await page.$eval(selector, el => el.value);
    }
    if (actual !== value) throw new Error(`Impossible de remplir ${fieldName}`);
}

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Méthode non autorisée' });

    if (!BROWSERLESS_TOKEN) {
        console.error('❌ BROWSERLESS_TOKEN manquant');
        return res.status(500).json({ error: 'Configuration serveur incomplète (BROWSERLESS_TOKEN)' });
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

    let proxyConfig = null;
    if (proxy) {
        const parts = proxy.split(':');
        if (parts.length === 2) proxyConfig = { host: parts[0], port: parts[1] };
        else if (parts.length === 4) proxyConfig = { host: parts[0], port: parts[1], username: parts[2], password: parts[3] };
    } else {
        proxyConfig = { host: DEFAULT_PROXY_HOST, port: DEFAULT_PROXY_PORT, username: PROXY_USERNAME, password: PROXY_PASSWORD };
    }

    let browser;
    try {
        browser = await puppeteer.connect({
            browserWSEndpoint: `wss://chrome.browserless.io?token=${BROWSERLESS_TOKEN}`
        });

        const page = await browser.newPage();
        if (proxyConfig && proxyConfig.username) {
            await page.authenticate({ username: proxyConfig.username, password: proxyConfig.password });
        }

        await page.setViewport({ width: 1280, height: 720 });
        await page.goto(loginUrl, { waitUntil: 'networkidle2', timeout: 60000 });

        await fillField(page, 'input[type="email"], input[name="email"]', email, 'email');
        await fillField(page, 'input[type="password"]', password, 'password');
        await delay(2000);

        try {
            const frame = await page.waitForFrame(f => f.url().includes('challenges.cloudflare.com/turnstile'), { timeout: 15000 });
            await frame.click('input[type="checkbox"]');
            await delay(5000);
        } catch (e) {}

        const loginClicked = await page.evaluate(() => {
            const btns = [...document.querySelectorAll('button')];
            const loginBtn = btns.find(b => b.textContent.trim() === 'Log in');
            if (loginBtn) { loginBtn.click(); return true; }
            return false;
        });
        if (!loginClicked) throw new Error('Bouton Log in introuvable');

        await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {});
        await delay(5000);

        if (page.url().includes('login.php')) {
            const errorMsg = await page.evaluate(() => {
                const el = document.querySelector('.alert-danger, .error, .message-error');
                return el ? el.textContent.trim() : null;
            });
            throw new Error(errorMsg || 'Identifiants invalides');
        }

        const cookies = await page.cookies();
        await browser.close();

        res.status(200).json({ success: true, cookies });

    } catch (error) {
        console.error('Erreur login:', error);
        if (browser) await browser.close();
        res.status(500).json({ error: error.message });
    }
}
