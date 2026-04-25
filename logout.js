const { connect } = require('puppeteer-real-browser');
const { Octokit } = require('@octokit/rest');
const fs = require('fs');
const path = require('path');

// ---------- Variables d'environnement ----------
const email = process.env.LOGOUT_EMAIL;
const password = process.env.LOGOUT_PASSWORD;
const platform = process.env.LOGOUT_PLATFORM;
const proxyIndex = process.env.LOGOUT_PROXY_INDEX !== undefined ? parseInt(process.env.LOGOUT_PROXY_INDEX) : 0;

const GH_TOKEN = process.env.GH_TOKEN;
const GH_USERNAME = process.env.GH_USERNAME;
const GH_REPO = process.env.GH_REPO;
const GH_BRANCH = process.env.GH_BRANCH || 'main';
const GH_FILE_PATH = process.env.GH_FILE_PATH || 'accounts.json';

const JP_PROXY_LIST = (process.env.JP_PROXY_LIST || '').split(',').filter(p => p.trim() !== '');

if (!email || !password || !platform) {
    console.error('❌ LOGOUT_EMAIL, LOGOUT_PASSWORD et LOGOUT_PLATFORM sont requis.');
    process.exit(1);
}
if (!GH_TOKEN || !GH_USERNAME || !GH_REPO) {
    console.error('❌ Variables GitHub manquantes');
    process.exit(1);
}
if (JP_PROXY_LIST.length === 0) {
    console.error('❌ JP_PROXY_LIST doit contenir au moins 1 proxy');
    process.exit(1);
}

const screenshotsDir = path.join(__dirname, 'screenshots');
if (!fs.existsSync(screenshotsDir)) fs.mkdirSync(screenshotsDir, { recursive: true });

const octokit = new Octokit({ auth: GH_TOKEN });
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function parseProxyUrl(proxyUrl) {
    if (!proxyUrl) return null;
    proxyUrl = proxyUrl.trim();
    const match = proxyUrl.match(/^http:\/\/([^:]+):([^@]+)@([^:]+):(\d+)$/);
    if (!match) {
        console.error('❌ Format HTTP invalide :', proxyUrl);
        return null;
    }
    return {
        server: `http://${match[3]}:${match[4]}`,
        username: match[1],
        password: match[2]
    };
}

// ---------- GitHub ----------
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
        owner: GH_USERNAME,
        repo: GH_REPO,
        path: GH_FILE_PATH,
        message: `Déconnexion – suppression de ${email}`,
        content,
        branch: GH_BRANCH,
        sha
    });
}

// ---------- Extraction intelligente du token CSRF ----------
async function extractCsrfToken(page) {
    console.log('🔎 Extraction du token CSRF...');

    // 1) Input classique
    let token = await page.evaluate(() => {
        const el = document.querySelector('input[name="csrf_test_name"]');
        return el ? el.value : null;
    });
    if (token) {
        console.log('✅ CSRF trouvé (input name="csrf_test_name")');
        return token;
    }

    // 2) Cookie csrf_cookie_name
    const cookies = await page.cookies();
    const csrfCookie = cookies.find(c => c.name === 'csrf_cookie_name');
    if (csrfCookie && csrfCookie.value) {
        console.log('✅ CSRF trouvé (cookie csrf_cookie_name)');
        return csrfCookie.value;
    }

    // 3) Variable JavaScript globale
    token = await page.evaluate(() => {
        if (window.csrfToken) return window.csrfToken;
        if (window.csrf_token) return window.csrf_token;
        if (window.CSRF_TOKEN) return window.CSRF_TOKEN;
        if (window.csrf_test_name) return window.csrf_test_name;
        return null;
    });
    if (token) {
        console.log('✅ CSRF trouvé (variable JS globale)');
        return token;
    }

    // 4) Balise meta
    token = await page.evaluate(() => {
        const meta = document.querySelector('meta[name="csrf-token"], meta[name="csrf_token"], meta[name="csrf_test_name"]');
        return meta ? meta.getAttribute('content') : null;
    });
    if (token) {
        console.log('✅ CSRF trouvé (balise meta)');
        return token;
    }

    return null;
}

