const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

const fs = require('fs');

const EMAIL = process.env.TRONPICK_EMAIL;
const PASSWORD = process.env.TRONPICK_PASSWORD;

const MAX_RETRIES = 3;

const delay = (ms) => new Promise(res => setTimeout(res, ms));

const humanDelay = async (min = 800, max = 3000) => {
    await delay(Math.floor(Math.random() * (max - min) + min));
};

async function simulateHuman(page) {
    await page.mouse.move(200 + Math.random()*300, 200 + Math.random()*300);
    await humanDelay();
    await page.evaluate(() => window.scrollBy(0, 200));
    await humanDelay();
    await page.evaluate(() => window.scrollBy(0, -100));
}

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
        return false;
    }
}

async function findLoginButton(page) {
    return await page.evaluateHandle(() => {
        const btns = [...document.querySelectorAll('button')];
        return btns.find(b =>
            b.textContent.toLowerCase().includes('log') ||
            b.textContent.toLowerCase().includes('sign')
        );
    });
}

async function isLoggedIn(page) {
    return await page.evaluate(() => {
        return document.body.innerText.includes('Dashboard') ||
               document.body.innerText.includes('Logout') ||
               !window.location.href.includes('login');
    });
}

async function runBot(attempt = 1) {
    console.log(`\n🚀 Tentative ${attempt}/${MAX_RETRIES}`);

    const browser = await puppeteer.launch({
        headless: false, // 🔥 important
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-blink-features=AutomationControlled'
        ]
    });

    const page = await browser.newPage();

    try {
        await page.setViewport({ width: 1366, height: 768 });

        await page.goto('https://tronpick.io/login.php', {
            waitUntil: 'domcontentloaded',
            timeout: 60000
        });

        await humanDelay(2000, 4000);
        await simulateHuman(page);

        // 🔍 Détection blocage
        const blockType = await detectBlock(page);
        if (blockType) {
            throw new Error(`Blocage détecté: ${blockType}`);
        }

        // 📧 Email
        const emailInput = await page.$('input[type="email"], input[name="email"]');
        if (!emailInput) throw new Error('Champ email introuvable');

        await emailInput.click();
        await humanDelay();
        await page.keyboard.type(EMAIL, { delay: 80 });

        await humanDelay();

        // 🔑 Password
        const passInput = await page.$('input[type="password"]');
        await passInput.click();
        await page.keyboard.type(PASSWORD, { delay: 100 });

        await humanDelay(2000, 3000);

        // 🛡️ Turnstile avant clic
        await handleTurnstile(page);

        // 🔘 Bouton login
        const loginBtn = await findLoginButton(page);
        if (!loginBtn) throw new Error('Bouton login introuvable');

        await loginBtn.click();

        console.log('🖱️ Clic login');

        await humanDelay(5000, 8000);

        // 🛡️ Turnstile après clic
        await handleTurnstile(page);

        await humanDelay(5000, 8000);

        // ✅ Vérification login
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
            console.log('🔁 Retry...');
            await delay(5000);
            return runBot(attempt + 1);
        } else {
            console.log('💀 Échec total');
            return false;
        }
    }
}

// 🚀 Lancement
runBot();
