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

// Diagnostic et tentative de déclenchement manuel
async function clickClaimButton(page) {
    console.log('🎯 Analyse du bouton CLAIM...');
    await page.waitForNetworkIdle({ timeout: 15000 }).catch(() => {});
    await delay(3000);

    console.log('🛡️ Vérification Turnstile faucet...');
    await waitForTurnstileGone(page, 30000);

    console.log('⏳ Pause de 10 secondes avant le clic...');
    await delay(10000);

    // Récupérer les infos du bouton et tenter de trouver des écouteurs
    const btnAnalysis = await page.evaluate(() => {
        const btn = [...document.querySelectorAll('button, input[type="submit"], a')].find(el => {
            const text = (el.textContent || el.value || '').trim().toUpperCase();
            return text === 'CLAIM' && !el.disabled && el.offsetParent !== null;
        });
        if (!btn) return { found: false };

        btn.scrollIntoView({ behavior: 'smooth', block: 'center' });

        // Récupérer les propriétés utiles
        const info = {
            tag: btn.tagName,
            id: btn.id,
            className: btn.className,
            attributes: Array.from(btn.attributes).map(a => ({ name: a.name, value: a.value })),
            dataset: { ...btn.dataset },
            events: []
        };

        // Tenter d'obtenir les écouteurs via l'API Chrome DevTools (si disponible)
        if (typeof window.getEventListeners === 'function') {
            try {
                const listeners = window.getEventListeners(btn);
                for (const [type, arr] of Object.entries(listeners)) {
                    info.events.push({ type, count: arr.length });
                }
            } catch (e) {}
        }

        // Chercher des fonctions globales suspectes
        const globalFuncs = [];
        for (const key of Object.keys(window)) {
            if (typeof window[key] === 'function' && /claim|faucet|withdraw|roll|getreward/i.test(key)) {
                globalFuncs.push(key);
            }
        }

        return { found: true, info, globalFuncs, btnExists: true };
    });

    if (!btnAnalysis.found) {
        console.log('❌ Bouton CLAIM non trouvé');
        return { success: false, message: 'Bouton CLAIM introuvable' };
    }

    console.log('📋 Informations sur le bouton :');
    console.log(JSON.stringify(btnAnalysis.info, null, 2));
    console.log('🌐 Fonctions globales suspectes :', btnAnalysis.globalFuncs);

    // Tenter plusieurs méthodes de clic
    const clickMethods = [
        { name: 'click()', action: () => page.evaluate(() => { const b = [...document.querySelectorAll('button')].find(b=>b.textContent.trim().toUpperCase()==='CLAIM'); if(b) b.click(); }) },
        { name: 'mousedown/mouseup/click', action: () => page.evaluate(() => {
            const b = [...document.querySelectorAll('button')].find(b=>b.textContent.trim().toUpperCase()==='CLAIM');
            if(b) {
                b.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
                b.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
                b.dispatchEvent(new MouseEvent('click', { bubbles: true }));
            }
        })},
        { name: 'focus + Enter', action: async () => {
            await page.focus('button');
            await page.keyboard.press('Enter');
        }},
        { name: 'form submit', action: () => page.evaluate(() => {
            const b = [...document.querySelectorAll('button')].find(b=>b.textContent.trim().toUpperCase()==='CLAIM');
            const form = b?.closest('form');
            if (form) form.submit();
        })}
    ];

    let bestResult = null;
    for (const method of clickMethods) {
        console.log(`🖱️ Tentative de clic via : ${method.name}`);
        // Réactiver le bouton si nécessaire (parfois il se désactive après un premier clic)
        await page.evaluate(() => {
            const b = [...document.querySelectorAll('button')].find(b=>b.textContent.trim().toUpperCase()==='CLAIM');
            if (b) b.disabled = false;
        });
        await method.action();
        await delay(5000);
        
        // Vérifier l'état après
        const state = await page.evaluate(() => {
            const btn = [...document.querySelectorAll('button')].find(b=>b.textContent.trim().toUpperCase()==='CLAIM');
            if (!btn) return null;
            const messages = Array.from(document.querySelectorAll('[class*="toast"], [class*="alert"], [class*="message"]')).map(el => el.textContent.trim()).filter(t=>t);
            return { disabled: btn.disabled, messages };
        });
        console.log(`   -> Bouton désactivé : ${state?.disabled}, messages : ${state?.messages.length ? state.messages[0] : 'aucun'}`);
        if (state?.disabled || state?.messages.length) {
            bestResult = { method: method.name, state };
            break;
        }
    }

    // Capture réseau
    const requests = [];
    const reqListener = (req) => requests.push(req.url());
    page.on('request', reqListener);
    await delay(10000);
    page.off('request', reqListener);

    console.log(`🌐 Requêtes réseau (${requests.length}) :`, requests);

    // Scan DOM final
    const finalMessages = await page.evaluate(() => {
        return Array.from(document.querySelectorAll('[class*="toast"], [class*="alert"], [class*="message"], [role="alert"]'))
            .map(el => el.textContent.trim()).filter(t => t);
    });
    console.log('💬 Messages DOM finaux :', finalMessages);

    const btnFinal = await page.evaluate(() => {
        const b = [...document.querySelectorAll('button')].find(b=>b.textContent.trim().toUpperCase()==='CLAIM');
        return b ? b.disabled : null;
    });

    if (btnFinal || finalMessages.length > 0) {
        return { success: true, message: finalMessages[0] || 'Bouton désactivé' };
    }
    return { success: false, message: 'Aucune réaction' };
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
