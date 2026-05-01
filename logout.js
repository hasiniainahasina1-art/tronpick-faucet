const { connect } = require('puppeteer-real-browser');
const { Octokit } = require('@octokit/rest');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const email = process.env.LOGOUT_EMAIL;
const password = process.env.LOGOUT_PASSWORD;
const platform = process.env.LOGOUT_PLATFORM;
const proxyIndex = process.env.LOGOUT_PROXY_INDEX !== undefined ? parseInt(process.env.LOGOUT_PROXY_INDEX) : 0;

const GH_TOKEN = process.env.GH_TOKEN;
const GH_USERNAME = process.env.GH_USERNAME;
const GH_REPO = process.env.GH_REPO;
const GH_BRANCH = process.env.GH_BRANCH || 'main';
const USER_ID = process.env.USER_ID;
const CRYPTO_SECRET = process.env.CRYPTO_SECRET;

if (!CRYPTO_SECRET || !USER_ID) {
    console.error('❌ CRYPTO_SECRET ou USER_ID manquant');
    process.exit(1);
}

// ✅ Fichier individuel
const USER_FILE = `account_${USER_ID}_${platform}_${email}.json`;
const GLOBAL_FILE = 'global_accounts.json';
const KEY = crypto.createHash('sha256').update(CRYPTO_SECRET).digest();

function encrypt(text) {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-cbc', KEY, iv);
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    return iv.toString('hex') + ':' + encrypted;
}
function decrypt(encryptedText) {
    const parts = encryptedText.split(':');
    if (parts.length !== 2) return encryptedText;
    try {
        const iv = Buffer.from(parts[0], 'hex');
        const encrypted = parts[1];
        const decipher = crypto.createDecipheriv('aes-256-cbc', KEY, iv);
        let decrypted = decipher.update(encrypted, 'hex', 'utf8');
        decrypted += decipher.final('utf8');
        return decrypted;
    } catch (e) { return encryptedText; }
}

if (!email || !password || !platform) {
    console.error('❌ LOGOUT_EMAIL, LOGOUT_PASSWORD et LOGOUT_PLATFORM sont requis.');
    process.exit(1);
}
if (!GH_TOKEN || !GH_USERNAME || !GH_REPO) {
    console.error('❌ Variables GitHub manquantes');
    process.exit(1);
}

const JP_PROXY_LIST = (process.env.JP_PROXY_LIST || '').split(',').filter(p => p.trim() !== '');
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
    const isSocks = proxyUrl.startsWith('socks5://') || proxyUrl.startsWith('socks://');
    const protocol = isSocks ? 'socks5' : 'http';
    const match = proxyUrl.match(/^(socks5?:\/\/)?(?:([^:]+):([^@]+)@)?([^:]+):(\d+)$/);
    if (!match) { console.error('❌ Format HTTP invalide'); return null; }
    return {
        server: `${protocol}://${match[4]}:${match[5]}`,
        username: match[2] || null,
        password: match[3] || null
    };
}

// ✅ Chargement du compte individuel
async function loadAccount() {
    try {
        const res = await octokit.repos.getContent({
            owner: GH_USERNAME,
            repo: GH_REPO,
            path: USER_FILE,
            ref: GH_BRANCH
        });
        return JSON.parse(Buffer.from(res.data.content, 'base64').toString('utf8'));
    } catch (e) {
        if (e.status === 404) return null;   // fichier inexistant
        throw e;
    }
}

// ✅ Suppression du fichier individuel
async function deleteAccountFile() {
    try {
        const res = await octokit.repos.getContent({
            owner: GH_USERNAME,
            repo: GH_REPO,
            path: USER_FILE,
            ref: GH_BRANCH
        });
        const sha = res.data.sha;
        await octokit.repos.deleteFile({
            owner: GH_USERNAME,
            repo: GH_REPO,
            path: USER_FILE,
            message: `Suppression du compte ${email}`,
            sha,
            branch: GH_BRANCH
        });
        console.log(`🗑️ Fichier ${USER_FILE} supprimé.`);
    } catch (e) {
        if (e.status === 404) {
            console.log('ℹ️ Le fichier individuel n\'existe pas, rien à supprimer.');
        } else {
            console.error('❌ Erreur suppression fichier :', e.message);
        }
    }
}

