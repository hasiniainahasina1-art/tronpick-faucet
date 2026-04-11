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

// Gestion avancée de Turnstile (clic si nécessaire)
async function resolveTurnstile(page, maxWaitMs = 60000) {
    console.log('🔎 Résolution de Turnstile...');
    const start = Date.now();
    while (Date.now() - start < maxWaitMs) {
        const frames = page.frames();
        const turnstileFrame = frames.find(f => f.url().includes('challenges.cloudflare.com/turnstile'));
        if (!turnstileFrame) {
            console.log('✅ Iframe Turnstile disparue');
            return true;
        }

        try {
            const isChecked = await turnstileFrame.$eval('input[type="checkbox"]', cb => cb.checked);
            if (isChecked) {
                console.log('   Case déjà cochée, attente validation...');
                while (Date.now() - start < maxWaitMs) {
                    if (!page.frames().some(f => f.url().includes('challenges.cloudflare.com/turnstile'))) {
                        console.log('✅ Turnstile validé');
                        return true;
                    }
                    await delay(1000);
                }
                return false;
            }

            console.log('   Case non cochée, tentative de clic...');
            await turnstileFrame.waitForSelector('body', { timeout: 5000 });
            await turnstileFrame.click('input[type="checkbox"]');
            console.log('   Clic effectué, attente validation...');
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

// Clic sur le bon bouton CLAIM avec résolution préalable du Turnstile faucet
async function clickCorrectClaimButton(page) {
    console.log('🎯 Accès à la page faucet et résolution du Turnstile...');
    await page.waitForNetworkIdle({ timeout: 15000 }).catch(() => {});
    await delay(3000);

    // 1. Résoudre le Turnstile qui peut apparaître sur la page faucet
    console.log('🛡️ Vérification Turnstile faucet...');
    const faucetTurnstileResolved = await resolveTurnstile(page, 45000);
    if (!faucetTurnstileResolved) {
        console.log('⚠️ Turnstile faucet non résolu, on tente le clic quand même...');
    }

    // 2. Lister les boutons pour diagnostic (optionnel)
    const allButtons = await page.evaluate(() => {
        return Array.from(document.querySelectorAll('button, input[type="submit"], a, [role="button"]'))
            .filter(el => el.offsetParent !== null)
            .map(el => ({
                tag: el.tagName,
                text: (el.textContent || el.value || '').trim(),
                disabled: el.disabled || false,
                id: el.id,
                className: el.className
            }));
    });
    console.log(`📋 ${allButtons.length} boutons visibles sur faucet`);

    // 3. Utiliser le sélecteur exact identifié précédemment
    const claimSelector = '#process_claim_hourly_faucet';
    try {
        await page.waitForSelector(claimSelector, { timeout: 10000 });
        const btn = await page.$(claimSelector);
        const isEnabled = await btn.evaluate(el => !el.disabled && el.offsetParent !== null);
        if (!isEnabled) {
            console.log('❌ Bouton CLAIM désactivé (probablement timer en cours)');
            return { success: false, message: 'Bouton CLAIM désactivé (timer)' };
        }

        console.log(`🖱️ Clic sur le sélecteur : ${claimSelector}`);
        await btn.click();
        console.log('✅ Clic effectué');
    } catch (e) {
        console.log(`⚠️ Clic via sélecteur échoué, fallback par texte exact...`);
        const clicked = await page.evaluate(() => {
            const btns = [...document.querySelectorAll('button, input[type="submit"], a')];
            const target = btns.find(b => (b.textContent || b.value || '').trim().toUpperCase() === 'CLAIM' && !b.disabled && b.offsetParent !== null);
            if (target) {
                target.scrollIntoView({ behavior: 'smooth', block: 'center' });
                target.click();
                return true;
            }
            return false;
        });
        if (!clicked) throw new Error('Impossible de cliquer sur CLAIM');
        console.log('✅ Clic par texte exact réussi');
    }

    // 4. Attendre la réponse réseau et les messages
    console.log('⏳ Attente de la réponse...');
    await page.waitForNetworkIdle({ timeout: 20000 }).catch(() => {});
    await delay(5000);

    // 5. Récupérer les messages DOM
    const messages = await page.evaluate(() => {
        return Array.from(document.querySelectorAll('[class*="toast"], [class*="alert"], [class*="message"], [role="alert"]'))
            .map(el => el.textContent.trim()).filter(t => t);
    });
    console.log('💬 Messages DOM après clic :', messages);

    // 6. Vérifier l'état du bouton
    const btnState = await page.evaluate(() => {
        const b = document.querySelector('#process_claim_hourly_faucet');
        return b ? { disabled: b.disabled, text: b.textContent.trim() } : null;
    });
    if (btnState) {
        console.log(`📌 Bouton CLAIM après clic : ${btnState.disabled ? 'DÉSACTIVÉ' : 'ACTIF'}`);
    }

    // 7. Déterminer le succès
    const success = btnState?.disabled || messages.some(m => /success|claimed|reward|sent|congratulations/i.test(m)) || false;
    const message = messages.find(m => /success|claimed|reward|error|invalid|try again|captcha/i.test(m)) 
                    || (btnState?.disabled ? 'Bouton désactivé (succès présumé)' : 'Aucune réaction');

    return { success, message };
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

        const turnstileResolved = await resolveTurnstile(page, 45000);
        if (!turnstileResolved) console.log('⚠️ Turnstile login non résolu, on tente quand même...');

        console.log('🔐 Clic sur "Log in"...');
        const loginBtn = await page.evaluateHandle(() => {
            const btns = Array.from(document.querySelectorAll('button'));
            return btns.find(b => b.textContent.trim() === 'Log in');
        });
        if (!loginBtn) throw new Error('Bouton Log in introuvable');

        await Promise.all([
            page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 90000 }).catch(e => console.log('⚠️ Navigation timeout:', e.message)),
            loginBtn.click()
        ]);
        await delay(5000);

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

            // --- CLAIM (avec résolution Turnstile faucet) ---
            const claimResult = await clickCorrectClaimButton(page);

            status.success = claimResult.success;
            status.message = claimResult.success
                ? `✅ CLAIM réussi : ${claimResult.message}`
                : `❌ CLAIM échoué : ${claimResult.message}`;
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
