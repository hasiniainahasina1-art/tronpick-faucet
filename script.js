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

// Diagnostic avant clic
async function diagnoseFaucet(page) {
    console.log('🔬 DIAGNOSTIC FAUCET AVANT CLIC :');
    const buttons = await page.evaluate(() => {
        return Array.from(document.querySelectorAll('button, input[type="submit"], a, [role="button"]'))
            .filter(el => el.offsetParent !== null)
            .map(el => ({
                tag: el.tagName,
                text: (el.textContent || el.value || '').trim(),
                disabled: el.disabled || false,
                className: el.className,
                id: el.id
            }));
    });
    console.log(`📋 ${buttons.length} boutons visibles :`);
    buttons.forEach((b, i) => {
        console.log(`   ${i+1}. [${b.tag}] "${b.text}" ${b.disabled ? '(DÉSACTIVÉ)' : ''}`);
    });
    const pageText = await page.evaluate(() => document.body.innerText);
    console.log('📄 Extrait du texte de la page (premières lignes) :');
    pageText.split('\n').filter(l => l.trim()).slice(0, 15).forEach(l => console.log(`   ${l}`));
    return buttons;
}

// Clic sur CLAIM avec détection avancée des messages/timer
async function clickClaimButton(page) {
    console.log('🎯 Recherche du bouton "CLAIM"...');
    await page.waitForNetworkIdle({ timeout: 15000 }).catch(() => {});
    await delay(3000);

    const buttons = await diagnoseFaucet(page);
    const claimBtnInfo = buttons.find(b => b.text.toUpperCase() === 'CLAIM');
    if (!claimBtnInfo) {
        console.log('❌ Bouton CLAIM non trouvé');
        return { success: false, message: 'Bouton CLAIM introuvable' };
    }
    if (claimBtnInfo.disabled) {
        console.log('⚠️ Bouton CLAIM désactivé (probablement déjà claimé ou timer)');
        return { success: false, message: 'Bouton CLAIM désactivé' };
    }

    console.log('🛡️ Vérification Turnstile faucet...');
    await waitForTurnstileGone(page, 30000);

    // ✅ Attente supplémentaire de 10 secondes
    console.log('⏳ Pause de 10 secondes avant le clic...');
    await delay(10000);

    // Clic via evaluate
    const clickResult = await page.evaluate(() => {
        const btn = [...document.querySelectorAll('button, input[type="submit"], a, [role="button"]')]
            .find(el => (el.textContent || el.value || '').trim().toUpperCase() === 'CLAIM' && !el.disabled && el.offsetParent !== null);
        if (!btn) return { success: false, reason: 'Bouton non trouvé' };
        btn.scrollIntoView({ behavior: 'smooth', block: 'center' });
        const rect = btn.getBoundingClientRect();
        const x = rect.x + rect.width / 2;
        const y = rect.y + rect.height / 2;
        ['mousedown', 'mouseup', 'click'].forEach(ev => {
            btn.dispatchEvent(new MouseEvent(ev, { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y }));
        });
        return { success: true, text: btn.textContent.trim() };
    });

    if (!clickResult.success) {
        console.log(`❌ Échec clic : ${clickResult.reason}`);
        return { success: false, message: clickResult.reason };
    }
    console.log(`✅ Clic simulé sur "${clickResult.text}"`);

    // Attendre et collecter les messages
    console.log('⏳ Attente de feedback (messages, timer)...');
    const startWait = Date.now();
    let detectedMessage = null;
    const requests = [];
    const reqListener = (req) => {
        if (['xhr', 'fetch'].includes(req.resourceType())) requests.push({ url: req.url(), method: req.method() });
    };
    page.on('request', reqListener);

    while (Date.now() - startWait < 20000) {
        detectedMessage = await page.evaluate(() => {
            // Sélecteurs élargis pour les notifications
            const msgSels = [
                '.alert', '.message', '.toast', '.notification', '.swal2-popup', '.modal',
                '[class*="success"]', '[class*="error"]', '[class*="info"]', '[class*="warning"]',
                '.sweet-alert', '.bootbox-body', '.noty_message', '.gritter-item',
                'div[role="alert"]', 'div[role="status"]'
            ];
            for (const s of msgSels) {
                const el = document.querySelector(s);
                if (el && el.offsetParent !== null && el.textContent.trim()) {
                    return { type: 'message', text: el.textContent.trim() };
                }
            }
            // Recherche d'un compte à rebours visible
            const timerEls = [...document.querySelectorAll('*')].filter(el => /next claim|wait|cooldown|timer|time remaining|hours|minutes|seconds/i.test(el.textContent));
            if (timerEls.length) {
                return { type: 'timer', text: timerEls[0].textContent.trim() };
            }
            // Vérifier si le bouton CLAIM est devenu désactivé
            const btn = [...document.querySelectorAll('button, input[type="submit"]')].find(el => (el.textContent || el.value || '').trim().toUpperCase() === 'CLAIM');
            if (btn && btn.disabled) {
                return { type: 'button_disabled', text: 'Bouton CLAIM désactivé' };
            }
            return null;
        });
        if (detectedMessage) break;
        await delay(1000);
    }

    page.off('request', reqListener);

    // Capture après clic
    const screenshotAfter = await page.screenshot({ encoding: 'base64', fullPage: true });
    console.log('📸 CAPTURE_APRES_BASE64_START');
    console.log(screenshotAfter);
    console.log('📸 CAPTURE_APRES_BASE64_END');

    console.log(`🌐 Requêtes réseau : ${requests.length}`);
    requests.forEach((r, i) => console.log(`   ${i+1}. ${r.method} ${r.url}`));

    // Log du texte complet de la page (extrait) pour analyse
    const fullText = await page.evaluate(() => document.body.innerText);
    console.log('📄 Texte complet de la page après clic (extrait) :');
    fullText.split('\n').filter(l => l.trim()).slice(0, 25).forEach(l => console.log(`   ${l}`));

    if (detectedMessage) {
        console.log(`💬 Message détecté : [${detectedMessage.type}] "${detectedMessage.text}"`);
        const msg = detectedMessage.text.toLowerCase();
        if (msg.includes('success') || msg.includes('claimed') || msg.includes('sent') || msg.includes('reward')) {
            return { success: true, message: detectedMessage.text };
        }
        if (msg.includes('wait') || msg.includes('cooldown') || msg.includes('already claimed') || msg.includes('try again') || msg.includes('hours') || msg.includes('minutes')) {
            return { success: false, message: `Timer/Cooldown: ${detectedMessage.text}` };
        }
        // Par défaut, on considère qu'un message d'erreur est un échec
        return { success: false, message: detectedMessage.text };
    }

    // Vérification finale du bouton
    const finalState = await page.evaluate(() => {
        const btn = [...document.querySelectorAll('button, input[type="submit"]')].find(el => (el.textContent || el.value || '').trim().toUpperCase() === 'CLAIM');
        return btn ? { text: btn.textContent.trim(), disabled: btn.disabled } : null;
    });
    if (finalState) {
        console.log(`📌 État final bouton : "${finalState.text}", disabled=${finalState.disabled}`);
        if (finalState.disabled) return { success: true, message: 'Bouton désactivé (succès présumé)' };
    }

    return { success: false, message: 'Aucun message ni changement détecté' };
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
                status.success = true; // Connexion OK même si claim échoue (timer)
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
