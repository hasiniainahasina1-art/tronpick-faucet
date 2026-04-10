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

// Attendre que Turnstile disparaisse (utilisable partout)
async function waitForTurnstileGone(page, maxWaitMs = 60000) {
    console.log('🔎 Surveillance Turnstile...');
    const start = Date.now();
    while (Date.now() - start < maxWaitMs) {
        try {
            const frames = page.frames();
            const tf = frames.find(f => f.url().includes('challenges.cloudflare.com/turnstile'));
            if (!tf) { console.log('✅ Iframe Turnstile disparue'); return true; }
            const checked = await tf.$eval('input[type="checkbox"]', cb => cb.checked);
            if (checked) console.log('   Case Turnstile cochée');
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

// Clic sur CLAIM (spécifiquement)
async function clickClaimButton(page) {
    console.log('🎯 Recherche du bouton "CLAIM"...');

    // Attendre que la page faucet soit stable
    await page.waitForNetworkIdle({ timeout: 15000 }).catch(() => {});
    await delay(3000);

    // Gérer Turnstile s'il apparaît sur la page faucet
    console.log('🛡️ Vérification Turnstile sur la page faucet...');
    await waitForTurnstileGone(page, 30000);

    // Fonction pour cliquer sur CLAIM dans une frame
    const clickInFrame = async (frame) => {
        try {
            return await frame.evaluate(() => {
                const elements = Array.from(document.querySelectorAll('button, input[type="submit"], a, div[role="button"], span[role="button"]'));
                // Recherche stricte du texte "CLAIM" (insensible à la casse)
                const btn = elements.find(el => {
                    const text = (el.textContent || el.value || '').trim();
                    return text.toUpperCase() === 'CLAIM' && !el.disabled && el.offsetParent !== null;
                });
                if (btn) {
                    btn.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    btn.click();
                    return { success: true, text: btn.textContent.trim() };
                }
                return { success: false };
            });
        } catch (e) {
            return { success: false, error: e.message };
        }
    };

    // Essayer page principale
    let result = await clickInFrame(page.mainFrame());
    if (!result.success) {
        const frames = page.frames();
        for (let i = 1; i < frames.length; i++) {
            result = await clickInFrame(frames[i]);
            if (result.success) break;
        }
    }

    if (!result || !result.success) {
        console.log('❌ Bouton CLAIM introuvable');
        return { success: false, message: 'Bouton CLAIM introuvable' };
    }

    console.log(`✅ Clic sur "${result.text}" effectué`);

    // Attendre la réponse réseau
    await page.waitForNetworkIdle({ timeout: 15000 }).catch(() => console.log('⚠️ Network idle timeout'));
    await delay(4000);

    // Vérifier l'état après clic (bouton désactivé ou message)
    const afterInfo = await page.evaluate(() => {
        const elements = Array.from(document.querySelectorAll('button, input[type="submit"], a, div[role="button"], span[role="button"]'));
        const btn = elements.find(el => (el.textContent || el.value || '').trim().toUpperCase() === 'CLAIM');
        if (btn) {
            return { text: btn.textContent.trim(), disabled: btn.disabled };
        }
        return null;
    });

    if (afterInfo) {
        console.log(`📌 État après clic : "${afterInfo.text}", disabled=${afterInfo.disabled}`);
        if (afterInfo.disabled) {
            return { success: true, message: 'Bouton CLAIM désactivé (succès présumé)' };
        }
    }

    // Vérifier messages DOM (succès/erreur)
    const message = await page.evaluate(() => {
        const sels = ['.alert', '.message', '.toast', '[class*="success"]', '[class*="error"]'];
        for (const s of sels) {
            const el = document.querySelector(s);
            if (el && el.offsetParent !== null) return el.textContent.trim();
        }
        return null;
    });
    if (message) {
        console.log(`💬 Message DOM : ${message}`);
        if (message.toLowerCase().includes('success') || message.toLowerCase().includes('claim')) {
            return { success: true, message };
        }
    }

    // Aucun changement → capture d'écran
    const screenshot = await page.screenshot({ encoding: 'base64', fullPage: true });
    console.log('📸 CAPTURE_BASE64_START');
    console.log(screenshot);
    console.log('📸 CAPTURE_BASE64_END');
    return { success: false, message: 'Aucune réaction après clic' };
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

            // --- CLAIM (avec gestion Turnstile spécifique) ---
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
