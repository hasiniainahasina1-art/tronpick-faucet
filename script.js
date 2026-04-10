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

// Turnstile
async function waitForTurnstileGone(page, maxWaitMs = 60000) {
    console.log('🔎 Surveillance Turnstile...');
    const start = Date.now();
    while (Date.now() - start < maxWaitMs) {
        try {
            const frames = page.frames();
            const tf = frames.find(f => f.url().includes('challenges.cloudflare.com/turnstile'));
            if (!tf) { console.log('✅ Iframe Turnstile disparue'); return true; }
            const checked = await tf.$eval('input[type="checkbox"]', cb => cb.checked);
            if (checked) console.log('   Case cochée');
        } catch (e) {}
        await delay(2000);
    }
    console.log('⚠️ Timeout Turnstile');
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

// Analyse du clic CLAIM
async function clickClaimWithDiagnostics(page) {
    console.log('🎯 Recherche du bouton CLAIM...');

    // Collecte des requêtes réseau
    const requests = [];
    const onRequest = (req) => {
        if (['xhr', 'fetch'].includes(req.resourceType())) {
            requests.push({ url: req.url(), method: req.method(), postData: req.postData() });
        }
    };
    page.on('request', onRequest);

    // Collecte des messages console
    const consoleMessages = [];
    const onConsole = msg => consoleMessages.push({ type: msg.type(), text: msg.text() });
    page.on('console', onConsole);

    // Trouver le bouton dans la page principale ou iframes
    const findButtonInFrame = async (frame) => {
        try {
            return await frame.evaluateHandle(() => {
                const keywords = ['claim', 'roll', 'get', 'receive', 'collect', 'free', 'withdraw'];
                const elements = Array.from(document.querySelectorAll('button, input[type="submit"], a, div[role="button"], span[role="button"]'));
                return elements.find(el => {
                    const text = (el.textContent || el.value || '').toLowerCase();
                    return keywords.some(kw => text.includes(kw)) && !el.disabled && el.offsetParent !== null;
                });
            });
        } catch (e) { return null; }
    };

    let buttonHandle = await findButtonInFrame(page.mainFrame());
    let targetFrame = page.mainFrame();
    if (!buttonHandle) {
        const frames = page.frames();
        for (let i = 1; i < frames.length; i++) {
            buttonHandle = await findButtonInFrame(frames[i]);
            if (buttonHandle) {
                targetFrame = frames[i];
                break;
            }
        }
    }

    if (!buttonHandle) {
        console.log('❌ Bouton CLAIM introuvable');
        return { success: false, message: 'Bouton introuvable' };
    }

    // Informations avant clic
    const beforeInfo = await targetFrame.evaluate(el => ({
        text: el.textContent.trim(),
        disabled: el.disabled,
        className: el.className,
        boundingBox: el.getBoundingClientRect()
    }), buttonHandle);
    console.log(`📌 Bouton avant clic : "${beforeInfo.text}", disabled=${beforeInfo.disabled}`);

    // S'assurer que le bouton est visible et cliquable
    await targetFrame.evaluate(el => el.scrollIntoView({ behavior: 'smooth', block: 'center' }), buttonHandle);
    await delay(500);

    // Simuler un clic réaliste (mouvement de souris + clic)
    const box = beforeInfo.boundingBox;
    if (box) {
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 10 });
        await delay(100);
        await page.mouse.down();
        await delay(50);
        await page.mouse.up();
    } else {
        await buttonHandle.click();
    }
    console.log('🖱️ Clic émulé');

    // Attendre les requêtes réseau
    await page.waitForNetworkIdle({ timeout: 10000 }).catch(() => console.log('⚠️ Network idle timeout'));

    // Informations après clic
    const afterInfo = await targetFrame.evaluate(el => ({
        text: el.textContent.trim(),
        disabled: el.disabled,
        className: el.className
    }), buttonHandle);
    console.log(`📌 Bouton après clic : "${afterInfo.text}", disabled=${afterInfo.disabled}`);

    // Nettoyer les écouteurs
    page.off('request', onRequest);
    page.off('console', onConsole);

    // Analyser les requêtes
    console.log(`🌐 Requêtes AJAX/Fetch capturées : ${requests.length}`);
    requests.forEach((r, i) => {
        console.log(`   ${i+1}. ${r.method} ${r.url}`);
        if (r.postData) console.log(`      Body: ${r.postData}`);
    });

    // Analyser les messages console
    const relevantConsole = consoleMessages.filter(m => m.type === 'log' || m.type === 'info' || m.type === 'error');
    if (relevantConsole.length) {
        console.log(`📟 Messages console :`);
        relevantConsole.forEach(m => console.log(`   [${m.type}] ${m.text}`));
    }

    // Vérifier les messages d'erreur/succès dans le DOM
    const domMessage = await page.evaluate(() => {
        const sels = ['.alert', '.message', '.toast', '[class*="success"]', '[class*="error"]'];
        for (const s of sels) {
            const el = document.querySelector(s);
            if (el && el.offsetParent !== null) return el.textContent.trim();
        }
        return null;
    });
    if (domMessage) console.log(`💬 Message DOM : ${domMessage}`);

    // Déterminer le succès
    const changed = (beforeInfo.text !== afterInfo.text) || (beforeInfo.disabled !== afterInfo.disabled);
    const hasRequest = requests.length > 0;
    const hasMessage = domMessage !== null;

    if (changed || hasRequest || hasMessage) {
        return { success: true, message: 'Action détectée (changement bouton / requête / message)' };
    } else {
        // Capture d'écran et HTML pour diagnostic
        const screenshot = await page.screenshot({ encoding: 'base64', fullPage: true });
        console.log('📸 CAPTURE_BASE64_START');
        console.log(screenshot);
        console.log('📸 CAPTURE_BASE64_END');
        const html = await page.content();
        console.log('📄 HTML (extrait) :', html.substring(0, 500));
        return { success: false, message: 'Aucune réaction détectée' };
    }
}

