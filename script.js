const { connect } = require('puppeteer-real-browser');
const fs = require('fs');
const path = require('path');
const { Octokit } = require('@octokit/rest');

// Configuration GitHub
const GH_TOKEN = process.env.GH_TOKEN;
const GH_USERNAME = process.env.GH_USERNAME;
const GH_REPO = process.env.GH_REPO;
const GH_BRANCH = process.env.GH_BRANCH || 'main';
const GH_FILE_PATH = process.env.GH_FILE_PATH || 'accounts.json';

const octokit = new Octokit({ auth: GH_TOKEN });

const DEFAULT_PROXY_HOST = '31.59.20.176';
const DEFAULT_PROXY_PORT = '6754';
const DEFAULT_PROXY_USERNAME = process.env.PROXY_USERNAME || '';
const DEFAULT_PROXY_PASSWORD = process.env.PROXY_PASSWORD || '';

const TURNSTILE_COORDS = { x: 640, y: 195 };
const CLAIM_COORDS = { x: 640, y: 223 };

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// --- Fonctions utilitaires (fillField, humanScrollToClaim, humanClickAt) inchangées ---
// (Recopiez-les depuis les versions précédentes)

// --- Login et capture des cookies ---
async function performLoginAndCaptureCookies(browser, account) {
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

    let proxyConfig = null;
    if (proxy) {
        const parts = proxy.split(':');
        if (parts.length === 2) proxyConfig = { host: parts[0], port: parts[1] };
        else if (parts.length === 4) proxyConfig = { host: parts[0], port: parts[1], username: parts[2], password: parts[3] };
    } else {
        proxyConfig = { host: DEFAULT_PROXY_HOST, port: DEFAULT_PROXY_PORT, username: DEFAULT_PROXY_USERNAME, password: DEFAULT_PROXY_PASSWORD };
    }

    const context = await browser.createIncognitoBrowserContext();
    const page = await context.newPage();
    if (proxyConfig && proxyConfig.username) {
        await page.authenticate({ username: proxyConfig.username, password: proxyConfig.password });
    }

    try {
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
            throw new Error(errorMsg || 'Échec connexion');
        }

        const cookies = await page.cookies();
        return cookies;
    } finally {
        await context.close();
    }
}

// --- Claim avec cookies (identique à avant) ---
async function claimWithCookies(browser, account) {
    // ... (fonction existante, retourne { success, message })
}

// --- Sauvegarde des comptes sur GitHub ---
async function loadAccounts() {
    try {
        const res = await octokit.repos.getContent({ owner: GH_USERNAME, repo: GH_REPO, path: GH_FILE_PATH, ref: GH_BRANCH });
        return JSON.parse(Buffer.from(res.data.content, 'base64').toString('utf8'));
    } catch (e) {
        if (e.status === 404) return [];
        throw e;
    }
}

async function saveAccounts(accounts) {
    let sha = null;
    try {
        const res = await octokit.repos.getContent({ owner: GH_USERNAME, repo: GH_REPO, path: GH_FILE_PATH, ref: GH_BRANCH });
        sha = res.data.sha;
    } catch (e) {}
    const content = Buffer.from(JSON.stringify(accounts, null, 2)).toString('base64');
    await octokit.repos.createOrUpdateFileContents({
        owner: GH_USERNAME, repo: GH_REPO, path: GH_FILE_PATH,
        message: 'Mise à jour automatique', content, branch: GH_BRANCH, sha
    });
}

// --- Principal ---
(async () => {
    let browser;
    try {
        let accounts = await loadAccounts();
        if (!accounts.length) return;

        // 1. Login pour les comptes sans cookies
        const accountsWithoutCookies = accounts.filter(acc => acc.enabled && !acc.cookies);
        if (accountsWithoutCookies.length > 0) {
            console.log(`🍪 Capture des cookies pour ${accountsWithoutCookies.length} compte(s)...`);
            const { browser: br } = await connect({
                headless: false, turnstile: true,
                proxy: { host: DEFAULT_PROXY_HOST, port: DEFAULT_PROXY_PORT, username: DEFAULT_PROXY_USERNAME, password: DEFAULT_PROXY_PASSWORD }
            });
            browser = br;

            for (const acc of accountsWithoutCookies) {
                try {
                    const cookies = await performLoginAndCaptureCookies(browser, acc);
                    acc.cookies = cookies;
                    console.log(`✅ Cookies capturés pour ${acc.email}`);
                } catch (e) {
                    console.error(`❌ Échec login ${acc.email}:`, e.message);
                }
                await delay(5000);
            }
            await saveAccounts(accounts);
            if (browser) await browser.close();
        }

        // 2. Claim pour les comptes avec cookies et éligibles
        const now = Date.now();
        const eligible = accounts.filter(acc => acc.enabled && acc.cookies && (now - (acc.lastClaim||0)) >= (acc.timer||60)*60000);
        if (eligible.length > 0) {
            console.log(`🚀 Claim pour ${eligible.length} compte(s)...`);
            const { browser: br } = await connect({
                headless: false, turnstile: true,
                proxy: { host: DEFAULT_PROXY_HOST, port: DEFAULT_PROXY_PORT, username: DEFAULT_PROXY_USERNAME, password: DEFAULT_PROXY_PASSWORD }
            });
            browser = br;

            for (const acc of eligible) {
                const result = await claimWithCookies(browser, acc);
                if (result.success) {
                    acc.lastClaim = now;
                    console.log(`✅ Claim réussi pour ${acc.email}`);
                } else {
                    console.log(`❌ Claim échoué pour ${acc.email}: ${result.message}`);
                }
                await delay(5000);
            }
            await saveAccounts(accounts);
        }

    } catch (e) {
        console.error('Erreur fatale:', e);
    } finally {
        if (browser) await browser.close();
    }
})();
