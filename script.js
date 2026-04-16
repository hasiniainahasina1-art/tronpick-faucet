// script.js
const { connect } = require('puppeteer-real-browser');
const { Octokit } = require('@octokit/rest');

// --- Configuration GitHub (dépôt) ---
const GH_TOKEN = process.env.GH_TOKEN;
const GH_USERNAME = process.env.GH_USERNAME;
const GH_REPO = process.env.GH_REPO;
const GH_BRANCH = process.env.GH_BRANCH || 'main';
const GH_FILE_PATH = process.env.GH_FILE_PATH || 'accounts.json';

if (!GH_TOKEN || !GH_USERNAME || !GH_REPO) {
    console.error('❌ Variables GitHub manquantes');
    process.exit(1);
}

const octokit = new Octokit({ auth: GH_TOKEN });

// --- Proxy par défaut ---
const DEFAULT_PROXY_HOST = '31.59.20.176';
const DEFAULT_PROXY_PORT = '6754';
const DEFAULT_PROXY_USERNAME = process.env.PROXY_USERNAME || '';
const DEFAULT_PROXY_PASSWORD = process.env.PROXY_PASSWORD || '';

// --- Coordonnées fixes (résolution 1280x720) ---
const TURNSTILE_COORDS = { x: 640, y: 615 }; // Login
const CLAIM_COORDS = { x: 640, y: 223 };     // Faucet

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// --- Fonctions utilitaires ---
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

async function humanScrollToClaim(page) {
    const coords = await page.evaluate(() => {
        const btn = document.querySelector('#process_claim_hourly_faucet');
        if (!btn) return null;
        const rect = btn.getBoundingClientRect();
        return { y: rect.y + window.scrollY };
    });
    if (!coords) throw new Error('Bouton CLAIM introuvable pour le scroll');
    const startY = await page.evaluate(() => window.scrollY);
    const targetY = Math.max(0, coords.y - 200);
    const steps = 20;
    for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        const currentY = startY + (targetY - startY) * t;
        await page.evaluate((y) => window.scrollTo(0, y), currentY);
        await delay(50 + Math.random() * 100);
    }
}

async function humanClickAt(page, coords) {
    const start = await page.evaluate(() => ({ x: window.innerWidth / 2, y: window.innerHeight / 2 }));
    const steps = 20;
    for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        const cp = { x: start.x + (Math.random() - 0.5) * 100, y: start.y + (Math.random() - 0.5) * 100 };
        const x = Math.pow(1 - t, 2) * start.x + 2 * (1 - t) * t * cp.x + Math.pow(t, 2) * coords.x;
        const y = Math.pow(1 - t, 2) * start.y + 2 * (1 - t) * t * cp.y + Math.pow(t, 2) * coords.y;
        await page.mouse.move(x, y);
        await delay(15);
    }
    await page.mouse.click(coords.x, coords.y);
}

// --- Gestion du dépôt GitHub ---
async function loadAccounts() {
    try {
        const res = await octokit.repos.getContent({
            owner: GH_USERNAME,
            repo: GH_REPO,
            path: GH_FILE_PATH,
            ref: GH_BRANCH
        });
        return JSON.parse(Buffer.from(res.data.content, 'base64').toString('utf8'));
    } catch (e) {
        if (e.status === 404) return [];
        throw e;
    }
}

async function saveAccounts(accounts) {
    let sha = null;
    try {
        const res = await octokit.repos.getContent({
            owner: GH_USERNAME,
            repo: GH_REPO,
            path: GH_FILE_PATH,
            ref: GH_BRANCH
        });
        sha = res.data.sha;
    } catch (e) {}
    const content = Buffer.from(JSON.stringify(accounts, null, 2)).toString('base64');
    await octokit.repos.createOrUpdateFileContents({
        owner: GH_USERNAME,
        repo: GH_REPO,
        path: GH_FILE_PATH,
        message: 'Mise à jour automatique',
        content,
        branch: GH_BRANCH,
        sha
    });
}

// --- Login et capture cookies (nouveau navigateur à chaque appel) ---
async function performLoginAndCaptureCookies(account) {
    const { email, password, platform, proxy } = account;
    console.log(`🔐 Login pour ${email}...`);

    const siteUrls = {
        tronpick: 'https://tronpick.io/login.php',
        litepick: 'https://litepick.io/login.php',
        dogepick: 'https://dogepick.io/login.php',
        solpick: 'https://solpick.io/login.php',
        binpick: 'https://binpick.io/login.php'
    };
    const loginUrl = siteUrls[platform];
    if (!loginUrl) throw new Error('Plateforme inconnue');

    let proxyConfig = null;
    if (proxy) {
        const parts = proxy.split(':');
        if (parts.length === 2) proxyConfig = { host: parts[0], port: parts[1] };
        else if (parts.length === 4) proxyConfig = { host: parts[0], port: parts[1], username: parts[2], password: parts[3] };
    } else {
        proxyConfig = { host: DEFAULT_PROXY_HOST, port: DEFAULT_PROXY_PORT, username: DEFAULT_PROXY_USERNAME, password: DEFAULT_PROXY_PASSWORD };
    }

    let browser;
    try {
        const { browser: br, page } = await connect({
            headless: false,
            turnstile: true,
            proxy: proxyConfig
        });
        browser = br;

        if (proxyConfig && proxyConfig.username) {
            await page.authenticate({ username: proxyConfig.username, password: proxyConfig.password });
        }

        await page.setViewport({ width: 1280, height: 720 });
        await page.goto(loginUrl, { waitUntil: 'networkidle2', timeout: 60000 });

        await fillField(page, 'input[type="email"], input[name="email"]', email, 'email');
        await fillField(page, 'input[type="password"]', password, 'password');
        await delay(2000);

        await humanClickAt(page, TURNSTILE_COORDS);
        await delay(10000);

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
                const el = document.querySelector('.alert-danger, .error');
                return el ? el.textContent.trim() : null;
            });
            throw new Error(errorMsg || 'Échec connexion');
        }

        const cookies = await page.cookies();
        return cookies;
    } finally {
        if (browser) await browser.close().catch(() => {});
    }
}

