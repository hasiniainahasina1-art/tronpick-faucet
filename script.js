const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

const fs = require('fs');

const EMAIL = process.env.TRONPICK_EMAIL;
const PASSWORD = process.env.TRONPICK_PASSWORD;

const MAX_RETRIES = 3;

const delay = (ms) => new Promise(res => setTimeout(res, ms));

const humanDelay = async (min = 1000, max = 4000) => {
    await delay(Math.floor(Math.random() * (max - min) + min));
};

// 🧠 Simulation humaine simple
async function simulateHuman(page) {
    await page.mouse.move(300 + Math.random()*200, 300 + Math.random()*200);
    await humanDelay();

    await page.evaluate(() => window.scrollBy(0, 250));
    await humanDelay();

    await page.evaluate(() => window.scrollBy(0, -120));
}

// 🔍 Détection blocage
async function detectBlock(page) {
    const content = await page.content();

    if (content.includes('cf-challenge') || content.includes('Cloudflare')) {
        return 'cloudflare';
    }

    if (content.toLowerCase().includes('captcha')) {
        return 'captcha';
    }

    return null;
}

// 🛡️ Turnstile (best effort)
async function handleTurnstile(page) {
    const frame = page.frames().find(f =>
        f.url().includes('challenges.cloudflare.com')
    );

    if (!frame) return false;

    console.log('🛡️ Turnstile détecté');

    try {
        await delay(5000);

        const checkbox = await frame.$('input[type="checkbox"]');
        if (checkbox) {
            await checkbox.click();
            console.log('✅ Tentative clic Turnstile');
        }

        await delay(8000);
        return true;

    } catch (e) {
        console.log('⚠️ Erreur Turnstile');
        return false;
    }
}

// 🔘 Trouver bouton login
async function findLoginButton(page) {
    return await page.evaluateHandle(() => {
        const btns = [...document.querySelectorAll('button')];
        return btns.find(b =>
            b.textContent.toLowerCase().includes('log') ||
            b.textContent.toLowerCase().includes('sign')
        );
    });
}

// ✅ Vérifier login
async function isLoggedIn(page) {
    return await page.evaluate(() => {
        const txt = document.body.innerText.toLowerCase();
        return (
            txt.includes('dashboard') ||
            txt.includes('logout') ||
            txt.includes('account') ||
            !window.location.href.includes('login')
        );
    });
}

// 🚀 BOT PRINCIPAL
async function runBot(attempt = 1) {
    console.log(`\n🚀 Tentative ${attempt}/${MAX_RETRIES}`);

    const browser = await puppeteer.launch({
        headless: 'new', // ✅ compatible serveur
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-blink-features=AutomationControlled',
            '--window-size=1366,768'
        ]
    });

    const page = await browser.newPage();

    try {
        await page.setViewport({ width: 1366, height: 768 });

        await page.setUserAgent(
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
            '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        );

        console.log('🌐 Accès page login...');
        await page.goto('https://tronpick.io/login.php', {
            waitUntil: 'domcontentloaded',
            timeout: 60000
        });

        await humanDelay(2000, 4000);
        await simulateHuman(page);

        // 🔍 Vérifier blocage
        const block = await detectBlock(page);
        if (block) throw new Error(`Blocage détecté: ${block}`);

        // 📧 Email
        const emailInput = await page.$('input[type="email"], input[name="email"]');
        if (!emailInput) throw new Error('Champ email introuvable');

        await emailInput.click();
        await humanDelay();
        await page.keyboard.type(EMAIL, { delay: 80 });

        await humanDelay();

        // 🔑 Password
        const passInput = await page.$('input[type="password"]');
        if (!passInput) throw new Error('Champ password introuvable');

        await passInput.click();
        await page.keyboard.type(PASSWORD, { delay: 100 });

        await humanDelay(2000, 3000);

        // 🛡️ Turnstile avant clic
        await handleTurnstile(page);

        // 🔘 Login button
        const loginBtn = await findLoginButton(page);
        if (!loginBtn) throw new Error('Bouton login introuvable');

        await loginBtn.click();
        console.log('🖱️ Clic login');

        await humanDelay(5000, 8000);

        // 🛡️ Turnstile après clic
        await handleTurnstile(page);

        await humanDelay(5000, 8000);

        // ✅ Vérification
        const success = await isLoggedIn(page);

        if (success) {
            console.log('✅ LOGIN RÉUSSI');
            await browser.close();
            return true;
        }

        throw new Error('Login échoué');

    } catch (err) {
        console.log('❌', err.message);
        await browser.close();

        if (attempt < MAX_RETRIES) {
            console.log('🔁 Retry dans 5s...');
            await delay(5000);
            return runBot(attempt + 1);
        } else {
            console.log('💀 Échec total');
            return false;
        }
    }
}

// 🚀 START
runBot();
