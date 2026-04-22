const { connect } = require('puppeteer-real-browser');
const { Octokit } = require('@octokit/rest');
const fs = require('fs');
const path = require('path');

const email = process.env.TEST_EMAIL;
const password = process.env.TEST_PASSWORD;
const platform = process.env.TEST_PLATFORM;
const proxyIndex = process.env.TEST_PROXY_INDEX !== '' ? parseInt(process.env.TEST_PROXY_INDEX) : 0;
const initialTimerStr = process.env.TEST_INITIAL_TIMER || '60:00';
const action = process.env.TEST_ACTION || 'login';
const GH_TOKEN = process.env.GH_TOKEN;
const GH_USERNAME = process.env.GH_USERNAME;
const GH_REPO = process.env.GH_REPO;
const GH_BRANCH = process.env.GH_BRANCH;
const GH_FILE_PATH = process.env.GH_FILE_PATH;
const JP_PROXY_LIST = (process.env.JP_PROXY_LIST || '').split(',').filter(p => p.trim() !== '');

if (JP_PROXY_LIST.length === 0) {
    console.error('❌ JP_PROXY_LIST doit contenir au moins 1 proxy');
    process.exit(1);
}

const screenshotsDir = path.join(__dirname, 'screenshots');
if (!fs.existsSync(screenshotsDir)) fs.mkdirSync(screenshotsDir, { recursive: true });

const TURNSTILE_LOGIN_COORDS = { x: 640, y: 615 };
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function parseProxyUrl(proxyUrl) {
    if (!proxyUrl) return null;
    proxyUrl = proxyUrl.trim();
    const match = proxyUrl.match(/^http:\/\/([^:]+):([^@]+)@([^:]+):(\d+)$/);
    if (!match) {
        console.error('❌ Format HTTP invalide:', proxyUrl);
        return null;
    }
    return {
        server: `http://${match[3]}:${match[4]}`,
        username: match[1],
        password: match[2]
    };
}

function timeStrToMinutes(str) {
    if (!str || !str.includes(':')) return 60;
    const parts = str.split(':');
    const mins = parseInt(parts[0]) || 0;
    const secs = parseInt(parts[1]) || 0;
    return mins + secs / 60;
}

