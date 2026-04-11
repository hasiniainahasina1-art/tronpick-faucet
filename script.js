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

// Gestion avancée de Turnstile
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

// Diagnostic complet des boutons et clic sur le bon CLAIM
async function clickCorrectClaimButton(page) {
    console.log('🎯 Diagnostic des boutons de la page faucet...');
    await page.waitForNetworkIdle({ timeout: 15000 }).catch(() => {});
    await delay(3000);

    // 1. Lister TOUS les boutons visibles avec leurs caractéristiques
    const allButtons = await page.evaluate(() => {
        return Array.from(document.querySelectorAll('button, input[type="submit"], a, [role="button"]'))
            .filter(el => el.offsetParent !== null)
            .map(el => {
                const text = (el.textContent || el.value || '').trim();
                return {
                    tag: el.tagName,
                    text: text,
                    disabled: el.disabled || false,
                    className: el.className,
                    id: el.id,
                    href: el.href || null,
                    dataset: { ...el.dataset }
                };
            });
    });

    console.log(`📋 ${allButtons.length} boutons visibles :`);
    allButtons.forEach((b, i) => {
        console.log(`   ${i+1}. [${b.tag}] "${b.text}" ${b.disabled ? '(DÉSACTIVÉ)' : ''} class="${b.className}" id="${b.id}"`);
    });

    // 2. Identifier le bon bouton CLAIM : celui dont le texte est exactement "CLAIM" (insensible casse)
    //    et qui n'est PAS associé à des commissions (exclure ceux dont le contexte mentionne "commission" ou "balance")
    const claimCandidates = allButtons.filter(b => b.text.toUpperCase() === 'CLAIM' && !b.disabled);
    console.log(`🔍 Candidats CLAIM actifs : ${claimCandidates.length}`);

    if (claimCandidates.length === 0) {
        console.log('❌ Aucun bouton CLAIM actif trouvé');
        return { success: false, message: 'Aucun bouton CLAIM actif' };
    }

    // Stratégie de sélection : on prend le premier candidat qui n'a pas de classe/id lié à "commission"
    let targetButton = claimCandidates.find(b => 
        !b.className.toLowerCase().includes('commission') && 
        !b.className.toLowerCase().includes('balance') &&
        !b.text.toLowerCase().includes('commission')
    );
    if (!targetButton) targetButton = claimCandidates[0]; // fallback

    console.log(`🎯 Bouton cible : ${targetButton.tag} "${targetButton.text}" class="${targetButton.className}" id="${targetButton.id}"`);

    // 3. Construire un sélecteur fiable
    let selector;
    if (targetButton.id) {
        selector = `#${targetButton.id}`;
    } else if (targetButton.className) {
        const firstClass = targetButton.className.split(' ')[0];
        selector = `${targetButton.tag}.${firstClass}`;
    } else {
        selector = targetButton.tag;
    }

    // 4. Attendre que le bouton soit cliquable et cliquer
    try {
        await page.waitForSelector(selector, { timeout: 5000 });
        console.log(`🖱️ Clic sur le sélecteur : ${selector}`);
        await page.click(selector);
        console.log('✅ Clic effectué');
    } catch (e) {
        console.log(`⚠️ Clic via sélecteur échoué, tentative par texte exact...`);
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
        if (!clicked) throw new Error('Impossible de cliquer sur le bouton CLAIM');
        console.log('✅ Clic par texte exact réussi');
    }

    // 5. Attendre et analyser la réponse
    console.log('⏳ Attente de la réponse...');
    await page.waitForNetworkIdle({ timeout: 15000 }).catch(() => {});
    await delay(5000);

    // 6. Récupérer les messages DOM
    const messages = await page.evaluate(() => {
        return Array.from(document.querySelectorAll('[class*="toast"], [class*="alert"], [class*="message"], [role="alert"]'))
            .map(el => el.textContent.trim()).filter(t => t);
    });
    console.log('💬 Messages DOM après clic :', messages);

    // 7. Vérifier si le bouton est désactivé (succès présumé)
    const btnState = await page.evaluate(() => {
        const b = [...document.querySelectorAll('button, input[type="submit"], a')].find(b => (b.textContent || b.value || '').trim().toUpperCase() === 'CLAIM');
        return b ? { disabled: b.disabled, text: b.textContent.trim() } : null;
    });
    if (btnState) {
        console.log(`📌 État du bouton CLAIM après clic : ${btnState.disabled ? 'DÉSACTIVÉ' : 'ACTIF'}`);
    }

    // 8. Déterminer le succès
    const success = btnState?.disabled || messages.some(m => /success|claimed|reward|sent/i.test(m)) || false;
    const message = messages[0] || (btnState?.disabled ? 'Bouton désactivé (succès présumé)' : 'Aucune réaction');

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
        if (!turnstileResolved) console.log('⚠️ Turnstile non résolu, on tente quand même...');

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

            // --- CLAIM (ciblage précis) ---
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
