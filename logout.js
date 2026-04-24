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

const TURNSTILE_LOGIN_COORDS = { x: 640, y: 615 };
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
            await page.mouse.click(TURNSTILE_LOGIN_COORDS.x, TURNSTILE_LOGIN_COORDS.y);
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

// ========== DÉCONNEXION SANS INTERACTION SOURIS ==========
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

        // Attente initiale
        console.log('⏳ Attente de 5 secondes...');
        await delay(5000);
        console.log('🔄 Actualisation de la page...');
        await page.reload({ waitUntil: 'networkidle2', timeout: 30000 });
        await page.screenshot({ path: path.join(screenshotsDir, `01_after_reload_${email.replace(/[^a-zA-Z0-9]/g, '_')}.png`), fullPage: true });
        console.log('⏳ Attente de 20 secondes...');
        await delay(20000);
        await page.screenshot({ path: path.join(screenshotsDir, `02_after_wait_${email.replace(/[^a-zA-Z0-9]/g, '_')}.png`), fullPage: true });

        // Démarrer la vidéo
        const videoPath = path.join(screenshotsDir, `logout_video_${email.replace(/[^a-zA-Z0-9]/g, '_')}.mp4`);
        recorder = new PuppeteerScreenRecorder(page);
        await recorder.start(videoPath);

        // Recherche directe de "Logout" dans tout le DOM
        const logoutSelector = await page.evaluate(() => {
            const keywords = ['logout', 'sign out', 'déconnexion', 'se déconnecter', 'log out'];
            const all = [...document.querySelectorAll('*')];
            const element = all.find(el => {
                const text = (el.textContent || '').trim().toLowerCase();
                return keywords.some(kw => text === kw || text.includes(kw));
            });
            if (element) {
                const rect = element.getBoundingClientRect();
                return { found: true, x: rect.x + rect.width/2, y: rect.y + rect.height/2, visible: rect.width > 0 && rect.height > 0 };
            }
            return { found: false };
        });

        let logoutClicked = false;
        if (logoutSelector.found) {
            console.log(`✅ Logout trouvé directement (visible: ${logoutSelector.visible}) à (${Math.round(logoutSelector.x)}, ${Math.round(logoutSelector.y)})`);
            if (!logoutSelector.visible) {
                // Rendre visible
                await page.evaluate(() => {
                    const el = document.elementFromPoint(logoutSelector.x, logoutSelector.y);
                    if (el) el.style.display = 'block';
                });
            }
            // Cliquer via DOM
            await page.evaluate((x, y) => {
                const el = document.elementFromPoint(x, y);
                if (el) el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
            }, logoutSelector.x, logoutSelector.y);
            logoutClicked = true;
        } else {
            // Fallback : ouvrir le menu via clic DOM à (645,40) puis rechercher
            console.log('⚠️ Logout non trouvé directement, tentative d\'ouverture du menu');
            await page.evaluate(() => {
                const el = document.elementFromPoint(645, 40);
                if (el) el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
            });
            await delay(2000);
            const retry = await page.evaluate(() => {
                const keywords = ['logout', 'sign out', 'déconnexion', 'se déconnecter', 'log out'];
                const all = [...document.querySelectorAll('*')];
                const el = all.find(el => {
                    const text = (el.textContent || '').trim().toLowerCase();
                    return keywords.some(kw => text === kw || text.includes(kw));
                });
                if (el) {
                    const rect = el.getBoundingClientRect();
                    return { found: true, x: rect.x + rect.width/2, y: rect.y + rect.height/2 };
                }
                return { found: false };
            });
            if (retry.found) {
                console.log(`✅ Logout trouvé après ouverture à (${Math.round(retry.x)}, ${Math.round(retry.y)})`);
                await page.evaluate((x, y) => {
                    const el = document.elementFromPoint(x, y);
                    if (el) el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
                }, retry.x, retry.y);
                logoutClicked = true;
            }
        }

        if (!logoutClicked) {
            console.log('❌ Impossible de trouver Logout');
            await page.screenshot({ path: path.join(screenshotsDir, `03_logout_not_found_${email.replace(/[^a-zA-Z0-9]/g, '_')}.png`), fullPage: true });
            await recorder.stop();
            return false;
        }

        await page.screenshot({ path: path.join(screenshotsDir, `04_after_logout_click_${email.replace(/[^a-zA-Z0-9]/g, '_')}.png`), fullPage: true });
        console.log('⏳ Attente de 10 secondes...');
        await delay(10000);
        await page.screenshot({ path: path.join(screenshotsDir, `05_final_${email.replace(/[^a-zA-Z0-9]/g, '_')}.png`), fullPage: true });
        await recorder.stop();

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
