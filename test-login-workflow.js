const { connect } = require('puppeteer-real-browser');
const { Octokit } = require('@octokit/rest');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const email = process.env.TEST_EMAIL;
const password = process.env.TEST_PASSWORD;
const platform = process.env.TEST_PLATFORM;
const proxyIndex = process.env.TEST_PROXY_INDEX !== '' ? parseInt(process.env.TEST_PROXY_INDEX) : 0;
const initialTimerStr = process.env.TEST_INITIAL_TIMER || '60:00';
const GH_TOKEN = process.env.GH_TOKEN;
const GH_USERNAME = process.env.GH_USERNAME;
const GH_REPO = process.env.GH_REPO;
const GH_BRANCH = process.env.GH_BRANCH || 'main';
const GH_FILE_PATH = process.env.GH_FILE_PATH || 'accounts.json';
const USER_ID = process.env.USER_ID;
const CRYPTO_SECRET = process.env.CRYPTO_SECRET;

if (!CRYPTO_SECRET || !USER_ID) {
    console.error('❌ CRYPTO_SECRET ou USER_ID manquant');
    process.exit(1);
}

const USER_FILE = `accounts_${USER_ID}.json`;
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
    } catch (e) {
        return encryptedText;
    }
}

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

// --- Vérification globale atomique ---
async function isAccountAlreadyTaken(email, platform, octokit) {
    const GLOBAL_FILE = 'global_accounts.json';
    try {
        const res = await octokit.repos.getContent({
            owner: GH_USERNAME,
            repo: GH_REPO,
            path: GLOBAL_FILE,
            ref: GH_BRANCH
        });
        const entries = JSON.parse(Buffer.from(res.data.content, 'base64').toString('utf8'));
        return entries.some(e => e.email === email && e.platform === platform);
    } catch (e) {
        // si le fichier n'existe pas encore, le compte est libre
        return false;
    }
}

async function addToGlobalList(email, platform, normalizedEmail) {
    if (!GH_TOKEN || !GH_USERNAME || !GH_REPO) {
        console.warn('⚠️ Impossible d\'ajouter à la liste globale (variables manquantes)');
        return;
    }
    const octokit = new Octokit({ auth: GH_TOKEN });
    const GLOBAL_FILE = 'global_accounts.json';
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
        } catch (e) {}

        if (entries.some(e => e.email === email && e.platform === platform)) {
            console.log('ℹ️ Déjà présent dans la liste globale.');
            return;
        }

        entries.push({ email: normalizedEmail, platform });

        const content = Buffer.from(JSON.stringify(entries, null, 2)).toString('base64');
        const message = `Ajout de ${normalizedEmail} (${platform}) à la liste globale`;

        await octokit.repos.createOrUpdateFileContents({
            owner: GH_USERNAME,
            repo: GH_REPO,
            path: GLOBAL_FILE,
            message,
            content,
            branch: GH_BRANCH,
            sha
        });
        console.log('✅ Compte ajouté à la liste globale.');
    } catch (error) {
        console.error('❌ Erreur lors de l\'ajout global :', error.message);
    }
}