(async () => {
    let browser;
    const status = { success: false, time: new Date().toISOString(), message: '' };

    try {
        console.log('🚀 Lancement navigateur furtif...');
        const { browser: br, page } = await connect({
            headless: false,
            turnstile: true,
            proxy: { host: PROXY_HOST, port: PROXY_PORT, username: PROXY_USERNAME, password: PROXY_PASSWORD }
        });
        browser = br;
        console.log('✅ Navigateur prêt');

        page.on('dialog', async d => { await d.accept(); });
        await page.setViewport({ width: 1280, height: 720 });

        // --- LOGIN ---
        console.log('🌐 Accès login...');
        await page.goto('https://tronpick.io/login.php', { waitUntil: 'networkidle2', timeout: 60000 });

        const emailSel = 'input[type="email"], input[name="email"], input#email';
        const passSel = 'input[type="password"], input[name="password"], input#password';
        await fillField(page, emailSel, EMAIL, 'email');
        await delay(500);
        await fillField(page, passSel, PASSWORD, 'password');
        await delay(2000);

        console.log('🔐 Clic sur "Log in"...');
        const loginBtn = await page.evaluateHandle(() => {
            const btns = Array.from(document.querySelectorAll('button'));
            return btns.find(b => b.textContent.trim() === 'Log in');
        });
        if (!loginBtn) throw new Error('Bouton Log in introuvable');

        await Promise.all([
            page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 60000 }).catch(e => console.log('⚠️ Navigation timeout:', e.message)),
            loginBtn.click()
        ]);
        console.log('✅ Navigation terminée');

        await delay(3000);
        await waitForTurnstileGone(page, 60000);

        const loggedIn = await isLoggedIn(page);
        console.log('📍 URL après login :', page.url());
        if (!loggedIn) {
            const err = await page.evaluate(() => {
                const el = document.querySelector('.alert-danger, .error');
                return el ? el.textContent.trim() : null;
            });
            status.message = err ? `Échec login: ${err}` : 'Échec de connexion';
            console.log('❌', status.message);
        } else {
            console.log('✅ Connexion réussie !');

            // --- FAUCET ---
            console.log('🚰 Accès faucet...');
            await page.goto('https://tronpick.io/faucet.php', { waitUntil: 'networkidle2', timeout: 30000 });
            await delay(10000);

            // --- CLAIM avec diagnostics ---
            const claimResult = await clickClaimWithDiagnostics(page);

            status.success = claimResult.success;
            status.message = claimResult.success
                ? `Connexion OK, CLAIM: ${claimResult.message}`
                : `Connexion OK, CLAIM échec: ${claimResult.message}`;
        }

    } catch (error) {
        console.error('❌ Erreur fatale :', error);
        status.message = error.message;
    } finally {
        if (browser) await browser.close();
        const statusPath = path.join(__dirname, 'public', 'status.json');
        fs.writeFileSync(statusPath, JSON.stringify(status, null, 2));
        console.log('📝 Statut enregistré :', status.success ? 'SUCCÈS' : 'ÉCHEC');
    }
})();
