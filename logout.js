const { connect } = require('puppeteer-real-browser');
const { Octokit } = require('@octokit/rest');
const { PuppeteerScreenRecorder } = require('puppeteer-screen-recorder');
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

const TURNSTILE_LOGIN_COORDS = { x: 640, y: 615 }; // fallback
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

async function fillField(page, selector, value, fieldName) {
    await page.waitForSelector(selector, { timeout: 10000 });
    await page.click(selector, { clickCount: 3 });
    await page.keyboard.press('Backspace');
    await delay(100);
    await page.evaluate((sel, val) => {
        const el = document.querySelector(sel);
        if (el) el.value = val;
    }, selector, value);
    await delay(300);
    let actual = await page.$eval(selector, el => el.value);
    if (actual !== value) {
        await page.click(selector, { clickCount: 3 });
        await page.keyboard.press('Backspace');
        for (const char of value) await page.keyboard.type(char, { delay: 30 });
    }
}

async function addRedDot(page, x, y) {
    await page.evaluate((x, y) => {
        const dot = document.createElement('div');
        dot.style.position = 'fixed';
        dot.style.left = (x - 5) + 'px';
        dot.style.top = (y - 5) + 'px';
        dot.style.width = '10px';
        dot.style.height = '10px';
        dot.style.borderRadius = '50%';
        dot.style.backgroundColor = 'red';
        dot.style.zIndex = '99999';
        dot.style.pointerEvents = 'none';
        dot.id = 'click-dot';
        document.body.appendChild(dot);
        setTimeout(() => dot.remove(), 5000);
    }, x, y);
    await delay(500);
}

async function humanClickAt(page, coords) {
    await addRedDot(page, coords.x, coords.y);
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
    console.log(`🖱️ Clic à (${coords.x}, ${coords.y}) avec point rouge`);
    await delay(500);
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

// ========== SÉQUENCE DE DÉCONNEXION AVEC VIDÉO ==========
async function logoutSequence(account) {
    const { email, cookies, platform } = account;
    console.log(`🚪 Déconnexion pour ${email}`);

    const faucetUrl = `https://${platform}.io/faucet.php`;
    const proxyUrl = getProxyUrlForAccount(account);
    if (!proxyUrl) throw new Error('Aucun proxy fourni');

    let browser;
    let recorder;
    try {
        const { browser: br, page } = await connectWithProxy(proxyUrl);
        browser = br;
        await page.setCookie(...cookies);
        await page.goto(faucetUrl, { waitUntil: 'networkidle2', timeout: 30000 });
        await delay(5000);
        if (page.url().includes('login.php')) throw new Error('Cookies expirés');

        // Étape 1 : attendre 5s
        console.log('⏳ Attente de 5 secondes...');
        await delay(5000);

        // Étape 2 : actualiser
        console.log('🔄 Actualisation de la page...');
        await page.reload({ waitUntil: 'networkidle2', timeout: 30000 });
        await page.screenshot({ path: path.join(screenshotsDir, `01_after_reload_${email.replace(/[^a-zA-Z0-9]/g, '_')}.png`), fullPage: true });

        // Étape 3 : attendre 20s
        console.log('⏳ Attente de 20 secondes...');
        await delay(20000);
        await page.screenshot({ path: path.join(screenshotsDir, `02_after_wait_${email.replace(/[^a-zA-Z0-9]/g, '_')}.png`), fullPage: true });

        // Démarrer l'enregistrement vidéo avant le premier clic
        const videoPath = path.join(screenshotsDir, `logout_video_${email.replace(/[^a-zA-Z0-9]/g, '_')}.mp4`);
        recorder = new PuppeteerScreenRecorder(page);
        await recorder.start(videoPath);

        // Étape 4 : premier clic (645,40)
        console.log(`🖱️ Premier clic à (645, 40)`);
        await humanClickAt(page, { x: 645, y: 40 });
        await page.screenshot({ path: path.join(screenshotsDir, `03_after_first_click_${email.replace(/[^a-zA-Z0-9]/g, '_')}.png`), fullPage: true });

        // Attendre 5 secondes (délai entre les deux clics)
        console.log('⏳ Attente de 5 secondes avant le deuxième clic...');
        await delay(5000);

        // Étape 5 : deuxième clic (450,270)
        console.log(`🖱️ Deuxième clic à (450, 270)`);
        await humanClickAt(page, { x: 450, y: 270 });
        await page.screenshot({ path: path.join(screenshotsDir, `04_after_second_click_${email.replace(/[^a-zA-Z0-9]/g, '_')}.png`), fullPage: true });

        // Attendre que la déconnexion se produise
        console.log('⏳ Attente de 10 secondes pour observer le résultat...');
        await delay(10000);
        await page.screenshot({ path: path.join(screenshotsDir, `05_final_${email.replace(/[^a-zA-Z0-9]/g, '_')}.png`), fullPage: true });

        // Arrêter la vidéo
        await recorder.stop();

        // Vérifier la déconnexion
        const currentUrl = page.url();
        const isLoggedOut = currentUrl.includes('login.php') || currentUrl.includes('logout') || currentUrl.includes('index.php');
        let logoutMessage = '';
        if (!isLoggedOut) {
            logoutMessage = await page.evaluate(() => {
                const msg = document.querySelector('.alert-success, .alert-info, .message, .toast');
                return msg ? msg.textContent.trim() : '';
            }).catch(() => '');
        }
        const success = isLoggedOut || logoutMessage.toLowerCase().includes('logout') || logoutMessage.toLowerCase().includes('déconnecté');
        console.log(`🔍 Résultat : URL=${currentUrl}, message="${logoutMessage}", succès=${success}`);
        return success;
    } catch (error) {
        if (recorder) await recorder.stop().catch(() => {});
        if (error.message.includes('Cookies expirés')) {
            console.log(`🔄 Cookies expirés pour ${email}, reconnexion...`);
            try {
                const newCookies = await performLoginAndCaptureCookies(account);
                account.cookies = newCookies;
                account.cookiesStatus = 'valid';
                return await logoutSequence(account);
            } catch (loginError) {
                console.error(`❌ Échec reconnexion : ${loginError.message}`);
                return false;
            }
        }
        console.error(`❌ Erreur : ${error.message}`);
        return false;
    } finally {
        if (browser) await browser.close().catch(() => {});
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
        console.error('❌ Erreur fatale :', err);
        process.exit(1);
    }
})();
