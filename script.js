// script.js
const { connect } = require('puppeteer-real-browser');
const { Octokit } = require('@octokit/rest');
const fs = require('fs');
const path = require('path');

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

// --- Configuration des proxys ---
// Option 1 : Proxy unique tournant (ex: Bright Data gateway)
const PROXY_URL = process.env.PROXY_URL || ''; // ex: "http://user:pass@gateway:port"

// Option 2 : Liste de proxys japonais (si pas de proxy tournant)
const JP_PROXY_LIST = (process.env.JP_PROXY_LIST || '').split(',').filter(p => p.trim() !== '');

let proxyList = [];
if (PROXY_URL) {
    // Mode proxy unique tournant : on utilisera toujours la même URL, mais elle fournira des IPs différentes
    console.log('🌐 Mode proxy tournant unique activé');
    proxyList = [PROXY_URL];
} else if (JP_PROXY_LIST.length > 0) {
    console.log(`🌐 Mode liste de proxys japonais : ${JP_PROXY_LIST.length} proxys chargés`);
    proxyList = JP_PROXY_LIST;
} else {
    console.error('❌ Aucun proxy configuré. Définissez PROXY_URL ou JP_PROXY_LIST.');
    process.exit(1);
}

// Mélanger un tableau (Fisher–Yates)
function shuffleArray(array) {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
}

let shuffledProxies = shuffleArray([...proxyList]);
let currentProxyIndex = 0;

function getNextProxyConfig() {
    if (shuffledProxies.length === 0) return null;
    const proxyUrl = shuffledProxies[currentProxyIndex];
    currentProxyIndex = (currentProxyIndex + 1) % shuffledProxies.length;
    if (currentProxyIndex === 0) {
        shuffledProxies = shuffleArray([...proxyList]);
        console.log('🔄 Tour des proxys terminé, nouvelle permutation.');
    }
    const match = proxyUrl.match(/^http:\/\/([^:]+):([^@]+)@([^:]+):(\d+)$/);
    if (!match) {
        console.error('❌ Format de proxy invalide:', proxyUrl);
        return null;
    }
    return {
        server: `http://${match[3]}:${match[4]}`,
        username: match[1],
        password: match[2]
    };
}

// --- Dossier pour les captures d'écran ---
const screenshotsDir = path.join(__dirname, 'screenshots');
if (!fs.existsSync(screenshotsDir)) {
    fs.mkdirSync(screenshotsDir, { recursive: true });
}

// --- Coordonnées validées ---
const TURNSTILE_LOGIN_COORDS = { x: 640, y: 615 };
const TURNSTILE_FAUCET_COORDS = { x: 400, y: 158 };
const CLAIM_COORDS = { x: 400, y: 223 };

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// --- Fonctions utilitaires (inchangées) ---
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

// --- Gestion du dépôt GitHub (inchangée) ---
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

