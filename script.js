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

// Clic sur CLAIM avec gestion d'obsolescence
async function clickClaimButton(page) {
    console.log('🎯 Recherche du bouton "CLAIM"...');
    await page.waitForNetworkIdle({ timeout: 15000 }).catch(() => {});
    await delay(3000);

    console.log('🛡️ Vérification Turnstile faucet...');
    await waitForTurnstileGone(page, 30000);

    console.log('⏳ Pause de 10 secondes avant le clic...');
    await delay(10000);

    // Définir le XPath exact pour un élément avec texte "CLAIM" (insensible à la casse)
    const claimXPath = `//*[self::button or self::a or self::input][translate(normalize-space(text()), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz')='claim']`;

    // Vérifier si le bouton est présent et activé
    const isEnabled = await page.evaluate((xpath) => {
        const btn = document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
        return btn ? !btn.disabled && btn.offsetParent !== null : false;
    }, claimXPath);

    if (!isEnabled) {
        console.log('❌ Bouton CLAIM non trouvé ou désactivé');
        return { success: false, message: 'Bouton CLAIM introuvable ou désactivé' };
    }

    console.log('✅ Bouton CLAIM trouvé et activé');

    // Clic natif via Puppeteer avec le XPath
    try {
        await page.click(`::-p-xpath(${claimXPath})`);
        console.log('🖱️ Clic natif réussi');
    } catch (e) {
        console.log('⚠️ Clic natif échoué, tentative de clic forcé...');
        // Forcer le clic via JavaScript
        const forced = await page.evaluate((xpath) => {
            const btn = document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
            if (btn) {
                btn.scrollIntoView({ behavior: 'smooth', block: 'center' });
                btn.click();
                return true;
            }
            return false;
        }, claimXPath);
        if (!forced) {
            console.log('❌ Échec du clic forcé');
            return { success: false, message: 'Impossible de cliquer sur CLAIM' };
        }
        console.log('✅ Clic forcé réussi');
    }

    // Attendre la réponse
    console.log('⏳ Attente de feedback...');
    await page.waitForNetworkIdle({ timeout: 15000 }).catch(() => {});
    await delay(5000);

    // Détecter les messages
    const feedback = await page.evaluate(() => {
        const msgSels = ['.alert', '.message', '.toast', '.notification', '.swal2-popup', '.modal', '[class*="success"]', '[class*="error"]'];
        for (const s of msgSels) {
            const el = document.querySelector(s);
            if (el && el.offsetParent !== null && el.textContent.trim()) {
                return { type: 'message', text: el.textContent.trim() };
            }
        }
        const btn = [...document.querySelectorAll('button, input[type="submit"]')].find(el => (el.textContent || el.value || '').trim().toUpperCase() === 'CLAIM');
        if (btn && btn.disabled) return { type: 'button_disabled', text: 'Bouton désactivé après clic' };
        return null;
    });

    // Capture écran
    const screenshot = await page.screenshot({ encoding: 'base64', fullPage: true });
    console.log('📸 CAPTURE_APRES_BASE64_START');
    console.log(screenshot);
    console.log('📸 CAPTURE_APRES_BASE64_END');

    // Texte page
    const pageText = await page.evaluate(() => document.body.innerText);
    console.log('📄 Extrait texte page :');
    pageText.split('\n').filter(l => l.trim()).slice(0, 20).forEach(l => console.log(`   ${l}`));

    if (feedback) {
        console.log(`💬 Feedback : ${feedback.type} - "${feedback.text}"`);
        const msg = feedback.text.toLowerCase();
        if (msg.includes('success') || msg.includes('claimed') || msg.includes('reward') || feedback.type === 'button_disabled') {
            return { success: true, message: feedback.text };
        }
        return { success: false, message: feedback.text };
    }

    return { success: false, message: 'Aucun retour détecté' };
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

            // --- CLAIM ---
            const claimResult = await clickClaimButton(page);

            if (claimResult.success) {
                status.success = true;
                status.message = `Connexion OK, CLAIM: ${claimResult.message}`;
            } else {
                status.success = true; // Connexion OK
                status.message = `Connexion OK, CLAIM échec: ${claimResult.message}`;
            }
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
