const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');
const path = require('path');

puppeteer.use(StealthPlugin());

const EMAIL = process.env.TRONPICK_EMAIL.trim().toLowerCase();
const PASSWORD = process.env.TRONPICK_PASSWORD;
const PROXY_USERNAME = process.env.PROXY_USERNAME;
const PROXY_PASSWORD = process.env.PROXY_PASSWORD;
const PROXY_HOST = '31.59.20.176';
const PROXY_PORT = '6754';

const outputDir = path.join(__dirname, 'screenshots');
if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

if (!EMAIL || !PASSWORD || !PROXY_USERNAME || !PROXY_PASSWORD) {
    console.error('❌ Variables d\'environnement manquantes');
    process.exit(1);
}

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Saisie robuste (identique)
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

// Connexion (adaptée pour Firefox)
async function login(page) {
    console.log('🌐 Accès login...');
    await page.goto('https://tronpick.io/login.php', { waitUntil: 'networkidle2', timeout: 60000 });
    await fillField(page, 'input[type="email"], input[name="email"]', EMAIL, 'email');
    await fillField(page, 'input[type="password"]', PASSWORD, 'password');
    await delay(2000);

    // Gestion du Turnstile login (Firefox peut avoir une iframe différente, on utilise waitForFrame)
    try {
        const frame = await page.waitForFrame(f => f.url().includes('challenges.cloudflare.com/turnstile'), { timeout: 30000 });
        console.log('✅ Turnstile login présent, clic...');
        await frame.click('input[type="checkbox"]');
        await delay(5000);
    } catch (e) {
        console.log('⚠️ Turnstile login non trouvé, on continue...');
    }

    console.log('🔐 Clic sur "Log in"...');
    const loginClicked = await page.evaluate(() => {
        const btns = [...document.querySelectorAll('button')];
        const loginBtn = btns.find(b => b.textContent.trim() === 'Log in');
        if (loginBtn) { loginBtn.click(); return true; }
        return false;
    });
    if (!loginClicked) throw new Error('Bouton Log in introuvable');

    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 90000 }).catch(() => {});
    await delay(5000);
    if (page.url().includes('login.php')) throw new Error('Échec connexion');
    console.log('✅ Connecté');
}

// Actions de réveil (inchangées)
async function wakeUpPage(page) {
    console.log('🖱️ Actions de réveil...');
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await delay(1000);
    await page.evaluate(() => window.scrollTo(0, 0));
    await delay(1000);
    await page.mouse.move(300, 200);
    await page.mouse.move(600, 400);
    await page.mouse.move(500, 500);
    await page.mouse.move(400, 600);
    await delay(500);
    await page.mouse.click(500, 450);
    await delay(2000);
    await page.mouse.click(550, 480);
    await delay(2000);
}