// ✅ Suppression de la liste globale
async function removeFromGlobalList(email, platform) {
    try {
        let entries = [];
        let sha = null;
        try {
            const res = await octokit.repos.getContent({
                owner: GH_USERNAME,
                repo: GH_REPO,
                path: GLOBAL_FILE,
                ref: GH_BRANCH
            });
            entries = JSON.parse(Buffer.from(res.data.content, 'base64').toString('utf8'));
            sha = res.data.sha;
        } catch (e) {
            console.log('ℹ️ Fichier global introuvable, rien à supprimer.');
            return;
        }

        const newEntries = entries.filter(e => !(e.email === email && e.platform === platform));
        if (newEntries.length === entries.length) {
            console.log('ℹ️ Compte non trouvé dans la liste globale.');
            return;
        }

        const content = Buffer.from(JSON.stringify(newEntries, null, 2)).toString('base64');
        await octokit.repos.createOrUpdateFileContents({
            owner: GH_USERNAME,
            repo: GH_REPO,
            path: GLOBAL_FILE,
            message: `Suppression de ${email} (${platform}) de la liste globale`,
            content,
            branch: GH_BRANCH,
            sha
        });
        console.log('✅ Compte retiré de la liste globale.');
    } catch (error) {
        console.error('❌ Erreur suppression globale :', error.message);
    }
}

// --- Fonctions Puppeteer (identiques à script.js) ---
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

async function extractCsrfToken(page) {
    const cookies = await page.cookies();
    const csrfCookie = cookies.find(c => c.name === 'csrf_cookie_name');
    if (csrfCookie && csrfCookie.value) return csrfCookie.value;
    const token = await page.evaluate(() => {
        const el = document.querySelector('input[name="csrf_test_name"]');
        return el ? el.value : null;
    });
    return token;
}

