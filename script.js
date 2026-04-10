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

// Saisie robuste d'un champ
async function fillField(page, selector, value, fieldName) {
    console.log(`⌨️ Remplissage du champ ${fieldName}...`);
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
    let actualValue = await page.$eval(selector, el => el.value);
    if (actualValue !== value) {
        await page.click(selector, { clickCount: 3 });
        await page.keyboard.press('Backspace');
        for (const char of value) await page.keyboard.type(char, { delay: 30 });
        actualValue = await page.$eval(selector, el => el.value);
    }
    if (actualValue !== value) throw new Error(`Impossible de remplir ${fieldName}`);
    console.log(`✅ Champ ${fieldName} rempli`);
}

// Surveillance Turnstile
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

// Lister les éléments cliquables visibles (diagnostic)
async function listClickableElements(page) {
    const elements = await page.evaluate(() => {
        const sels = 'button, a, input[type="submit"], input[type="button"], [role="button"], [onclick]';
        return Array.from(document.querySelectorAll(sels))
            .filter(el => el.offsetParent !== null)
            .map(el => ({
                tag: el.tagName,
                text: (el.textContent || el.value || '').trim().substring(0, 40),
                disabled: el.disabled || false
            }));
    });
    console.log('📋 Éléments cliquables visibles :');
    elements.forEach((el, i) => console.log(`   ${i+1}. [${el.tag}] "${el.text}" ${el.disabled ? '(désactivé)' : ''}`));
    return elements;
}

// Recherche et clic sur CLAIM (dans la page principale et iframes)
async function clickClaimButton(page) {
    console.log('🎯 Recherche du bouton CLAIM...');

    // Fonction pour chercher dans une frame donnée
    const findAndClickInFrame = async (frame) => {
        try {
            return await frame.evaluate(() => {
                const keywords = ['claim', 'roll', 'get', 'receive', 'collect', 'free', 'withdraw', 'claim now', 'get reward'];
                const elements = Array.from(document.querySelectorAll('button, input[type="submit"], a, div[role="button"], span[role="button"]'));
                for (const el of elements) {
                    const text = (el.textContent || el.value || '').toLowerCase();
                    if (keywords.some(kw => text.includes(kw)) && !el.disabled && el.offsetParent !== null) {
                        el.click();
                        return { clicked: true, text: text };
                    }
                }
                return { clicked: false };
            });
        } catch (e) {
            return { clicked: false };
        }
    };

    // Essayer la page principale
    let result = await findAndClickInFrame(page.mainFrame());
    if (result.clicked) {
        console.log(`✅ CLAIM cliqué (page principale) : "${result.text}"`);
        await delay(5000);
        return true;
    }

    // Essayer toutes les iframes
    const frames = page.frames();
    for (let i = 1; i < frames.length; i++) {
        result = await findAndClickInFrame(frames[i]);
        if (result.clicked) {
            console.log(`✅ CLAIM cliqué (iframe ${i}) : "${result.text}"`);
            await delay(5000);
            return true;
        }
    }

    console.log('⚠️ Aucun bouton CLAIM trouvé');
    return false;
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
            await delay(10000); // Attendre chargement complet

            // Diagnostic : lister les éléments cliquables
            await listClickableElements(page);

            // Tentative de clic sur CLAIM
            const claimClicked = await clickClaimButton(page);

            if (claimClicked) {
                status.success = true;
                status.message = 'Connexion réussie et CLAIM effectué';
            } else {
                // Échec : capture d'écran pour analyse
                console.log('📸 Capture d\'écran pour diagnostic :');
                const screenshot = await page.screenshot({ encoding: 'base64', fullPage: true });
                console.log('📸 CAPTURE_BASE64_START');
                console.log(screenshot);
                console.log('📸 CAPTURE_BASE64_END');
                status.success = true; // Connexion OK, mais claim échoue
                status.message = 'Connexion réussie, mais CLAIM non trouvé (voir capture)';
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
