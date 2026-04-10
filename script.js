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

// Attendre Turnstile
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

// Clic sur CLAIM avec capture réseau et diagnostic avancé
async function clickClaimButton(page) {
    console.log('🎯 Recherche du bouton "CLAIM"...');
    await page.waitForNetworkIdle({ timeout: 15000 }).catch(() => {});
    await delay(3000);

    console.log('🛡️ Vérification Turnstile faucet...');
    await waitForTurnstileGone(page, 30000);

    // Collecte des requêtes réseau
    const requests = [];
    const requestListener = (req) => {
        if (['xhr', 'fetch'].includes(req.resourceType())) {
            requests.push({ url: req.url(), method: req.method(), postData: req.postData() });
        }
    };
    page.on('request', requestListener);

    // Fonction pour cliquer dans une frame
    const clickInFrame = async (frame) => {
        try {
            return await frame.evaluate(() => {
                const elements = Array.from(document.querySelectorAll('button, input[type="submit"], a, div[role="button"], span[role="button"]'));
                const btn = elements.find(el => {
                    const text = (el.textContent || el.value || '').trim().toUpperCase();
                    return text === 'CLAIM' && !el.disabled && el.offsetParent !== null;
                });
                if (btn) {
                    btn.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    btn.click();
                    return { success: true, text: btn.textContent.trim() };
                }
                return { success: false };
            });
        } catch (e) {
            return { success: false };
        }
    };

    let result = await clickInFrame(page.mainFrame());
    if (!result.success) {
        const frames = page.frames();
        for (let i = 1; i < frames.length; i++) {
            result = await clickInFrame(frames[i]);
            if (result.success) break;
        }
    }

    if (!result || !result.success) {
        page.off('request', requestListener);
        console.log('❌ Bouton CLAIM introuvable');
        return { success: false, message: 'Bouton introuvable' };
    }

    console.log(`✅ Clic sur "${result.text}" effectué`);

    // Attendre les requêtes réseau (max 20s)
    await page.waitForNetworkIdle({ timeout: 20000 }).catch(() => console.log('⚠️ Network idle timeout'));

    // Attendre l'apparition d'éventuels messages/modales
    console.log('⏳ Attente de feedback (messages, modales)...');
    const startWait = Date.now();
    let feedback = null;
    while (Date.now() - startWait < 15000) {
        feedback = await page.evaluate(() => {
            // Messages
            const msgSels = ['.alert', '.message', '.toast', '[class*="success"]', '[class*="error"]', '.swal2-popup', '.modal'];
            for (const s of msgSels) {
                const el = document.querySelector(s);
                if (el && el.offsetParent !== null) return { type: 'message', text: el.textContent.trim() };
            }
            // Bouton CLAIM désactivé ?
            const btn = [...document.querySelectorAll('button, input[type="submit"]')].find(el => (el.textContent || el.value || '').trim().toUpperCase() === 'CLAIM');
            if (btn && btn.disabled) return { type: 'button_disabled', text: btn.textContent.trim() };
            return null;
        });
        if (feedback) break;
        await delay(1000);
    }

    page.off('request', requestListener);

    // Logs des requêtes capturées
    console.log(`🌐 Requêtes AJAX/Fetch : ${requests.length}`);
    requests.forEach((r, i) => console.log(`   ${i+1}. ${r.method} ${r.url}`));

    // Capture d'écran post-clic
    const screenshot = await page.screenshot({ encoding: 'base64', fullPage: true });
    console.log('📸 CAPTURE_BASE64_START');
    console.log(screenshot);
    console.log('📸 CAPTURE_BASE64_END');

    if (feedback) {
        console.log(`💬 Feedback détecté : ${feedback.type} - "${feedback.text}"`);
        if (feedback.type === 'button_disabled' || feedback.text.toLowerCase().includes('success')) {
            return { success: true, message: feedback.text };
        } else {
            return { success: false, message: feedback.text };
        }
    }

    // Vérifier si le bouton a changé d'état (dernière chance)
    const afterInfo = await page.evaluate(() => {
        const btn = [...document.querySelectorAll('button, input[type="submit"]')].find(el => (el.textContent || el.value || '').trim().toUpperCase() === 'CLAIM');
        return btn ? { text: btn.textContent.trim(), disabled: btn.disabled } : null;
    });
    if (afterInfo) {
        console.log(`📌 État final bouton : "${afterInfo.text}", disabled=${afterInfo.disabled}`);
        if (afterInfo.disabled) {
            return { success: true, message: 'Bouton désactivé (succès présumé)' };
        }
    }

    return { success: false, message: 'Aucune réaction détectée' };
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
                status.success = true;
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
