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

// Anciennes coordonnées (conservées pour le login si besoin)
const TURNSTILE_LOGIN_COORDS = { x: 640, y: 615 };
// NOUVELLES COORDONNÉES POUR LES DEUX CLICS TURNSTILE
const TURNSTILE_FAUCET_COORDS_1 = { x: 640, y: 43 };
const TURNSTILE_FAUCET_COORDS_2 = { x: 400, y: 282 };
const CLAIM_COORDS = { x: 400, y: 223 }; // inchangé

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

async function humanScrollToClaim(page) {
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
        setTimeout(() => dot.remove(), 2000);
    }, x, y);
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
    console.log(`🖱️ Clic à (${coords.x}, ${coords.y})`);
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
        message: 'Mise à jour automatique',
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

// ========== CLAIM AVEC DEUX CLICS TURNSTILE AUX NOUVELLES COORDONNÉES ==========
async function claimWithCookies(account) {
    const { email, cookies, platform } = account;
    console.log(`🍪 Claim pour ${email} via cookies`);
    const siteUrls = {
        tronpick: 'https://tronpick.io/faucet.php',
        litepick: 'https://litepick.io/faucet.php',
        dogepick: 'https://dogepick.io/faucet.php',
        solpick: 'https://solpick.io/faucet.php',
        binpick: 'https://binpick.io/faucet.php'
    };
    const faucetUrl = siteUrls[platform] || 'https://tronpick.io/faucet.php';
    const proxyUrl = getProxyUrlForAccount(account);
    if (!proxyUrl) throw new Error('Aucun proxy fourni');

    let browser;
    try {
        const { browser: br, page } = await connectWithProxy(proxyUrl);
        browser = br;
        await page.setCookie(...cookies);
        await page.goto(faucetUrl, { waitUntil: 'networkidle2', timeout: 30000 });
        await delay(5000);
        if (page.url().includes('login.php')) throw new Error('Cookies expirés');

        console.log('⏳ Attente de 5 secondes...');
        await delay(5000);
        console.log('🔄 Actualisation de la page faucet...');
        await page.reload({ waitUntil: 'networkidle2', timeout: 30000 });
        await page.screenshot({ path: path.join(screenshotsDir, `01_after_reload_${email.replace(/[^a-zA-Z0-9]/g, '_')}.png`), fullPage: true });

        console.log('⏳ Attente de 20 secondes...');
        await delay(20000);
        await page.screenshot({ path: path.join(screenshotsDir, `02_after_wait_${email.replace(/[^a-zA-Z0-9]/g, '_')}.png`), fullPage: true });

        await humanScrollToClaim(page);
        await delay(2000);
        await page.screenshot({ path: path.join(screenshotsDir, `03_before_turnstile_${email.replace(/[^a-zA-Z0-9]/g, '_')}.png`), fullPage: true });

        // --- PREMIER CLIC TURNSTILE (640, 43) ---
        console.log(`🖱️ Premier clic Turnstile à (${TURNSTILE_FAUCET_COORDS_1.x}, ${TURNSTILE_FAUCET_COORDS_1.y})`);
        await humanClickAt(page, TURNSTILE_FAUCET_COORDS_1);
        await page.screenshot({ path: path.join(screenshotsDir, `04_after_first_turnstile_click_${email.replace(/[^a-zA-Z0-9]/g, '_')}.png`), fullPage: true });

        console.log('⏳ Attente de 10 secondes...');
        await delay(10000);

        // --- DEUXIÈME CLIC TURNSTILE (400, 282) ---
        console.log(`🖱️ Deuxième clic Turnstile à (${TURNSTILE_FAUCET_COORDS_2.x}, ${TURNSTILE_FAUCET_COORDS_2.y})`);
        await humanClickAt(page, TURNSTILE_FAUCET_COORDS_2);
        await page.screenshot({ path: path.join(screenshotsDir, `05_after_second_turnstile_click_${email.replace(/[^a-zA-Z0-9]/g, '_')}.png`), fullPage: true });

        console.log('⏳ Attente de 10 secondes...');
        await delay(10000);

        console.log('⏳ Attente de 10 secondes avant le clic sur CLAIM...');
        await delay(10000);
        await page.screenshot({ path: path.join(screenshotsDir, `06_before_claim_${email.replace(/[^a-zA-Z0-9]/g, '_')}.png`), fullPage: true });

        await humanClickAt(page, CLAIM_COORDS);
        await page.waitForNetworkIdle({ timeout: 20000 }).catch(() => {});
        await delay(5000);
        await page.screenshot({ path: path.join(screenshotsDir, `07_after_claim_${email.replace(/[^a-zA-Z0-9]/g, '_')}.png`), fullPage: true });

        const messages = await page.evaluate(() => {
            return Array.from(document.querySelectorAll('[class*="toast"], [class*="alert"], [role="alert"], .alert, .message, .notification'))
                .map(el => el.textContent.trim()).filter(t => t);
        });
        const btnDisabled = await page.evaluate(() => {
            const btn = document.querySelector('#process_claim_hourly_faucet');
            return btn ? btn.disabled : false;
        });
        const success = btnDisabled || messages.some(m => /success|claimed|reward|sent|received|thanks/i.test(m));
        const resultMessage = messages[0] || (btnDisabled ? 'Bouton désactivé (succès présumé)' : 'Aucune réaction');
        console.log(`📢 Messages détectés : ${messages.join(' | ')}`);
        console.log(`🔘 Bouton désactivé : ${btnDisabled}`);

        return { success, message: resultMessage };
    } catch (error) {
        if (error.message.includes('Cookies expirés')) {
            console.log(`🔄 Cookies expirés pour ${email}, reconnexion...`);
            try {
                const newCookies = await performLoginAndCaptureCookies(account);
                account.cookies = newCookies;
                account.cookiesStatus = 'valid';
                console.log(`✅ Nouveaux cookies capturés. Relance du claim.`);
                return await claimWithCookies(account);
            } catch (loginError) {
                console.error(`❌ Échec reconnexion : ${loginError.message}`);
                account.cookiesStatus = 'failed';
                return { success: false, message: `Échec reconnexion: ${loginError.message}` };
            }
        }
        console.error(`❌ Erreur claim : ${error.message}`);
        return { success: false, message: error.message };
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
        const now = Date.now();
        let needsSave = false;
        let nextIndex = 0;
        for (const acc of accounts) {
            if (acc.proxyIndex === undefined) {
                acc.proxyIndex = nextIndex % JP_PROXY_LIST.length;
                nextIndex++;
                needsSave = true;
            }
            if (!acc.timer) acc.timer = 60;
        }
        for (const acc of accounts) {
            if (!acc.enabled) continue;
            console.log(`\n===== Traitement : ${acc.email} =====`);
            const proxyUrl = getProxyUrlForAccount(acc);
            console.log(`🔄 Proxy fixe : ${proxyUrl} (index ${acc.proxyIndex})`);
            if (!acc.cookies || acc.cookiesStatus === 'expired' || acc.cookiesStatus === 'failed') {
                console.log(`🍪 Tentative de login...`);
                try {
                    const newCookies = await performLoginAndCaptureCookies(acc);
                    acc.cookies = newCookies;
                    acc.cookiesStatus = 'valid';
                    needsSave = true;
                } catch (e) {
                    acc.cookiesStatus = 'failed';
                    console.log(`❌ Échec login : ${e.message}`);
                    continue;
                }
            }
            const lastClaim = acc.lastClaim || 0;
            const intervalMs = (acc.timer || 60) * 60 * 1000;
            const isEligible = (now - lastClaim) >= intervalMs;
            if (!isEligible) {
                const remainingMin = Math.ceil((intervalMs - (now - lastClaim)) / 60000);
                console.log(`⏳ Prochain claim dans ${remainingMin} min (timer actuel: ${acc.timer} min)`);
                continue;
            }
            console.log(`🚀 Claim éligible`);
            try {
                const result = await claimWithCookies(acc);
                if (result.success) {
                    acc.lastClaim = now;
                    if (acc.timer !== 60) {
                        console.log(`🕒 Premier claim réussi pour ${acc.email} : passage du timer de ${acc.timer} à 60 minutes.`);
                        acc.timer = 60;
                    }
                    console.log(`✅ Claim réussi : ${result.message}`);
                } else {
                    console.log(`❌ Claim échoué : ${result.message}`);
                }
                needsSave = true;
            } catch (e) {
                console.error(`❌ Erreur claim : ${e.message}`);
                if (e.message.includes('expir')) {
                    acc.cookies = null;
                    acc.cookiesStatus = 'expired';
                    needsSave = true;
                }
            }
            await delay(5000);
        }
        if (needsSave) await saveAccounts(accounts);
    } catch (e) { console.error('Erreur fatale:', e); }
})();
