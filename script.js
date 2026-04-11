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

// Saisie robuste (inchangée)
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

// Résolution de Turnstile avec renouvellement forcé du token
async function resolveTurnstile(page, maxWaitMs = 90000) {
    console.log('🔎 Résolution renforcée de Turnstile (renouvellement forcé)...');
    const start = Date.now();

    // Étape 1 : Trouver l'iframe Turnstile
    let turnstileFrame = null;
    while (Date.now() - start < 30000 && !turnstileFrame) {
        const frames = page.frames();
        turnstileFrame = frames.find(f => f.url().includes('challenges.cloudflare.com/turnstile'));
        if (!turnstileFrame) await delay(1000);
    }

    if (!turnstileFrame) {
        console.log('⚠️ Iframe Turnstile non trouvée, on vérifie si le token existe déjà...');
        const tokenExists = await page.evaluate(() => {
            return !!document.querySelector('[name="cf-turnstile-response"]')?.value;
        });
        if (tokenExists) {
            console.log('✅ Token Turnstile présent sans iframe');
            return true;
        }
        console.log('❌ Iframe Turnstile introuvable et pas de token');
        return false;
    }

    console.log('✅ Iframe Turnstile trouvée');

    // Étape 2 : Cliquer sur la case pour forcer un nouveau token
    try {
        await turnstileFrame.waitForSelector('body', { timeout: 5000 });
        // Cliquer même si déjà cochée pour renouveler
        await turnstileFrame.click('input[type="checkbox"]');
        console.log('   Clic effectué pour renouveler le token');
    } catch (e) {
        console.log('⚠️ Impossible de cliquer sur la case Turnstile');
    }

    // Étape 3 : Attendre que le nouveau token apparaisse (max 45 secondes)
    const tokenWaitStart = Date.now();
    let tokenValue = '';
    while (Date.now() - tokenWaitStart < 45000) {
        tokenValue = await page.evaluate(() => {
            const input = document.querySelector('[name="cf-turnstile-response"]') ||
                          document.querySelector('[name="turnstile-token"]') ||
                          document.querySelector('input[name*="captcha-response"]');
            return input ? input.value : '';
        });
        if (tokenValue && tokenValue.length > 10) {
            console.log(`✅ Nouveau token Turnstile généré (${tokenValue.length} caractères)`);
            // Laisser le temps au site d'enregistrer le token
            await delay(3000);
            return true;
        }
        await delay(1000);
    }

    console.log('⚠️ Timeout attente du nouveau token');
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

async function clickClaimButton(page) {
    console.log('🎯 Résolution Turnstile faucet et clic sur Claim...');
    await page.waitForNetworkIdle({ timeout: 15000 }).catch(() => {});
    await delay(3000);

    // Résoudre Turnstile faucet avec renouvellement
    const faucetTurnstileResolved = await resolveTurnstile(page, 90000);
    if (!faucetTurnstileResolved) {
        console.log('❌ Turnstile faucet non résolu');
        return { success: false, message: 'Turnstile faucet non résolu' };
    }

    await delay(2000);

    // Cliquer sur le bouton Claim
    const claimSelector = '#process_claim_hourly_faucet';
    try {
        await page.waitForSelector(claimSelector, { timeout: 10000 });
        const btn = await page.$(claimSelector);
        const isEnabled = await btn.evaluate(el => !el.disabled && el.offsetParent !== null);
        if (!isEnabled) {
            console.log('❌ Bouton CLAIM désactivé (timer)');
            return { success: false, message: 'Bouton CLAIM désactivé (timer)' };
        }

        console.log(`🖱️ Clic sur ${claimSelector}`);
        await btn.click();
        console.log('✅ Clic effectué');
    } catch (e) {
        console.log('⚠️ Fallback par texte exact...');
        const clicked = await page.evaluate(() => {
            const btns = [...document.querySelectorAll('button')];
            const target = btns.find(b => b.textContent.trim().toUpperCase() === 'CLAIM' && !b.disabled && b.offsetParent !== null);
            if (target) {
                target.click();
                return true;
            }
            return false;
        });
        if (!clicked) throw new Error('Impossible de cliquer sur CLAIM');
        console.log('✅ Clic fallback réussi');
    }

    // Attendre réponse
    console.log('⏳ Attente réponse...');
    await page.waitForNetworkIdle({ timeout: 20000 }).catch(() => {});
    await delay(5000);

    // Messages DOM
    const messages = await page.evaluate(() => {
        return Array.from(document.querySelectorAll('[class*="toast"], [class*="alert"], [class*="message"], [role="alert"]'))
            .map(el => el.textContent.trim()).filter(t => t);
    });
    console.log('💬 Messages DOM :', messages);

    const btnState = await page.evaluate(() => {
        const b = document.querySelector('#process_claim_hourly_faucet');
        return b ? { disabled: b.disabled } : null;
    });

    const success = btnState?.disabled || messages.some(m => /success|claimed|reward|sent/i.test(m));
    const message = messages.find(m => /success|claimed|error|invalid|captcha/i.test(m)) 
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

        const loginTurnstileResolved = await resolveTurnstile(page, 60000);
        if (!loginTurnstileResolved) console.log('⚠️ Turnstile login non résolu');

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

            // --- CLAIM ---
            const claimResult = await clickClaimButton(page);

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