// --- Déconnexion humaine ---
async function performNormalLogout(accountCookies) {
    const proxyUrl = JP_PROXY_LIST[proxyIndex] || JP_PROXY_LIST[0];
    const proxyConfig = parseProxyUrl(proxyUrl);
    if (!proxyConfig) throw new Error('Proxy invalide');

    console.log(`🔌 Déconnexion de ${email} sur ${platform}.io via proxy ${proxyConfig.server}`);

    const options = {
        headless: false,
        turnstile: false,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    };
    if (proxyConfig.username && proxyConfig.password) {
        options.proxy = `${proxyConfig.server.replace('://', '://' + proxyConfig.username + ':' + proxyConfig.password + '@')}`;
    } else {
        options.proxy = proxyConfig.server;
    }

    const { browser, page } = await connect(options);

    try {
        await page.setViewport({ width: 1280, height: 720 });

        if (accountCookies && accountCookies.length > 0) {
            await page.setCookie(...accountCookies);
            console.log(`🍪 ${accountCookies.length} cookie(s) injecté(s)`);
        }

        const faucetUrl = `https://${platform}.io/faucet.php`;
        await page.goto(faucetUrl, { waitUntil: 'networkidle2', timeout: 30000 });
        console.log('⏳ Attente 20 secondes (stabilisation)...');
        await delay(20000);

        if (page.url().includes('login.php')) {
            console.log('ℹ️ Session déjà expirée');
            return true;
        }

        await page.screenshot({ path: path.join(screenshotsDir, `01_before_logout_${email.replace(/[^a-zA-Z0-9]/g, '_')}.png`), fullPage: true });

        // Chercher le bouton de déconnexion
        const logoutCoords = await page.evaluate(() => {
            const candidates = [...document.querySelectorAll('button, a, div[role="button"], input[type="submit"]')];
            const btn = candidates.find(el => {
                const txt = el.textContent?.toLowerCase() || '';
                return txt.includes('log out') || txt.includes('logout') || txt.includes('déconnexion') || txt.includes('sign out');
            });
            if (btn) {
                const rect = btn.getBoundingClientRect();
                return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, text: btn.textContent.trim() };
            }
            return null;
        });

        if (logoutCoords) {
            console.log(`🖱️ Clic humain sur "${logoutCoords.text}"`);
            await humanClickAt(page, logoutCoords);

            await delay(1000);
            const dialogVisible = await page.evaluate(() => {
                const modals = document.querySelectorAll('.modal, .dialog, [role="dialog"], .popup');
                return Array.from(modals).some(m => m.offsetParent !== null);
            });
            if (dialogVisible) {
                console.log('🔔 Boîte de confirmation détectée');
                const confirmClicked = await page.evaluate(() => {
                    const btns = [...document.querySelectorAll('button')];
                    const confirmBtn = btns.find(b => /yes|ok|confirm|oui|valider/i.test(b.textContent));
                    if (confirmBtn) { confirmBtn.click(); return true; }
                    return false;
                });
                if (!confirmClicked) await page.keyboard.press('Escape');
                await delay(2000);
            }

            try {
                await page.waitForFunction(() => window.location.href.includes('login.php'), { timeout: 15000 });
                console.log('✅ Redirigé vers login.php');
                return true;
            } catch {
                const finalUrl = page.url();
                if (finalUrl.includes('login.php')) return true;
                console.warn('⚠️ Pas de redirection, recharge pour vérifier...');
                await page.goto(faucetUrl, { waitUntil: 'networkidle2', timeout: 10000 });
                await delay(5000);
                if (page.url().includes('login.php')) return true;
            }
        } else {
            console.log('⚠️ Aucun bouton trouvé, tentative fallback POST...');
            const csrfToken = await extractCsrfToken(page);
            if (!csrfToken) throw new Error('Token CSRF introuvable');
            await page.evaluate(async (token) => {
                const formData = new FormData();
                formData.append('action', 'logout');
                formData.append('csrf_test_name', token);
                await fetch('process.php', { method: 'POST', body: formData });
            }, csrfToken);
            await delay(5000);
            await page.goto(faucetUrl, { waitUntil: 'networkidle2', timeout: 10000 });
            await delay(5000);
            if (page.url().includes('login.php')) return true;
        }
        throw new Error('Échec de la déconnexion');
    } finally {
        await browser.close().catch(() => {});
    }
}

// --- Main ---
(async () => {
    try {
        // 1. Charger le compte individuel
        const account = await loadAccount();
        if (!account) {
            console.log(`ℹ️ Le compte ${email} n'existe pas dans la base.`);
            process.exit(0);
        }

        console.log(`🔍 Compte trouvé : ${account.email}`);

        // 2. Déchiffrer les champs sensibles
        if (account.password) account.password = decrypt(account.password);
        if (typeof account.cookies === 'string' && account.cookies) {
            try { account.cookies = JSON.parse(decrypt(account.cookies)); } catch {}
        }

        // 3. Déconnexion réelle si les cookies sont valides
        if (account.cookies && account.cookies.length > 0 && account.cookiesStatus !== 'expired') {
            account.pendingLogout = true;
            // Pas besoin de sauvegarder le flag ici car nous allons supprimer le fichier après
            await performNormalLogout(account.cookies);
        } else {
            console.log('⏩ Cookies déjà expirés ou absents, pas de déconnexion nécessaire.');
        }

        // 4. Supprimer le fichier individuel
        await deleteAccountFile();

        // 5. Retirer de la liste globale
        await removeFromGlobalList(email, platform);

        console.log(`✅ Compte ${email} entièrement supprimé.`);
        process.exit(0);
    } catch (err) {
        console.error('❌ Erreur fatale :', err.message);
        process.exit(1);
    }
})();