async function run() {
    let browser;
    try {
        const proxyUrl = JP_PROXY_LIST[proxyIndex] || JP_PROXY_LIST[0];
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

        console.log('🔑 Tentative unique de login');
        try {
            await performLogin(page, email, password);
        } catch (err) {
            console.error(`❌ Échec login : ${err.message}`);
            // Sauvegarde de l'échec dans le fichier utilisateur (inchangé)
            const octokit = new Octokit({ auth: GH_TOKEN });
            let accounts = [];
            try {
                const res = await octokit.repos.getContent({ owner: GH_USERNAME, repo: GH_REPO, path: USER_FILE, ref: GH_BRANCH });
                accounts = JSON.parse(Buffer.from(res.data.content, 'base64').toString());
            } catch (e) {}
            const normalizedEmail = email.trim().toLowerCase();
            const existingIndex = accounts.findIndex(a => a.email.toLowerCase() === normalizedEmail && a.platform === platform);
            const failedAccount = {
                email: normalizedEmail,
                password: encrypt(password),
                platform,
                proxyIndex,
                enabled: false,
                cookies: encrypt('[]'),
                cookiesStatus: 'failed',
                errorMessage: err.message || 'Erreur inconnue',
                lastClaim: 0,
                timer: 60
            };
            if (existingIndex !== -1) accounts[existingIndex] = failedAccount;
            else accounts.push(failedAccount);
            const content = Buffer.from(JSON.stringify(accounts, null, 2)).toString('base64');
            let sha = null;
            try {
                const res = await octokit.repos.getContent({ owner: GH_USERNAME, repo: GH_REPO, path: USER_FILE, ref: GH_BRANCH });
                sha = res.data.sha;
            } catch (e) {}
            await octokit.repos.createOrUpdateFileContents({
                owner: GH_USERNAME,
                repo: GH_REPO,
                path: USER_FILE,
                message: `Échec login pour ${normalizedEmail}`,
                content,
                branch: GH_BRANCH,
                sha
            });
            console.log(`❌ État d'échec sauvegardé pour ${normalizedEmail}`);
            if (browser) await browser.close().catch(() => {});
            process.exit(1);
        }

        const freshCookies = await page.cookies();
        console.log(`🍪 Cookies récupérés : ${freshCookies.length}`);
        await page.screenshot({ path: path.join(screenshotsDir, '02_login_success.png'), fullPage: true });
        await browser.close();

        if (freshCookies.length > 0) {
            const octokit = new Octokit({ auth: GH_TOKEN });
            const normalizedEmail = email.trim().toLowerCase();

            // 🔒 Vérification globale AVANT de modifier le fichier utilisateur
            const alreadyTaken = await isAccountAlreadyTaken(email, platform, octokit);
            if (alreadyTaken) {
                console.error(`❌ Le compte ${normalizedEmail} (${platform}) est déjà utilisé globalement. Annulation.`);
                // On ne sauvegarde rien dans le fichier utilisateur
                process.exit(1);
            }

            let accounts = [];
            try {
                const res = await octokit.repos.getContent({ owner: GH_USERNAME, repo: GH_REPO, path: USER_FILE, ref: GH_BRANCH });
                accounts = JSON.parse(Buffer.from(res.data.content, 'base64').toString());
            } catch (e) {}
            const timerValue = timeStrToMinutes(initialTimerStr);
            const existingIndex = accounts.findIndex(a => a.email.toLowerCase() === normalizedEmail && a.platform === platform);
            const newAccount = {
                email: normalizedEmail,
                password: encrypt(password),
                platform,
                proxyIndex,
                enabled: true,
                cookies: encrypt(JSON.stringify(freshCookies)),
                cookiesStatus: 'valid',
                lastClaim: Date.now(),
                timer: timerValue
            };
            if (existingIndex !== -1) accounts[existingIndex] = newAccount;
            else accounts.push(newAccount);

            const content = Buffer.from(JSON.stringify(accounts, null, 2)).toString('base64');
            let sha = null;
            try {
                const res = await octokit.repos.getContent({ owner: GH_USERNAME, repo: GH_REPO, path: USER_FILE, ref: GH_BRANCH });
                sha = res.data.sha;
            } catch (e) {}
            await octokit.repos.createOrUpdateFileContents({
                owner: GH_USERNAME,
                repo: GH_REPO,
                path: USER_FILE,
                message: `Login réussi pour ${normalizedEmail}`,
                content,
                branch: GH_BRANCH,
                sha
            });
            console.log(`✅ Compte ${normalizedEmail} enregistré avec succès (timer initial = ${initialTimerStr})`);

            // Enregistrement dans la liste globale (après succès)
            await addToGlobalList(email, platform, normalizedEmail);

            process.exit(0);
        } else {
            throw new Error('Aucun cookie récupéré');
        }
    } catch (err) {
        console.error('❌ Erreur fatale :', err.message);
        if (browser) {
            try {
                const screenshotPath = path.join(screenshotsDir, 'error.png');
                await browser.screenshot({ fullPage: true }).then(img => fs.writeFileSync(screenshotPath, img));
                console.log(`📸 Capture d'erreur sauvegardée : ${screenshotPath}`);
            } catch (e) {}
            await browser.close();
        }
        process.exit(1);
    }
}
run();