// Gestion Turnstile faucet (identique mais avec captures)
async function handleFaucetTurnstile(page) {
    console.log('🚰 Accès faucet...');
    await page.goto('https://tronpick.io/faucet.php', { waitUntil: 'networkidle2', timeout: 30000 });
    await delay(5000);
    
    console.log('🔄 Actualisation de la page faucet...');
    await page.reload({ waitUntil: 'networkidle2', timeout: 30000 });
    await delay(20000);

    await page.screenshot({ path: path.join(outputDir, '01_firefox_after_reload.png'), fullPage: true });
    await wakeUpPage(page);
    await delay(10000);
    await page.screenshot({ path: path.join(outputDir, '02_firefox_after_wakeup.png'), fullPage: true });

    console.log('🔍 Recherche de "Verify you are human"...');
    const start = Date.now();
    let clicked = false;
    
    while (Date.now() - start < 60000 && !clicked) {
        const frames = page.frames();
        for (const frame of frames) {
            try {
                const found = await frame.evaluate(() => {
                    const elements = document.querySelectorAll('label, span, div, button, a');
                    for (const el of elements) {
                        if (el.textContent.toLowerCase().includes('verify you are human')) {
                            el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                            el.click();
                            return true;
                        }
                    }
                    return false;
                });
                if (found) {
                    console.log(`✅ Clic effectué dans une frame`);
                    clicked = true;
                    break;
                }
            } catch (e) {}
        }
        if (!clicked) {
            await wakeUpPage(page);
            await delay(5000);
        }
    }
    
    if (!clicked) {
        await page.screenshot({ path: path.join(outputDir, '03_firefox_verify_not_found.png'), fullPage: true });
        console.log('❌ Texte non trouvé après 60s');
        return false;
    }

    for (let i = 1; i <= 2; i++) {
        await page.evaluate(() => {
            const el = [...document.querySelectorAll('*')].find(e => e.textContent.toLowerCase().includes('verify you are human'));
            if (el) el.click();
        });
        await delay(1500);
    }

    console.log('⏳ Attente de la génération du token (max 30s)...');
    const tokenGenerated = await page.waitForFunction(
        () => {
            const inp = document.querySelector('[name="cf-turnstile-response"]');
            return inp && inp.value.length > 10;
        },
        { timeout: 30000 }
    ).catch(() => false);

    if (!tokenGenerated) {
        await page.screenshot({ path: path.join(outputDir, '04_firefox_token_not_generated.png'), fullPage: true });
        return false;
    }
    console.log('✅ Token Turnstile généré');
    return true;
}

// Clic sur CLAIM par coordonnées
async function clickClaim(page) {
    console.log('🎯 Clic sur le bouton CLAIM...');
    const coords = await page.evaluate(() => {
        const btn = document.querySelector('#process_claim_hourly_faucet');
        if (!btn) return null;
        const rect = btn.getBoundingClientRect();
        return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    });
    if (!coords) throw new Error('Bouton CLAIM introuvable');
    console.log(`📍 Coordonnées : (${Math.round(coords.x)}, ${Math.round(coords.y)})`);
    await page.mouse.click(coords.x, coords.y);
    console.log('✅ Clic effectué');
}

(async () => {
    let browser;
    const status = { success: false, time: new Date().toISOString(), message: '' };
    try {
        console.log('🚀 Lancement de Firefox...');
        browser = await puppeteer.launch({
            product: 'firefox',
            protocol: 'webDriverBiDi',
            headless: false,
            args: [
                `--proxy-server=http://${PROXY_HOST}:${PROXY_PORT}`,
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--window-size=1280,720'
            ]
        });

        const page = await browser.newPage();
        await page.authenticate({ username: PROXY_USERNAME, password: PROXY_PASSWORD });
        console.log('✅ Proxy authentifié');

        page.on('dialog', d => d.accept());
        await page.setViewport({ width: 1280, height: 720 });

        await login(page);

        const turnstileOk = await handleFaucetTurnstile(page);
        if (!turnstileOk) throw new Error('Turnstile faucet non résolu');

        console.log('⏳ Pause de 10 secondes après validation...');
        await delay(10000);

        await clickClaim(page);

        await page.waitForNetworkIdle({ timeout: 20000 }).catch(() => {});
        await delay(5000);

        const messages = await page.evaluate(() => {
            return Array.from(document.querySelectorAll('[class*="toast"], [class*="alert"], [role="alert"]'))
                .map(el => el.textContent.trim()).filter(t => t);
        });
        console.log('💬 Messages :', messages);

        const btnDisabled = await page.evaluate(() => {
            return document.querySelector('#process_claim_hourly_faucet')?.disabled || false;
        });

        const success = btnDisabled || messages.some(m => /success|claimed|reward|sent/i.test(m));
        status.success = success;
        status.message = messages[0] || (btnDisabled ? 'Bouton désactivé (succès présumé)' : 'Aucune réaction');

    } catch (e) {
        console.error('❌', e);
        status.message = e.message;
    } finally {
        if (browser) await browser.close();
        fs.writeFileSync(path.join(__dirname, 'public', 'status.json'), JSON.stringify(status, null, 2));
        console.log('📝', status.success ? 'SUCCÈS' : 'ÉCHEC');
    }
})();
