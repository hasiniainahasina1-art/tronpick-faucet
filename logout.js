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

// ---------- Fonctions GitHub ----------
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
        message: `Déconnexion – suppression de ${email}`,
        content,
        branch: GH_BRANCH,
        sha
    });
}

// ---------- Logique de déconnexion ----------
async function performLogout() {
    const proxyUrl = JP_PROXY_LIST[proxyIndex] || JP_PROXY_LIST[0];
    if (!proxyUrl) throw new Error('Aucun proxy valide trouvé pour l’index ' + proxyIndex);
    const proxyConfig = parseProxyUrl(proxyUrl);
    if (!proxyConfig) throw new Error('Proxy invalide');

    console.log(`🔌 Déconnexion de ${email} sur ${platform}.io via proxy ${proxyConfig.server}`);

    const { browser, page } = await connect({
        headless: false,          // on utilise xvfb-run, donc ok
        turnstile: false,         // pas besoin de turnstile pour logout
        proxy: proxyConfig,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    try {
        await page.setViewport({ width: 1280, height: 720 });

        // 1) Aller directement sur la page de déconnexion
        const logoutUrl = `https://${platform}.io/logout.php`;
        console.log(`🌐 Accès à ${logoutUrl}`);
        await page.goto(logoutUrl, { waitUntil: 'networkidle2', timeout: 30000 });
        await delay(3000);
        await page.screenshot({ path: path.join(screenshotsDir, `01_logout_${email.replace(/[^a-zA-Z0-9]/g, '_')}.png`) });

        // 2) Vérifier le résultat
        const currentUrl = page.url();
        console.log(`📍 URL actuelle : ${currentUrl}`);
        // En général, après logout on est redirigé vers login.php ou la page d'accueil
        const isLoggedOut = currentUrl.includes('login.php') || currentUrl.includes('index.php') || !currentUrl.includes('logout.php');

        if (isLoggedOut) {
            console.log('✅ Déconnexion réussie');
            await page.screenshot({ path: path.join(screenshotsDir, `02_logout_success_${email.replace(/[^a-zA-Z0-9]/g, '_')}.png`) });
            return true;
        } else {
            // Si on est resté sur logout.php ou autre, essayer de cliquer sur un bouton de confirmation hypothétique
            console.log('⚠️ Pas de redirection immédiate, recherche d’un bouton de déconnexion…');
            const clicked = await page.evaluate(() => {
                const btns = [...document.querySelectorAll('button, input[type="submit"], a')];
                const logoutBtn = btns.find(b => /log\s*out|déconnexion|sign out/i.test(b.textContent));
                if (logoutBtn) { logoutBtn.click(); return true; }
                return false;
            });
            if (clicked) {
                await page.waitForNavigation({ timeout: 10000 }).catch(() => {});
                await delay(3000);
                const newUrl = page.url();
                console.log(`📍 URL après clic : ${newUrl}`);
                if (newUrl.includes('login.php') || !newUrl.includes('logout.php')) {
                    console.log('✅ Déconnexion réussie via bouton');
                    return true;
                }
            }
            throw new Error('La déconnexion semble avoir échoué');
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

        console.log(`🔍 Compte trouvé : ${accounts[idx].email}`);
        // Tenter la déconnexion même si les cookies sont expirés
        await performLogout();

        // Supprimer le compte du tableau local et sauvegarder
        accounts.splice(idx, 1);
        await saveAccounts(accounts);
        console.log(`🗑️ Compte ${normalizedEmail} supprimé avec succès.`);
        process.exit(0);
    } catch (err) {
        console.error('❌ Erreur fatale :', err.message);
        process.exit(1);
    }
})();
