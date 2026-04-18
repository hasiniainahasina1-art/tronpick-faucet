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

// --- Proxy tournant unique (fourni par l'utilisateur) ---
const PROXY_URL = process.env.PROXY_URL || ''; // ex: http://84.8.134.235:8888/ ou avec auth
if (!PROXY_URL) {
    console.error('❌ PROXY_URL manquant');
    process.exit(1);
}
console.log(`🌐 Proxy tournant configuré : ${PROXY_URL}`);

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
async function fillField(page, selector, value, fieldName) { /* ... */ }
async function humanScrollToClaim(page) { /* ... */ }
async function humanClickAt(page, coords) { /* ... */ }

// --- Gestion du dépôt GitHub ---
async function loadAccounts() { /* ... */ }
async function saveAccounts(accounts) { /* ... */ }

// --- Parser une URL de proxy ---
function parseProxyUrl(proxyUrl) {
    // Si l'URL contient une authentification
    const match = proxyUrl.match(/^http:\/\/([^:]+):([^@]+)@([^:]+):(\d+)$/);
    if (match) {
        return {
            server: `http://${match[3]}:${match[4]}`,
            username: match[1],
            password: match[2]
        };
    }
    // Sinon, proxy sans authentification
    const simpleMatch = proxyUrl.match(/^http:\/\/([^:]+):(\d+)$/);
    if (simpleMatch) {
        return {
            server: proxyUrl
        };
    }
    return null;
}

// --- Login et capture cookies ---
async function performLoginAndCaptureCookies(account) {
    const { email, password, platform } = account;
    console.log(`🔐 Login pour ${email}...`);

    const siteUrls = { /* ... */ };
    const loginUrl = siteUrls[platform];
    if (!loginUrl) throw new Error('Plateforme inconnue');

    // Utiliser le proxy tournant (peut-être avec un suffixe de session)
    let proxyConfig = parseProxyUrl(PROXY_URL);
    if (!proxyConfig) throw new Error('Proxy invalide');
    
    // Optionnel : forcer une nouvelle IP en ajoutant un paramètre de session (si supporté)
    // proxyConfig.username = proxyConfig.username + '-session-' + Math.random().toString(36).substring(2, 10);

    console.log(`🔄 Proxy utilisé : ${proxyConfig.server}`);

    let browser;
    try {
        const { browser: br, page } = await connect({
            headless: false,
            turnstile: true,
            proxy: proxyConfig
        });
        browser = br;

        // ... (le reste du login identique)
        const cookies = await page.cookies();
        return cookies;
    } finally {
        if (browser) await browser.close().catch(() => {});
    }
}

// --- Claim avec cookies (relance auto si expirés) ---
async function claimWithCookies(account) {
    const { email, cookies, platform } = account;
    console.log(`🍪 Claim pour ${email} via cookies`);

    const siteUrls = { /* ... */ };
    const faucetUrl = siteUrls[platform] || 'https://tronpick.io/faucet.php';

    let proxyConfig = parseProxyUrl(PROXY_URL);
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
        await page.goto('https://api.ipify.org?format=json');
        const ipText = await page.evaluate(() => document.body.textContent);
        const ipData = JSON.parse(ipText);
        console.log(`🌍 IP publique : ${ipData.ip}`);

        // ... (suite du claim identique)
        return { success, message: resultMessage };
    } catch (error) {
        if (error.message.includes('Cookies expirés')) {
            // Reconnexion avec le même proxy
            console.log(`🔄 Cookies expirés, reconnexion...`);
            const newCookies = await performLoginAndCaptureCookies(account);
            account.cookies = newCookies;
            account.cookiesStatus = 'valid';
            return await claimWithCookies(account);
        }
        throw error;
    } finally {
        if (browser) await browser.close().catch(() => {});
    }
}

// --- Principal (boucle sur les comptes) ---
(async () => {
    try {
        let accounts = await loadAccounts();
        console.log(`📋 Comptes chargés : ${accounts.length}`);

        if (!accounts.length) return;

        const now = Date.now();
        let needsSave = false;

        for (const acc of accounts) {
            if (!acc.enabled) continue;

            console.log(`\n===== Traitement du compte : ${acc.email} =====`);

            // 1. Login si nécessaire
            if (!acc.cookies || acc.cookiesStatus === 'expired' || acc.cookiesStatus === 'failed') {
                try {
                    const newCookies = await performLoginAndCaptureCookies(acc);
                    acc.cookies = newCookies;
                    acc.cookiesStatus = 'valid';
                    needsSave = true;
                } catch (e) {
                    acc.cookiesStatus = 'failed';
                    console.log(`❌ Échec login: ${e.message}`);
                    continue;
                }
            }

            // 2. Claim si éligible
            const lastClaim = acc.lastClaim || 0;
            const intervalMs = (acc.timer || 60) * 60 * 1000;
            if ((now - lastClaim) >= intervalMs) {
                console.log(`🚀 Claim éligible`);
                try {
                    const result = await claimWithCookies(acc);
                    if (result.success) {
                        acc.lastClaim = now;
                        console.log(`✅ Claim réussi`);
                    } else {
                        console.log(`❌ Claim échoué: ${result.message}`);
                    }
                    needsSave = true;
                } catch (e) {
                    console.error(`❌ Erreur claim: ${e.message}`);
                }
            } else {
                const remaining = Math.ceil((intervalMs - (now - lastClaim)) / 60000);
                console.log(`⏳ Prochain claim dans ${remaining} min`);
            }

            await delay(5000);
        }

        if (needsSave) await saveAccounts(accounts);
    } catch (e) {
        console.error('Erreur fatale:', e);
    }
})();
