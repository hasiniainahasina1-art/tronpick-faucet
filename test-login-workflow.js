const { connect } = require('puppeteer-real-browser');
const { Octokit } = require('@octokit/rest');

// ---------- Variables d'environnement ----------
const email = process.env.TEST_EMAIL;
const password = process.env.TEST_PASSWORD;
const platform = process.env.TEST_PLATFORM;
const proxyIndex = process.env.TEST_PROXY_INDEX !== '' ? parseInt(process.env.TEST_PROXY_INDEX) : 0;
const initialTimerStr = process.env.TEST_INITIAL_TIMER || '60:00';
const GH_TOKEN = process.env.GH_TOKEN;
const GH_USERNAME = process.env.GH_USERNAME;
const GH_REPO = process.env.GH_REPO;
const GH_BRANCH = process.env.GH_BRANCH || 'main';
const USER_ID = process.env.USER_ID;

const USER_FILE = USER_ID
    ? `account_${USER_ID}_${platform}_${email}.json`
    : `account_${email}_${platform}.json`;

const GLOBAL_FILE = 'global_accounts.json';

const JP_PROXY_LIST = (process.env.JP_PROXY_LIST || '').split(',').filter(p => p.trim() !== '');
if (JP_PROXY_LIST.length === 0) {
    console.error('❌ JP_PROXY_LIST doit contenir au moins 1 proxy');
    process.exit(1);
}

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const randomDelay = (min, max) => delay(Math.floor(Math.random() * (max - min + 1) + min));

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

function timeStrToMinutes(str) {
    if (!str || !str.includes(':')) return 60;
    const parts = str.split(':');
    const mins = parseInt(parts[0]) || 0;
    const secs = parseInt(parts[1]) || 0;
    return mins + secs / 60;
}

