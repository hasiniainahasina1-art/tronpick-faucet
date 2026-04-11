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

// Mouvement de souris courbe (Bézier quadratique)
async function humanMouseMove(page, targetX, targetY) {
    const start = await page.evaluate(() => ({ x: window.innerWidth / 2, y: window.innerHeight / 2 }));
    const steps = 25;
    for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        const cp = {
            x: start.x + (Math.random() - 0.5) * 200,
            y: start.y + (Math.random() - 0.5) * 200
        };
        const x = Math.pow(1 - t, 2) * start.x + 2 * (1 - t) * t * cp.x + Math.pow(t, 2) * targetX;
        const y = Math.pow(1 - t, 2) * start.y + 2 * (1 - t) * t * cp.y + Math.pow(t, 2) * targetY;
        await page.mouse.move(x, y);
        await delay(Math.floor(Math.random() * 20) + 10);
    }
}

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

// Clic humain complet sur CLAIM avec analyse réseau et DOM
async function clickClaimButton(page) {
    console.log('🎯 Recherche du bouton CLAIM...');
    await page.waitForNetworkIdle({ timeout: 15000 }).catch(() => {});
    await delay(3000);

    console.log('🛡️ Vérification Turnstile faucet...');
    await waitForTurnstileGone(page, 30000);

    console.log('⏳ Pause de 10 secondes avant le clic...');
    await delay(10000);

    // Récupérer les coordonnées et l'état du bouton
    const btnInfo = await page.evaluate(() => {
        const btn = [...document.querySelectorAll('button, input[type="submit"], a')].find(el => {
            const text = (el.textContent || el.value || '').trim().toUpperCase();
            return text === 'CLAIM' && !el.disabled && el.offsetParent !== null;
        });
        if (!btn) return null;
        btn.scrollIntoView({ behavior: 'smooth', block: 'center' });
        const rect = btn.getBoundingClientRect();
        return {
            x: rect.x + rect.width / 2,
            y: rect.y + rect.height / 2,
            tag: btn.tagName,
            text: btn.textContent.trim(),
            disabled: btn.disabled
        };
    });

    if (!btnInfo) {
        console.log('❌ Bouton CLAIM non trouvé ou désactivé avant clic');
        return { success: false, message: 'Bouton CLAIM introuvable ou désactivé' };
    }

    console.log(`📍 Bouton trouvé : ${btnInfo.tag} "${btnInfo.text}" à (${Math.round(btnInfo.x)}, ${Math.round(btnInfo.y)})`);

    // Intercepter les réponses réseau
    const responses = [];
    const responseListener = async (response) => {
        const req = response.request();
        if (['xhr', 'fetch'].includes(req.resourceType())) {
            try {
                const text = await response.text().catch(() => '');
                responses.push({ url: response.url(), status: response.status(), body: text.substring(0, 500) });
            } catch (e) {}
        }
    };
    page.on('response', responseListener);

    // Déplacer la souris et effectuer une séquence de clic complète
    console.log('🖱️ Déplacement réaliste de la souris...');
    await humanMouseMove(page, btnInfo.x, btnInfo.y);
    await delay(250);
    console.log('🔽 mousedown');
    await page.mouse.down();
    await delay(150);
    console.log('🔼 mouseup');
    await page.mouse.up();
    await delay(100);
    console.log('🖱️ click');
    await page.mouse.click(btnInfo.x, btnInfo.y);
    console.log('✅ Séquence de clic terminée');

    // Attendre les réponses réseau et les éventuels messages
    console.log('⏳ Attente des réponses (max 20s)...');
    await page.waitForNetworkIdle({ timeout: 15000 }).catch(() => {});
    await delay(5000);

    page.off('response', responseListener);

    // Afficher les réponses réseau
    console.log(`🌐 Réponses AJAX/Fetch (${responses.length}) :`);
    responses.forEach((r, i) => {
        console.log(`   ${i+1}. [${r.status}] ${r.url}`);
        if (r.body) console.log(`       Body: ${r.body}`);
    });

    // Détection étendue des messages DOM
    const domFeedback = await page.evaluate(() => {
        const msgSels = ['.alert', '.message', '.toast', '.notification', '.swal2-popup', '.modal', '[class*="success"]', '[class*="error"]', '[role="alert"]', '.fade.show'];
        for (const s of msgSels) {
            const el = document.querySelector(s);
            if (el && el.offsetParent !== null && el.textContent.trim()) {
                return { text: el.textContent.trim(), selector: s };
            }
        }
        return null;
    });

    // Vérifier l'état du bouton après clic
    const btnAfter = await page.evaluate(() => {
        const btn = [...document.querySelectorAll('button, input[type="submit"], a')].find(el => {
            const text = (el.textContent || el.value || '').trim().toUpperCase();
            return text === 'CLAIM';
        });
        return btn ? { disabled: btn.disabled, text: btn.textContent.trim() } : null;
    });

    let finalMessage = '';
    let success = false;

    // Analyser les réponses serveur
    for (const r of responses) {
        if (r.body) {
            const b = r.body.toLowerCase();
            if (b.includes('success') || b.includes('claimed') || b.includes('reward') || b.includes('ok')) {
                success = true;
                finalMessage = r.body;
                break;
            }
            if (b.includes('wait') || b.includes('cooldown') || b.includes('already') || b.includes('too early') || b.includes('timer')) {
                finalMessage = r.body;
                break;
            }
        }
    }

    // Si aucun message serveur clair, utiliser le DOM ou l'état du bouton
    if (!finalMessage) {
        if (domFeedback) {
            finalMessage = domFeedback.text;
            if (domFeedback.text.toLowerCase().includes('success') || domFeedback.text.toLowerCase().includes('claim')) {
                success = true;
            }
        } else if (btnAfter && btnAfter.disabled) {
            finalMessage = 'Bouton désactivé après clic (succès présumé)';
            success = true;
        } else {
            finalMessage = 'Aucune réaction détectée';
        }
    }

    // Recherche de timer dans le texte de la page
    const pageText = await page.evaluate(() => document.body.innerText);
    const timerMatch = pageText.match(/next claim.*?(\d+)\s*(hour|minute|second)/i);
    if (timerMatch) {
        finalMessage += ` (Timer: ${timerMatch[0]})`;
    }

    console.log(`📌 Résultat final : ${success ? 'SUCCÈS' : 'ÉCHEC'} - ${finalMessage}`);
    return { success, message: finalMessage };
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