// ---------- Déconnexion ----------
async function performNormalLogout(accountCookies) {
    const proxyUrl = JP_PROXY_LIST[proxyIndex] || JP_PROXY_LIST[0];
    const proxyConfig = parseProxyUrl(proxyUrl);
    if (!proxyConfig) throw new Error('Proxy invalide');

    console.log(`🔌 Déconnexion de ${email} sur ${platform}.io via proxy ${proxyConfig.server}`);

    const { browser, page } = await connect({
        headless: false,
        turnstile: false,
        proxy: proxyConfig,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    try {
        await page.setViewport({ width: 1280, height: 720 });

        // 1) Injection des cookies
        if (accountCookies && accountCookies.length > 0) {
            await page.setCookie(...accountCookies);
            console.log(`🍪 ${accountCookies.length} cookie(s) injecté(s)`);
        }

        // 2) Charger la page faucet
        const faucetUrl = `https://${platform}.io/faucet.php`;
        await page.goto(faucetUrl, { waitUntil: 'networkidle2', timeout: 30000 });
        console.log('⏳ Attente de 20 secondes pour stabilisation complète...');
        await delay(20000);  // Attente demandée

        // Vérifier si déjà déconnecté
        if (page.url().includes('login.php')) {
            console.log('ℹ️ Session déjà expirée');
            return true;
        }

        // Capture avant extraction (utile si échec)
        await page.screenshot({
            path: path.join(screenshotsDir, `before_csrf_${email.replace(/[^a-zA-Z0-9]/g, '_')}.png`),
            fullPage: true
        });

        // 3) Extraction du token CSRF
        const csrfToken = await extractCsrfToken(page);
        if (!csrfToken) {
            throw new Error('Token CSRF introuvable (aucune source trouvée)');
        }
        console.log(`🔑 Token CSRF utilisé : ${csrfToken}`);

        // 4) Envoi de la requête de déconnexion
        console.log('📤 Envoi de la requête de déconnexion...');
        await page.evaluate(async (token) => {
            const formData = new FormData();
            formData.append('action', 'logout');
            formData.append('csrf_test_name', token);
            await fetch('process.php', {
                method: 'POST',
                body: formData
            });
        }, csrfToken);

        await delay(5000); // Attendre mise à jour des cookies / redirection

        // 5) Vérification de la déconnexion
        console.log('🔄 Vérification : rechargement faucet.php');
        await page.goto(faucetUrl, { waitUntil: 'networkidle2', timeout: 15000 });
        await delay(5000);

        const finalUrl = page.url();
        const loginBtnVisible = await page.evaluate(() => {
            const btns = [...document.querySelectorAll('button')];
            return btns.some(b => b.textContent.trim() === 'Log in');
        });

        if (finalUrl.includes('login.php') || loginBtnVisible) {
            console.log(`✅ Déconnexion confirmée (${finalUrl.includes('login.php') ? 'redirigé' : 'bouton Log in présent'})`);
            return true;
        } else {
            throw new Error('Échec de la déconnexion : ni redirection, ni bouton Log in');
        }
    } finally {
        await browser.close().catch(() => {});
    }
}

// ---------- Main ----------
(async () => {
    try {
        let accounts = await loadAccounts();
        const normalizedEmail = email.trim().toLowerCase();
        const idx = accounts.findIndex(a => a.email.toLowerCase() === normalizedEmail);
        if (idx === -1) {
            console.log(`ℹ️ Le compte ${normalizedEmail} n’existe pas dans la base.`);
            process.exit(0);
        }

        const account = accounts[idx];
        console.log(`🔍 Compte trouvé : ${account.email}`);

        if (!account.cookies || account.cookiesStatus === 'expired') {
            console.log('⏩ Cookies déjà expirés, suppression directe.');
        } else {
            await performNormalLogout(account.cookies);
        }

        accounts.splice(idx, 1);
        await saveAccounts(accounts);
        console.log(`🗑️ Compte ${normalizedEmail} supprimé avec succès.`);
        process.exit(0);
    } catch (err) {
        console.error('❌ Erreur fatale :', err.message);
        process.exit(1);
    }
})();