async function fillFieldHuman(page, selector, value, fieldName) {
    console.log(`⌨️ Remplissage humain de ${fieldName}...`);
    await page.waitForSelector(selector, { visible: true, timeout: 10000 });
    await page.click(selector, { clickCount: 3 });
    await page.keyboard.press('Backspace');
    await randomDelay(100, 200);
    for (const char of value) {
        await page.keyboard.type(char, { delay: Math.floor(Math.random() * 70) + 30 });
    }
    await randomDelay(200, 500);
    let actual = await page.$eval(selector, el => el.value);
    if (actual !== value) {
        console.warn(`⚠️ Correction du champ ${fieldName}, nouvelle tentative`);
        await page.click(selector, { clickCount: 3 });
        await page.keyboard.press('Backspace');
        for (const char of value) await page.keyboard.type(char, { delay: Math.floor(Math.random() * 50) + 40 });
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
}

async function humanClickAt(page, coords) {
    await addRedDot(page, coords.x, coords.y);
    await randomDelay(150, 300);
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

async function connectWithProxy(proxyUrl) {
    const proxyConfig = parseProxyUrl(proxyUrl);
    if (!proxyConfig) throw new Error('Proxy invalide');
    console.log(`🔄 Connexion avec proxy : ${proxyConfig.server}`);
    const options = {
        headless: false,
        turnstile: true,
        proxy: proxyConfig,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    };
    const { browser, page } = await connect(options);
    return { browser, page };
}

async function saveAccount(accountData) {
    const octokit = new Octokit({ auth: GH_TOKEN });
    let sha = null;
    try {
        const res = await octokit.repos.getContent({
            owner: GH_USERNAME, repo: GH_REPO, path: USER_FILE, ref: GH_BRANCH
        });
        sha = res.data.sha;
    } catch (e) {}

    const content = Buffer.from(JSON.stringify(accountData, null, 2)).toString('base64');
    await octokit.repos.createOrUpdateFileContents({
        owner: GH_USERNAME,
        repo: GH_REPO,
        path: USER_FILE,
        message: `Ajout du compte ${email}`,
        content,
        branch: GH_BRANCH,
        sha
    });
    console.log(`💾 Compte individuel sauvegardé dans ${USER_FILE}`);
}

async function getGlobalAccounts() {
    const octokit = new Octokit({ auth: GH_TOKEN });
    try {
        const res = await octokit.repos.getContent({
            owner: GH_USERNAME, repo: GH_REPO, path: GLOBAL_FILE, ref: GH_BRANCH
        });
        const content = Buffer.from(res.data.content, 'base64').toString('utf-8');
        return JSON.parse(content);
    } catch (e) {
        return [];
    }
}

async function updateGlobalAccounts(newEntry) {
    const octokit = new Octokit({ auth: GH_TOKEN });

    let sha = null;
    let currentAccounts = [];
    try {
        const res = await octokit.repos.getContent({
            owner: GH_USERNAME, repo: GH_REPO, path: GLOBAL_FILE, ref: GH_BRANCH
        });
        sha = res.data.sha;
        const content = Buffer.from(res.data.content, 'base64').toString('utf-8');
        currentAccounts = JSON.parse(content);
    } catch (e) {}

    currentAccounts.push(newEntry);

    const content = Buffer.from(JSON.stringify(currentAccounts, null, 2)).toString('base64');
    await octokit.repos.createOrUpdateFileContents({
        owner: GH_USERNAME,
        repo: GH_REPO,
        path: GLOBAL_FILE,
        message: `Ajout auto de ${newEntry.email}`,
        content,
        branch: GH_BRANCH,
        sha
    });
    console.log(`🌍 Compte ajouté à ${GLOBAL_FILE} : ${newEntry.email} (${newEntry.platform})`);
}

async function isAccountDuplicate(email, platform) {
    const accounts = await getGlobalAccounts();
    return accounts.some(acc => acc.email === email && acc.platform === platform);
}

async function getLoginButtonCoords(page) {
    return await page.evaluate(() => {
        const btns = [...document.querySelectorAll('button')];
        const loginBtn = btns.find(b => b.textContent.trim() === 'Log in');
        if (!loginBtn) return null;
        const rect = loginBtn.getBoundingClientRect();
        return {
            x: Math.round(rect.left + rect.width / 2),
            y: Math.round(rect.top + rect.height / 2)
        };
    });
}

async function isVerifyTextVisible(page) {
    return await page.evaluate(() => {
        return document.body.innerText.includes('Verify you are human');
    });
}

// --- Vérification renforcée de succès de connexion ---
async function checkLoginSuccess(page) {
    return await page.evaluate(() => {
        // 1. Vérifier qu'on n'est plus sur login.php
        if (window.location.href.includes('login.php')) return false;

        // 2. Vérifier l'absence de messages d'erreur
        const errorSelectors = ['.alert-danger', '.error', '[class*="error"]'];
        for (const sel of errorSelectors) {
            const el = document.querySelector(sel);
            if (el && el.textContent.trim().length > 0) return false;
        }

        // 3. Vérifier la présence d'un élément positif (Logout, Dashboard, etc.)
        const positiveTexts = ['Dashboard', 'Logout', 'Log out', 'My account', 'Account'];
        const bodyText = document.body.innerText;
        for (const txt of positiveTexts) {
            if (bodyText.includes(txt)) return true;
        }

        // 4. Si on a quitté login.php sans erreur, on accepte (prudence)
        return true;
    });
}

async function performLoginWithCaptcha(page, email, password) {
    await fillFieldHuman(page, 'input[type="email"], input[name="email"]', email, 'email');
    await fillFieldHuman(page, 'input[type="password"]', password, 'password');
    await randomDelay(500, 1000);

    console.log('📜 Scroll jusqu’au bouton Log in...');
    await page.evaluate(() => {
        const btns = [...document.querySelectorAll('button')];
        const loginBtn = btns.find(b => b.textContent.trim() === 'Log in');
        if (loginBtn) loginBtn.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
    await delay(2000);

    console.log('🔍 Sélection du type de captcha...');
    const selectSelector = 'select';
    await page.waitForSelector(selectSelector, { visible: true, timeout: 10000 });
    const availableOptions = await page.$$eval(`${selectSelector} option`, opts =>
        opts.map(o => ({ text: o.textContent.trim(), value: o.value }))
    );
    console.log('📋 Options disponibles :', availableOptions);

    const targetOptionText = 'Cloudflare Turnstile';
    const target = availableOptions.find(o => o.text === targetOptionText);
    if (!target) throw new Error(`Option "${targetOptionText}" introuvable`);
    await page.select(selectSelector, target.value);
    console.log(`✅ Option "${targetOptionText}" sélectionnée`);
    await delay(5000);

    let loginCoords = await getLoginButtonCoords(page);
    if (!loginCoords) {
        console.warn('⚠️ Bouton Log in non trouvé, fallback (640,615)');
        loginCoords = { x: 640, y: 615 };
    }
    console.log(`📍 Bouton Log in trouvé à (${loginCoords.x}, ${loginCoords.y})`);

    const verifyCoords = { x: loginCoords.x, y: loginCoords.y - 70 };
    console.log(`🖱️ Clic sur "Verify you are human" à (${verifyCoords.x}, ${verifyCoords.y})`);

    const maxAttempts = 3;
    let validated = false;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        console.log(`🔄 Tentative ${attempt}/${maxAttempts} de validation Turnstile...`);
        await humanClickAt(page, verifyCoords);
        await delay(5000);

        const stillVisible = await isVerifyTextVisible(page);
        if (!stillVisible) {
            console.log('✅ Turnstile validé');
            validated = true;
            break;
        } else {
            console.warn(`⚠️ Texte encore présent, nouvel essai...`);
        }
    }

    if (!validated) {
        console.warn('⚠️ Échec de validation après plusieurs tentatives');
    }

    console.log('🖱️ Clic sur le bouton Log in...');
    await humanClickAt(page, loginCoords);
    await randomDelay(2000, 3000);

    // Attendre navigation ou délai
    try {
        await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 40000 });
    } catch (navError) {
        console.warn('⚠️ Navigation non détectée, vérification manuelle...');
        await delay(5000);
    }

    // Vérification du succès
    const success = await checkLoginSuccess(page);
    if (!success) {
        const errorMsg = await page.evaluate(() => {
            const el = document.querySelector('.alert-danger, .error');
            return el ? el.textContent.trim() : 'Aucun message explicite';
        });
        throw new Error(`Échec de connexion : ${errorMsg}`);
    }

    console.log('✅ Connexion réussie');
}

// --- Main ---
async function run() {
    const normalizedEmail = email.trim().toLowerCase();

    console.log(`🔎 Vérification anti-doublon pour ${normalizedEmail} [${platform}]...`);
    const duplicate = await isAccountDuplicate(normalizedEmail, platform);
    if (duplicate) {
        console.log('⚠️ Ce compte existe déjà dans le fichier global. Aucune action.');
        process.exit(0);
    }

    let browser;
    try {
        const proxyUrl = JP_PROXY_LIST[proxyIndex] || JP_PROXY_LIST[0];
        if (!proxyUrl) throw new Error('Proxy indisponible');
        console.log(`🔄 Proxy utilisé : ${proxyUrl}`);

        const { browser: br, page } = await connectWithProxy(proxyUrl);
        browser = br;
        await page.setViewport({ width: 1280, height: 720 });

        const loginUrl = `https://${platform}.io/login.php`;
        console.log(`🌐 Connexion à ${loginUrl}`);
        await page.goto(loginUrl, { waitUntil: 'networkidle2', timeout: 60000 });

        await performLoginWithCaptcha(page, normalizedEmail, password);

        // Si on arrive ici, connexion OK
        const cookies = await page.cookies();
        console.log(`🍪 Cookies récupérés : ${cookies.length}`);

        await browser.close();

        const timerValue = timeStrToMinutes(initialTimerStr);
        const account = {
            email: normalizedEmail,
            password,
            platform,
            proxyIndex,
            enabled: true,
            cookies,
            cookiesStatus: 'valid',
            lastClaim: Date.now(),
            timer: timerValue
        };

        await saveAccount(account);
        await updateGlobalAccounts({
            email: normalizedEmail,
            platform,
            addedAt: new Date().toISOString()
        });

        console.log('🎉 Script terminé avec succès.');
        process.exit(0);
    } catch (err) {
        console.error('❌ Erreur fatale :', err.message);
        // Aucune sauvegarde n'a lieu
        if (browser) await browser.close();
        process.exit(1);
    }
}
run();
