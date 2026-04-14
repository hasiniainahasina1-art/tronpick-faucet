const { connect } = require('puppeteer-real-browser');
const fs = require('fs');
const path = require('path');
const { Octokit } = require('@octokit/rest');

// --- Configuration GitHub (via variables d'environnement) ---
const GH_TOKEN = process.env.GH_TOKEN;
const GH_USERNAME = process.env.GH_USERNAME;
const GH_REPO = process.env.GH_REPO;
const GH_BRANCH = process.env.GH_BRANCH || 'main';
const GH_FILE_PATH = process.env.GH_FILE_PATH || 'accounts.json';

if (!GH_TOKEN || !GH_USERNAME || !GH_REPO) {
    console.error('❌ Variables GitHub manquantes dans l\'environnement.');
    process.exit(1);
}

const octokit = new Octokit({ auth: GH_TOKEN });

// --- Proxy par défaut (utilisé si aucun proxy spécifique n'est fourni) ---
const DEFAULT_PROXY_HOST = '31.59.20.176';
const DEFAULT_PROXY_PORT = '6754';
const DEFAULT_PROXY_USERNAME = process.env.PROXY_USERNAME || '';
const DEFAULT_PROXY_PASSWORD = process.env.PROXY_PASSWORD || '';

// --- Coordonnées fixes (résolution 1280x720) ---
const TURNSTILE_COORDS = { x: 640, y: 195 };
const CLAIM_COORDS = { x: 640, y: 223 };

// --- Dossier des captures (optionnel) ---
const outputDir = path.join(__dirname, 'screenshots');
if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

// --- Utilitaires de délai ---
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// --- Fonctions de saisie et d'interaction (éprouvées) ---
async function fillField(page, selector, value, fieldName) {
    console.log(`⌨️ Remplissage ${fieldName}...`);
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
    console.log(`✅ ${fieldName} rempli`);
}

async function humanScrollToClaim(page) {
    console.log('📜 Scroll progressif vers le bouton CLAIM...');
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
    console.log('✅ Scroll terminé');
}

async function humanClickAt(page, coords, label) {
    console.log(`🖱️ Clic ${label} aux coordonnées (${coords.x}, ${coords.y})`);
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
    console.log(`✅ Clic ${label} effectué`);
}

// --- Gestion du stockage GitHub ---
async function loadAccountsFromGitHub() {
    try {
        const response = await octokit.repos.getContent({
            owner: GH_USERNAME,
            repo: GH_REPO,
            path: GH_FILE_PATH,
            ref: GH_BRANCH
        });
        const content = Buffer.from(response.data.content, 'base64').toString('utf8');
        return JSON.parse(content);
    } catch (error) {
        if (error.status === 404) return [];
        throw error;
    }
}

async function saveAccountsToGitHub(accounts) {
    let sha = null;
    try {
        const response = await octokit.repos.getContent({
            owner: GH_USERNAME,
            repo: GH_REPO,
            path: GH_FILE_PATH,
            ref: GH_BRANCH
        });
        sha = response.data.sha;
    } catch (error) {
        // Le fichier n'existe pas encore, sha reste null
    }

    const content = Buffer.from(JSON.stringify(accounts, null, 2)).toString('base64');
    await octokit.repos.createOrUpdateFileContents({
        owner: GH_USERNAME,
        repo: GH_REPO,
        path: GH_FILE_PATH,
        message: 'Mise à jour automatique des comptes',
        content,
        branch: GH_BRANCH,
        sha
    });
}