async function fillField(page, selector, value, fieldName) {
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

async function performLogin(page, email, password) {
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
}

// === Déconnexion strictement identique au claim (attente 20s puis clic) ===
async function performLogout(page) {
    console.log('⏳ Attente de 20 secondes avant déconnexion (comme pour le claim)...');
    await delay(20000);
    const logoutClicked = await page.evaluate(() => {
        const keywords = ['logout', 'sign out', 'déconnexion', 'se déconnecter', 'log out'];
        const elements = [...document.querySelectorAll('a, button')];
        const logoutElement = elements.find(el => {
            const text = (el.textContent || '').toLowerCase();
            return keywords.some(kw => text.includes(kw));
        });
        if (logoutElement) {
            logoutElement.click();
            return true;
        }
        return false;
    });
    if (logoutClicked) {
        console.log('✅ Clic sur déconnexion effectué');
        await delay(3000);
    } else {
        console.log('⚠️ Bouton de déconnexion non trouvé');
    }
    return logoutClicked;
}

async function run() {
    if (action === 'logout') {
        let browser;
        try {
            const octokit = new Octokit({ auth: GH_TOKEN });
            let accounts = [];
            try {
                const res = await octokit.repos.getContent({ owner: GH_USERNAME, repo: GH_REPO, path: GH_FILE_PATH, ref: GH_BRANCH });
                accounts = JSON.parse(Buffer.from(res.data.content, 'base64').toString());
            } catch (e) {
                console.log(`Impossible de lire accounts.json : ${e.message}`);
                process.exit(1);
            }

            const normalizedEmail = email.trim().toLowerCase();
            const accountIndex = accounts.findIndex(a => a.email.toLowerCase() === normalizedEmail);
            if (accountIndex === -1 || !accounts[accountIndex].cookies || accounts[accountIndex].cookies.length === 0) {
                console.log(`❌ Aucun cookie trouvé pour ${email}, impossible de se déconnecter.`);
                process.exit(1);
            }

            const account = accounts[accountIndex];
            const proxyUrl = JP_PROXY_LIST[proxyIndex];
            const proxyConfig = parseProxyUrl(proxyUrl);
            if (!proxyConfig) throw new Error('Proxy invalide');
            console.log(`🔄 Proxy utilisé pour déconnexion : ${proxyConfig.server}`);

            const { browser: br, page } = await connect({
                headless: false,
                turnstile: true,
                proxy: proxyConfig,
                args: ['--no-sandbox', '--disable-setuid-sandbox']
            });
            browser = br;
            await page.setCookie(...account.cookies);
            const faucetUrl = `https://${account.platform}.io/faucet.php`;
            await page.goto(faucetUrl, { waitUntil: 'networkidle2', timeout: 30000 });
            await delay(5000); // petit délai après chargement
            await page.screenshot({ path: path.join(screenshotsDir, `logout_before_${account.email.replace(/[^a-zA-Z0-9]/g, '_')}.png`), fullPage: true });
            const logoutSuccess = await performLogout(page);
            if (logoutSuccess) {
                await page.screenshot({ path: path.join(screenshotsDir, `logout_after_${account.email.replace(/[^a-zA-Z0-9]/g, '_')}.png`), fullPage: true });
            } else {
                await page.screenshot({ path: path.join(screenshotsDir, `logout_failed_${account.email.replace(/[^a-zA-Z0-9]/g, '_')}.png`), fullPage: true });
            }
            await browser.close();

            if (logoutSuccess) {
                accounts.splice(accountIndex, 1);
                const content = Buffer.from(JSON.stringify(accounts, null, 2)).toString('base64');
                let sha = null;
                try {
                    const res = await octokit.repos.getContent({ owner: GH_USERNAME, repo: GH_REPO, path: GH_FILE_PATH, ref: GH_BRANCH });
                    sha = res.data.sha;
                } catch (e) {}
                await octokit.repos.createOrUpdateFileContents({
                    owner: GH_USERNAME,
                    repo: GH_REPO,
                    path: GH_FILE_PATH,
                    message: `Logout and remove account ${email}`,
                    content,
                    branch: GH_BRANCH,
                    sha
                });
                console.log(`✅ Déconnexion réussie pour ${email}, compte supprimé.`);
                process.exit(0);
            } else {
                console.log(`❌ Déconnexion échouée (bouton non trouvé) pour ${email}, compte non supprimé.`);
                process.exit(1);
            }
        } catch (err) {
            if (browser) await browser.close();
            console.error('❌ Erreur lors de la déconnexion :', err.message);
            process.exit(1);
        }
    }

    // --- Mode login (inchangé) ---
    let browser;
    try {
        const proxyUrl = JP_PROXY_LIST[proxyIndex];
        if (!proxyUrl) throw new Error(`Aucun proxy trouvé pour l'index ${proxyIndex}`);
        const proxyConfig = parseProxyUrl(proxyUrl);
        if (!proxyConfig) throw new Error('Proxy invalide');
        console.log(`🔄 Proxy utilisé : ${proxyConfig.server}`);

        const { browser: br, page } = await connect({
            headless: false,
            turnstile: true,
            proxy: proxyConfig,
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        });
        browser = br;

        await page.setViewport({ width: 1280, height: 720 });
        const loginUrl = `https://${platform}.io/login.php`;
        console.log(`🌐 Connexion à ${loginUrl}`);
        await page.goto(loginUrl, { waitUntil: 'networkidle2', timeout: 60000 });
        await page.screenshot({ path: path.join(screenshotsDir, '01_login_page.png'), fullPage: true });

        let loginSuccess = false;
        let lastError = null;
        const maxAttempts = 2;
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
                console.log(`🔄 Tentative de login ${attempt}/${maxAttempts}`);
                await performLogin(page, email, password);
                loginSuccess = true;
                break;
            } catch (err) {
                lastError = err;
                console.log(`❌ Échec tentative ${attempt}: ${err.message}`);
                if (attempt < maxAttempts) {
                    console.log('⏳ Attente 5 secondes avant actualisation...');
                    await delay(5000);
                    console.log('🔄 Actualisation de la page...');
                    await page.reload({ waitUntil: 'networkidle2', timeout: 30000 });
                    console.log('⏳ Attente 20 secondes supplémentaires...');
                    await delay(20000);
                }
            }
        }

        if (!loginSuccess) {
            throw new Error(`Login échoué après ${maxAttempts} tentatives : ${lastError.message}`);
        }

        const freshCookies = await page.cookies();
        console.log(`🍪 Cookies récupérés : ${freshCookies.length}`);
        await page.screenshot({ path: path.join(screenshotsDir, '02_login_success.png'), fullPage: true });
        await browser.close();

        if (freshCookies.length > 0) {
            const octokit = new Octokit({ auth: GH_TOKEN });
            let accounts = [];
            try {
                const res = await octokit.repos.getContent({ owner: GH_USERNAME, repo: GH_REPO, path: GH_FILE_PATH, ref: GH_BRANCH });
                accounts = JSON.parse(Buffer.from(res.data.content, 'base64').toString());
            } catch (e) {}
            const timerValue = timeStrToMinutes(initialTimerStr);
            const normalizedEmail = email.trim().toLowerCase();
            const existingIndex = accounts.findIndex(a => a.email.toLowerCase() === normalizedEmail);
            const newAccount = {
                email: normalizedEmail,
                password,
                platform,
                proxyIndex,
                enabled: true,
                cookies: freshCookies,
                cookiesStatus: 'valid',
                lastClaim: Date.now(),
                timer: timerValue
            };
            if (existingIndex !== -1) accounts[existingIndex] = newAccount;
            else accounts.push(newAccount);

            const content = Buffer.from(JSON.stringify(accounts, null, 2)).toString('base64');
            let sha = null;
            try {
                const res = await octokit.repos.getContent({ owner: GH_USERNAME, repo: GH_REPO, path: GH_FILE_PATH, ref: GH_BRANCH });
                sha = res.data.sha;
            } catch (e) {}
            await octokit.repos.createOrUpdateFileContents({
                owner: GH_USERNAME,
                repo: GH_REPO,
                path: GH_FILE_PATH,
                message: `Test login for ${normalizedEmail} - success (${freshCookies.length} cookies)`,
                content,
                branch: GH_BRANCH,
                sha
            });
            console.log(`✅ Compte ${normalizedEmail} enregistré avec succès (timer initial = ${initialTimerStr})`);
            process.exit(0);
        } else {
            console.log(`❌ Connexion réussie mais aucun cookie récupéré pour ${email}.`);
            process.exit(1);
        }
    } catch (err) {
        if (browser) {
            try {
                const screenshotPath = path.join(screenshotsDir, 'error.png');
                await browser.screenshot({ fullPage: true }).then(img => fs.writeFileSync(screenshotPath, img));
                console.log(`📸 Capture d'erreur sauvegardée : ${screenshotPath}`);
            } catch (e) {}
            await browser.close();
        }
        console.error('❌ Erreur fatale :', err.message);
        process.exit(1);
    }
}
run();
