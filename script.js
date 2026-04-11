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

// Résolution renforcée de Turnstile (vérifie le token)
async function resolveTurnstile(page, maxWaitMs = 90000) {
    console.log('🔎 Résolution renforcée de Turnstile...');
    const start = Date.now();

    // Boucle principale d'attente de l'iframe
    while (Date.now() - start < maxWaitMs) {
        const frames = page.frames();
        const turnstileFrame = frames.find(f => f.url().includes('challenges.cloudflare.com/turnstile'));

        if (!turnstileFrame) {
            // Vérifier si le token Turnstile est déjà présent dans la page (peut arriver si résolu précédemment)
            const tokenExists = await page.evaluate(() => {
                return !!document.querySelector('[name="cf-turnstile-response"]')?.value ||
                       !!document.querySelector('[name="turnstile-token"]')?.value ||
                       !!document.querySelector('input[name*="captcha"]')?.value;
            });
            if (tokenExists) {
                console.log('✅ Token Turnstile déjà présent');
                return true;
            }
            console.log('✅ Iframe Turnstile disparue');
            return true;
        }

        try {
            // Vérifier si la case est déjà cochée
            const isChecked = await turnstileFrame.$eval('input[type="checkbox"]', cb => cb.checked);
            if (!isChecked) {
                console.log('   Case non cochée, tentative de clic...');
                await turnstileFrame.waitForSelector('body', { timeout: 5000 });
                await turnstileFrame.click('input[type="checkbox"]');
                console.log('   Clic effectué, attente validation...');
            } else {
                console.log('   Case déjà cochée, attente du token...');
            }
        } catch (e) {
            // L'élément n'est peut-être pas encore prêt
        }

        // Attendre que le token Turnstile apparaisse (max 10 secondes par itération)
        const tokenAppeared = await page.evaluate(() => {
            return new Promise(resolve => {
                const start = Date.now();
                const check = () => {
                    const tokenInput = document.querySelector('[name="cf-turnstile-response"]') ||
                                       document.querySelector('[name="turnstile-token"]') ||
                                       document.querySelector('input[name*="captcha-response"]');
                    if (tokenInput && tokenInput.value) {
                        resolve(true);
                    } else if (Date.now() - start < 10000) {
                        setTimeout(check, 500);
                    } else {
                        resolve(false);
                    }
                };
                check();
            });
        });

        if (tokenAppeared) {
            console.log('✅ Token Turnstile généré');
            // Laisser un peu de temps pour que le site prenne en compte le token
            await delay(2000);
            return true;
        }

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

async function clickClaimButton(page) {
    console.log('🎯 Résolution Turnstile faucet et clic sur Claim...');
    await page.waitForNetworkIdle({ timeout: 15000 }).catch(() => {});
    await delay(3000);

    // 1. Résoudre le Turnstile faucet avec la fonction renforcée
    const faucetTurnstileResolved = await resolveTurnstile(page, 90000);
    if (!faucetTurnstileResolved) {
        console.log('❌ Turnstile faucet non résolu');
        return { success: false, message: 'Turnstile faucet non résolu' };
    }

    // 2. Attendre un peu pour la stabilité
    await delay(3000);

    // 3. Cliquer sur le bouton Claim
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

    // 4. Attendre réponse
    console.log('⏳ Attente réponse...');
    await page.waitForNetworkIdle({ timeout: 20000 }).catch(() => {});
    await delay(5000);

    // 5. Messages DOM
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
