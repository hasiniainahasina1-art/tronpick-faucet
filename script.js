const { connect } = require('puppeteer-real-browser');
const fs = require('fs');
const path = require('path');

// --- Paramètres par défaut du proxy (utilisé si aucun proxy spécifique) ---
const DEFAULT_PROXY_HOST = '31.59.20.176';
const DEFAULT_PROXY_PORT = '6754';
const DEFAULT_PROXY_USERNAME = process.env.PROXY_USERNAME || '';
const DEFAULT_PROXY_PASSWORD = process.env.PROXY_PASSWORD || '';

// Coordonnées fixes (résolution 1280x720)
const TURNSTILE_COORDS = { x: 640, y: 158 };
const CLAIM_COORDS = { x: 640, y: 223 };

const outputDir = path.join(__dirname, 'screenshots');
if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// --- Fonctions utilitaires (inchangées) ---
async function fillField(page, selector, value, fieldName) {
    console.log(`⌨️ Remplissage ${fieldName}...`);
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
    console.log(`✅ ${fieldName} rempli`);
}

async function humanScrollToClaim(page) {
    console.log('📜 Scroll progressif vers le bouton CLAIM...');
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
    console.log('✅ Scroll terminé');
}

async function humanClickAt(page, coords, label) {
    console.log(`🖱️ Clic ${label} aux coordonnées (${coords.x}, ${coords.y})`);
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
    console.log(`✅ Clic ${label} effectué`);
}

// --- Traitement d'un compte ---
async function processAccount(browser, account, index) {
    const { email, password, timer, platform, proxy, enabled, lastClaim } = account;
    if (enabled === false) {
        console.log(`⏭️ Compte ${email} désactivé, ignoré.`);
        return { email, success: false, message: 'Désactivé', lastClaim };
    }

    const now = Date.now();
    const intervalMs = (timer || 60) * 60 * 1000;
    if (now - (lastClaim || 0) < intervalMs) {
        const remaining = Math.ceil((intervalMs - (now - lastClaim)) / 60000);
        console.log(`⏳ Compte ${email} : prochain claim dans ${remaining} minutes.`);
        return { email, success: false, message: `Prochain claim dans ${remaining} min`, lastClaim };
    }

    console.log(`\n===== 🤖 Traitement du compte ${index + 1} : ${email} (${platform}) =====`);

    // Déterminer les URLs
    const siteUrls = {
        tronpick: 'https://tronpick.io',
        litepick: 'https://litepick.io',
        dogepick: 'https://dogepick.io',
        solpick: 'https://solpick.io',
        binpick: 'https://binpick.io'
    };
    const baseUrl = siteUrls[platform] || 'https://tronpick.io';
    const loginUrl = baseUrl + '/login.php';
    const faucetUrl = baseUrl + '/faucet.php';

    // Configurer le proxy
    let proxyConfig = null;
    if (proxy) {
        const parts = proxy.split(':');
        if (parts.length === 2) {
            proxyConfig = { host: parts[0], port: parts[1] };
        } else if (parts.length === 4) {
            proxyConfig = { host: parts[0], port: parts[1], username: parts[2], password: parts[3] };
        }
    }

    const context = await browser.createIncognitoBrowserContext();
    const page = await context.newPage();
    if (proxyConfig && proxyConfig.username) {
        await page.authenticate({ username: proxyConfig.username, password: proxyConfig.password });
    }

    try {
        // --- LOGIN ---
        console.log(`🌐 Accès login ${platform}...`);
        await page.goto(loginUrl, { waitUntil: 'networkidle2', timeout: 60000 });
        await fillField(page, 'input[type="email"], input[name="email"]', email, 'email');
        await fillField(page, 'input[type="password"]', password, 'password');
        await delay(2000);

        try {
            const frame = await page.waitForFrame(f => f.url().includes('challenges.cloudflare.com/turnstile'), { timeout: 30000 });
            console.log('✅ Turnstile login présent, clic...');
            await frame.click('input[type="checkbox"]');
            await delay(5000);
        } catch (e) {}

        console.log('🔐 Clic sur "Log in"...');
        const loginClicked = await page.evaluate(() => {
            const btns = [...document.querySelectorAll('button')];
            const loginBtn = btns.find(b => b.textContent.trim() === 'Log in');
            if (loginBtn) { loginBtn.click(); return true; }
            return false;
        });
        if (!loginClicked) throw new Error('Bouton Log in introuvable');

        await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 90000 }).catch(() => {});
        await delay(5000);
        if (page.url().includes('login.php')) throw new Error('Échec connexion');
        console.log('✅ Connecté');

        // --- FAUCET ---
        console.log(`🚰 Accès faucet...`);
        await page.goto(faucetUrl, { waitUntil: 'networkidle2', timeout: 30000 });
        await delay(10000);

        await humanScrollToClaim(page);
        await delay(2000);

        await humanClickAt(page, TURNSTILE_COORDS, 'Turnstile 1/2');
        await delay(10000);
        await humanClickAt(page, TURNSTILE_COORDS, 'Turnstile 2/2');
        await delay(10000);
        await delay(10000);

        await humanClickAt(page, CLAIM_COORDS, 'CLAIM');
        await page.waitForNetworkIdle({ timeout: 20000 }).catch(() => {});
        await delay(5000);

        const messages = await page.evaluate(() => {
            return Array.from(document.querySelectorAll('[class*="toast"], [class*="alert"], [role="alert"]'))
                .map(el => el.textContent.trim()).filter(t => t);
        });
        const btnDisabled = await page.evaluate(() => {
            return document.querySelector('#process_claim_hourly_faucet')?.disabled || false;
        });
        const success = btnDisabled || messages.some(m => /success|claimed|reward|sent/i.test(m));

        const newLastClaim = success ? now : lastClaim;
        return { email, success, message: messages[0] || (btnDisabled ? 'Bouton désactivé' : 'Aucune réaction'), lastClaim: newLastClaim };

    } catch (error) {
        console.error(`❌ Erreur pour ${email}:`, error);
        return { email, success: false, message: error.message, lastClaim };
    } finally {
        await context.close();
    }
}

