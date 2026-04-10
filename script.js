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

// Clic sur CLAIM – version finale avec liste après désactivation
async function clickClaimButton(page) {
    console.log('🎯 Recherche et clic sur CLAIM...');
    await page.waitForNetworkIdle({ timeout: 15000 }).catch(() => {});
    await delay(3000);

    console.log('🛡️ Vérification Turnstile faucet...');
    await waitForTurnstileGone(page, 30000);

    console.log('⏳ Pause de 10 secondes avant le clic...');
    await delay(10000);

    // Clic via JavaScript pur
    const clickResult = await page.evaluate(() => {
        const claimBtn = [...document.querySelectorAll('button, input[type="submit"], a')].find(el => {
            const text = (el.textContent || el.value || '').trim().toUpperCase();
            return text === 'CLAIM' && !el.disabled && el.offsetParent !== null;
        });
        if (claimBtn) {
            claimBtn.scrollIntoView({ behavior: 'smooth', block: 'center' });
            claimBtn.click();
            return { success: true, text: claimBtn.textContent.trim() };
        }
        return { success: false };
    });

    if (!clickResult.success) {
        console.log('❌ Bouton CLAIM non trouvé ou désactivé');
        return { success: false, message: 'Bouton CLAIM introuvable ou désactivé' };
    }

    console.log(`✅ Clic effectué sur "${clickResult.text}"`);

    // Attendre la réponse (réseau + délai supplémentaire)
    console.log('⏳ Attente de la réponse du site...');
    await page.waitForNetworkIdle({ timeout: 15000 }).catch(() => {});
    await delay(5000);

    // Détecter les messages et l'état du bouton
    let feedback = await page.evaluate(() => {
        const msgSels = ['.alert', '.message', '.toast', '.notification', '.swal2-popup', '.modal', '[class*="success"]', '[class*="error"]'];
        for (const s of msgSels) {
            const el = document.querySelector(s);
            if (el && el.offsetParent !== null && el.textContent.trim()) {
                return el.textContent.trim();
            }
        }
        const btn = [...document.querySelectorAll('button, input[type="submit"]')].find(el => (el.textContent || el.value || '').trim().toUpperCase() === 'CLAIM');
        if (btn && btn.disabled) return 'Bouton désactivé après clic';
        return null;
    });

    // Si le feedback est "Bouton désactivé", on attend 5 secondes et on reliste les boutons
    if (feedback === 'Bouton désactivé après clic') {
        console.log('⏳ Pause de 5 secondes après désactivation...');
        await delay(5000);

        // Lister tous les boutons visibles après la désactivation
        const buttonsAfter = await page.evaluate(() => {
            return Array.from(document.querySelectorAll('button, input[type="submit"], a, [role="button"]'))
                .filter(el => el.offsetParent !== null)
                .map(el => ({
                    tag: el.tagName,
                    text: (el.textContent || el.value || '').trim().substring(0, 30),
                    disabled: el.disabled || false
                }));
        });
        console.log(`📋 ${buttonsAfter.length} boutons visibles après désactivation :`);
        buttonsAfter.forEach((b, i) => console.log(`   ${i+1}. [${b.tag}] "${b.text}" ${b.disabled ? '(DÉSACTIVÉ)' : ''}`));

        // Vérifier à nouveau les messages
        const newMessage = await page.evaluate(() => {
            const msgSels = ['.alert', '.message', '.toast', '.notification', '.swal2-popup', '.modal', '[class*="success"]', '[class*="error"]'];
            for (const s of msgSels) {
                const el = document.querySelector(s);
                if (el && el.offsetParent !== null && el.textContent.trim()) {
                    return el.textContent.trim();
                }
            }
            return null;
        });
        if (newMessage) {
            console.log(`💬 Nouveau message détecté : "${newMessage}"`);
            feedback = newMessage;
        }
    }

    // Texte de la page pour capture timer
    const pageText = await page.evaluate(() => document.body.innerText);
    const timerMatch = pageText.match(/next claim.*?(\d+)\s*(hour|minute|second)/i);
    const timerInfo = timerMatch ? timerMatch[0] : null;

    if (feedback) {
        console.log(`💬 Feedback final : "${feedback}"`);
        if (timerInfo) console.log(`⏱️ Timer détecté : ${timerInfo}`);
        const isSuccess = feedback.includes('désactivé') || feedback.toLowerCase().includes('success') || feedback.toLowerCase().includes('claimed') || feedback.toLowerCase().includes('reward');
        if (isSuccess) {
            return { success: true, message: feedback + (timerInfo ? ` (${timerInfo})` : '') };
        } else {
            return { success: false, message: feedback };
        }
    }

    // Si aucun message mais bouton désactivé (vérification supplémentaire)
    const isDisabledNow = await page.evaluate(() => {
        const btn = [...document.querySelectorAll('button, input[type="submit"]')].find(el => (el.textContent || el.value || '').trim().toUpperCase() === 'CLAIM');
        return btn ? btn.disabled : false;
    });

    if (isDisabledNow) {
        console.log('✅ Bouton désactivé (succès implicite)');
        return { success: true, message: 'Bouton désactivé après clic' + (timerInfo ? ` (${timerInfo})` : '') };
    }

    return { success: false, message: 'Aucun retour détecté' };
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
