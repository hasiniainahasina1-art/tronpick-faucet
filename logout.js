const { connect } = require('puppeteer-real-browser');
const { Octokit } = require('@octokit/rest');
const fs = require('fs');
const path = require('path');

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

const JP_PROXY_LIST = (process.env.JP_PROXY_LIST || '').split(',').filter(p => p.trim() !== '');
if (JP_PROXY_LIST.length === 0) {
    console.error('❌ JP_PROXY_LIST doit contenir au moins 1 proxy');
    process.exit(1);
}
console.log(`🌐 ${JP_PROXY_LIST.length} proxy(s) chargé(s).`);

const screenshotsDir = path.join(__dirname, 'screenshots');
if (!fs.existsSync(screenshotsDir)) fs.mkdirSync(screenshotsDir, { recursive: true });

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function parseProxyUrl(proxyUrl) {
    if (!proxyUrl) return null;
    proxyUrl = proxyUrl.trim();
    const match = proxyUrl.match(/^http:\/\/([^:]+):([^@]+)@([^:]+):(\d+)$/);
    if (!match) {
        console.error('❌ Format HTTP invalide (attendu: http://user:pass@ip:port) :', proxyUrl);
        return null;
    }
    return {
        server: `http://${match[3]}:${match[4]}`,
        username: match[1],
        password: match[2]
    };
}

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
        message: 'Logout - remove account',
        content,
        branch: GH_BRANCH,
        sha
    });
}

function getProxyUrlForAccount(account) {
    if (account.proxyIndex !== undefined && JP_PROXY_LIST[account.proxyIndex]) {
        return JP_PROXY_LIST[account.proxyIndex];
    }
    return JP_PROXY_LIST[0];
}

async function connectWithProxy(proxyUrl) {
    const proxyConfig = parseProxyUrl(proxyUrl);
    if (!proxyConfig) throw new Error('Proxy invalide');
    console.log(`🔄 Connexion avec proxy : ${proxyConfig.server}`);
    const { browser, page } = await connect({
        headless: false,
        turnstile: true,
        proxy: proxyConfig,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    return { browser, page };
}

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
    const proxyUrl = getProxyUrlForAccount(account);
    if (!proxyUrl) throw new Error('Aucun proxy fourni');

    let browser;
    try {
        const { browser: br, page } = await connectWithProxy(proxyUrl);
        browser = br;
        await page.setViewport({ width: 1280, height: 720 });
        await page.goto(loginUrl, { waitUntil: 'networkidle2', timeout: 60000 });
        await page.type('input[type="email"], input[name="email"]', email);
        await page.type('input[type="password"]', password);
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
            await page.mouse.click(640, 615);
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

// ========== DÉCONNEXION PAR REQUÊTE POST (avec CSRF) ==========
async function logoutSequence(account) {
    const { email, cookies, platform } = account;
    console.log(`🚪 Déconnexion pour ${email} via requête POST`);

    const proxyUrl = getProxyUrlForAccount(account);
    if (!proxyUrl) throw new Error('Aucun proxy fourni');

    let browser;
    try {
        const { browser: br, page } = await connectWithProxy(proxyUrl);
        browser = br;
        await page.setCookie(...cookies);

        // Aller sur la page du faucet pour récupérer le jeton CSRF
        await page.goto(`https://${platform}.io/faucet.php`, { waitUntil: 'networkidle2', timeout: 30000 });
        await delay(2000);

        // Récupérer le jeton CSRF (soit depuis un cookie, soit depuis un champ caché)
        const csrfToken = await page.evaluate(() => {
            // Essayer de lire le cookie csrf_cookie_name
            const cookieValue = document.cookie.split('; ').find(row => row.startsWith('csrf_cookie_name='));
            if (cookieValue) return cookieValue.split('=')[1];
            // Sinon chercher un champ caché avec name="csrf_test_name"
            const hiddenField = document.querySelector('input[name="csrf_test_name"]');
            if (hiddenField) return hiddenField.value;
            return null;
        });

        if (!csrfToken) {
            console.error('❌ Impossible de récupérer le jeton CSRF');
            await browser.close();
            return false;
        }
        console.log(`🔑 Jeton CSRF récupéré: ${csrfToken}`);

        // Construire les données POST
        const postData = new URLSearchParams();
        postData.append('action', 'logout');
        postData.append('csrf_test_name', csrfToken);

        // Envoyer la requête POST avec les cookies actifs
        const response = await page.evaluate(async (data) => {
            const res = await fetch('/process.php', {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: data
            });
            return { status: res.status, text: await res.text() };
        }, postData.toString());

        console.log(`📡 Réponse du serveur: status ${response.status}, body: "${response.text}"`);

        if (response.status === 200 && response.text.includes('success')) {
            console.log('✅ Déconnexion confirmée par le serveur');
            await browser.close();
            return true;
        } else {
            console.log('❌ La requête de déconnexion n\'a pas abouti');
            await browser.close();
            return false;
        }
    } catch (error) {
        if (browser) await browser.close();
        console.error(`❌ Erreur lors de la déconnexion : ${error.message}`);
        return false;
    }
}

// ========== MAIN ==========
(async () => {
    try {
        let accounts = await loadAccounts();
        console.log(`📋 Comptes chargés : ${accounts.length}`);
        if (!accounts.length) return;

        const targetEmail = process.env.LOGOUT_EMAIL;
        if (!targetEmail) {
            console.error('❌ Aucun email fourni (LOGOUT_EMAIL)');
            process.exit(1);
        }
        const normalizedEmail = targetEmail.trim().toLowerCase();
        const accountIndex = accounts.findIndex(a => a.email.toLowerCase() === normalizedEmail);
        if (accountIndex === -1) {
            console.log(`❌ Compte ${normalizedEmail} non trouvé dans accounts.json`);
            process.exit(1);
        }

        const account = accounts[accountIndex];
        if (!account.cookies || account.cookies.length === 0) {
            console.log(`❌ Aucun cookie pour ${account.email}, tentative de login...`);
            try {
                const newCookies = await performLoginAndCaptureCookies(account);
                account.cookies = newCookies;
                account.cookiesStatus = 'valid';
            } catch (e) {
                console.error(`❌ Échec login : ${e.message}`);
                process.exit(1);
            }
        }

        console.log(`\n===== Traitement : ${account.email} =====`);
        const proxyUrl = getProxyUrlForAccount(account);
        console.log(`🔄 Proxy fixe : ${proxyUrl} (index ${account.proxyIndex})`);

        const success = await logoutSequence(account);
        if (success) {
            accounts.splice(accountIndex, 1);
            await saveAccounts(accounts);
            console.log(`✅ Déconnexion réussie pour ${account.email}, compte supprimé.`);
            process.exit(0);
        } else {
            console.log(`❌ Déconnexion échouée pour ${account.email}, compte non supprimé.`);
            process.exit(1);
        }
    } catch (err) {
        console.error('❌ Erreur fatale:', err);
        process.exit(1);
    }
})();