// --- Traitement d'un compte avec cookies ---
async function claimWithCookies(browser, account, index) {
    const { email, cookies, platform, proxy, timer } = account;
    console.log(`\n===== 🍪 Traitement du compte ${index + 1} : ${email} (${platform}) via cookies =====`);

    // Déterminer l'URL du faucet selon la plateforme
    const siteUrls = {
        tronpick: 'https://tronpick.io/faucet.php',
        litepick: 'https://litepick.io/faucet.php',
        dogepick: 'https://dogepick.io/faucet.php',
        solpick: 'https://solpick.io/faucet.php',
        binpick: 'https://binpick.io/faucet.php'
    };
    const faucetUrl = siteUrls[platform] || 'https://tronpick.io/faucet.php';

    // Configurer le proxy
    let proxyConfig = null;
    if (proxy) {
        const parts = proxy.split(':');
        if (parts.length === 2) {
            proxyConfig = { host: parts[0], port: parts[1] };
        } else if (parts.length === 4) {
            proxyConfig = { host: parts[0], port: parts[1], username: parts[2], password: parts[3] };
        }
    } else {
        proxyConfig = {
            host: DEFAULT_PROXY_HOST,
            port: DEFAULT_PROXY_PORT,
            username: DEFAULT_PROXY_USERNAME,
            password: DEFAULT_PROXY_PASSWORD
        };
    }

    const context = await browser.createIncognitoBrowserContext();
    const page = await context.newPage();
    if (proxyConfig && proxyConfig.username) {
        await page.authenticate({ username: proxyConfig.username, password: proxyConfig.password });
    }

    try {
        // Injecter les cookies
        await page.setCookie(...cookies);
        console.log('✅ Cookies injectés');

        await page.goto(faucetUrl, { waitUntil: 'networkidle2', timeout: 30000 });
        await delay(5000);

        // Vérifier si redirigé vers login (cookies expirés)
        if (page.url().includes('login.php')) {
            throw new Error('Cookies expirés');
        }

        await humanScrollToClaim(page);
        await delay(2000);

        // Clics Turnstile (parfois encore nécessaire même avec cookies)
        await humanClickAt(page, TURNSTILE_COORDS, 'Turnstile 1/2');
        await delay(10000);
        await humanClickAt(page, TURNSTILE_COORDS, 'Turnstile 2/2');
        await delay(10000);
        await delay(10000);

        await humanClickAt(page, CLAIM_COORDS, 'CLAIM');
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

        const resultMessage = messages[0] || (btnDisabled ? 'Bouton désactivé (succès présumé)' : 'Aucune réaction');
        return { email, success, message: resultMessage };

    } catch (error) {
        console.error(`❌ Erreur pour ${email}:`, error);
        return { email, success: false, message: error.message };
    } finally {
        await context.close();
    }
}

// --- Fonction principale ---
(async () => {
    let browser;
    const results = [];
    try {
        // Charger les comptes
        const accounts = await loadAccountsFromGitHub();
        if (accounts.length === 0) {
            console.log('ℹ️ Aucun compte configuré.');
            return;
        }

        // Filtrer les comptes actifs ayant des cookies
        const activeAccounts = accounts.filter(acc => acc.enabled !== false && acc.cookies);
        if (activeAccounts.length === 0) {
            console.log('ℹ️ Aucun compte actif avec cookies.');
            return;
        }

        // Déterminer les comptes éligibles (compte à rebours écoulé)
        const now = Date.now();
        const eligibleAccounts = activeAccounts.filter(acc => {
            const lastClaim = acc.lastClaim || 0;
            const intervalMs = (acc.timer || 60) * 60 * 1000;
            return (now - lastClaim) >= intervalMs;
        });

        if (eligibleAccounts.length === 0) {
            console.log('⏳ Aucun compte éligible pour le moment.');
            return;
        }

        console.log(`🚀 Lancement pour ${eligibleAccounts.length} compte(s) éligible(s)`);

        // Lancer un navigateur avec le proxy par défaut
        const { browser: br } = await connect({
            headless: false,
            turnstile: true,
            proxy: DEFAULT_PROXY_USERNAME ? {
                host: DEFAULT_PROXY_HOST,
                port: DEFAULT_PROXY_PORT,
                username: DEFAULT_PROXY_USERNAME,
                password: DEFAULT_PROXY_PASSWORD
            } : {
                host: DEFAULT_PROXY_HOST,
                port: DEFAULT_PROXY_PORT
            }
        });
        browser = br;

        let needsSave = false;
        for (let i = 0; i < eligibleAccounts.length; i++) {
            const acc = eligibleAccounts[i];
            const result = await claimWithCookies(browser, acc, i);
            results.push(result);

            // Mettre à jour lastClaim si succès
            if (result.success) {
                const originalAccount = accounts.find(a => a.email === acc.email);
                if (originalAccount) {
                    originalAccount.lastClaim = now;
                    needsSave = true;
                }
            }
            await delay(5000);
        }

        console.log('📊 Résultats finaux :', results);

        // Sauvegarder les modifications dans GitHub
        if (needsSave) {
            await saveAccountsToGitHub(accounts);
            console.log('💾 Timestamps mis à jour dans GitHub.');
        }

        // Sauvegarder les résultats pour le dashboard
        const statusPath = path.join(__dirname, 'public', 'status.json');
        fs.writeFileSync(statusPath, JSON.stringify(results, null, 2));

    } catch (error) {
        console.error('❌ Erreur fatale :', error);
    } finally {
        if (browser) await browser.close();
    }
})();
