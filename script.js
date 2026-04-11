const { connect } = require('puppeteer-real-browser');
const fs = require('fs');
const path = require('path');

const EMAIL = process.env.TRONPICK_EMAIL.trim().toLowerCase();
const PASSWORD = process.env.TRONPICK_PASSWORD;
const PROXY_USERNAME = process.env.PROXY_USERNAME;
const PROXY_PASSWORD = process.env.PROXY_PASSWORD;
const PROXY_HOST = '31.59.20.176';
const PROXY_PORT = '6754';

if (!EMAIL || !PASSWORD || !PROXY_USERNAME || !PROXY_PASSWORD) {
    console.error('❌ Variables d\'environnement manquantes');
    process.exit(1);
}

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Saisie robuste
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

// Réveiller la page pour faire apparaître Turnstile
async function wakeUpPage(page) {
    console.log('🖱️ Actions de réveil...');
    await page.evaluate(() => window.scrollBy(0, 300));
    await delay(500);
    await page.evaluate(() => window.scrollBy(0, -150));
    await delay(500);
    await page.mouse.move(400, 300);
    await delay(300);
    await page.mouse.move(600, 400);
    await delay(300);
    await page.click('body', { offset: { x: 100, y: 100 } });
    await delay(1000);
}

// Résolution renforcée de Turnstile
async function resolveTurnstile(page, maxWaitMs = 90000) {
    console.log('🔎 Recherche et résolution de Turnstile...');
    let turnstileFrame = null;
    try {
        turnstileFrame = await page.waitForFrame(
            f => f.url().includes('challenges.cloudflare.com/turnstile'),
            { timeout: 30000 }
        );
        console.log('✅ Iframe Turnstile trouvée');
    } catch (e) {
        console.log('⚠️ Iframe non apparue, tentative de réveil...');
        await wakeUpPage(page);
        try {
            turnstileFrame = await page.waitForFrame(
                f => f.url().includes('challenges.cloudflare.com/turnstile'),
                { timeout: 30000 }
            );
            console.log('✅ Iframe trouvée après réveil');
        } catch (e2) {
            const tokenExists = await page.evaluate(() => {
                return !!document.querySelector('[name="cf-turnstile-response"]')?.value;
            });
            if (tokenExists) {
                console.log('✅ Token déjà présent');
                return true;
            }
            console.log('❌ Iframe introuvable et pas de token');
            return false;
        }
    }

    try {
        await turnstileFrame.waitForSelector('body', { timeout: 5000 });
        await turnstileFrame.click('input[type="checkbox"]');
        console.log('   Clic pour générer le token');
    } catch (e) {}

    const tokenWaitStart = Date.now();
    while (Date.now() - tokenWaitStart < 45000) {
        const tokenValue = await page.evaluate(() => {
            const input = document.querySelector('[name="cf-turnstile-response"]') ||
                          document.querySelector('[name="turnstile-token"]') ||
                          document.querySelector('input[name*="captcha-response"]');
            return input ? input.value : '';
        });
        if (tokenValue && tokenValue.length > 10) {
            console.log(`✅ Token généré (${tokenValue.length} car.)`);
            await delay(3000);
            return true;
        }
        await delay(1000);
    }
    return false;
}

async function isLoggedIn(page) {
    try {
        const url = page.url();
        if (!url.includes('login.php')) return true;
        const sel = ['a[href*="dashboard"]', 'a[href*="account"]', '.user-menu'];
        for (const s of sel) if (await page.$(s)) return true;
    } catch (e) {}
    return false;
}

async function clickClaimButton(page) {
    console.log('🎯 Préparation du claim...');
    await page.waitForNetworkIdle({ timeout: 15000 }).catch(() => {});
    await delay(5000);
    await wakeUpPage(page);

    const resolved = await resolveTurnstile(page, 90000);
    if (!resolved) {
        const screenshot = await page.screenshot({ encoding: 'base64', fullPage: true });
        console.log('📸 CAPTURE_ECHEC_BASE64_START');
        console.log(screenshot);
        console.log('📸 CAPTURE_ECHEC_BASE64_END');
        return { success: false, message: 'Turnstile non résolu' };
    }

    await delay(2000);
    const claimSelector = '#process_claim_hourly_faucet';
    try {
        await page.waitForSelector(claimSelector, { timeout: 10000 });
        const btn = await page.$(claimSelector);
        if (!await btn.evaluate(el => !el.disabled && el.offsetParent !== null)) {
            return { success: false, message: 'Bouton désactivé (timer)' };
        }
        await btn.click();
        console.log('✅ Clic effectué');
    } catch (e) {
        const clicked = await page.evaluate(() => {
            const b = [...document.querySelectorAll('button')].find(b => b.textContent.trim().toUpperCase() === 'CLAIM');
            if (b && !b.disabled) { b.click(); return true; }
            return false;
        });
        if (!clicked) throw new Error('Clic impossible');
    }

    await page.waitForNetworkIdle({ timeout: 20000 }).catch(() => {});
    await delay(5000);

    const messages = await page.evaluate(() => {
        return Array.from(document.querySelectorAll('[class*="toast"], [class*="alert"], [role="alert"]'))
            .map(el => el.textContent.trim()).filter(t => t);
    });
    console.log('💬 Messages :', messages);

    const btnDisabled = await page.evaluate(() => {
        return document.querySelector('#process_claim_hourly_faucet')?.disabled || false;
    });

    const success = btnDisabled || messages.some(m => /success|claimed|reward/i.test(m));
    const message = messages[0] || (btnDisabled ? 'Bouton désactivé' : 'Aucune réaction');
    return { success, message };
}

(async () => {
    let browser;
    const status = { success: false, time: new Date().toISOString(), message: '' };
    try {
        console.log('🚀 Lancement...');
        const { browser: br, page } = await connect({
            headless: false,
            turnstile: true,
            proxy: { host: PROXY_HOST, port: PROXY_PORT, username: PROXY_USERNAME, password: PROXY_PASSWORD }
        });
        browser = br;
        page.on('dialog', d => d.accept());
        await page.setViewport({ width: 1280, height: 720 });

        // --- LOGIN ---
        await page.goto('https://tronpick.io/login.php', { waitUntil: 'networkidle2', timeout: 60000 });
        await fillField(page, 'input[type="email"], input[name="email"]', EMAIL, 'email');
        await fillField(page, 'input[type="password"]', PASSWORD, 'password');
        await delay(2000);
        await resolveTurnstile(page, 60000);
        await page.click('button:has-text("Log in")');
        await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 90000 }).catch(() => {});
        await delay(5000);

        if (!await isLoggedIn(page)) throw new Error('Échec connexion');
        console.log('✅ Connecté');

        // --- FAUCET ---
        await page.goto('https://tronpick.io/faucet.php', { waitUntil: 'networkidle2', timeout: 30000 });
        await delay(10000);
        const claimResult = await clickClaimButton(page);

        status.success = claimResult.success;
        status.message = claimResult.success ? `✅ ${claimResult.message}` : `❌ ${claimResult.message}`;
    } catch (e) {
        console.error('❌', e);
        status.message = e.message;
    } finally {
        if (browser) await browser.close();
        fs.writeFileSync(path.join(__dirname, 'public', 'status.json'), JSON.stringify(status, null, 2));
        console.log('📝', status.success ? 'SUCCÈS' : 'ÉCHEC');
    }
})();
