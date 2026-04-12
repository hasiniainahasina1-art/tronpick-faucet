const { connect } = require('puppeteer-real-browser');
const fs = require('fs');
const path = require('path');

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

// Coordonnées fixes (résolution 1280x720)
const TURNSTILE_COORDS = { x: 640, y: 195 };
const CLAIM_COORDS = { x: 640, y: 223 };

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

async function login(page) {
    console.log('🌐 Accès login...');
    await page.goto('https://tronpick.io/login.php', { waitUntil: 'networkidle2', timeout: 60000 });
    await fillField(page, 'input[type="email"], input[name="email"]', EMAIL, 'email');
    await fillField(page, 'input[type="password"]', PASSWORD, 'password');
    await delay(2000);

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

async function humanScrollToClaim(page) {
    console.log('📜 Scroll progressif vers le bouton CLAIM...');
    const coords = await page.evaluate(() => {
        const btn = document.querySelector('#process_claim_hourly_faucet');
        if (!btn) return null;
        const rect = btn.getBoundingClientRect();
        return { y: rect.y + window.scrollY };
    });
    if (!coords) throw new Error('Bouton CLAIM introuvable pour le scroll');

    const startY = await page.evaluate(() => window.scrollY);
    const targetY = Math.max(0, coords.y - 200);
    const steps = 20;
    for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        const currentY = startY + (targetY - startY) * t;
        await page.evaluate((y) => window.scrollTo(0, y), currentY);
        await delay(50 + Math.random() * 100);
    }
    console.log('✅ Scroll terminé');
}

async function humanClickAt(page, coords, label) {
    console.log(`🖱️ Clic ${label} aux coordonnées (${coords.x}, ${coords.y})`);
    const start = await page.evaluate(() => ({ x: window.innerWidth / 2, y: window.innerHeight / 2 }));
    const steps = 20;
    for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        const cp = { x: start.x + (Math.random() - 0.5) * 100, y: start.y + (Math.random() - 0.5) * 100 };
        const x = Math.pow(1 - t, 2) * start.x + 2 * (1 - t) * t * cp.x + Math.pow(t, 2) * coords.x;
        const y = Math.pow(1 - t, 2) * start.y + 2 * (1 - t) * t * cp.y + Math.pow(t, 2) * coords.y;
        await page.mouse.move(x, y);
        await delay(15);
    }
    await page.mouse.click(coords.x, coords.y);
    console.log(`✅ Clic ${label} effectué`);
}

(async () => {
    let browser;
    const status = { success: false, time: new Date().toISOString(), message: '' };
    try {
        console.log('🚀 Lancement de Chrome...');
        const { browser: br, page } = await connect({
            headless: false,
            turnstile: true,
            proxy: { host: PROXY_HOST, port: PROXY_PORT, username: PROXY_USERNAME, password: PROXY_PASSWORD }
        });
        browser = br;
        page.on('dialog', d => d.accept());
        await page.setViewport({ width: 1280, height: 720 });

        await login(page);

        console.log('⏳ Attente de 5 secondes après connexion...');
        await delay(5000);

        console.log('🔄 Actualisation de la page faucet...');
        await page.reload({ waitUntil: 'networkidle2', timeout: 30000 });
        await page.screenshot({ path: path.join(outputDir, '01_after_reload.png'), fullPage: true });

        console.log('⏳ Attente de 20 secondes pour chargement du Turnstile...');
        await delay(20000);
        await page.screenshot({ path: path.join(outputDir, '02_after_wait.png'), fullPage: true });

        await humanScrollToClaim(page);
        await delay(2000);
        await page.screenshot({ path: path.join(outputDir, '03_turnstile_visible.png'), fullPage: true });

        // Premier clic Turnstile
        await humanClickAt(page, TURNSTILE_COORDS, 'Turnstile 1/2');
        await page.screenshot({ path: path.join(outputDir, '04_after_first_turnstile_click.png'), fullPage: true });

        console.log('⏳ Attente de 10 secondes...');
        await delay(10000);

        // Deuxième clic Turnstile
        await humanClickAt(page, TURNSTILE_COORDS, 'Turnstile 2/2');
        await page.screenshot({ path: path.join(outputDir, '05_after_second_turnstile_click.png'), fullPage: true });

        console.log('⏳ Attente de 10 secondes...');
        await delay(10000);

        console.log('⏳ Attente de 10 secondes avant le clic sur CLAIM...');
        await delay(10000);
        await page.screenshot({ path: path.join(outputDir, '06_before_claim.png'), fullPage: true });

        // Clic sur CLAIM
        await humanClickAt(page, CLAIM_COORDS, 'CLAIM');
        await page.waitForNetworkIdle({ timeout: 20000 }).catch(() => {});
        await delay(5000);
        await page.screenshot({ path: path.join(outputDir, '07_after_claim.png'), fullPage: true });

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
