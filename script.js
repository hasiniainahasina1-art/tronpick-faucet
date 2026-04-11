const { connect } = require('puppeteer-real-browser');
const fs = require('fs');
const path = require('path');

const EMAIL = process.env.TRONPICK_EMAIL.trim().toLowerCase();
const PASSWORD = process.env.TRONPICK_PASSWORD;
const PROXY_USERNAME = process.env.PROXY_USERNAME;
const PROXY_PASSWORD = process.env.PROXY_PASSWORD;
const PROXY_HOST = '31.59.20.176';
const PROXY_PORT = '6754';

// Création du dossier de captures
const outputDir = path.join(__dirname, 'screenshots');
if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

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

// Connexion avec gestion Turnstile
async function login(page) {
    console.log('🌐 Accès login...');
    await page.goto('https://tronpick.io/login.php', { waitUntil: 'networkidle2', timeout: 60000 });

    await fillField(page, 'input[type="email"], input[name="email"]', EMAIL, 'email');
    await fillField(page, 'input[type="password"]', PASSWORD, 'password');
    await delay(2000);

    // Résoudre Turnstile login (simplifié)
    try {
        const frame = await page.waitForFrame(
            f => f.url().includes('challenges.cloudflare.com/turnstile'),
            { timeout: 30000 }
        );
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

// Diagnostic complet de la page faucet (avant clic)
async function diagnoseFaucet(page) {
    console.log('🔬 DIAGNOSTIC FAUCET AVANT CLIC');

    // Capture d'écran AVANT
    const screenshotBefore = await page.screenshot({ encoding: 'base64', fullPage: true });
    const beforePath = path.join(outputDir, `before_${Date.now()}.png`);
    fs.writeFileSync(beforePath, screenshotBefore, 'base64');
    console.log(`📸 Capture AVANT sauvegardée : ${beforePath}`);

    // Lister toutes les iframes
    const frames = page.frames();
    console.log(`🖼️ ${frames.length} frames :`);
    frames.forEach((f, i) => console.log(`   ${i}: ${f.url().substring(0, 100)}`));

    // Lister les inputs cachés
    const hiddenInputs = await page.evaluate(() => {
        return Array.from(document.querySelectorAll('input[type="hidden"]')).map(el => ({
            name: el.name,
            value: el.value.substring(0, 100)
        }));
    });
    console.log('📦 Inputs cachés :', JSON.stringify(hiddenInputs, null, 2));

    // État du bouton Claim
    const btnInfo = await page.evaluate(() => {
        const btn = document.querySelector('#process_claim_hourly_faucet');
        if (!btn) return null;
        return {
            text: btn.textContent.trim(),
            disabled: btn.disabled,
            visible: btn.offsetParent !== null,
            className: btn.className
        };
    });
    console.log('🔘 Bouton Claim :', btnInfo);
}

// Clic forcé et monitoring réseau
async function forceClickAndMonitor(page) {
    const networkLogs = [];
    const requestListener = (req) => {
        if (['xhr', 'fetch'].includes(req.resourceType())) {
            networkLogs.push({ type: 'request', url: req.url(), method: req.method(), postData: req.postData() });
        }
    };
    const responseListener = async (res) => {
        const req = res.request();
        if (['xhr', 'fetch'].includes(req.resourceType())) {
            try {
                const body = await res.text().catch(() => '');
                networkLogs.push({ type: 'response', url: res.url(), status: res.status(), body: body.substring(0, 500) });
            } catch (e) {}
        }
    };
    page.on('request', requestListener);
    page.on('response', responseListener);

    console.log('🖱️ Clic forcé sur le bouton Claim...');
    const clicked = await page.evaluate(() => {
        const btn = document.querySelector('#process_claim_hourly_faucet');
        if (btn && !btn.disabled) {
            btn.scrollIntoView({ behavior: 'smooth', block: 'center' });
            btn.click();
            return true;
        }
        return false;
    });
    if (!clicked) {
        const fallback = await page.evaluate(() => {
            const b = [...document.querySelectorAll('button')].find(b => b.textContent.trim().toUpperCase() === 'CLAIM');
            if (b && !b.disabled) { b.click(); return true; }
            return false;
        });
        if (!fallback) throw new Error('Impossible de cliquer sur Claim');
    }
    console.log('✅ Clic effectué');

    await delay(15000);
    page.off('request', requestListener);
    page.off('response', responseListener);

    // Logs réseau
    console.log(`🌐 Trafic réseau (${networkLogs.length}) :`);
    networkLogs.forEach((log, i) => {
        if (log.type === 'request') {
            console.log(`   ${i+1}. REQ ${log.method} ${log.url}`);
        } else {
            console.log(`   ${i+1}. RES ${log.status} ${log.url} → ${log.body || ''}`);
        }
    });

    // Capture APRÈS
    const screenshotAfter = await page.screenshot({ encoding: 'base64', fullPage: true });
    const afterPath = path.join(outputDir, `after_${Date.now()}.png`);
    fs.writeFileSync(afterPath, screenshotAfter, 'base64');
    console.log(`📸 Capture APRÈS sauvegardée : ${afterPath}`);

    // Messages DOM
    const messages = await page.evaluate(() => {
        return Array.from(document.querySelectorAll('[class*="toast"], [class*="alert"], [role="alert"]'))
            .map(el => el.textContent.trim()).filter(t => t);
    });
    console.log('💬 Messages DOM après clic :', messages);

    // État final du bouton
    const finalState = await page.evaluate(() => {
        const btn = document.querySelector('#process_claim_hourly_faucet');
        return btn ? { disabled: btn.disabled, text: btn.textContent.trim() } : null;
    });
    console.log('🔘 État final bouton :', finalState);

    return { messages, finalState, networkLogs };
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

        await diagnoseFaucet(page);
        const result = await forceClickAndMonitor(page);

        const success = result.finalState?.disabled ||
                        result.messages.some(m => /success|claimed|reward|sent/i.test(m)) ||
                        result.networkLogs.some(l => l.type === 'response' && l.status === 200 && /claim|reward|faucet/i.test(l.url));
        status.success = success;
        status.message = result.messages[0] || (result.finalState?.disabled ? 'Bouton désactivé' : 'Aucune réaction');

    } catch (e) {
        console.error('❌', e);
        status.message = e.message;
    } finally {
        if (browser) await browser.close();
        fs.writeFileSync(path.join(__dirname, 'public', 'status.json'), JSON.stringify(status, null, 2));
        console.log('📝', status.success ? 'SUCCÈS' : 'ÉCHEC');
    }
})();