// --- Fonction principale ---
(async () => {
    let browser;
    const results = [];
    try {
        const accountsPath = path.join(__dirname, 'accounts.json');
        if (!fs.existsSync(accountsPath)) {
            console.log('❌ Fichier accounts.json introuvable.');
            return;
        }
        const accounts = JSON.parse(fs.readFileSync(accountsPath, 'utf8'));
        if (accounts.length === 0) {
            console.log('ℹ️ Aucun compte configuré.');
            return;
        }

        console.log(`🚀 Lancement pour ${accounts.length} compte(s)`);

        const { browser: br } = await connect({
            headless: false,
            turnstile: true,
            proxy: DEFAULT_PROXY_USERNAME ? {
                host: DEFAULT_PROXY_HOST,
                port: DEFAULT_PROXY_PORT,
                username: DEFAULT_PROXY_USERNAME,
                password: DEFAULT_PROXY_PASSWORD
            } : {
                host: DEFAULT_PROXY_HOST,
                port: DEFAULT_PROXY_PORT
            }
        });
        browser = br;

        let needsSave = false;
        for (let i = 0; i < accounts.length; i++) {
            const result = await processAccount(browser, accounts[i], i);
            results.push(result);
            if (result.lastClaim !== accounts[i].lastClaim) {
                accounts[i].lastClaim = result.lastClaim;
                needsSave = true;
            }
            await delay(5000);
        }

        console.log('📊 Résultats finaux :', results);

        if (needsSave) {
            fs.writeFileSync(accountsPath, JSON.stringify(accounts, null, 2));
            console.log('💾 Timestamps mis à jour dans accounts.json');
        }

        const statusPath = path.join(__dirname, 'public', 'status.json');
        fs.writeFileSync(statusPath, JSON.stringify(results, null, 2));

    } catch (e) {
        console.error('❌ Erreur fatale :', e);
    } finally {
        if (browser) await browser.close();
    }
})();
