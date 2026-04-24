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

// ---------- Déconnexion par requête POST avec extraction robuste du CSRF ----------
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

        // 1) Injecter les cookies
        if (accountCookies && accountCookies.length > 0) {
            await page.setCookie(...accountCookies);
            console.log(`🍪 ${accountCookies.length} cookie(s) injecté(s)`);
        }

        // 2) Aller sur faucet.php
        const faucetUrl = `https://${platform}.io/faucet.php`;
        await page.goto(faucetUrl, { waitUntil: 'networkidle2', timeout: 30000 });
        await delay(5000); // délai supplémentaire pour la stabilisation complète

        // Vérifier si déjà redirigé vers login
        if (page.url().includes('login.php')) {
            console.log('ℹ️ Session déjà expirée');
            return true;
        }

        // 3) Extraction robuste du token CSRF avec retry
        let csrfToken = null;
        for (let attempt = 1; attempt <= 3; attempt++) {
            console.log(`🔍 Tentative ${attempt} de récupération du token CSRF...`);
            try {
                await page.waitForSelector('input[name="csrf_test_name"]', { timeout: 10000 });
                csrfToken = await page.$eval('input[name="csrf_test_name"]', el => el.value);
                if (csrfToken) break;
            } catch (e) {
                console.warn(`⚠️ Tentative ${attempt} échouée`);
                if (attempt < 3) {
                    console.log('🔄 Rechargement de la page...');
                    await page.reload({ waitUntil: 'networkidle2', timeout: 30000 });
                    await delay(5000);
                }
            }
        }

        if (!csrfToken) {
            // Capture pour débogage
            await page.screenshot({ path: path.join(screenshotsDir, `csrf_not_found_${email.replace(/[^a-zA-Z0-9]/g, '_')}.png`), fullPage: true });
            throw new Error('Token CSRF introuvable après plusieurs tentatives (capture sauvegardée)');
        }

        console.log(`🔑 Token CSRF récupéré : ${csrfToken}`);

        // 4) Envoyer la requête de déconnexion
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

        await delay(4000); // attendre la mise à jour des cookies et d'éventuelles redirections

        // 5) Vérifier la déconnexion
        console.log('🔄 Vérification : rechargement faucet.php');
        await page.goto(faucetUrl, { waitUntil: 'networkidle2', timeout: 15000 });
        await delay(4000);

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