// --- Claim avec cookies (nouveau navigateur à chaque appel) ---
async function claimWithCookies(account) {
    const { email, cookies, platform, proxy } = account;
    console.log(`🍪 Claim pour ${email} via cookies`);

    const siteUrls = {
        tronpick: 'https://tronpick.io/faucet.php',
        litepick: 'https://litepick.io/faucet.php',
        dogepick: 'https://dogepick.io/faucet.php',
        solpick: 'https://solpick.io/faucet.php',
        binpick: 'https://binpick.io/faucet.php'
    };
    const faucetUrl = siteUrls[platform] || 'https://tronpick.io/faucet.php';

    let proxyConfig = null;
    if (proxy) {
        const parts = proxy.split(':');
        if (parts.length === 2) proxyConfig = { host: parts[0], port: parts[1] };
        else if (parts.length === 4) proxyConfig = { host: parts[0], port: parts[1], username: parts[2], password: parts[3] };
    } else {
        proxyConfig = { host: DEFAULT_PROXY_HOST, port: DEFAULT_PROXY_PORT, username: DEFAULT_PROXY_USERNAME, password: DEFAULT_PROXY_PASSWORD };
    }

    let browser;
    try {
        const { browser: br, page } = await connect({
            headless: false,
            turnstile: true,
            proxy: proxyConfig
        });
        browser = br;

        if (proxyConfig && proxyConfig.username) {
            await page.authenticate({ username: proxyConfig.username, password: proxyConfig.password });
        }

        await page.setCookie(...cookies);
        await page.goto(faucetUrl, { waitUntil: 'networkidle2', timeout: 30000 });
        await delay(5000);

        if (page.url().includes('login.php')) {
            throw new Error('Cookies expirés');
        }

        await humanScrollToClaim(page);
        await delay(2000);

        await humanClickAt(page, CLAIM_COORDS);
        await delay(10000);
        await humanClickAt(page, CLAIM_COORDS);
        await delay(10000);

        const claimClicked = await page.evaluate(() => {
            const btn = document.querySelector('#process_claim_hourly_faucet');
            if (btn && !btn.disabled) {
                btn.click();
                return true;
            }
            return false;
        });
        if (!claimClicked) throw new Error('Bouton CLAIM introuvable ou désactivé');

        await page.waitForNetworkIdle({ timeout: 20000 }).catch(() => {});
        await delay(5000);

        const messages = await page.evaluate(() => {
            return Array.from(document.querySelectorAll('[class*="toast"], [class*="alert"], [role="alert"]'))
                .map(el => el.textContent.trim()).filter(t => t);
        });
        const btnDisabled = await page.evaluate(() => {
            return document.querySelector('#process_claim_hourly_faucet')?.disabled || false;
        });
        const success = btnDisabled || messages.some(m => /success|claimed|reward|sent/i.test(m));
        return { success, message: messages[0] || (btnDisabled ? 'Bouton désactivé' : 'Aucune réaction') };
    } finally {
        if (browser) await browser.close().catch(() => {});
    }
}

// --- Principal ---
(async () => {
    try {
        let accounts = await loadAccounts();
        console.log(`📋 Comptes chargés : ${accounts.length}`);

        if (!accounts.length) {
            console.log('Aucun compte.');
            return;
        }

        const now = Date.now();
        let needsSave = false;

        // 1. Capturer cookies pour les comptes pending
        const pending = accounts.filter(acc => acc.enabled && !acc.cookies);
        if (pending.length) {
            console.log(`🍪 Capture cookies pour ${pending.length} compte(s)...`);
            for (const acc of pending) {
                try {
                    const cookies = await performLoginAndCaptureCookies(acc);
                    acc.cookies = cookies;
                    acc.cookiesStatus = 'valid';
                    console.log(`✅ Cookies OK pour ${acc.email}`);
                } catch (e) {
                    acc.cookiesStatus = 'failed';
                    console.log(`❌ Échec login ${acc.email}: ${e.message}`);
                }
                needsSave = true;
                await delay(5000);
            }
        }

        // 2. Claim pour les comptes valides
        const eligible = accounts.filter(acc => {
            if (!acc.enabled || !acc.cookies || acc.cookiesStatus !== 'valid') return false;
            const last = acc.lastClaim || 0;
            return (now - last) >= (acc.timer || 60) * 60 * 1000;
        });

        if (eligible.length) {
            console.log(`🚀 Claim pour ${eligible.length} compte(s)...`);
            for (const acc of eligible) {
                try {
                    const result = await claimWithCookies(acc);
                    if (result.success) {
                        acc.lastClaim = now;
                        console.log(`✅ Claim réussi pour ${acc.email}`);
                    } else {
                        console.log(`❌ Claim échoué pour ${acc.email}: ${result.message}`);
                    }
                } catch (e) {
                    console.error(`❌ Erreur claim ${acc.email}:`, e.message);
                    if (e.message.includes('expir')) {
                        acc.cookies = null;
                        acc.cookiesStatus = 'expired';
                    }
                }
                needsSave = true;
                await delay(5000);
            }
        }

        if (needsSave) {
            await saveAccounts(accounts);
            console.log('💾 Comptes sauvegardés.');
        }

    } catch (e) {
        console.error('Erreur fatale:', e);
    }
})();
