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

async function performNormalLogout(accountCookies) {
    const proxyUrl = JP_PROXY_LIST[proxyIndex] || JP_PROXY_LIST[0];
    const proxyConfig = parseProxyUrl(proxyUrl);
    if (!proxyConfig) throw new Error('Proxy invalide');

    console.log(`🔌 Déconnexion douce de ${email} sur ${platform}.io`);

    const { browser, page } = await connect({
        headless: false,
        turnstile: false,
        proxy: proxyConfig,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    try {
        await page.setViewport({ width: 1280, height: 720 });

        if (accountCookies && accountCookies.length > 0) {
            await page.setCookie(...accountCookies);
            console.log(`🍪 ${accountCookies.length} cookie(s) injecté(s)`);
        }

        const faucetUrl = `https://${platform}.io/faucet.php`;
        await page.goto(faucetUrl, { waitUntil: 'networkidle2', timeout: 30000 });
        await delay(3000);

        if (page.url().includes('login.php')) {
            console.log('ℹ️ Session déjà expirée');
            return true;
        }

        await page.screenshot({ path: path.join(screenshotsDir, `01_before_logout_${email.replace(/[^a-zA-Z0-9]/g, '_')}.png`) });

        // Chercher le bouton
        const logoutBtnInfo = await page.evaluate(() => {
            const candidates = [...document.querySelectorAll('button, a, input[type="submit"], div[role="button"]')];
            const btn = candidates.find(el => {
                const txt = el.textContent?.toLowerCase() || '';
                return txt.includes('log out') || txt.includes('logout') || txt.includes('déconnexion') || txt.includes('sign out');
            });
            if (btn) {
                const rect = btn.getBoundingClientRect();
                return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, tag: btn.tagName, text: btn.textContent.trim() };
            }
            return null;
        });

        if (logoutBtnInfo) {
            console.log(`🖱️ Clic sur "${logoutBtnInfo.text}"`);
            await humanClickAt(page, { x: logoutBtnInfo.x, y: logoutBtnInfo.y });

            // Gérer boîte de dialogue éventuelle
            await delay(1000);
            const dialogVisible = await page.evaluate(() => {
                const modals = document.querySelectorAll('.modal, .dialog, [role="dialog"], .popup');
                return Array.from(modals).some(m => m.offsetParent !== null);
            });
            if (dialogVisible) {
                console.log('🔔 Boîte de dialogue détectée');
                // essayer bouton confirmer
                const clicked = await page.evaluate(() => {
                    const btns = [...document.querySelectorAll('button')];
                    const confirmBtn = btns.find(b => /yes|ok|confirm|oui|valider/i.test(b.textContent));
                    if (confirmBtn) { confirmBtn.click(); return true; }
                    return false;
                });
                if (!clicked) await page.keyboard.press('Escape');
                await delay(2000);
            }
        } else {
            console.log('⚠️ Aucun bouton trouvé, tentative via /logout.php');
            await page.goto(`https://${platform}.io/logout.php`, { waitUntil: 'networkidle2', timeout: 15000 });
            await delay(3000);
        }

        // 💡 Étape clé : vider les cookies pour forcer la vérification
        console.log('🧹 Suppression forcée des cookies...');
        const client = await page.target().createCDPSession();
        await client.send('Network.clearBrowserCookies');

        // Recharger faucet.php → doit rediriger vers login.php
        console.log('🔄 Vérification : chargement faucet.php sans cookies');
        await page.goto(faucetUrl, { waitUntil: 'networkidle2', timeout: 15000 });
        await delay(3000);

        if (page.url().includes('login.php')) {
            console.log('✅ Session bien détruite (redirigé vers login)');
            await page.screenshot({ path: path.join(screenshotsDir, `02_logout_success_${email.replace(/[^a-zA-Z0-9]/g, '_')}.png`) });
            return true;
        } else {
            throw new Error('Redirection vers login.php absente après suppression des cookies');
        }
    } finally {
        await browser.close().catch(() => {});
    }
}

(async () => {
    try {
        let accounts = await loadAccounts();
        const normalizedEmail = email.trim().toLowerCase();
        const idx = accounts.findIndex(a => a.email.toLowerCase() === normalizedEmail);
        if (idx === -1) {
            console.log(`ℹ️ Compte ${normalizedEmail} inexistant.`);
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