// --- Login et capture cookies ---
async function performLoginAndCaptureCookies(account) {
    const { email, password, platform } = account;
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

    const proxyConfig = getNextProxyConfig();
    if (!proxyConfig) throw new Error('Aucun proxy valide disponible');
    console.log(`🔄 Proxy utilisé : ${proxyConfig.server}`);

    let browser;
    try {
        const { browser: br, page } = await connect({
            headless: false,
            turnstile: true,
            proxy: proxyConfig
        });
        browser = br;

        await page.setViewport({ width: 1280, height: 720 });
        await page.goto(loginUrl, { waitUntil: 'networkidle2', timeout: 60000 });

        await fillField(page, 'input[type="email"], input[name="email"]', email, 'email');
        await fillField(page, 'input[type="password"]', password, 'password');
        await delay(2000);

        const frame = await page.waitForFrame(
            f => f.url().includes('challenges.cloudflare.com/turnstile'),
            { timeout: 15000 }
        ).catch(() => null);

        if (frame) {
            console.log('✅ Iframe Turnstile trouvée (login), clic checkbox');
            await frame.click('input[type="checkbox"]');
            await delay(8000);
        } else {
            console.log('⚠️ Iframe non trouvée, fallback coordonné');
            await humanClickAt(page, TURNSTILE_LOGIN_COORDS);
            await delay(10000);
        }

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

// --- Claim avec cookies (rotation proxy + renouvellement auto) ---
async function claimWithCookies(account) {
    const { email, cookies, platform } = account;
    console.log(`🍪 Claim pour ${email} via cookies`);

    const siteUrls = {
        tronpick: 'https://tronpick.io/faucet.php',
        litepick: 'https://litepick.io/faucet.php',
        dogepick: 'https://dogepick.io/faucet.php',
        solpick: 'https://solpick.io/faucet.php',
        binpick: 'https://binpick.io/faucet.php'
    };
    const faucetUrl = siteUrls[platform] || 'https://tronpick.io/faucet.php';

    const proxyConfig = getNextProxyConfig();
    if (!proxyConfig) throw new Error('Aucun proxy valide disponible');
    console.log(`🔄 Proxy utilisé : ${proxyConfig.server}`);

    let browser;
    try {
        const { browser: br, page } = await connect({
            headless: false,
            turnstile: true,
            proxy: proxyConfig
        });
        browser = br;

        await page.setCookie(...cookies);
        await page.goto(faucetUrl, { waitUntil: 'networkidle2', timeout: 30000 });
        await delay(5000);

        // Vérification IP publique
        await page.goto('https://api.ipify.org?format=json', { waitUntil: 'domcontentloaded', timeout: 10000 });
        const ipText = await page.evaluate(() => document.body.textContent);
        const ipData = JSON.parse(ipText);
        console.log(`🌍 IP publique : ${ipData.ip}`);
        await page.goto(faucetUrl, { waitUntil: 'networkidle2', timeout: 30000 });
        await delay(2000);

        if (page.url().includes('login.php')) {
            throw new Error('Cookies expirés');
        }

        // --- SÉQUENCE DE CLAIM (identique) ---
        console.log('⏳ Attente de 5 secondes...');
        await delay(5000);

        console.log('🔄 Actualisation de la page faucet...');
        await page.reload({ waitUntil: 'networkidle2', timeout: 30000 });
        await page.screenshot({ path: path.join(screenshotsDir, `01_after_reload_${email.replace(/[^a-zA-Z0-9]/g, '_')}.png`), fullPage: true });

        console.log('⏳ Attente de 20 secondes...');
        await delay(20000);
        await page.screenshot({ path: path.join(screenshotsDir, `02_after_wait_${email.replace(/[^a-zA-Z0-9]/g, '_')}.png`), fullPage: true });

        await humanScrollToClaim(page);
        await delay(2000);
        await page.screenshot({ path: path.join(screenshotsDir, `03_turnstile_visible_${email.replace(/[^a-zA-Z0-9]/g, '_')}.png`), fullPage: true });

        await humanClickAt(page, TURNSTILE_FAUCET_COORDS);
        await page.screenshot({ path: path.join(screenshotsDir, `04_after_first_click_${email.replace(/[^a-zA-Z0-9]/g, '_')}.png`), fullPage: true });

        console.log('⏳ Attente de 10 secondes...');
        await delay(10000);

        await humanClickAt(page, TURNSTILE_FAUCET_COORDS);
        await page.screenshot({ path: path.join(screenshotsDir, `05_after_second_click_${email.replace(/[^a-zA-Z0-9]/g, '_')}.png`), fullPage: true });

        console.log('⏳ Attente de 10 secondes...');
        await delay(10000);

        console.log('⏳ Attente de 10 secondes avant le clic sur CLAIM...');
        await delay(10000);
        await page.screenshot({ path: path.join(screenshotsDir, `06_before_claim_${email.replace(/[^a-zA-Z0-9]/g, '_')}.png`), fullPage: true });

        await humanClickAt(page, CLAIM_COORDS);
        await page.waitForNetworkIdle({ timeout: 20000 }).catch(() => {});
        await delay(5000);
        await page.screenshot({ path: path.join(screenshotsDir, `07_after_claim_${email.replace(/[^a-zA-Z0-9]/g, '_')}.png`), fullPage: true });

        const messages = await page.evaluate(() => {
            return Array.from(document.querySelectorAll('[class*="toast"], [class*="alert"], [role="alert"]'))
                .map(el => el.textContent.trim()).filter(t => t);
        });
        const btnDisabled = await page.evaluate(() => {
            return document.querySelector('#process_claim_hourly_faucet')?.disabled || false;
        });
        const success = btnDisabled || messages.some(m => /success|claimed|reward|sent/i.test(m));
        const resultMessage = messages[0] || (btnDisabled ? 'Bouton désactivé (succès présumé)' : 'Aucune réaction');

        // --- DÉCONNEXION ---
        console.log('⏳ Attente de 20 secondes avant déconnexion...');
        await delay(20000);
        await page.screenshot({ path: path.join(screenshotsDir, `08_before_logout_${email.replace(/[^a-zA-Z0-9]/g, '_')}.png`), fullPage: true });

        console.log('🚪 Tentative de déconnexion...');
        const logoutClicked = await page.evaluate(() => {
            const keywords = ['logout', 'sign out', 'déconnexion', 'se déconnecter', 'log out'];
            const elements = [...document.querySelectorAll('a, button')];
            const logoutElement = elements.find(el => {
                const text = (el.textContent || '').toLowerCase();
                return keywords.some(kw => text.includes(kw));
            });
            if (logoutElement) {
                logoutElement.click();
                return true;
            }
            return false;
        });

        if (logoutClicked) {
            console.log('✅ Clic sur le bouton de déconnexion effectué');
            await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {});
            await delay(3000);
            await page.screenshot({ path: path.join(screenshotsDir, `09_after_logout_${email.replace(/[^a-zA-Z0-9]/g, '_')}.png`), fullPage: true });
        } else {
            console.log('⚠️ Bouton de déconnexion non trouvé.');
        }

        return { success, message: resultMessage };

    } catch (error) {
        if (error.message.includes('Cookies expirés')) {
            console.log(`🔄 Cookies expirés pour ${email}, tentative de reconnexion...`);
            try {
                const newCookies = await performLoginAndCaptureCookies(account);
                account.cookies = newCookies;
                account.cookiesStatus = 'valid';
                console.log(`✅ Nouveaux cookies capturés pour ${email}.`);
                return { success: false, message: 'Cookies renouvelés', cookiesRenewed: true };
            } catch (loginError) {
                console.error(`❌ Échec reconnexion ${email}:`, loginError.message);
                account.cookiesStatus = 'failed';
                return { success: false, message: `Échec reconnexion: ${loginError.message}` };
            }
        }
        console.error(`❌ Erreur claim ${email}:`, error.message);
        return { success: false, message: error.message };
    } finally {
        if (browser) await browser.close().catch(() => {});
    }
}

// --- Principal (multi‑comptes) ---
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
                    if (result.cookiesRenewed) {
                        console.log(`🔄 Cookies renouvelés pour ${acc.email}`);
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
