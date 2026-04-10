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

async function getErrorMessages(page) {
    try {
        return await page.evaluate(() => {
            const sels = ['.alert-danger', '.error', '.message-error', '[class*="error"]', '.text-danger'];
            for (const s of sels) {
                const el = document.querySelector(s);
                if (el && el.offsetParent !== null) return el.textContent.trim();
            }
            return null;
        });
    } catch (e) { return null; }
}

async function getSuccessMessages(page) {
    try {
        return await page.evaluate(() => {
            const sels = ['.alert-success', '.success', '.message-success', '[class*="success"]'];
            for (const s of sels) {
                const el = document.querySelector(s);
                if (el && el.offsetParent !== null) return el.textContent.trim();
            }
            return null;
        });
    } catch (e) { return null; }
}

// Recherche et clic sur CLAIM avec feedback
async function clickClaimButton(page) {
    console.log('🎯 Recherche du bouton CLAIM...');

    // Fonction pour trouver dans une frame
    const findInFrame = async (frame) => {
        try {
            return await frame.evaluate(() => {
                const keywords = ['claim', 'roll', 'get', 'receive', 'collect', 'free', 'withdraw', 'claim now', 'get reward'];
                const elements = Array.from(document.querySelectorAll('button, input[type="submit"], a, div[role="button"], span[role="button"]'));
                for (const el of elements) {
                    const text = (el.textContent || el.value || '').toLowerCase();
                    if (keywords.some(kw => text.includes(kw)) && !el.disabled && el.offsetParent !== null) {
                        return { selector: el.tagName, text: text };
                    }
                }
                return null;
            });
        } catch (e) { return null; }
    };

    // Trouver le bouton
    let buttonInfo = await findInFrame(page.mainFrame());
    let targetFrame = page.mainFrame();
    if (!buttonInfo) {
        const frames = page.frames();
        for (let i = 1; i < frames.length; i++) {
            buttonInfo = await findInFrame(frames[i]);
            if (buttonInfo) {
                targetFrame = frames[i];
                break;
            }
        }
    }

    if (!buttonInfo) {
        console.log('⚠️ Bouton CLAIM non trouvé');
        return false;
    }

    console.log(`✅ Bouton trouvé : "${buttonInfo.text}" dans ${targetFrame === page.mainFrame() ? 'page principale' : 'iframe'}`);

    // Sauvegarder l'état avant clic
    const beforeState = await targetFrame.evaluate(() => {
        const btn = [...document.querySelectorAll('button, input[type="submit"], a')].find(el => {
            const t = (el.textContent || el.value || '').toLowerCase();
            return ['claim','roll','get','receive','collect','free','withdraw'].some(k => t.includes(k));
        });
        return btn ? { text: btn.textContent.trim(), disabled: btn.disabled } : null;
    });

    // Cliquer
    await targetFrame.evaluate((textHint) => {
        const keywords = ['claim', 'roll', 'get', 'receive', 'collect', 'free', 'withdraw', 'claim now', 'get reward'];
        const elements = Array.from(document.querySelectorAll('button, input[type="submit"], a, div[role="button"], span[role="button"]'));
        const btn = elements.find(el => {
            const t = (el.textContent || el.value || '').toLowerCase();
            return keywords.some(kw => t.includes(kw)) && !el.disabled && el.offsetParent !== null;
        });
        if (btn) btn.click();
    }, buttonInfo.text);

    console.log('🖱️ Clic effectué, attente de la réponse...');
    await page.waitForNetworkIdle({ timeout: 15000 }).catch(() => console.log('⚠️ Network idle timeout'));
    await delay(3000);

    // Vérifier les messages
    const errorMsg = await getErrorMessages(page);
    if (errorMsg) {
        console.log('❌ Message d\'erreur :', errorMsg);
        return { success: false, message: errorMsg };
    }

    const successMsg = await getSuccessMessages(page);
    if (successMsg) {
        console.log('✅ Message de succès :', successMsg);
        return { success: true, message: successMsg };
    }

    // Vérifier le changement d'état du bouton
    const afterState = await targetFrame.evaluate(() => {
        const btn = [...document.querySelectorAll('button, input[type="submit"], a')].find(el => {
            const t = (el.textContent || el.value || '').toLowerCase();
            return ['claim','roll','get','receive','collect','free','withdraw'].some(k => t.includes(k));
        });
        return btn ? { text: btn.textContent.trim(), disabled: btn.disabled } : null;
    });

    if (afterState) {
        if (afterState.disabled) {
            console.log('✅ Bouton désactivé après clic – probablement réussi');
            return { success: true, message: 'Bouton CLAIM désactivé (succès présumé)' };
        }
        if (beforeState && beforeState.text !== afterState.text) {
            console.log(`✅ Texte du bouton changé : "${beforeState.text}" → "${afterState.text}"`);
            return { success: true, message: 'Bouton CLAIM changé (succès présumé)' };
        }
    }

    // Aucun feedback évident
    console.log('⚠️ Aucun feedback détecté après clic');
    return { success: false, message: 'Aucune réaction visible' };
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
            const err = await getErrorMessages(page);
            status.message = err ? `Échec login: ${err}` : 'Échec de connexion';
            console.log('❌', status.message);
        } else {
            console.log('✅ Connexion réussie !');

            // --- FAUCET ---
            console.log('🚰 Accès faucet...');
            await page.goto('https://tronpick.io/faucet.php', { waitUntil: 'networkidle2', timeout: 30000 });
            await delay(10000);

            // --- CLAIM avec feedback ---
            const claimResult = await clickClaimButton(page);

            if (claimResult.success) {
                status.success = true;
                status.message = `Connexion OK, CLAIM: ${claimResult.message}`;
            } else {
                // Capture d'écran
                const screenshot = await page.screenshot({ encoding: 'base64', fullPage: true });
                console.log('📸 CAPTURE_BASE64_START');
                console.log(screenshot);
                console.log('📸 CAPTURE_BASE64_END');
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
