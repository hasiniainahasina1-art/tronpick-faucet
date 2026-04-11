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

async function wakeUpPage(page) {
    console.log('🖱️ Actions de réveil...');
    await page.evaluate(() => window.scrollBy(0, 500));
    await delay(800);
    await page.evaluate(() => window.scrollBy(0, -300));
    await delay(500);
    await page.mouse.move(300, 200);
    await page.mouse.move(700, 500);
    await page.mouse.move(500, 400);
    await delay(300);
    await page.click('body', { offset: { x: 200, y: 200 } });
    await delay(1000);
}

async function resolveTurnstile(page, maxWaitMs = 90000) {
    console.log('🔎 Résolution de Turnstile...');
    const start = Date.now();
    let turnstileFrame = null;

    // Fonction pour trouver l'iframe avec plusieurs patterns d'URL
    const findTurnstileFrame = () => {
        const frames = page.frames();
        return frames.find(f => 
            f.url().includes('challenges.cloudflare.com/turnstile') ||
            f.url().includes('challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/turnstile')
        );
    };

    // Attente initiale (30s)
    while (Date.now() - start < 30000) {
        turnstileFrame = findTurnstileFrame();
        if (turnstileFrame) break;
        await delay(1000);
    }

    if (!turnstileFrame) {
        console.log('⚠️ Iframe non apparue, réveil de la page...');
        await wakeUpPage(page);
        // Seconde attente après réveil (30s supplémentaires)
        while (Date.now() - start < 60000) {
            turnstileFrame = findTurnstileFrame();
            if (turnstileFrame) break;
            await delay(1000);
        }
    }

    if (!turnstileFrame) {
        // Dernière vérification du token
        const tokenExists = await page.evaluate(() => {
            const input = document.querySelector('[name="cf-turnstile-response"]');
            return input && input.value.length > 10;
        });
        if (tokenExists) {
            console.log('✅ Token déjà présent et valide');
            return true;
        }
        console.log('❌ Iframe Turnstile introuvable et pas de token');
        return false;
    }

    console.log('✅ Iframe Turnstile trouvée');

    // Cliquer sur la case
    try {
        await turnstileFrame.waitForSelector('body', { timeout: 5000 });
        await turnstileFrame.click('input[type="checkbox"]');
        console.log('   Clic sur la case Turnstile');
    } catch (e) {
        console.log('⚠️ Clic impossible, on continue...');
    }

    // Attendre un token valide
    const tokenWaitStart = Date.now();
    while (Date.now() - tokenWaitStart < 45000) {
        const tokenValue = await page.evaluate(() => {
            const input = document.querySelector('[name="cf-turnstile-response"]') ||
                          document.querySelector('[name="turnstile-token"]') ||
                          document.querySelector('input[name*="captcha-response"]');
            return input ? input.value : '';
        });
        if (tokenValue && tokenValue.length > 10) {
            console.log(`✅ Token frais généré (${tokenValue.length} car.)`);
            await delay(3000);
            return true;
        }
        await delay(1000);
    }
    console.log('⚠️ Timeout attente token');
    return false;
}

async function isLoggedIn(page) {
    return !page.url().includes('login.php');
}

async function clickClaimButton(page) {
    console.log('🎯 Préparation du claim...');
    await page.waitForNetworkIdle({ timeout: 15000 }).catch(() => {});
    await delay(5000);
    await wakeUpPage(page);

    const resolved = await resolveTurnstile(page, 90000);
    if (!resolved) {
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
        console.log('✅ Clic sur Claim effectué');
    } catch (e) {
        const clicked = await page.evaluate(() => {
            const b = [...document.querySelectorAll('button')].find(b => b.textContent.trim().toUpperCase() === 'CLAIM');
            if (b && !b.disabled) { b.click(); return true; }
            return false;
        });
        if (!clicked) throw new Error('Clic Claim impossible');
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
        console.log('🌐 Accès login...');
        await page.goto('https://tronpick.io/login.php', { waitUntil: 'networkidle2', timeout: 60000 });
        await fillField(page, 'input[type="email"], input[name="email"]', EMAIL, 'email');
        await fillField(page, 'input[type="password"]', PASSWORD, 'password');
        await delay(2000);
        const loginTurnstileResolved = await resolveTurnstile(page, 60000);
        if (!loginTurnstileResolved) throw new Error('Turnstile login non résolu');

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
        if (!await isLoggedIn(page)) {
            const err = await page.evaluate(() => {
                const el = document.querySelector('.alert-danger, .error');
                return el ? el.textContent.trim() : null;
            });
            throw new Error(err || 'Échec connexion');
        }
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
        if (browser) {
            try {
                const pages = await browser.pages();
                const page = pages[pages.length - 1];
                const screenshot = await page.screenshot({ encoding: 'base64', fullPage: true });
                console.log('📸 CAPTURE_ERREUR_BASE64_START');
                console.log(screenshot);
                console.log('📸 CAPTURE_ERREUR_BASE64_END');
            } catch (se) {}
        }
    } finally {
        if (browser) await browser.close();
        fs.writeFileSync(path.join(__dirname, 'public', 'status.json'), JSON.stringify(status, null, 2));
        console.log('📝', status.success ? 'SUCCÈS' : 'ÉCHEC');
    }
})();
