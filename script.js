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

// Connexion (inchangée)
async function login(page) {
    console.log('🌐 Accès login...');
    await page.goto('https://tronpick.io/login.php', { waitUntil: 'networkidle2', timeout: 60000 });
    await fillField(page, 'input[type="email"], input[name="email"]', EMAIL, 'email');
    await fillField(page, 'input[type="password"]', PASSWORD, 'password');
    await delay(2000);

    try {
        const frame = await page.waitForFrame(f => f.url().includes('challenges.cloudflare.com/turnstile'), { timeout: 30000 });
        console.log('✅ Turnstile login présent, clic...');
        await frame.click('input[type="checkbox"]');
        await delay(5000);
    } catch (e) {
        console.log('⚠️ Turnstile login non trouvé, on continue...');
    }

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
}

// Résolution du Turnstile faucet avec actions de réveil
async function resolveFaucetTurnstile(page) {
    console.log('🛡️ Résolution du Turnstile faucet...');

    // Actions pour inciter Turnstile à apparaître
    await page.evaluate(() => window.scrollBy(0, 300));
    await delay(500);
    await page.mouse.move(400, 300);
    await page.mouse.click(400, 300);
    await delay(1000);
    await page.evaluate(() => window.scrollBy(0, -150));

    try {
        const frame = await page.waitForFrame(
            f => f.url().includes('challenges.cloudflare.com/turnstile'),
            { timeout: 90000 } // 90 secondes
        );
        console.log('✅ Iframe Turnstile faucet trouvée');

        await frame.waitForSelector('body', { timeout: 5000 });
        await frame.evaluate(() => {
            const labels = [...document.querySelectorAll('label')];
            const target = labels.find(l => l.textContent.toLowerCase().includes('verify you are human'));
            if (target) target.click();
            else {
                const cb = document.querySelector('input[type="checkbox"]');
                if (cb) cb.click();
            }
        });
        console.log('✅ Clic sur "Verify you are human"');

        // Attendre que Turnstile se résolve (max 45s)
        const start = Date.now();
        while (Date.now() - start < 45000) {
            const isChecked = await frame.$eval('input[type="checkbox"]', cb => cb.checked).catch(() => false);
            const token = await page.evaluate(() => {
                const inp = document.querySelector('[name="cf-turnstile-response"]');
                return inp ? inp.value : '';
            });
            if (isChecked || (token && token.length > 10)) {
                console.log('✅ Turnstile résolu');
                return true;
            }
            await delay(2000);
        }
        console.log('⚠️ Timeout résolution Turnstile');
        return false;
    } catch (e) {
        console.log('❌ Iframe Turnstile faucet non trouvée :', e.message);
        return false;
    }
}

// Clic sur CLAIM
async function clickClaim(page) {
    console.log('🎯 Clic sur le bouton CLAIM...');
    const claimSelector = '#process_claim_hourly_faucet';
    await page.waitForSelector(claimSelector, { timeout: 10000 });
    const btn = await page.$(claimSelector);
    if (!await btn.evaluate(el => !el.disabled && el.offsetParent !== null)) {
        throw new Error('Bouton CLAIM désactivé');
    }
    await btn.click();
    console.log('✅ Clic sur CLAIM effectué');
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

        await login(page);

        console.log('🚰 Accès faucet...');
        await page.goto('https://tronpick.io/faucet.php', { waitUntil: 'networkidle2', timeout: 30000 });
        await delay(10000);

        const resolved = await resolveFaucetTurnstile(page);
        if (!resolved) throw new Error('Turnstile faucet non résolu');

        console.log('⏳ Attente de 15 secondes après Turnstile...');
        await delay(15000);

        await clickClaim(page);

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

        const success = btnDisabled || messages.some(m => /success|claimed|reward|sent/i.test(m));
        status.success = success;
        status.message = messages[0] || (btnDisabled ? 'Bouton désactivé' : 'Aucune réaction');

    } catch (e) {
        console.error('❌', e);
        status.message = e.message;
    } finally {
        if (browser) await browser.close();
        fs.writeFileSync(path.join(__dirname, 'public', 'status.json'), JSON.stringify(status, null, 2));
        console.log('📝', status.success ? 'SUCCÈS' : 'ÉCHEC');
    }
})();
