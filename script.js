const { connect } = require('puppeteer-real-browser');
const fs = require('fs');
const path = require('path');

const EMAIL = process.env.TRONPICK_EMAIL.trim().toLowerCase();
const PASSWORD = process.env.TRONPICK_PASSWORD;
const PROXY_USERNAME = process.env.PROXY_USERNAME;
const PROXY_PASSWORD = process.env.PROXY_PASSWORD;
const PROXY_HOST = '31.59.20.176';
const PROXY_PORT = '6754';

// Dossier pour les captures
const outputDir = path.join(__dirname, 'screenshots');
if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

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

async function resolveTurnstile(page) {
    console.log('🛡️ Résolution avancée de Turnstile...');
    await delay(5000);

    // Approche 1 : via iframe
    const iframeHandle = await page.$('iframe[src*="challenges.cloudflare.com/turnstile"]');
    if (iframeHandle) {
        console.log('✅ Iframe Turnstile trouvée via sélecteur CSS');
        const frame = await iframeHandle.contentFrame();
        if (frame) {
            try {
                await frame.waitForSelector('body', { timeout: 5000 });
                const clicked = await frame.evaluate(() => {
                    const label = Array.from(document.querySelectorAll('label')).find(l => l.textContent.toLowerCase().includes('verify you are human'));
                    if (label) { label.click(); return true; }
                    const cb = document.querySelector('input[type="checkbox"]');
                    if (cb) { cb.click(); return true; }
                    return false;
                });
                if (clicked) {
                    console.log('   Clic effectué dans l\'iframe');
                    await page.waitForFunction(() => {
                        const inp = document.querySelector('[name="cf-turnstile-response"]');
                        return inp && inp.value.length > 10;
                    }, { timeout: 30000 });
                    console.log('✅ Token généré après clic dans l\'iframe');
                    return true;
                }
            } catch (e) {
                console.log('   Erreur dans l\'iframe :', e.message);
            }
        }
    }

    // Approche 2 : clic par coordonnées
    console.log('🔄 Passage à la méthode de clic par coordonnées...');
    try {
        await page.waitForSelector('iframe[src*="challenges.cloudflare.com/turnstile"]', { timeout: 30000 });
        const iframeElement = await page.$('iframe[src*="challenges.cloudflare.com/turnstile"]');
        const box = await iframeElement.boundingBox();
        if (!box) throw new Error('Bounding box non disponible');

        const clickX = box.x + box.width / 2;
        const clickY = box.y + box.height / 2;
        console.log(`📍 Clic prévu au centre (${Math.round(clickX)}, ${Math.round(clickY)})`);

        const start = await page.evaluate(() => ({ x: window.innerWidth / 2, y: window.innerHeight / 2 }));
        const steps = 25;
        for (let i = 1; i <= steps; i++) {
            const t = i / steps;
            const cp = { x: start.x + (Math.random() - 0.5) * 200, y: start.y + (Math.random() - 0.5) * 200 };
            const x = Math.pow(1 - t, 2) * start.x + 2 * (1 - t) * t * cp.x + Math.pow(t, 2) * clickX;
            const y = Math.pow(1 - t, 2) * start.y + 2 * (1 - t) * t * cp.y + Math.pow(t, 2) * clickY;
            await page.mouse.move(x, y);
            await delay(20);
        }
        await page.mouse.click(clickX, clickY);
        console.log('✅ Clic effectué sur l\'iframe');

        await page.waitForFunction(() => {
            const inp = document.querySelector('[name="cf-turnstile-response"]');
            return inp && inp.value.length > 10;
        }, { timeout: 30000 });
        console.log('✅ Token généré');
        return true;
    } catch (e) {
        console.error('❌ Échec de la méthode par coordonnées :', e.message);
        // 📸 Capture d'écran de diagnostic
        const screenshotPath = path.join(outputDir, `faucet_failure_${Date.now()}.png`);
        await page.screenshot({ path: screenshotPath, fullPage: true });
        console.log(`📸 Capture sauvegardée : ${screenshotPath}`);
        return false;
    }
}

async function clickClaim(page) {
    console.log('🎯 Clic sur le bouton CLAIM...');
    const claimSelector = '#process_claim_hourly_faucet';
    await page.waitForSelector(claimSelector, { timeout: 10000 });
    const btn = await page.$(claimSelector);
    if (!await btn.evaluate(el => !el.disabled && el.offsetParent !== null)) {
        throw new Error('Bouton CLAIM désactivé (timer)');
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

        const resolved = await resolveTurnstile(page);
        if (!resolved) throw new Error('Turnstile faucet non résolu');

        console.log('⏳ Pause de 10 secondes après résolution...');
        await delay(10000);

        await clickClaim(page);

        await page.waitForNetworkIdle({ timeout: 20000 }).catch(() => {});
        await delay(5000);

        const messages = await page.evaluate(() => {
            return Array.from(document.querySelectorAll('[class*="toast"], [class*="alert"], [role="alert"]'))
                .map(el => el.textContent.trim()).filter(t => t);
        });
        console.log('💬 Messages :', messages);

        const btnDisabled = await page.evaluate(() => document.querySelector('#process_claim_hourly_faucet')?.disabled || false);

        const success = btnDisabled || messages.some(m => /success|claimed|reward|sent/i.test(m));
        status.success = success;
        status.message = messages[0] || (btnDisabled ? 'Bouton désactivé (succès présumé)' : 'Aucune réaction');

    } catch (e) {
        console.error('❌', e);
        status.message = e.message;
    } finally {
        if (browser) await browser.close();
        fs.writeFileSync(path.join(__dirname, 'public', 'status.json'), JSON.stringify(status, null, 2));
        console.log('📝', status.success ? 'SUCCÈS' : 'ÉCHEC');
    }
})();
